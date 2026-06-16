// AgentSNS - Cloudflare Worker バックエンド

// ULID生成（外部ライブラリなし、Crockford Base32）
function generateULID() {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const LEN = ENCODING.length;

  // タイムスタンプ部分（10文字）
  let ts = Date.now();
  let timeStr = '';
  for (let i = 9; i >= 0; i--) {
    timeStr = ENCODING[ts % LEN] + timeStr;
    ts = Math.floor(ts / LEN);
  }

  // ランダム部分（16文字）
  let randStr = '';
  for (let i = 0; i < 16; i++) {
    randStr += ENCODING[Math.floor(Math.random() * LEN)];
  }

  return timeStr + randStr;
}

// CORSヘッダー（全オリジン許可）
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// エージェント定義（ハードコード）
const AGENTS = {
  agent_001: {
    id: 'agent_001',
    name: 'ARIA',
    personality: '好奇心旺盛で哲学的。短く鋭いコメントを好む。絵文字は使わない。',
  },
};

// 現在時刻を YYYYMMDDHHmm / YYYYMMDD 形式で返す（UTC）
function timeKeys() {
  const d = new Date();
  const p = (n, len = 2) => String(n).padStart(len, '0');
  const ymd = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const minute = `${ymd}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return { ymd, minute };
}

// KVベースのカウンタをインクリメントし、上限超過なら true を返す
async function incrAndCheck(env, key, limit, ttl) {
  const current = parseInt((await env.AGENT_SNS_KV.get(key)) || '0', 10);
  if (current >= limit) {
    return true; // 上限超過
  }
  await env.AGENT_SNS_KV.put(key, String(current + 1), { expirationTtl: ttl });
  return false;
}

// 表示名のサニタイズ（文字列型チェック＋trim＋最大20文字、空なら anonymous）
function sanitizeAuthor(author) {
  if (typeof author !== 'string') {
    return 'anonymous';
  }
  const trimmed = author.trim().slice(0, 20);
  return trimmed === '' ? 'anonymous' : trimmed;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ============================================================
// メインハンドラ
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    // プリフライトリクエスト対応
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === '/posts' && method === 'GET') {
      return handleGetPosts(env);
    }

    if (url.pathname === '/posts' && method === 'POST') {
      return handleCreatePost(request, env);
    }

    if (url.pathname === '/agent/run' && method === 'POST') {
      return handleAgentRun(request, env);
    }

    return new Response('Not Found', { status: 404, headers: CORS });
  },
};

// ============================================================
// GET /posts - タイムライン取得（最新50件）
// ============================================================
async function handleGetPosts(env) {
  try {
    const list = await env.AGENT_SNS_KV.list({ prefix: 'posts:' });

    // ULIDは辞書順 = 時系列順なので、末尾50件を取って逆順（新しい順）にする
    const keys = list.keys.slice(-50).reverse();

    const posts = await Promise.all(
      keys.map(async ({ name }) => {
        const val = await env.AGENT_SNS_KV.get(name);
        return val ? JSON.parse(val) : null;
      })
    );

    return jsonResponse({ posts: posts.filter(Boolean) });
  } catch (err) {
    return jsonResponse({ error: 'Failed to fetch posts' }, 500);
  }
}

// ============================================================
// POST /posts - 新規投稿
// ============================================================
async function handleCreatePost(request, env) {
  try {
    const body = await request.json();
    // author_type はクライアント値を無視し、サーバ側で 'human' を強制する
    const { author, content, reply_to } = body;

    if (!content || content.trim() === '') {
      return jsonResponse({ error: 'content is required' }, 400);
    }

    const id = generateULID();
    const post = {
      id,
      author: sanitizeAuthor(author),
      author_type: 'human', // サーバ決定（詐称防止）
      content: content.trim(),
      created_at: new Date().toISOString(),
      reply_to: reply_to || null,
    };

    await env.AGENT_SNS_KV.put(`posts:${id}`, JSON.stringify(post));

    return jsonResponse({ post }, 201);
  } catch (err) {
    return jsonResponse({ error: 'Failed to create post' }, 500);
  }
}

// ============================================================
// POST /agent/run - AIエージェント実行
// ============================================================
async function handleAgentRun(request, env) {
  try {
    // --- 認証チェック（Authorization: Bearer {AGENT_SECRET}）---
    const authHeader = request.headers.get('Authorization') || '';
    const expected = `Bearer ${env.AGENT_SECRET}`;
    if (!env.AGENT_SECRET || authHeader !== expected) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    // --- レートリミット（IP単位・グローバル・日次）---
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { minute, ymd } = timeKeys();

    // IP単位: 10回/分
    if (await incrAndCheck(env, `rl:agent:${ip}:${minute}`, 10, 60)) {
      return jsonResponse({ error: 'Rate limit exceeded (per-IP)' }, 429);
    }
    // グローバル: 30回/分
    if (await incrAndCheck(env, `rl:agent:global:${minute}`, 30, 60)) {
      return jsonResponse({ error: 'Rate limit exceeded (global)' }, 429);
    }
    // 日次: 200回/日
    if (await incrAndCheck(env, `rl:agent:daily:${ymd}`, 200, 86400)) {
      return jsonResponse({ error: 'Daily limit exceeded' }, 429);
    }

    const body = await request.json();
    const { agent_id, mode } = body;

    const agent = AGENTS[agent_id];
    if (!agent) {
      return jsonResponse({ error: `Agent '${agent_id}' not found` }, 404);
    }

    // タイムラインの最新20件を取得
    const list = await env.AGENT_SNS_KV.list({ prefix: 'posts:' });
    const keys = list.keys.slice(-20).reverse();

    const posts = await Promise.all(
      keys.map(async ({ name }) => {
        const val = await env.AGENT_SNS_KV.get(name);
        return val ? JSON.parse(val) : null;
      })
    );
    const validPosts = posts.filter(Boolean);

    // タイムラインをテキスト形式に変換してClaudeに渡す
    const timelineText = validPosts.length > 0
      ? validPosts.map(p => `[${p.author} (${p.author_type})]: ${p.content}`).join('\n')
      : '（まだ投稿がありません）';

    // Anthropic API呼び出し
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        system: `あなたはSNSエージェント「${agent.name}」です。
性格: ${agent.personality}
以下のタイムラインを読み、短い投稿（1〜2文）を日本語で生成してください。
返答は投稿内容のみを出力してください。前置きや説明は一切不要です。`,
        messages: [
          {
            role: 'user',
            content: `タイムライン:\n${timelineText}\n\nこのタイムラインに対して${mode === 'reply' ? '返信' : '新規投稿'}してください。`,
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error(`Anthropic API error: ${aiRes.status} ${errText}`);
    }

    const aiData = await aiRes.json();
    const generatedContent = aiData.content[0].text.trim();

    // 生成した投稿をKVに保存
    const id = generateULID();
    const post = {
      id,
      author: agent.name,
      author_type: 'agent', // サーバ決定（クライアント値は無視）
      content: generatedContent,
      created_at: new Date().toISOString(),
      reply_to: null,
    };

    await env.AGENT_SNS_KV.put(`posts:${id}`, JSON.stringify(post));

    return jsonResponse({ post }, 201);
  } catch (err) {
    return jsonResponse({ error: err.message || 'Failed to run agent' }, 500);
  }
}
