/* ============================================================
   分享链接卡片：聊天里贴链接 → 抓 og 元数据渲染卡片，body=true 时连正文一起喂给沈晏

   2026-09-09 从 server.js 原样搬出（分区第 2 步）。逻辑一字未改。

   这块是所有路由域里最干净的：解析逻辑（og / twitter / JSON-LD / 相对 URL /
   小红书 SSR 挖掘）早在分区第 1 步就抽进了 lib/share-parse.js，这里只剩
   「怎么抓」——多 UA 重试、超时、错误如实返回。所以不需要依赖注入，
   直接 require 那个 lib 即可。
   ============================================================ */
const express = require('express');
const { stripHtml, extractMetaHtml, digXhsNote, resolveAbsUrl } = require('../lib/share-parse');

module.exports = function createShareRouter() {
  const router = express.Router();

// ===== 分享链接卡片 =====
// GET /api/share/preview?url=xxx → 抓 og 元数据（标题/图/描述/站点名）+ 可选正文纯文本
// 设计：前端聊天里贴链接 → 渲染卡片；body=true 时同时抓正文给沈晏读。
// 反爬现实（2026-08-16 实测）：bilibili/公众号/普通网页 ✅；知乎 403；小红书 og:image 是占位图。
// 增强（2026-08-16）：多 UA 重试（Googlebot 拿 SEO SSR）、og 多变体 + JSON-LD、
// 相对 URL 转绝对、小红书 SSR 挖掘（__INITIAL_STATE__ 里的 note 对象）。
// 抓不到的诚实返回 error，不硬编。
// （解析函数已在文件顶部从 ../lib/share-parse 引入；这里只剩「怎么抓」。）

  router.get('/preview', async (req, res) => {
  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: '缺少 url 参数' });
    if (!/^https?:\/\//i.test(rawUrl)) return res.status(400).json({ error: 'url 必须是 http(s) 链接' });

    // 多 UA 尝试：普通 Chrome → Googlebot（SEO SSR 全量内容）→ 手机。拿到像样的页面就停。
    const UAS = [
      ['chrome', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'],
      ['seo', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
      ['mobile', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'],
    ];
    let html = '';
    let finalUrl = rawUrl;
    for (const [, ua] of UAS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      try {
        const resp = await fetch(rawUrl, {
          signal: ctrl.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': ua,
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': (() => { try { return new URL(rawUrl).origin + '/'; } catch { return undefined; } })(),
          },
        });
        if (!resp.ok) { clearTimeout(timer); continue; }
        finalUrl = resp.url || rawUrl;
        html = await resp.text();
      } catch { clearTimeout(timer); continue; }
      clearTimeout(timer);
      if (html && html.length >= 2000) break; // 拿到像样的 HTML 就不再试
    }
    if (!html || html.length < 200) return res.status(502).json({ error: '页面内容为空（可能被反爬拦截）' });

    const base = finalUrl;
    const meta = extractMetaHtml(html, base);
    const isXhs = /xiaohongshu\.com|xhslink\.cn/i.test(finalUrl) || /xiaohongshu\.com|xhslink\.cn/i.test(rawUrl);

    // 小红书 SSR 挖掘：og:image 常给占位图，真实封面/标题/描述/作者在 __INITIAL_STATE__
    let xhsNote = null;
    if (isXhs) {
      xhsNote = digXhsNote(html);
      if (xhsNote) {
        if (xhsNote.title && !meta.title) meta.title = xhsNote.title;
        // 小红书 og:description 是平台 slogan（"3 亿人的生活经验"），SSR desc 才是正文首行——直接覆盖
        if (xhsNote.desc) meta.description = xhsNote.desc.slice(0, 400);
        if (xhsNote.cover && (!meta.image || /(placeholder|default|cover\.s|fe-platform|picasso-static)/i.test(meta.image))) {
          meta.image = xhsNote.cover;
        }
        if (xhsNote.author && !meta.author) meta.author = xhsNote.author;
      }
    }

    // 站点名：og → title 尾巴（_ / - / · 分隔）→ 域名
    let siteName = meta.site_name;
    if (!siteName && meta.title) {
      const sepM = meta.title.match(/\s*[_\-·|｜]\s*([^_\-·|｜]+?)\s*$/);
      if (sepM) siteName = sepM[1].trim();
    }
    if (!siteName) { try { siteName = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* 忽略 */ } }
    // 清站点名噪声（17173 那种 "**中国游戏门户站"）
    siteName = String(siteName || '').replace(/[*#*]|[☀-➿]/g, '').trim();
    if (siteName === 'xhslink.cn' || siteName === 'www.xiaohongshu.com') siteName = '小红书';

    const card = {
      url: rawUrl,
      final_url: finalUrl !== rawUrl ? finalUrl : undefined,
      title: meta.title,
      image: meta.image,
      description: meta.description,
      site_name: siteName,
      author: meta.author,
    };

    // body=true：抓正文纯文本（公众号 js_content / 小红书 note.desc / B站 / 通用 <p> 兜底）
    if (req.query.body === 'true' || req.query.body === '1') {
      let body = '';
      const jsContent = html.match(/id="js_content"([\s\S]*?)<script/i);
      if (jsContent) {
        body = stripHtml(jsContent[1]);
      } else if (isXhs && xhsNote && xhsNote.desc) {
        // 小红书笔记正文就是 desc；[话题] 是话题标签壳，去掉壳只留 #标签
        body = xhsNote.desc.replace(/\[话题\]/g, '').trim();
      } else if (/bilibili\.com/i.test(finalUrl) && html.includes('__INITIAL_STATE__')) {
        const braw = extractJsonWindow(html, '__INITIAL_STATE__');
        if (braw) {
          try {
            const st = JSON.parse(braw);
            body = st.videoData?.desc || '';
          } catch { /* 忽略 */ }
        }
      } else {
        const ps = [];
        const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
        let m;
        while ((m = re.exec(html)) && ps.length < 40) ps.push(m[1]);
        body = stripHtml(ps.join(' '));
      }
      card.body = body.slice(0, 4000) || null;
      if (!card.body) card.body_error = '正文抓不到（该平台反爬或需登录）';
    }

    res.json(card);
  } catch (err) {
    const msg = err.name === 'AbortError' ? '抓取超时' : (err.message || '抓取失败');
    res.status(502).json({ error: msg });
  }
});

// POST /api/sessions

  return router;
};
