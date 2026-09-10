/* 分区第 3 步 · lib/context/select.js 的行为基线 spec
   同一份 spec 跑两个来源，输出必须逐字节一致：
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs --rev HEAD
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-select.cjs --module lib/context/select.js
   向量是照代码里的分支**逐条打**的（不是随手举几个例子）——每个 if/循环出口都要有向量压着，
   否则基线只能证明「常见路径没变」，证明不了「改没改分支」。 */

const A = '熬夜习惯';
const STOPWORDY = '我们';
const D = '我们';

const msgCases = [
  // —— topicHits：≤4 字短主题（整词优先，整词不中拆 2 字片段）——
  ['今天又熬夜了', A],                 // 长主题滑窗命中
  ['我最近熬夜习惯改了点', A],          // 长主题 4 字窗口直接命中
  ['熬夜', '熬夜习惯'],                // ≤4 字：整词不中，拆前 2 字命中
  ['习惯了', '熬夜习惯'],              // 整词不中，拆后 2 字命中
  ['熬夜习惯', '熬夜习惯'],            // 整词命中
  ['习惯', '熬夜习惯'],                // 只命中后 2 字
  ['猫', '猫'],                        // 2 字短主题整词命中
  ['小猫在窗台', '猫'],                // 2 字短主题子串命中（≤4 走 includes）
  ['我们', D],                         // ⚠️ 整词命中但命中词是口水词 → 必须 false
  ['我们今天', D],                     // 同上
  ['搬家', '搬家啦'],                  // 3 字主题拆前 2 字
  ['我家搬家', '搬家啦'],              // 3 字主题拆后 2 字
  ['搬', '搬家啦'],                    // 3 字主题两个片段都不中
  ['完全没有关系', A],                 // 不命中
  ['', A],                             // 空消息
  [null, A],                           // null 消息
  ['今天聊点别的', ''],                // 空 topic
  ['今天聊点别的', '   '],             // 空白 topic（trim 后空）
  ['很长的一个主题词若干个字', '很长的一个主题词若干个字'], // 长主题整词
  ['随', '随便'],                      // 2 字主题，消息里有单字
  // —— 长主题的 2 字片段必须是实词（len>=3 直接算命中，len==2 要过 isStopword）——
  ['觉得', '什么觉得'],                // 2 字片段「觉得」是口水词 → 不命中
  ['知道吗', '知道什么'],              // 2 字片段「知道」口水 → 不命中
  ['下雨了', '下雨的晚上'],            // 片段「下雨」是实词 → 命中
];

const ngramCases = [
  '打雷了',
  '今天 we 一起 123',
  '',
  '   ',
  '一',
  '雷雨',
  null,
  undefined,
  'a1b2',
];

const exactCases = [
  ['小猫在吃猫粮', '猫'],              // 两侧都是汉字 → 不是独立词
  ['我养了一只猫。', '猫'],            // 右侧是标点 → 独立词
  ['猫', '猫'],                        // 整串就是它 → 独立词
  ['猫粮', '猫'],                      // 右侧是汉字 → 不是
  ['the cat sat', 'cat'],              // 英文两侧空格 → 独立词
  ['scatter', 'cat'],                  // 两侧字母 → 不是
  ['雨夜好眠', '雨夜'],                // 中文连写 → 不是独立词（文档里点名的情形）
  ['我说雨夜，好眠', '雨夜'],          // ⚠️ 右侧虽是标点，但左侧贴着「说」→ 仍**不是**独立词
  ['雨夜，好眠', '雨夜'],              // 两侧都不是词字符 → 独立词
  ['猫猫猫', '猫'],                    // 全部不独立（多次出现要能正确继续找）
  ['猫猫猫。', '猫'],                  // 最后一个右侧是标点 → 独立词（循环必须走到）
  ['', '猫'],
  // ⚠️ 故意**不放** ['猫', ''] 这个向量：isExactWord(msg, '') 会死循环（2026-09-10 实测）。
  //    根因 `''.indexOf('', from)` 把 from 夹到 str.length，于是 from=idx+1 永远推不过
  //    串长、永远找不到 -1。当前**不可达**——唯一调用点 retrieveWorld 有 `if (!kl ...) continue`
  //    挡着。已单独记进交接文档，不在这次重构里顺手改（重构只许等价）。
  //    ['猫', ''],
];

