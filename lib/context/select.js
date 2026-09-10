/* ============================================================
   Context / 检索层 · 纯选择器（分区第 3 步 · 2026-09-10）

   为什么单独一个文件：这些函数是「找什么」的全部判据 —— 主题命中、n-gram、
   世界书独立词判定、mode×kind 矩阵。它们零 IO、零模块状态，却散在 server.js
   里跟热路径混在一起，改一条规则要在 480 行的 buildModelContext 附近翻。

   逐字搬运自 server.js（行 1992-2035 / 2249-2251 / 2350-2361 / 2375-2421），
   注释一并带走，**零逻辑改动**。
   行为基线（搬迁前 HEAD 的真实输出，逐字节比对）：
     test/fixtures/context-select.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs --module lib/context/select.js --compare test/fixtures/context-select.baseline.json

   ⚠️ 已知隐患（**没改**，重构只许等价）：isExactWord(msg, '') 会死循环 ——
   ''.indexOf('', from) 把 from 夹到 str.length，from=idx+1 永远推不过串长。
   当前不可达（唯一调用点 retrieveWorld 有 `if (!kl ...) continue`）。详见交接文档。
   ============================================================ */

const STOPWORD2 = new Set([
  '我们','你们','他们','今天','明天','昨天','现在','时候','觉得','感觉','知道','说话','聊天','聊天',
  '然后','但是','还是','就是','真的','什么','怎么','这个','那个','一下','有点','没有','如果','因为',
  '所以','自己','一起','家里','回来','走了','好吧','对了','等等','事情','东西','问题','朋友','早上',
  '晚上','中午','下午','上次','以前','后来','一直','还是','但是','特别','越来越','上次',
]);

function isStopword(s) { return s.length === 2 && STOPWORD2.has(s); }

function topicHits(userMessage, topic) {
  if (!userMessage || !topic) return false;
  const msg = String(userMessage);
  const t = String(topic).trim();
  if (!t) return false;
  if (t.length <= 4) {
    // 短短语整词命中优先；整词不中时取 2 字片段再碰——
    // 中文口语常把四字短语拆开说（"熬夜习惯"→"上次说我熬夜，现在习惯了"），整词会漏。
    // 但 2 字片段若是口水词（我们/今天…）不算命中。
    if (msg.includes(t)) return !isStopword(t);
    if (t.length === 4) return (msg.includes(t.slice(0, 2)) && !isStopword(t.slice(0, 2))) || (msg.includes(t.slice(2, 4)) && !isStopword(t.slice(2, 4)));
    if (t.length === 3) return (msg.includes(t.slice(0, 2)) && !isStopword(t.slice(0, 2))) || (msg.includes(t.slice(1, 3)) && !isStopword(t.slice(1, 3)));
    return false;
  }
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= t.length; i++) {
      const frag = t.slice(i, i + len);
      if (msg.includes(frag)) {
        // 4/3 字片段足够具体，直接算命中；2 字片段必须是实词
        if (len >= 3 || !isStopword(frag)) return true;
      }
    }
  }
  return false;
}

/* 提取文本的 2~4 字 n-gram（去掉标点），用于牵挂闸的「共享词」判断 */
function extractNgrams(text) {
  const s = String(text || '').replace(/[^一-龥a-zA-Z0-9]/g, '');
  const set = new Set();
  for (let len = 2; len <= 4; len++) {
    for (let i = 0; i + len <= s.length; i++) set.add(s.slice(i, i + len));
  }
  return set;
}
const RELATION_TYPES = ['触发', '导致', '贡献', '改善', '解释', '更新', '同类'];
const RELATION_HOP1_WEIGHT = 1.0; // 直接关联
const RELATION_HOP2_WEIGHT = 0.7; // 间接（邻居的邻居），V1 常数，后续可调
function isExactWord(msg, kw) {
  let from = 0;
  while (true) {
    const idx = msg.indexOf(kw, from);
    if (idx === -1) return false;
    const before = idx > 0 ? msg[idx - 1] : '';
    const after = idx + kw.length < msg.length ? msg[idx + kw.length] : '';
    const wordChar = (ch) => /[a-z0-9一-鿿]/.test(ch);
    if (!wordChar(before) && !wordChar(after)) return true;
    from = idx + 1;
  }
}
function selectWorldHits(hits, curMode) {
  const mode = ['亲密', '深入', '正事', '闲聊'].includes(curMode) ? curMode : '深入';
  const exactFirst = (a, b) => (b._hit === 'exact' ? 1 : 0) - (a._hit === 'exact' ? 1 : 0);

  // 保留席：remind + exact。亲密 = 刹车①；正事/闲聊 = 破例（mode 滞后一窗时真亲密漏注更糟）。
  // 深入不设席——矩阵本就允许 remind 进普通块（exact 优先排在块内），无需另开通道。
  const seat = mode !== '深入'
    ? (hits.find((h) => h.kind === 'remind' && h._hit === 'exact') || null)
    : null;

  const allow = (k) => {
    if (mode === '亲密') return k === 'remind';
    if (mode === '深入') return true; // setting/remind 全注，know 走弱档
    if (mode === '正事') return k === 'setting' || k === 'know';
    return k === 'setting';           // 闲聊
  };
  let picked = hits.filter((h) => allow(h.kind)).sort(exactFirst);

  // 亲密：remind 全归保留席（exact 进席，contains 刹车②不注），普通块空
  if (mode === '亲密') return { seat, block: [] };
  // 正事/闲聊：破例已把 remind+exact 拿走当席，普通块别再重复注 remind（矩阵本就不让进）
  if (mode === '正事' || mode === '闲聊') picked = picked.filter((h) => h.kind !== 'remind');

  // 深入（2026-08-30 程芥裁决「深入该保知识卡」）：exact 关系提醒 > exact 设定 > exact 知识软位。
  //   保 1 席但不是写死第 3 席——有 exact 知识就占第 3，无 exact 知识才补 contains（设定/关系）。
  //   无 exact 命中绝不硬塞（没知识命中就不带知识，宁缺不乱说话）。
  if (mode === '深入') {
    const exactRemind = picked.find((h) => h.kind === 'remind' && h._hit === 'exact');
    const exactSetting = picked.find((h) => h.kind === 'setting' && h._hit === 'exact');
    const exactKnow = picked.find((h) => h.kind === 'know' && h._hit === 'exact');
    const contains = picked.find((h) => h._hit === 'contains');
    const block = [exactRemind, exactSetting, exactKnow].filter(Boolean);
    if (block.length < 3 && contains && !block.includes(contains)) block.push(contains);
    return { seat: null, block: block.slice(0, 3) };
  }

  // 预算：exact ≤3 / contains 只带 1 / 弱档再压（闲聊 setting ≤1）
  const block = [];
  let containsCount = 0;
  for (const h of picked) {
    if (block.length >= 3) break;
    if (h._hit === 'exact') block.push(h);
    else if (containsCount === 0) { containsCount = 1; block.push(h); }
  }
  if (mode === '闲聊') return { seat, block: block.slice(0, 1) };
  return { seat, block };
}

module.exports = {
  topicHits, extractNgrams, isExactWord, selectWorldHits, isStopword,
  RELATION_TYPES, RELATION_HOP1_WEIGHT, RELATION_HOP2_WEIGHT,
};
