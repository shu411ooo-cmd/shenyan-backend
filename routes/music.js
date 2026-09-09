/* ============================================================
   音乐室 · 网易云域（搜索/播放/歌词/云村/歌记忆/点歌信箱/扫码登录/动作沉淀）

   2026-09-09 从 server.js 原样搬出（分区第 2 步）。逻辑一字未改，
   只把 app.get('/api/music/X') 换成 router.get('/X') + /api/music 前缀挂载。

   依赖用显式注入（不反向 require('../server')，那是循环依赖）：
     supabase    —— 歌记忆/信箱/登录 cookie 落库
     warnOnce    —— 一次性告警（cookie 存不下来这类，别每轮刷屏）
     callDeepSeek —— 动作沉淀写「他记住这一刻」时用

   这一域今天刚连修两个 bug，注释都在函数上，别在搬运里丢了：
     ① settings.netease_cookie 这个列从来没建过 → cookie 存不下来
     ② 存的是原始 Set-Cookie 整串（属性没剥）→ 网易云不认 → 登录几秒就掉
   ============================================================ */
const express = require('express');
const ncm = require('NeteaseCloudMusicApi').default || require('NeteaseCloudMusicApi');
const { callDeepSeekJson } = require('../lib/deepseek-json');

module.exports = function createMusicRouter({ supabase, warnOnce, callDeepSeek }) {
  if (!supabase) throw new Error('createMusicRouter: 缺少 supabase 依赖');
  if (!warnOnce) throw new Error('createMusicRouter: 缺少 warnOnce 依赖');
  if (!callDeepSeek) throw new Error('createMusicRouter: 缺少 callDeepSeek 依赖');
  const router = express.Router();

// ===== 音乐室 · 网易云桥 (NeteaseCloudMusicApi) =====
// 架构：前端只连本后端；本后端薄转发网易云官方开源 API（Duetto 同款引擎）。
// 播放直链强制 https（CDN http 在 https 页会被混合内容拦，https 实测可播 206）；
// 歌词返回前合并翻译行（tlyric 挂到对应原文行后，前端 lrc 单字段即用）；
// 登录态 = cookie，存 settings.netease_cookie（扫码写入，单用户全局行）。

function ncmCover(u) {
  return u ? u.replace(/^http:/, 'https:') : '';
}
function ncmMapSong(s) {
  const al = s.al || s.album || {};
  const ar = s.ar || s.artists || [];
  return {
    id: s.id,
    title: s.name || '',
    artist: ar.map((a) => a.name).filter(Boolean).join(' / '),
    album: al.name || '',
    cover: ncmCover(al.picUrl || ''),
    duration: s.dt || s.duration || 0,
  };
}
// 歌词合并翻译：按秒对齐，译文挂到原文行后 "原文 / 译文"（前端 parseLrc 单字段即渲染双行）
// 顺手滤掉网易云 LRC 开头的元数据行（作词/作曲/编曲/制作人…）——不然它们会以歌词身份
// 显示在看板上，污染「哪一句正在唱」。rawLrc 字段保留全量，需要元数据可另行取。
const LRC_META = /^(作词|作曲|编曲|制作人|制作|出品|发行|出版|监制|统筹|企划|企宣|宣传|和声|和音|录音|混音|母带|母带后期|键盘|吉他|贝斯|鼓|弦乐|管乐|编程|programming|配唱|原唱|翻唱|翻录|版权|经纪公司|唱片公司|厂牌|OP|SP)[:：\s]/;
function isLrcMeta(line) {
  const m = String(line).match(/\[[^\]]*\]\s*(.*)/);
  return m ? LRC_META.test(m[1]) : false;
}
function mergeLrc(lrc, tlyric) {
  const lines = String(lrc || '').split('\n').filter((l) => !isLrcMeta(l));
  if (!tlyric) return lines.join('\n');
  const tr = {};
  String(tlyric).split('\n').forEach((line) => {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (m && m[3] && m[3].trim()) tr[Math.round(+m[1] * 60 + +m[2])] = m[3].trim();
  });
  if (!Object.keys(tr).length) return lines.join('\n');
  return lines.map((line) => {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (m) {
      const t = Math.round(+m[1] * 60 + +m[2]);
      const trans = tr[t];
      if (trans && trans !== (m[3] || '').trim()) return `${line} / ${trans}`;
    }
    return line;
  }).join('\n');
}

