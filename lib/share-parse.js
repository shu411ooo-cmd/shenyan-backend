/* ============================================================
   分享卡片的 HTML / JSON 解析 —— 纯函数，无网络无 IO

   从 server.js 原样搬出（2026-09-08 分区第 1 步），注释一并带走。
   抓取本身（多 UA 重试、超时）仍在 server.js 的 /api/share/preview 里；
   这里只负责「拿到 HTML 之后怎么把有用的东西挖出来」，所以可以脱网单测。

   反爬现实是会变的，这组函数是最经常要改的地方之一 —— 单独成文件，
   改的时候不用在 9000 行里找。
   ============================================================ */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\s+(class|style|id|data-[a-z-]+)="[^"]*"/gi, ' ')  // 剥内联属性残渣
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 相对引用 → 绝对 URL（base 用 finalUrl，redirect 后真实地址）
function resolveAbsUrl(base, ref) {
  if (!ref) return null;
  try { return new URL(ref, base).href; } catch { return null; }
}

// 元数据提取：og 多变体 + twitter + <link image_src> + JSON-LD 兜底
// 返回 { title, image, description, site_name }（缺失为 null）
function extractMetaHtml(html, baseUrl) {
  const get = (prop) => {
    const m = html.match(new RegExp(`(?:property|name)="(?:og:)?${prop}"\\s+content="([^"]*)"`, 'i'));
    return m ? m[1].trim() : null;
  };
  const getTwitter = (prop) => {
    const m = html.match(new RegExp(`name="twitter:${prop}"\\s+content="([^"]*)"`, 'i'));
    return m ? m[1].trim() : null;
  };
  let title = get('title') || getTwitter('title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || null;
  let description = get('description') || getTwitter('description') || get('desc') || null;
  const site_name = get('site_name') || null;
  // 作者：og:author / article:author / name=author（不强制 og: 前缀）
  let author = get('author')
    || ((html.match(/(?:property|name)="(?:article:)?author"\s+content="([^"]*)"/i) || [])[1]?.trim() || null);

  // 图：og:image → twitter:image → link[rel=image_src]
  let image = get('image') || getTwitter('image') || null;
  if (!image) {
    const im = html.match(/<link[^>]+rel="image_src"[^>]+href="([^"]+)"/i)
      || html.match(/<link[^>]+href="([^"]+)"[^>]+rel="image_src"/i);
    if (im) image = im[1];
  }
  if (image) image = resolveAbsUrl(baseUrl, image);

  // JSON-LD 兜底：只在主 meta 缺字段时补（防广告位覆盖）
  if (!title || !description || !image) {
    const ldM = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldM) {
      try {
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          if (!title && (node.headline || node.name)) title = String(node.headline || node.name);
          if (!description && node.description) description = String(node.description);
          if (!image && (node.image || node.thumbnailUrl)) {
            const im = Array.isArray(node.image) ? node.image[0] : (node.image || node.thumbnailUrl);
            image = typeof im === 'string' ? resolveAbsUrl(baseUrl, im) : resolveAbsUrl(baseUrl, im?.url || im?.contentUrl);
          }
          for (const k in node) walk(node[k]);
        };
        walk(JSON.parse(ldM[1]));
      } catch { /* JSON-LD 解析失败就忽略，不影响主链路 */ }
    }
  }
  if (description && description.length > 400) description = description.slice(0, 400) + '…';
  return { title, image, description, site_name, author };
}

// 从 HTML 里提取标记后的 JSON 对象窗口（括号配平，防嵌套 JSON 截断）
function extractJsonWindow(html, marker, startPos = 0) {
  const i = html.indexOf(marker, startPos);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
  }
  return null;
}

// 宽容解析：小红书 SSR 状态里有 JS 字面量（undefined/NaN/Infinity），转合法 JSON
function lenientJsonParse(raw) {
  const cleaned = raw
    .replace(/:\s*undefined\b/g, ': null')
    .replace(/:\s*NaN\b/g, ': null')
    .replace(/:\s*Infinity\b/g, ': null');
  return JSON.parse(cleaned);
}

// 小红书笔记 SSR 挖掘：window.__INITIAL_STATE__ 里的 note 对象
// 小红书对 SEO bot SSR 完整内容（og:image 常给平台占位图，真实封面在 SSR 的 noteDetailMap 里）
// 返回 { title, desc, cover, author } 或 null
function digXhsNote(html) {
  // HTML 里可能出现多个 __INITIAL_STATE__，逐个试，找到含 noteDetailMap 的那个
  let idx = 0;
  while (true) {
    const pos = html.indexOf('__INITIAL_STATE__', idx);
    if (pos < 0) break;
    const raw = extractJsonWindow(html, '__INITIAL_STATE__', pos);
    idx = pos + 1;
    if (!raw || raw.length < 500) continue;
    let state;
    try { state = lenientJsonParse(raw); } catch { continue; }
    const note = findXhsNote(state);
    if (note) return note;
  }
  return null;
}

// 在 state 树里找小红书 note 对象（noteDetailMap 容器里的 note）
function findXhsNote(state) {
  if (!state || typeof state !== 'object') return null;
  // 直接命中 noteDetailMap 容器
  const nm = state.note && state.note.noteDetailMap;
  if (nm) {
    for (const k in nm) {
      const n = nm[k] && nm[k].note;
      if (n && (n.desc || n.imageList || n.title)) {
        const coverRaw = Array.isArray(n.imageList) ? n.imageList[0] : n.cover;
        const cover = coverRaw
          ? resolveAbsUrl('https://www.xiaohongshu.com', typeof coverRaw === 'string' ? coverRaw : (coverRaw.urlDefault || coverRaw.urlPre || coverRaw.url))
          : null;
        const desc = String(n.desc || '');
        return {
          title: n.title || desc.split('\n')[0].slice(0, 80) || null,
          desc: desc.slice(0, 4000) || null,
          // 封面转 https（SSR 里是 http://，浏览器 mixed-content 会拦）
          cover: cover ? cover.replace(/^http:\/\//i, 'https://') : null,
          author: (n.user && (n.user.nickname || n.user.name)) || (nm[k].user && nm[k].user.nickname) || null,
        };
      }
    }
  }
  // 兜底：深度优先找 (desc/title + imageList/cover) 特征
  const find = (node, depth = 0) => {
    if (depth > 5 || !node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const it of node) { const r = find(it, depth + 1); if (r) return r; }
      return null;
    }
    if ((node.desc || node.title) && (node.imageList || node.cover)) return node;
    for (const k in node) { const r = find(node[k], depth + 1); if (r) return r; }
    return null;
  };
  const note = find(state);
  if (!note) return null;
  const coverRaw = Array.isArray(note.imageList) ? note.imageList[0] : note.cover;
  const cover = coverRaw ? resolveAbsUrl('https://www.xiaohongshu.com', typeof coverRaw === 'string' ? coverRaw : (coverRaw.urlDefault || coverRaw.urlPre || coverRaw.url)) : null;
  const desc = String(note.desc || '');
  return {
    title: note.title || desc.split('\n')[0].slice(0, 80) || null,
    desc: desc.slice(0, 4000) || null,
    cover: cover ? cover.replace(/^http:\/\//i, 'https://') : null,
    author: (note.user && (note.user.nickname || note.user.name)) || null,
  };
}

module.exports = {
  stripHtml,
  resolveAbsUrl,
  extractMetaHtml,
  extractJsonWindow,
  lenientJsonParse,
  digXhsNote,
  findXhsNote,
};