const W = (kind, _hit, title) => ({ id: Math.abs(hash(title || kind)) % 900 + 1, title: title || `${kind}-${_hit}`, content: `${kind}内容`, keywords: ['x'], kind, _hit });
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

// 每种矩阵格都要有：亲密/深入/正事/闲聊 × kind(setting/remind/know) × _hit(exact/contains)
const worldCases = [
  // 亲密：只有 remind 允许；remind+exact 进保留席，remind+contains 被刹车②挡掉，普通块空
  [[W('remind', 'exact'), W('remind', 'contains'), W('setting', 'exact')], '亲密'],
  [[W('remind', 'contains'), W('setting', 'exact'), W('know', 'exact')], '亲密'],
  // 深入：无席；exact remind > exact setting > exact know，第 3 席无 exact 知识才补 contains
  [[W('remind', 'exact'), W('setting', 'exact'), W('know', 'exact'), W('know', 'contains')], '深入'],
  [[W('remind', 'contains'), W('setting', 'contains'), W('know', 'contains')], '深入'],   // 无 exact：只带 1 个 contains
  [[W('know', 'exact'), W('know', 'contains')], '深入'],                                   // 有 exact 知识 → 占第 3 席
  [[W('remind', 'exact')], '深入'],                                                        // 只有 exact remind
  [[W('setting', 'exact'), W('setting', 'exact'), W('know', 'exact'), W('remind', 'exact')], '深入'], // 超 3 席截断
  // 正事：setting/know；remind+exact 破例进席，普通块不重复注 remind
  [[W('remind', 'exact'), W('setting', 'exact'), W('know', 'contains'), W('setting', 'contains')], '正事'],
  [[W('remind', 'contains'), W('setting', 'exact')], '正事'],   // 破例只认 exact；contains 的 remind 直接被 allow 挡掉
  // 闲聊：setting 弱档 ≤1
  [[W('setting', 'exact'), W('setting', 'contains'), W('know', 'exact')], '闲聊'],
  [[W('remind', 'exact'), W('setting', 'contains'), W('setting', 'exact')], '闲聊'],
  // mode 兜底：不认识/空/null → 按「深入」
  [[W('remind', 'exact'), W('know', 'exact')], null],
  [[W('remind', 'exact'), W('know', 'exact')], ''],
  [[W('remind', 'exact'), W('know', 'exact')], '不认识的模式'],
  // 空命中
  [[], '深入'],
  [[], null],
  // 预算：exact ≤3 / contains 只带 1
  [[W('setting', 'exact'), W('remind', 'exact'), W('know', 'exact'), W('setting', 'contains'), W('know', 'contains')], '正事'],
];

module.exports = {
  // ⚠️ 区间要停在完整语句的末尾：2036 行起是「注意力组装」那段块注释的开头，
  // 切到 2037 会把 /* 切进来但切不到 */ → vm 报 Invalid or unexpected token。
  ranges: [[1992, 2035], [2249, 2251], [2350, 2361], [2375, 2421]],
  expose: ['topicHits', 'extractNgrams', 'isExactWord', 'selectWorldHits', 'isStopword', 'RELATION_TYPES', 'RELATION_HOP1_WEIGHT', 'RELATION_HOP2_WEIGHT'],
  calls: [
    { name: 'topicHits', run: (M) => msgCases.map(([m, t]) => M.topicHits(m, t)) },
    { name: 'extractNgrams', run: (M) => ngramCases.map((t) => M.extractNgrams(t)) },
    { name: 'isExactWord', run: (M) => exactCases.map(([m, k]) => M.isExactWord(m, k)) },
    { name: 'isStopword', run: (M) => ['我们', '熬夜', '猫', '今天', '随便', '', '觉得很'].map((s) => M.isStopword(s)) },
    { name: 'selectWorldHits', run: (M) => worldCases.map(([hits, mode]) => M.selectWorldHits(hits, mode)) },
    { name: 'consts', run: (M) => ({ RELATION_TYPES: M.RELATION_TYPES, hop1: M.RELATION_HOP1_WEIGHT, hop2: M.RELATION_HOP2_WEIGHT }) },
  ],
};