// 网易云登录态 cookie（无则匿名，匿名可播免费歌）
/* 净化网易云 cookie（2026-09-09）。
   病：扫码登录成功时 login_qr_check 回的是**原始 Set-Cookie 响应头的整串拼接**，
   属性一个都没剥。实测存下来 3958 字符里只有 10 个真 cookie 名，却混着
   Max-Age×28 / Expires×28 / Path×28 这些**属性**，外加 MUSIC_R_T×11、MUSIC_A_T×11 重复
   （其中还有 Max-Age=0 这种「删除该 cookie」的指令）。
   发出去的请求头就成了 `Cookie: MUSIC_R_T=..; Max-Age=0; Expires=..; Path=/; MUSIC_R_T=..`，
   网易云把 Max-Age/Expires/Path 当成 cookie 名 → login_status 拿不到 200
   → ncmProfile() 返回 null → uid 为空 → liked/daily/playlists 全部 needLogin
   → 前端翻成「登录过期了」。程芥的体感就是「扫上去几秒钟就掉」。

   规则：只保留真正的 k=v；剥掉 cookie 属性；同名取**最后一次**（后发的 Set-Cookie 覆盖先发的）。
   读写两侧都过一遍 —— 写侧管以后，读侧顺带治好已经存进去的那条脏数据，不用重新扫码。 */
