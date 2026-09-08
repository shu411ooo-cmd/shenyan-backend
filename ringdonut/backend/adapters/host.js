/**
 * Host integration — 沈晏宿主实现（2026-08-24 接入）。
 *
 * ringdonut 从生产系统拆出，宿主适配层是可独立运行的参考实现：
 *  - 独立 createClient（SUPABASE_URL / SUPABASE_KEY 与主服务同一套环境变量）
 *  - 鉴权独立实现（cookie session，与主服务逻辑一致；x-site-key 兜底 2026-09-08 随主服务一并拆除）
 *
 * 这样 ringdonut 既可以挂进主 server.js，也可以单独 node 起一个实例调试。
 * 记忆接入点：loadMemories 从 memory_topics 表读（与主服务 getAttentionMaterial
 * 同源数据），语义 = 「沈晏心底的旧事」。
 */

const path = require('path');
require('dotenv').config({
  // 宿主 .env 在 shenyan-backend 根目录（ringdonut 是子目录，独立跑时也向上找）
  path: path.join(__dirname, '..', '..', '..', '.env'),
});
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const CALL_AUDIO_BUCKET = 'call-audio';
const SESSION_COOKIE = 'sid';

function notConfigured(name) {
  throw new Error(`Host adapter not configured: ${name}`);
}

// —— 鉴权：cookie(sid) 有效即放行（x-site-key 兜底已拆，2026-09-08）——
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function isValidSession(token) {
  if (!token) return false;
  try {
    const { data, error } = await supabase
      .from('auth_sessions')
      .select('id, expires_at')
      .eq('token', token)
      .maybeSingle();
    if (error || !data) return false;
    return new Date(data.expires_at).getTime() > Date.now();
  } catch (err) {
    console.error('[Call Host] isValidSession 异常:', err.message);
    return false;
  }
}

async function authorizeRequest(req) {
  const sitePassword = process.env.SITE_PASSWORD || '';
  // 无配置时不锁（防把自己锁死，与主服务行为一致）
  if (!sitePassword) return;
  // cookie session（完整校验；x-site-key 兜底 2026-09-08 已拆）
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token && (await isValidSession(token))) return;
  const err = new Error('unauthorized');
  err.statusCode = 401;
  throw err;
}

// —— 记忆：memory_topics 表（与 getAttentionMaterial 同源）——
async function loadMemories() {
  const { data, error } = await supabase
    .from('memory_topics')
    .select('topic, last_content, grounding, importance, updated_at')
    .order('updated_at', { ascending: true })
    .limit(60);
  if (error) { console.error('[Call Host] loadMemories 失败:', error.message); return []; }
  return (data || [])
    .filter(t => String(t.last_content || '').trim())
    .map(t => ({
      summary: String(t.last_content || '').trim().slice(0, 600),
      topic: t.topic,
      grounding: t.grounding,
      importance: t.importance,
      updated_at: t.updated_at,
    }));
}

// —— 聊天历史：messages 表（过滤思考链字段）——
async function loadMessagesForAI(sessionId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) { console.error('[Call Host] loadMessagesForAI 失败:', error.message); return []; }
  return (data || []).filter(m => ['user', 'assistant'].includes(m.role));
}

// —— 设置：settings 表（global 行）——
async function loadSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('system_prompt')
    .eq('session_id', 'global')
    .maybeSingle();
  if (error) { console.error('[Call Host] loadSettings 失败:', error.message); return {}; }
  return { system_prompt: String(data?.system_prompt || '') };
}

// —— 保存消息到主对话流（通话摘要记录进沈晏的聊天）——
async function saveMessage(role, content, extra = {}, sessionId) {
  const row = {
    session_id: sessionId,
    role,
    content: String(content || ''),
  };
  // extra 里可带 source / tool_calls 等主服务认识的字段
  if (extra && typeof extra === 'object') {
    if (extra.source) row.source = extra.source;
    if (extra.tool_calls) row.tool_calls = extra.tool_calls;
  }
  const { data, error } = await supabase.from('messages').insert(row).select('id, created_at').single();
  if (error) throw error;
  return data;
}

// —— 来电通知：落 keepalive_log（沈晏意识时间线）——
// 无 Web Push 基础设施；来电邀请本身已入库（call_invites），前端轮询
// GET /api/call/invite 就能看到。这里再留一条 keepalive_log 痕迹，
// 让「沈晏想打电话」出现在他的意识时间线里。
async function notifyIncomingCall({ sessionId, reason }) {
  try {
    const { error } = await supabase.from('keepalive_log').insert({
      session_id: sessionId,
      run_at: new Date().toISOString(),
      action: 'message',
      content: `【沈晏想给你打电话】${String(reason || '').slice(0, 80)}`,
      source: 'call-invite',
    });
    if (error) console.warn('[Call Host] keepalive_log 来电痕迹失败:', error.message);
  } catch (e) {
    console.warn('[Call Host] keepalive_log 来电痕迹异常:', e.message);
  }
  return false; // 无推送基础设施，返回 false（不阻断来电入库）
}

// —— 通话音频存储：Supabase Storage（私有 bucket）——
async function saveCallAudio({ callId, turnId, index, sourceHash, voiceId, audio, contentType }) {
  const bucket = CALL_AUDIO_BUCKET;
  const path = `calls/${String(callId).slice(0, 12)}/${turnId}/${index}-${sourceHash}.mp3`;
  const { error } = await supabase.storage.from(bucket).upload(path, audio, {
    contentType: contentType || 'audio/mpeg',
    upsert: true,
  });
  if (error) {
    console.error('[Call Host] 上传通话音频失败:', error.message);
    return null;
  }
  // 私密 URL：30 分钟有效期，前端用这个 URL 播放
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, 1800);
  return data?.signedUrl || null;
}

module.exports = {
  supabase,
  loadMemories,
  loadMessagesForAI,
  loadSettings,
  saveMessage,
  authorizeRequest,
  saveCallAudio,
  notifyIncomingCall,
};
