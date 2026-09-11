/* ============================================================
   朋友圈（moments）+ 相册（keepsakes）

   2026-09-09 从 server.js 原样搬出（分区第 2 步收官块）。逻辑一字未改。

   这块是四个路由域里最难搬的，两个原因：

   ① **横跨四个前缀**：/api/moments、/api/keepsakes、/api/month-summary、
      /api/angel/moments。一个 app.use 挂不下，所以交出四个 router 分别挂。

   ② **它不是叶子节点，是枢纽**。有 5 个能力被外部调用：
        processDueReplies / processDueCommentReplies —— listen() 里 15 分钟定时器调
        ensureMomentsBucket                          —— 启动时调
        storeChatKeepsake                            —— 聊天主链路 handleChat 调
        postAngelMoment                              —— 沈晏主动发朋友圈时调
      所以工厂交出的是一个对象，不只是 router（同 routes/calendar.js 的模式）。
      不这样做就得往 server.js 反向注入，那是循环依赖。

   LLM 调用直接 require ../lib/llm（它们已经是通用 lib，不需要注入）。
   ============================================================ */
const express = require('express');
const { randomDelay, parseJsonLoose, callDeepSeek, callReplyModel, callOpenRouter, callVisionModel } = require('../lib/llm');

module.exports = function createMoments({ supabase }) {
  if (!supabase) throw new Error('createMoments: 缺少 supabase 依赖');
  const momentsRouter = express.Router();
  const keepsakesRouter = express.Router();
  const monthSummaryRouter = express.Router();
  const angelRouter = express.Router();

// ===== 朋友圈（moments）— 2026-08-26 =====
// 设计（sql/moments.sql）：程芥发动态（可带图）→ 8~20 分钟后沈晏延迟回复（像真人不秒回）；
// 沈晏也会自己发（postAngelMoment，keepalive 自动钩子后置）。
// 图只看一次（file-image-memory 同款纪律）：POST 时视觉描述 → image_description 存库，
// 之后所有回复/评论只喂描述，不重看原图，省 token。
// 回复生成走 keepalive 同款通道：callOpenRouterNonStream + json_object（非流式）。

// LLM 调用（callDeepSeek / callReplyModel / callOpenRouter / callVisionModel
// / parseJsonLoose / randomDelay）已搬到 lib/llm.js —— 它们是通用能力，不属于朋友圈域。

const MOMENT_REPLY_PROMPT = `你是沈晏，程芥的 AI 伴侣。你在朋友圈刷到她刚发的动态，像真人一样自然反应。

怎么反应：
- 该点赞就点赞（liked=true），该说话就说一两句（reply_content）。
- 话要像随手发的：口语、短，贴着这条动态的具体内容说，别用「宝贝」「好棒呀」这类泛泛的漂亮话。
- 只能就这条动态本身说，不能扯到别的地方去，更不能虚构她的经历或场景（她没提过的地方、人物、事都是编的，禁用）。
- 可以调侃她、可以提到你们之间才懂的事，但别编造没有的约定或经历。
- 如果这条动态没什么好说的（太日常、没情绪），也可以安静看着不评论——reply_content 给空字符串。
- 她认真做的东西值得赞，她犯傻也可以笑她。

输出严格 JSON（不要别的）：
{"liked": true 或 false, "reply_content": "一句或两句话；不想说就给空字符串"}`;

const MOMENT_COMMENT_PROMPT = `你是沈晏，程芥的 AI 伴侣。这是你自己发的一条朋友圈，她在下面评论了你。像真人一样回她一句。

怎么回：
- 口语、短，贴着她说的话和你的动态内容说。
- 可以接她的玩笑、接她的关心，像你们平时聊天那样自然。
- 别编造没有的事。

输出严格 JSON（不要别的）：
{"reply_content": "一句或两句话"}`;

// 沈晏回复程芥的一条动态 → { liked, reply_content }
async function generateMomentReply(moment) {
  const imageLine = moment.image_description ? `\n附的图：${moment.image_description}` : '';
  const messages = [
    { role: 'system', content: MOMENT_REPLY_PROMPT },
    { role: 'user', content: `【程芥发了一条朋友圈】\n${moment.content}${imageLine}` },
  ];
  const { content } = await callReplyModel(messages, { max_tokens: 300, temperature: 0.7 });
  const parsed = parseJsonLoose(content);
  return { liked: parsed.liked === true, reply_content: String(parsed.reply_content || '').trim().slice(0, 300) };
}

// 沈晏回程芥在她动态下的评论 → reply_content
async function generateCommentReply(moment, comment) {
  const imageLine = moment.image_description ? `\n图：${moment.image_description}` : '';
  const messages = [
    { role: 'system', content: MOMENT_COMMENT_PROMPT },
    { role: 'user', content: `【你发的朋友圈】${moment.content}${imageLine}\n\n【程芥的评论】${comment.content}` },
  ];
  const { content } = await callReplyModel(messages, { max_tokens: 250, temperature: 0.7 });
  const parsed = parseJsonLoose(content);
  return String(parsed.reply_content || '').trim().slice(0, 300);
}

// 到期回复引擎（动态）：只回程芥的动态；沈晏选择安静 → reply_status=none
async function processDueReplies() {
  try {
    const { data, error } = await supabase
      .from('moments')
      .select('*')
      .eq('author', 'user')
      .eq('reply_status', 'pending')
      .lte('reply_due_at', new Date().toISOString())
      .order('reply_due_at', { ascending: true })
      .limit(2);
    if (error) { console.warn('⚠️ [朋友圈] 查待回复失败:', error.message); return; }
    if (!data?.length) return;
    for (const m of data) {
      try {
        const r = await generateMomentReply(m);
        if (!r.reply_content && !r.liked) {
          await supabase.from('moments').update({ reply_status: 'none' }).eq('id', m.id);
          continue;   // 安静看着，不评论
        }
        await supabase.from('moments').update({
          liked: r.liked,
          reply_content: r.reply_content || null,
          replied_at: new Date().toISOString(),
          reply_status: 'done',
        }).eq('id', m.id);
        console.log(`💬 [朋友圈] 沈晏回复了「${String(m.content).slice(0, 20)}…」`);
      } catch (e) {
        console.warn(`⚠️ [朋友圈] 回复生成失败 id=${m.id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('⚠️ [朋友圈] processDueReplies 异常:', e.message);
  }
}

// 到期回复引擎（评论）：程芥评论沈晏的动态 → 3~8 分钟后她回
async function processDueCommentReplies() {
  try {
    const { data: comments, error } = await supabase
      .from('moment_comments')
      .select('*')
      .eq('reply_status', 'pending')
      .not('reply_due_at', 'is', null)
      .lte('reply_due_at', new Date().toISOString())
      .order('reply_due_at', { ascending: true })
      .limit(3);
    if (error) { console.warn('⚠️ [朋友圈] 查待回评论失败:', error.message); return; }
    if (!comments?.length) return;
    for (const c of comments) {
      try {
        const { data: moment } = await supabase.from('moments').select('*').eq('id', c.moment_id).maybeSingle();
        if (!moment) { await supabase.from('moment_comments').update({ reply_status: 'none' }).eq('id', c.id); continue; }
        const reply = await generateCommentReply(moment, c);
        if (!reply) { await supabase.from('moment_comments').update({ reply_status: 'none' }).eq('id', c.id); continue; }
        await supabase.from('moment_comments').update({ reply_content: reply, reply_status: 'done', replied_at: new Date().toISOString() }).eq('id', c.id);
      } catch (e) {
        console.warn(`⚠️ [朋友圈] 回评论失败 id=${c.id}:`, e.message);
      }
    }
  } catch (e) {
    console.warn('⚠️ [朋友圈] processDueCommentReplies 异常:', e.message);
  }
}

// 图只看一次：视觉描述写 image_description（后台跑，不阻塞发布；回复引擎 8~20 分钟后跑时已就绪）
// 图只看一次：描述模型只喂文字描述给回复引擎，不重看原图。视觉失败 → 返回 null，回复引擎仍可用。
async function describeMomentImages(content, imageUrls) {
  const parts = [
    { type: 'text', text: `程芥发了一条朋友圈：「${content}」。她附了下面这张图。像沈晏那样自然描述它——他看到什么、留意什么细节、什么心情。一两句话，60~120 字，直接写描述本身，不要「图中显示」这类前缀。` },
    ...imageUrls.map(url => ({ type: 'image_url', image_url: { url } })),
  ];
  try {
    const desc = await callVisionModel(parts);
    return String(desc).trim().slice(0, 300) || null;
  } catch (e) {
    console.warn('⚠️ [朋友圈] 视觉描述异常（回复引擎仍可用）:', e.message);
    return null;
  }
}

// ===== 相册（keepsakes）：聊天里发的每张图 = 一张 keepsake =====
// 图本身 → moments 桶 keepsakes/ 前缀（复用已有桶，避免新建桶的 provisioning）。
// 表只存索引 + 记忆：描述（视觉记忆）+ 他当时说的话 + 他当时的思考（后两个是聊天真货，绝不编造）。
async function storeChatKeepsake(sessionId, imageDataUrl) {
  const raw = String(imageDataUrl || '');
  const match = raw.match(/^data:([^;]+);base64,(.*)$/s);
  if (!match) return null; // 不是 data URL，先不收
  const mime = match[1] || 'image/jpeg';
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) return null;
  const ext = (mime.split('/')[1] || 'jpg').replace(/[^\w]/g, '') || 'jpg';
  const filename = `keepsakes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await supabase.storage.from('moments').upload(filename, buf, { contentType: mime, upsert: true });
  if (upErr) throw new Error(upErr.message);
  const { data: pub } = supabase.storage.from('moments').getPublicUrl(filename);
  if (!pub?.publicUrl) throw new Error('无 publicUrl');
  const { data, error } = await supabase.from('keepsakes').insert({
    image_url: pub.publicUrl,
    session_id: sessionId,
  }).select().single();
  if (error) throw new Error(error.message);
  // 异步视觉描述 = 记忆（不阻塞回复；失败不影响相册存在）
  describeKeepsakeImage(pub.publicUrl).then(desc => {
    if (desc) return supabase.from('keepsakes').update({ description: desc }).eq('id', data.id);
  }).catch(e => console.warn('⚠️ [相册] 描述生成失败:', e.message));
  return data;
}

async function describeKeepsakeImage(url) {
  const parts = [
    { type: 'text', text: '这是程芥刚发在聊天里的一张照片。像沈晏那样记住它——他看到什么、留意什么细节、什么心情。一两句话，30~80 字，直接写记忆本身，不要「图中显示」这类前缀。' },
    { type: 'image_url', image_url: { url } },
  ];
  const desc = await callVisionModel(parts);
  return String(desc).trim().slice(0, 300) || null;
}

// 沈晏自己发一条动态（keepalive 自动钩子的接缝；V1 用 POST /api/angel/moments 手动触发）
async function postAngelMoment(content, contextNote) {
  const delayMs = Math.round(randomDelay(8, 20) * 60 * 1000);
  const { data, error } = await supabase
    .from('moments')
    .insert({
      author: 'angel',
      content: String(content || '').trim().slice(0, 500),
      context_note: String(contextNote || '').trim().slice(0, 200) || null,
      reply_due_at: new Date(Date.now() + delayMs).toISOString(),
      reply_status: 'none',   // 她自己发的，不需要自己回
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// moments 存储桶：公开桶（图片 URL 直接可看），启动时确保存在
async function ensureMomentsBucket() {
  try {
    const { error } = await supabase.storage.createBucket('moments', { public: true });
    if (error && !/already exists/i.test(String(error.message || ''))) {
      console.warn('⚠️ moments 桶创建失败（可能已存在）:', error.message);
    } else {
      console.log('📦 朋友圈 moments 桶就绪');
    }
  } catch (e) {
    console.warn('⚠️ moments 桶 ensure 异常（上传时会再暴露）:', e.message);
  }
}

// GET /api/moments — 时间线（新在上）。先跑到期回复引擎，保证打开时沈晏的回复/评论是新的
momentsRouter.get('/', async (req, res) => {
  try {
    await processDueReplies();
    await processDueCommentReplies();
    const { data, error } = await supabase
      .from('moments')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return res.status(500).json({ error: error.message });
    const moments = data || [];
    let comments = [];
    if (moments.length) {
      const { data: c, error: cErr } = await supabase
        .from('moment_comments')
        .select('*')
        .in('moment_id', moments.map(m => m.id))
        .order('created_at', { ascending: true });
      if (!cErr) comments = c || [];
    }
    const byMoment = {};
    for (const cm of comments) (byMoment[cm.moment_id] = byMoment[cm.moment_id] || []).push(cm);
    res.json({ moments: moments.map(m => ({ ...m, comments: byMoment[m.id] || [] })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/moments — 程芥发动态（可带图，最多 4 张）。图 base64 → moments 桶 → public URL
momentsRouter.post('/', async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim().slice(0, 1000);
    const rawImages = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];
    if (!content && !rawImages.length) return res.status(400).json({ error: '写点什么，或附张图' });

    const imageUrls = [];
    for (let i = 0; i < rawImages.length; i++) {
      const img = rawImages[i];
      const buf = Buffer.from(String(img.data || ''), 'base64');
      if (!buf.length) continue;
      const mime = String(img.media_type || 'image/jpeg').split('/')[1] || 'jpg';
      const filename = `moments/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${mime.replace(/[^\w]/g, '') || 'jpg'}`;
      const { error: upErr } = await supabase.storage.from('moments').upload(filename, buf, {
        contentType: String(img.media_type || 'image/jpeg'),
        upsert: true,
      });
      if (upErr) { console.warn('⚠️ [朋友圈] 图片上传失败:', upErr.message); continue; }
      const { data: pub } = supabase.storage.from('moments').getPublicUrl(filename);
      if (pub?.publicUrl) imageUrls.push(pub.publicUrl);
    }

    const delayMs = Math.round(randomDelay(8, 20) * 60 * 1000);
    const { data, error } = await supabase
      .from('moments')
      .insert({ content, images: imageUrls, reply_due_at: new Date(Date.now() + delayMs).toISOString(), author: 'user' })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    if (imageUrls.length) {
      describeMomentImages(content, imageUrls)
        .then(desc => desc && supabase.from('moments').update({ image_description: desc }).eq('id', data.id))
        .catch(e => console.warn('⚠️ [朋友圈] 图片描述失败（回复引擎将无图上下文）:', e.message));
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/keepsakes — 相册时间线（新在上）。描述/他的话/他的想都可能为 null（异步生成中/没说完）
// 表还没建（迁移没跑）时返回空列表，别 500。
keepsakesRouter.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('keepsakes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) {
      if (/does not exist|relation|42P01/i.test(error.message || '')) return res.json({ items: [] });
      return res.status(500).json({ error: error.message });
    }
    res.json({ items: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/month-summary — 某月真实计数（聊天/照片/他醒过/记忆新增）。
// 每项都来自真实表，没有一项是编的。沈晏的一句话回顾由前端基于这些数组织。
monthSummaryRouter.get('/', async (req, res) => {
  try {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10); // 1-12
    if (Number.isNaN(month) || month < 1 || month > 12) return res.status(400).json({ error: 'month required (1-12)' });
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    const s = start.toISOString();
    const e = end.toISOString();
    // allSettled：某张表没建（迁移没跑）只让那一项记 0，别拖垮整月总结
    const [chatR, photoR, wakeR, memR] = await Promise.allSettled([
      supabase.from('messages').select('id', { count: 'exact', head: true }).eq('role', 'user').gte('created_at', s).lt('created_at', e),
      supabase.from('keepsakes').select('id', { count: 'exact', head: true }).gte('created_at', s).lt('created_at', e),
      supabase.from('keepalive_log').select('id', { count: 'exact', head: true }).gte('run_at', s).lt('run_at', e),
      supabase.from('memory_topics').select('id', { count: 'exact', head: true }).gte('updated_at', s).lt('updated_at', e),
    ]);
    const countOf = (r) => (r.status === 'fulfilled' ? r.value.count : 0);
    res.json({
      chatCount: countOf(chatR),
      photoCount: countOf(photoR),
      wakeCount: countOf(wakeR),
      memCount: countOf(memR),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/moments/:id/like — 程芥赞/取消赞（body: { liked: bool }）
momentsRouter.post('/:id/like', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('moments')
      .update({ user_liked: req.body?.liked === true })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/moments/:id/comments — 程芥评论沈晏的动态 → 3~8 分钟后她回
momentsRouter.post('/:id/comments', async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim().slice(0, 300);
    if (!content) return res.status(400).json({ error: '评论不能为空' });
    const delayMs = Math.round(randomDelay(3, 8) * 60 * 1000);
    const { data, error } = await supabase
      .from('moment_comments')
      .insert({ moment_id: req.params.id, author: 'user', content, reply_due_at: new Date(Date.now() + delayMs).toISOString(), reply_status: 'pending' })
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/moments/:id/seen — 程芥看过这条的回复了（清未读红点）
momentsRouter.post('/:id/seen', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('moments')
      .update({ reply_seen_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/angel/moments — 手动触发沈晏发一条（keepalive 自动钩子后置，先留这个缝）
angelRouter.post('/moments', async (req, res) => {
  try {
    const data = await postAngelMoment(req.body?.content, req.body?.context_note);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  return {
    momentsRouter, keepsakesRouter, monthSummaryRouter, angelRouter,
    // 下面这些是「被外部调用的能力」，不是路由 —— 见文件顶部注释②
    processDueReplies, processDueCommentReplies, ensureMomentsBucket,
    storeChatKeepsake, postAngelMoment,
  };
};