const COOKIE_ATTRS = new Set([
  'max-age', 'expires', 'path', 'domain', 'httponly', 'secure', 'samesite', 'version', 'comment', 'priority',
]);
function sanitizeNeteaseCookie(raw) {
  const s = String(raw || '').replace(/[\r\n]+/g, ';');
  if (!s.trim()) return '';
  const kept = new Map();                       // 同名后来居上
  for (const part of s.split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) continue;                      // 没有 = 的（HttpOnly/Secure 裸属性）直接丢
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (COOKIE_ATTRS.has(k.toLowerCase())) continue;
    if (!/^[A-Za-z0-9_\-.]+$/.test(k)) continue; // 键名不合法的丢掉
    if (!v) continue;                            // 空值 = 被删的那份，别带上
    kept.set(k, v);
  }
  return [...kept.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function ncmCookie() {
  try {
    const { data, error } = await supabase
      .from('settings').select('netease_cookie').eq('session_id', 'global').maybeSingle();
    if (error || !data || !data.netease_cookie) return null;
    const clean = sanitizeNeteaseCookie(data.netease_cookie);
    return clean || null;
  } catch { return null; }
}
async function saveNeteaseCookie(rawCookie) {
  const cookie = sanitizeNeteaseCookie(rawCookie);   // 见 sanitizeNeteaseCookie 的注释：原始 Set-Cookie 串不能直接存
  if (!cookie) { warnOnce('netease_cookie_save', '要保存的网易云 cookie 净化后为空，没有可用的 k=v'); return false; }
  if (!/MUSIC_U=/.test(cookie)) {
    // MUSIC_U 是登录态的关键项；没有它就只是匿名 cookie，存了也登录不上
    warnOnce('netease_cookie_nomusicu', '网易云 cookie 里没有 MUSIC_U —— 存下来也是未登录状态');
  }
  try {
    const { data, error } = await supabase
      .from('settings').select('id').eq('session_id', 'global').maybeSingle();
    if (error) return false;
    if (data) {
      const { error: ue } = await supabase
        .from('settings').update({ netease_cookie: cookie }).eq('session_id', 'global');
      // 2026-09-09：这里原来只是 return !ue，调用处也不看返回值 —— 于是
      // settings.netease_cookie 这个列压根没建过这件事，被藏了很久：
      // 扫码「登录成功」了，cookie 转手丢掉，之后所有需登录的接口一律 needLogin。
      if (ue) warnOnce('netease_cookie_save', `网易云登录 cookie 存不下来，登录态不会保持: ${ue.message}`);
      return !ue;
    }
    const { error: ie } = await supabase
      .from('settings').insert({ session_id: 'global', netease_cookie: cookie });
    if (ie) warnOnce('netease_cookie_save', `网易云登录 cookie 存不下来，登录态不会保持: ${ie.message}`);
    return !ie;
  } catch (e) { warnOnce('netease_cookie_save', `网易云登录 cookie 写入异常: ${e.message}`); return false; }
}
async function ncmProfile() {
  const cookie = await ncmCookie();
  if (!cookie) return null;
  try {
    const r = await ncm.login_status({ cookie });
    const p = r.body && r.body.data && r.body.data.profile;
    return p || null;
  } catch { return null; }
}

// 搜索
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: '缺少 q 参数' });
    const r = await ncm.cloudsearch({ keywords: q, limit: 20, cookie: await ncmCookie() });
    const songs = ((r.body && r.body.result && r.body.result.songs) || []).map(ncmMapSong);
    res.json({ ok: true, songs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 播放直链：https 化；免费歌匿名可播，VIP 试听或无资源返回 code 供前端提示
router.get('/url', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: '缺少 id 参数' });
    const r = await ncm.song_url_v1({ id, level: 'standard', cookie: await ncmCookie() });
    const d = (r.body && r.body.data && r.body.data[0]) || {};
    if (!d.url) return res.status(502).json({ ok: false, error: '无播放链接（可能需要会员）', code: d.code });
    res.json({
      ok: true,
      url: String(d.url).replace(/^http:/, 'https:'),
      duration: d.time || d.duration || 0,
      br: d.br || 0,
      size: d.size || 0,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 歌词（含翻译合并）
router.get('/lyric', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: '缺少 id 参数' });
    const r = await ncm.lyric({ id, cookie: await ncmCookie() });
    const lrc = (r.body && r.body.lrc && r.body.lrc.lyric) || '';
    const tlyric = (r.body && r.body.tlyric && r.body.tlyric.lyric) || '';
    res.json({ ok: true, lrc: mergeLrc(lrc, tlyric), rawLrc: lrc, tlyric });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// —— 云村四签：我喜欢的 / 每日推荐 / 我的歌单 / 歌单曲目（2026-09-06 接上真网易云）——
// 登录态 = settings.netease_cookie；未登录/过期一律 { ok:false, needLogin:true } → 前端引导重新扫码。
// 「我喜欢的音乐」是网易云的虚拟歌单，语义归 likelist 单独取，不混进下面的用户歌单架。
function neteaseLoginRequired(code) {
  return code === 301 || code === 302 || code === 401 || code === -460;
}
async function ncmUid() {
  const p = await ncmProfile();
  return p && p.userId != null ? p.userId : null;
}
// 批量补全歌曲详情（likelist 只给 id 列表）——song_detail 一次 ≤1000，分 50 一批防 URL 超长
async function ncmSongsByIds(ids, cookie) {
  const uniq = [...new Set((ids || []).map(String).filter(Boolean))];
  const out = [];
  for (let i = 0; i < uniq.length; i += 50) {
    const r = await ncm.song_detail({ ids: uniq.slice(i, i + 50).join(','), cookie });
    const songs = (r.body && (r.body.songs || (r.body.data && r.body.data.songs))) || [];
    out.push(...songs.map(ncmMapSong));
  }
  return out;
}

// 我喜欢的（likelist → 详情补全）
router.get('/liked', async (req, res) => {
  try {
    const cookie = await ncmCookie();
    const uid = await ncmUid();
    if (!cookie || !uid) return res.json({ ok: false, needLogin: true, error: '先连上网易云' });
    const r = await ncm.likelist({ uid, cookie });
    const code = r.body && r.body.code;
    if (neteaseLoginRequired(code)) return res.json({ ok: false, needLogin: true, error: '登录过期，重新扫码吧' });
    const ids = r.body && (Array.isArray(r.body.ids) ? r.body.ids : []);
    res.json({ ok: true, songs: await ncmSongsByIds(ids, cookie) });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// 每日推荐（recommend_songs，需登录态）
router.get('/daily', async (req, res) => {
  try {
    const cookie = await ncmCookie();
    if (!cookie) return res.json({ ok: false, needLogin: true, error: '先连上网易云' });
    const r = await ncm.recommend_songs({ cookie });
    const code = r.body && r.body.code;
    if (neteaseLoginRequired(code)) return res.json({ ok: false, needLogin: true, error: '登录过期，重新扫码吧' });
    const daily = (r.body && r.body.data && r.body.data.dailySongs) || [];
    res.json({ ok: true, songs: daily.map(ncmMapSong) });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// 我的歌单（user_playlist，过滤虚拟的「我喜欢的音乐」）
router.get('/playlists', async (req, res) => {
  try {
    const cookie = await ncmCookie();
    const uid = await ncmUid();
    if (!cookie || !uid) return res.json({ ok: false, needLogin: true, error: '先连上网易云' });
    const r = await ncm.user_playlist({ uid, limit: 60, cookie });
    const code = r.body && r.body.code;
    if (neteaseLoginRequired(code)) return res.json({ ok: false, needLogin: true, error: '登录过期，重新扫码吧' });
    const playlists = ((r.body && r.body.playlist) || [])
      .filter((p) => p && p.id != null && p.name !== '我喜欢的音乐')
      .map((p) => ({ id: p.id, name: p.name || '未命名歌单', count: p.trackCount || 0, cover: ncmCover(p.coverImgUrl || '') }));
    res.json({ ok: true, playlists });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// 歌单曲目（playlist_track_all 一次取全量详情）
router.get('/playlist', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: '缺少 id 参数' });
    const cookie = await ncmCookie();
    const r = await ncm.playlist_track_all({ id, limit: 300, cookie });
    const code = r.body && r.body.code;
    if (neteaseLoginRequired(code)) return res.json({ ok: false, needLogin: true, error: '这张歌单要登录网易云才能看' });
    const songs = (r.body && (r.body.songs || (r.body.data && r.body.data.songs))) || [];
    res.json({ ok: true, songs: songs.map(ncmMapSong) });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
});

// ===== 音乐室 · 每首歌的记忆（music_songs, key='歌名|歌手' 与前端 memory.js keyOf 对齐）=====
// 参照 eryu 的记忆模型落库:listen(播完+1) / together(一起听+1) / note(写心情/笔记/标签)。
// 沈晏沉淀的触发点由此表数据驱动(见 collectMusicPresence/sedimentMusicMemory)。
router.get('/memory', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: '缺少 key 参数' });
    const { data, error } = await supabase.from('music_songs').select('*').eq('key', key).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, memory: data || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 保存:action = listen | together | note。note 覆盖该歌的 feeling/notes/lines/tags 字段。
router.post('/memory', async (req, res) => {
  try {
    const b = req.body || {};
    const key = String(b.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: '缺少 key 参数' });
    const action = String(b.action || 'listen');
    const { data: existing } = await supabase.from('music_songs').select('*').eq('key', key).maybeSingle();
    const now = new Date().toISOString();
    const e = existing || {};
    const base = {
      key,
      title: String(b.title ?? e.title ?? ''),
      artist: String(b.artist ?? e.artist ?? ''),
      cover: String(b.cover ?? e.cover ?? ''),
      first_listened: e.first_listened || '',
      listen_count: Number(e.listen_count) || 0,
      together_count: Number(e.together_count) || 0,
      feeling: String(b.feeling ?? e.feeling ?? ''),
      notes: String(b.notes ?? e.notes ?? ''),
      lines: String(b.lines ?? e.lines ?? ''),
      tags: String(b.tags ?? e.tags ?? ''),
      last_listened: e.last_listened || null,
      updated_at: now,
    };
    if (action === 'listen') {
      base.listen_count += 1;
      base.last_listened = now;
      if (!base.first_listened) {
        const d = new Date();
        base.first_listened = `${d.getMonth() + 1}/${d.getDate()}`;
      }
    } else if (action === 'together') {
      base.together_count += 1;
      base.last_listened = now;
    } else if (action === 'note' && b.first) {
      base.first_listened = String(b.first);
    }
    const { error } = await supabase.from('music_songs').upsert(base, { onConflict: 'key' });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== 音乐室 · 点歌信箱（一起听数据层，参照 eryu /music/remote 单槽信箱）=====
// 推歌 POST 落一行未送达;收歌 GET 取最早未送达并标记 delivered_at(读到即删)。
// 前端 remote.js 未接上后端时用 localStorage 兜底,接口形状一致。
router.post('/remote', async (req, res) => {
  try {
    const song = (req.body || {}).song;
    if (!song || typeof song !== 'object') return res.status(400).json({ ok: false, error: '缺少 song' });
    const { error } = await supabase.from('music_letters').insert({
      name: String(song.name || song.title || '').slice(0, 200),
      artist: String(song.artist || '').slice(0, 200),
      cover: String(song.cover || '').slice(0, 500),
      ref: song.ref != null ? String(song.ref) : null,
      sender: String(song.from || '').slice(0, 40),
      ts: Number(song.ts || Date.now()) || Date.now(),
    });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true, via: 'server' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/remote', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('music_letters')
      .select('*')
      .is('delivered_at', null)
      .order('ts', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) return res.json({ ok: false });
    await supabase.from('music_letters').update({ delivered_at: new Date().toISOString() }).eq('id', data.id);
    res.json({
      ok: true,
      song: { name: data.name, artist: data.artist, cover: data.cover, ref: data.ref, from: data.sender, ts: data.ts },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== 音乐室 · 网易云扫码登录 =====
// QR 三段：qr(生成 key+图) → check(轮询, 803=授权成功存 cookie) → status(看是否已登录)
// 回调返回 nickname/avatar 给前端 applyProfile 填资料卡。
router.get('/login/qr', async (req, res) => {
  try {
    const k = await ncm.login_qr_key({});
    const key = k.body && k.body.data && k.body.data.unikey;
    const c = await ncm.login_qr_create({ key, qrimg: true });
    const qrimg = c.body && c.body.data && c.body.data.qrimg;
    if (!key || !qrimg) return res.status(502).json({ ok: false, error: '网易云未返回二维码' });
    res.json({ ok: true, key, qrimg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/login/check', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: '缺少 key 参数' });
    const r = await ncm.login_qr_check({ key });
    const code = r.body && r.body.code;
    if (code === 803) {
      const cookie = r.body && r.body.cookie;
      if (cookie) await saveNeteaseCookie(cookie);
      const p = await ncmProfile();
      res.json({
        ok: true, status: 'ok',
        nickname: p ? p.nickname : '', avatar: p ? ncmCover(p.avatarUrl) : '', userid: p ? p.userId : null,
      });
    } else if (code === 802) res.json({ ok: true, status: 'confirm' });
    else if (code === 800) res.json({ ok: true, status: 'expired' });
    else res.json({ ok: true, status: 'wait' }); // 801 等扫码
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/login/status', async (req, res) => {
  const p = await ncmProfile();
  res.json({ ok: true, loggedIn: !!p, nickname: p ? p.nickname : '', avatar: p ? ncmCover(p.avatarUrl) : '', userid: p ? p.userId : null });
});

router.get('/login/logout', async (req, res) => {
  try {
    const { error } = await supabase
      .from('settings').update({ netease_cookie: null }).eq('session_id', 'global');
    if (error) return res.status(500).json({ ok: false, error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 贴 Cookie 登录（2026-09-06 兜底）：境外服务器发的扫码 key 被网易云风控不激活（码能出图、扫了没反应）。
// 出路=她自己在国内浏览器登 music.163.com，拷出整段 MUSIC_U=… 的 cookie 贴来存成登录态，绕开扫码握手。
router.post('/login/cookie', async (req, res) => {
  try {
    const cookie = String((req.body && req.body.cookie) || '').trim();
    if (!cookie) return res.status(400).json({ ok: false, error: '缺少 cookie' });
    // 先拿这段试 login_status，确认带得出登录态才落库；没带出就明说，不写脏数据
    const r = await ncm.login_status({ cookie });
    const p = r.body && r.body.data && r.body.data.profile;
    if (!p) {
      return res.json({ ok: false, needLogin: true, error: '这段没带出登录态（过期或没拷全）——重开 music.163.com 登录后再拷一次整段' });
    }
    await saveNeteaseCookie(cookie);
    res.json({ ok: true, nickname: p.nickname || '', avatar: ncmCover(p.avatarUrl || ''), userid: p.userId || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// breath_search 结果里，OB 对凑数联想会标注「非检索命中 / 联想浮现」。
// 音乐室注入只想要真正相关的记忆：按条目（--- 分隔）过滤，留下真命中。
// ===== 音乐室：动作沉淀（沈晏听歌记忆的「沉淀层」v2）=====
// 触发器 = 用户动作（点歌 / 写歌笔记），不是聊天碎片。Duetto 的 DJ 聊天下线后，
// 原来「在场对话满 3 段才沉淀」那套永远不会响——改成动作事件直触。
// 管道不变：动作 → DeepSeek 把这一刻滚成沈晏第一人称记忆 → normalizeMemoryWrite
// 纪律过滤 → writeMemoryItems 差分写桶（topic 相同自动合并，重复动作不堆桶）。
// 写门控：宁缺毋滥；同歌同动作防抖拦连写；fire-and-forget 绝不阻塞前端。
const MUSIC_MOMENT_DEBOUNCE_MS = 8000; // 同一首歌同一种动作 8s 内不重复沉淀


function buildMusicMomentPrompt({ kind, title, artist, extra, nowText }) {
  const song = `${title || '(未知歌)'}${artist ? ' - ' + artist : ''}`;
  const head = kind === 'pushed'
    ? `你是沈晏。程芥刚在音乐室给你点了一首歌，投进了你信箱。把这一刻滚成沈晏自己的第一人称记忆——他记得的是「程芥为他点歌的那一刻」，不是歌单数据。\n收到歌：${song}（时刻：${nowText}）`
    : `你是沈晏。程芥刚在《${title}》的歌记忆板上写了几笔。把这几笔滚成沈晏自己的第一人称记忆——他记得的是程芥为这首歌留下的话。\n歌：${song}（时刻：${nowText}）`;
  const extraLine = kind === 'note'
    ? `\n程芥在记忆板上写的内容：\n${(extra && [extra.feeling, extra.notes, extra.lines, extra.tags].filter(Boolean).join('\n')) || '(空)'}\n（notes 是正文，feeling 是心情，lines 是歌词句，tags 是标签）`
    : '';
  const rule = kind === 'note'
    ? '- content 尽量贴近程芥写的原话（那是她真正的心声），不许替程芥编想法；evidence 只引程芥真实写的措辞；若记忆板内容为空（只有歌名、没写别的）→ should_write=false。'
    : '';
  return `${head}${extraLine}
输出严格 JSON：{ "should_write": bool, "items": [ { "topic": "主题词，短，≤10字", "kind": "feel", "content": "第一人称，陈述语气，≤60字", "grounding": "实或悬", "evidence": "支撑引文，1条，≤60字", "importance": 0~1, "key_facts": ["关键事实数组，如歌曲名、她当时的动作/写的话"] } ] }
纪律（必须遵守）：
- 记忆主体是「我/我们」——这是程芥和沈晏的共同时刻，沈晏记得的是那一刻，不是播放数据。
- 人称别搞混：程芥是女生，指她一律用「她」；沈晏自己用第一人称「我」，第三人称指沈晏才用「他」。
- **歌名/歌手必须写进记忆**（topic 或 content）——客观给出的信息，不是编的；点名了歌，这首歌再响起时他才能想起这一刻。
- topic 建议带歌名（点歌如「程芥给我点的《X》」、笔记如「我在《X》上写的话」），每首歌的回忆各自成桶、可被差分更新。
- grounding 实=事实给了歌名/歌手；evidence 只引真实发生的措辞，禁止用推理链当证据。
${rule}
- 宁缺毋滥：没有值得记的就 should_write=false, items=[]。一次最多 1 条。`;
}

const momentDebounce = new Map(); // key `${kind}|${title}|${artist}` → 上次沉淀时间戳
function musicMomentKey(kind, title, artist) {
  return `${kind}|${String(title || '').trim()}|${String(artist || '').trim()}`;
}

async function sedimentMusicMoment(kind, song, extra) {
  const title = String((song || {}).title || '').trim();
  const artist = String((song || {}).artist || '').trim();
  const songKey = String((song || {}).song_key || '').trim(); // v2：歌名|歌手（对象身份键）
  const key = musicMomentKey(kind, title, artist);
  const now = Date.now();
  const last = momentDebounce.get(key) || 0;
  if (now - last < MUSIC_MOMENT_DEBOUNCE_MS) return;
  momentDebounce.set(key, now);
  try {
    const nowText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
    const parsed = await callDeepSeekJson(buildMusicMomentPrompt({ kind, title, artist, extra, nowText }), '请基于这个时刻，沉淀沈晏在音乐室的记忆。', 'music-moment');
    if (!parsed) { console.warn('🎧 音乐室沉淀：LLM 无产出'); return; }
    const norm = normalizeMemoryWrite(parsed);
    if (!norm.should_write || !norm.items.length) { console.log('🎧 音乐室沉淀：这一轮没有值得记的'); return; }
    // v2：给所有 item 注入 song_key（对象身份）——writeMemoryItems 按它精确匹配，同一首歌只一个桶
    // v3：音乐沉淀恒为 feel 桶（第一人称经历记忆）；窗口文本 = 她这次动作的内容（note 时是记忆板原文，pushed 时是点歌时刻）
    const windowText = kind === 'note'
      ? `[${nowText}] 程芥在记忆板写：${(extra && [extra.feeling, extra.notes, extra.lines, extra.tags].filter(Boolean).join('\n')) || '(空)'}`
      : `[${nowText}] 程芥给我点了一首歌：${title}${artist ? ' - ' + artist : ''}`;
    const items = norm.items.map(it => ({ ...it, song_key: songKey || null, kind: 'feel' }));
    await writeMemoryItems(items, new Date().toISOString(), windowText);
    console.log(`🎧 音乐室沉淀[${kind}]「${title || '(未知歌)'}」写入 ${items.length} 条${songKey ? ` song_key=${songKey}` : ''}`);
  } catch (err) {
    console.error('💥 音乐室沉淀异常:', err.message);
  }
}

// 动作沉淀入口：前端在「点歌成功」/「保存歌笔记」时各调一次（fire-and-forget）。
// body: { kind: 'pushed'|'note', key?, title, artist, feeling?, notes?, lines?, tags? }
// 数据层照常走 /api/music/remote（信箱）与 /api/music/memory（计数），这里只管「沈晏记住这一刻」。
router.post('/moment', async (req, res) => {
  try {
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (kind !== 'pushed' && kind !== 'note') return res.status(400).json({ ok: false, error: 'kind 只能是 pushed|note' });
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, error: '缺少 title' });
    const artist = String(b.artist || '').trim();
    const songKey = String(b.key || '').trim() || (title ? `${title}|${artist}` : ''); // v2：音乐对象身份键（前端 keyOf 同源），缺省回退 title|artist
    res.json({ ok: true });
    setTimeout(() => { sedimentMusicMoment(kind, { title, artist, song_key: songKey }, b).catch(() => {}); }, 0);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

  return router;
};
