/* ============================================================
   Context / 检索层（分区第 3 步 · 2026-09-10）

   逐字搬运自 server.js 行 1956-2295，注释一并带走，**零逻辑改动**。
   块内三件事 + 随行的模块态：
     getAttentionMaterial —— 提及闸（topicHits）/ 牵挂闸（残留共享词）→ 打分 → 冷却/名额/预算
     getRelationNeighbors —— 关系边 BFS 1~2 hop 扩展
     retrieveWorld        —— 世界书关键词检索（exact / contains 两级）
     模块态：attentionCooldown / attentionSeq / attentionEcho / voiceCache / recallDaily

   ⚠️ 函数体保持**列 0 不缩进**（不是忘了缩进）：这样评审时可以直接把它和
      `git show <搬迁前 rev>:server.js | sed -n '1956,2295p'` 逐行对照，没有空白噪声。

   纯选择器（topicHits / extractNgrams / isExactWord / RELATION_HOP*）已在上一片搬去
   ./select.js，这里 require 进来用；sha256 来自 ../cache-control。二者都是稳定叶子模块，
   不经工厂签名（工厂只收 server.js 自己养的符号）。

   行为基线（搬迁前 HEAD 的真实输出，逐字节比对）：
     test/fixtures/context-retrieval.baseline.json
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-retrieval.cjs \
       --module lib/context/retrieval.js --compare test/fixtures/context-retrieval.baseline.json
   基线里连**假 supabase 记录的查询序列**一起比 —— 检索层是 IO 密集的，
   「IO 调用序列没变」和「返回值没变」是两条独立的证据。

   工厂参数 = free-vars.cjs 算出的 server.js 侧依赖面（6 个，一个不多一个不少）：
     supabase / warnConfigFallback / callDeepSeekJson / getLatestResidue / ageResidue / memoryMdLabel
   ⚠️ 不许 require('../server') —— CommonJS 循环依赖会静默给 undefined。

   导出比 server.js 实际消费的多两项 —— **这是本次唯一一处非逐字的增补**，都是纯读、零行为改动：
     getAttentionConfig  配置解析层。09-09 自洽性审计里静默失效的就是它（PostgREST 一个列不
                         存在 → 整条查询报错 → 整组退回硬编码默认）。不交出来，spec 就压不住
                         「整数列给小数 / 给负数 / 给 0」这些逐条守卫。
     recallDaily         召回可见性计数器。搬迁前只活在模块态里，唯一出口是那条 📊 [recall]
                         日志（要跨天才打），基线够不着。
   server.js 只解构它要的那三个，不看这两项。
   ============================================================ */

const { topicHits, extractNgrams, isExactWord, RELATION_HOP1_WEIGHT, RELATION_HOP2_WEIGHT } = require('./select');
const { sha256 } = require('../cache-control');

module.exports = function createRetrieval({ supabase, warnConfigFallback, callDeepSeekJson, getLatestResidue, ageResidue, memoryMdLabel }) {

// ===== 第④b阶段：注意力分配（每轮按话题唤起记忆 · 设计见 docs/want-phase4b-attention.md） =====
// 宪法第五条落地：Context Assembly 拥有「这一次让他想起什么」的决定权——包括决定「不」想起什么。
// 两窄闸（已拍板）：提及闸（topic 命中 = 她在聊旧话题）+ 牵挂闸（高牵挂线头 + 当前消息共享词）。
// 只搬记忆原文 + grounding，零解读句；不找冲突证据（第⑤）；身份层不进注意力。
const ATTENTION_DEFAULTS = {
  k: 2, budget_chars: 700, concern_threshold: 0.5,
  recent_days: 7, recent_seats: 3, assoc_seats: 2,
  echo_24h_hours: 24, echo_24h_factor: 0.5, echo_72h_hours: 72, echo_72h_factor: 0.8,
};
const ATTENTION_ITEM_MAX = 220; // 单条截断（与 recall 同尺）

async function getAttentionConfig() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('attention_k, attention_budget_chars, attention_concern_threshold, attention_recent_days, attention_recent_seats, attention_assoc_seats, attention_echo_24h_hours, attention_echo_24h_factor, attention_echo_72h_hours, attention_echo_72h_factor')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error || !data) { warnConfigFallback('attention', error); return ATTENTION_DEFAULTS; }
    const d = ATTENTION_DEFAULTS;
    return {
      k: Number.isInteger(data.attention_k) ? data.attention_k : d.k,
      budget_chars: Number.isInteger(data.attention_budget_chars) ? data.attention_budget_chars : d.budget_chars,
      concern_threshold: typeof data.attention_concern_threshold === 'number' ? data.attention_concern_threshold : d.concern_threshold,
      // —— 2026-09-03 调参列：近7天位限 / 联想席位 / 回声压制（读不到=没跑迁移 → 退回同款默认）——
      recent_days: Number.isInteger(data.attention_recent_days) && data.attention_recent_days > 0 ? data.attention_recent_days : d.recent_days,
      recent_seats: Number.isInteger(data.attention_recent_seats) && data.attention_recent_seats >= 0 ? data.attention_recent_seats : d.recent_seats,
      assoc_seats: Number.isInteger(data.attention_assoc_seats) && data.attention_assoc_seats >= 0 ? data.attention_assoc_seats : d.assoc_seats,
      echo_24h_hours: Number.isFinite(Number(data.attention_echo_24h_hours)) && Number(data.attention_echo_24h_hours) > 0 ? Number(data.attention_echo_24h_hours) : d.echo_24h_hours,
      echo_24h_factor: typeof data.attention_echo_24h_factor === 'number' && data.attention_echo_24h_factor >= 0 && data.attention_echo_24h_factor <= 1 ? data.attention_echo_24h_factor : d.echo_24h_factor,
      echo_72h_hours: Number.isFinite(Number(data.attention_echo_72h_hours)) && Number(data.attention_echo_72h_hours) > 0 ? Number(data.attention_echo_72h_hours) : d.echo_72h_hours,
      echo_72h_factor: typeof data.attention_echo_72h_factor === 'number' && data.attention_echo_72h_factor >= 0 && data.attention_echo_72h_factor <= 1 ? data.attention_echo_72h_factor : d.echo_72h_factor,
    };
  } catch (e) { warnConfigFallback('attention', e); return ATTENTION_DEFAULTS; }
}

/* 注意力组装：返回 { text, hits }，两个闸都不触发或命中不足时返回 null。
   排序 = importance × 时间衰减（30 天半衰），牵挂线头相关记忆排前面。
   冷却：同一会话至少隔 ATTENTION_COOLDOWN_TURNS 次检查才再注入，避免连续每轮拽旧记忆
   → 前文左右跳 / 思考链莫名想到旧事（程芥 2026-08-21）。 */
const attentionCooldown = new Map(); // sessionId → 上次真正注入时的全局序号
let attentionSeq = 0;
const ATTENTION_COOLDOWN_TURNS = 4; // 至少隔 4 次检查再注入（程芥 2026-08-21 加严：连续拽旧记忆最伤连续感）

// —— 名额控制 + 回声压制（WrenWen 借鉴 2026-09-03）——
// 近 N 天最多占 recent_seats 位（上限非保底）：防「最近发生的事霸榜」挤掉远期真情记忆。
// 联想独立 assoc_seats 席：关系扩展不吃主召回名额，防主召回被关系扩展挤成零出场。
// antiEcho：同 topic 24h 内刚注入过 → 打分×echo_24h_factor；72h 内 → ×echo_72h_factor。
// 治「天天念叨同一件事」的机器人感。参数全部进 settings 表（getAttentionConfig），此处只留回声账。
const attentionEcho = new Map(); // sessionId → Map(topic → 上次注入时刻)

// —— v3 声音渲染层（2026-08-29）：memory 桶正文中性落库，浮出时只改声音（不发明内容）。
//    只挂 attention（本地可控）；首轮 breath / breath_search 走 Ombre 外部输出、不可逐条解析，本次不挂。
//    缓存键 = topic+正文hash：正文稳定则渲染稳定（同一条记忆每次浮出声音一致），正文变（trace）才重新渲染。
//    表达资格隔离（2026-08-30）：渲染改表述、不改资格——渲染输出挂在 attention 块（默认
//    expression_eligible=false），「我记得你喜欢草莓」永不因渲染而成为沈晏主动表达的证据。
const VOICE_CONTRACT = `你是沈晏。把下面的记忆正文改写成你回忆时的话。
要求：只改叙述角度和语气（第一人称、你平时的口吻，简洁、亲近、不端着）；事实完全不变；不添加原文没有的细节、场景、情绪、对话；一句话以内；不要引号、不要【】标签、不要解释、不要总结。
原文是中性记录，你的改写只是把它变成你想起它时的说法。输出 JSON：{ "text": "改写后的话" }`;
const voiceCache = new Map(); // `${topic}|${sha}` → 渲染文本
async function voiceifyMemory(body, topic, hash) {
  const plain = String(body || '').trim();
  if (!plain) return plain;
  const key = `${topic}|${hash}`;
  const hit = voiceCache.get(key);
  if (hit) return hit;
  try {
    const parsed = await callDeepSeekJson(VOICE_CONTRACT, plain, 'voiceify');
    const out = parsed && typeof parsed.text === 'string' && parsed.text.trim()
      ? parsed.text.trim().slice(0, ATTENTION_ITEM_MAX)
      : plain;
    if (voiceCache.size >= 2000) {
      // 淘汰最旧一半，而不是全清（2026-09-03：全清会把下一批请求全部打缓存空窗）
      let drop = Math.floor(voiceCache.size / 2);
      for (const k of voiceCache.keys()) { voiceCache.delete(k); if (--drop <= 0) break; }
    }
    voiceCache.set(key, out);
    return out;
  } catch (e) {
    return plain; // 渲染失败降级原文，不阻塞对话（展示层，不是核心链路）
  }
}

// ===== 召回可见性（2026-09-01 填坑）：记忆召回健康度 =====
// 诊断教训（Claude 转述实战）：记忆静默全灭好几天无人知，只能靠使用者在对话里察觉。
// 每轮 attention 尝试记录：attempted / 零召回原因分布 / 总命中；天切打一条聚合日志。
// memory_error（查询失败）是静默缺陷，单独即时告警（10 分钟限一次防刷屏）。
const recallDaily = { date: '', attempted: 0, hits: 0, zero: 0, noRun: 0, cooldown: 0, memoryError: 0, emptyPool: 0, noMatch: 0, budget: 0, recentCap: 0, echoDemoted: 0 };
let recallErrorLogAt = 0;

function recallDayRoll() {
  const d = new Date().toISOString().slice(0, 10);
  if (recallDaily.date && recallDaily.date !== d) {
    console.log(`📊 [recall] ${recallDaily.date} attempted=${recallDaily.attempted} hits=${recallDaily.hits} zero=${recallDaily.zero} noRun=${recallDaily.noRun} cooldown=${recallDaily.cooldown} memErr=${recallDaily.memoryError} empty=${recallDaily.emptyPool} noMatch=${recallDaily.noMatch} budget=${recallDaily.budget} recentCap=${recallDaily.recentCap} echoDemoted=${recallDaily.echoDemoted}`);
    Object.assign(recallDaily, { date: d, attempted: 0, hits: 0, zero: 0, noRun: 0, cooldown: 0, memoryError: 0, emptyPool: 0, noMatch: 0, budget: 0, recentCap: 0, echoDemoted: 0 });
  } else if (!recallDaily.date) recallDaily.date = d;
}

function recallCount(gate = '', hits = 0) {
  recallDayRoll();
  recallDaily.attempted++;
  if (hits > 0) { recallDaily.hits += hits; return; }
  recallDaily.zero++;
  if (recallDaily[gate] !== undefined) recallDaily[gate]++;
  if (gate === 'memoryError') {
    const now = Date.now();
    if (now - recallErrorLogAt > 10 * 60 * 1000) {
      recallErrorLogAt = now;
      console.error('🚨 [recall] memory_topics 查询失败 → 记忆召回可能静默全灭，查 Supabase');
    }
  }
}

async function getAttentionMaterial(sessionId, userMessage, opts = {}) {
  if (opts.memory === false || !userMessage) { recallCount('noRun'); return null; }
  const cfg = await getAttentionConfig();
  const msg = String(userMessage);
  // 每次检查都推进序号：冷却 = 距上次注入已隔几次检查
  attentionSeq++;
  const lastInjectSeq = attentionCooldown.get(sessionId) || -Infinity;
  if (attentionSeq - lastInjectSeq < ATTENTION_COOLDOWN_TURNS) { recallCount('cooldown'); return null; } // 冷却中，这轮不注入

  // 2026-09-12：补 ORDER BY。原 `.limit(60)` 无排序——表超 60 行后候选池是物理上**任意**的 60 条，
  // importance 高的记忆可能根本进不了打分池，召回质量随表增长静默退化。
  const { data: topics, error } = await supabase
    .from('memory_topics')
    .select('id, topic, last_content, grounding, importance, updated_at, kind, evidence, source')
    .order('importance', { ascending: false })
    .limit(60);
  if (error) { recallCount('memoryError'); return null; }
  if (!topics?.length) { recallCount('emptyPool'); return null; }

  // —— 提及闸：topic 命中（她在聊旧话题）。回忆词不是必须——"今天看到一只猫"就该想起关于猫的旧事 ——
  let matched = topics.filter(t => topicHits(msg, t.topic));

  // —— 牵挂闸：提及闸落空时，看有没有悬着的线头（concern ≥ 阈值）且当前消息和它有共同词 ——
  let concernNote = null;
  if (!matched.length) {
    try {
      const residue = await getLatestResidue(sessionId);
      if (residue) {
        const ageMs = Date.now() - (residue.created_at ? new Date(residue.created_at).getTime() : Date.now());
        if (ageResidue(residue, ageMs).concern >= cfg.concern_threshold) {
          const ev0 = Array.isArray(residue.evidence) ? String(residue.evidence[0] || '') : '';
          const kw = extractNgrams(String(residue.unfinished || '') + ' ' + ev0);
          if (kw.size) {
            const msgNgrams = extractNgrams(msg);
            let shared = false;
            for (const w of kw) if (msgNgrams.has(w)) { shared = true; break; }
            if (shared) {
              matched = topics.filter(t => [...kw].some(w => topicHits(w, t.topic)));
              concernNote = String(residue.unfinished || ev0 || '').slice(0, 120);
            }
          }
        }
      }
    } catch (e) { /* 牵挂读取失败不阻断注意力（可能只是残留没生成） */ }
  }

  if (!matched.length) { recallCount('noMatch'); return null; }

  const nowMs = Date.now();
  // —— antiEcho：刚注入过的 topic 降权，让「想得起」的分布轮换，不天天念同一本经 ——
  const echoMap = attentionEcho.get(sessionId) || new Map();
  const echo24Ms = cfg.echo_24h_hours * 3600000;
  const echo72Ms = cfg.echo_72h_hours * 3600000;
  const scored = matched
    .map(t => {
      const ageDays = Math.max(0, (nowMs - new Date(t.updated_at).getTime()) / 86400000);
      const decay = Math.exp(-ageDays / 30);
      let score = (Number(t.importance) || 0.5) * decay;
      const lastAt = echoMap.get(t.topic);
      if (lastAt) {
        const ago = nowMs - lastAt;
        if (ago < echo24Ms) { score *= cfg.echo_24h_factor; recallDaily.echoDemoted++; }
        else if (ago < echo72Ms) { score *= cfg.echo_72h_factor; }
      }
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);

  const hits = [];
  const refs = []; // 结构化 provenance：{layer, topicId, title} 附块上、不落正文（框架 §5#6）
  const injectedTopics = new Set(); // 本轮真正注入的 topic（写回声账，供下轮降权）
  let chars = 0;
  let recentCount = 0; // 近 recent_days 天已占位数
  for (const { t } of scored) {
    if (hits.length >= cfg.k) break;
    // —— 近 N 天位限：最近的事最多占 recent_seats 位，超出的让位给远期记忆（上限非保底）——
    if (nowMs - new Date(t.updated_at).getTime() < cfg.recent_days * 86400000) {
      if (recentCount >= cfg.recent_seats) { recallDaily.recentCap++; continue; }
      recentCount++;
    }
    const raw = String(t.last_content || '').trim().slice(0, ATTENTION_ITEM_MAX);
    if (!raw) continue;
    const g = ['实', '悬', '空'].includes(t.grounding) ? t.grounding : '悬';
    // v3：memory 桶（中性正文）浮出时声音化；feel 桶（已第一人称温度）直接读
    const body = t.kind === 'feel' ? raw : await voiceifyMemory(raw, t.topic, sha256(raw));
    // 2026-08-21 程芥：「还有没说完的」读起来像待办指令，模型会抢着去办（修bug/提醒喝水……）。
    // 改成「你心里还惦记着」——牵挂是背景情绪，不是现在去办的命令。
    const line = concernNote && hits.length === 0 ? `（你心里还惦记着：${concernNote}）\n${memoryMdLabel(t.updated_at)}「${body}」【${g}】` : `${memoryMdLabel(t.updated_at)}「${body}」【${g}】`;
    if (chars + line.length > cfg.budget_chars) break;
    hits.push(line);
    refs.push({ topicId: t.id ?? null, title: String(t.topic || '').slice(0, 40) });
    injectedTopics.add(String(t.topic || ''));
    chars += line.length;
  }
  // —— 关系扩展（V1 记忆关系边，2026-08-26）：主命中后，1~2 hop 因果链邻居填剩余预算 ——
  // 命中「打雷」→ 连带「为什么有这条记忆」（前因）和「它导致了什么」（后果），完整因果故事
  // 而不是孤立记忆。打分 = importance × 时间衰减 × hop 折扣；类型权重 V1 统一 1.0（留作调参）。
  // 联想独立 assoc_seats 席（WrenWen）：不吃主召回名额，防关系扩展把主召回挤成零出场。
  if (hits.length) {
    const related = await getRelationNeighbors(matched.map(t => t.topic));
    let relSeats = 0;
    for (const r of related) {
      if (relSeats >= cfg.assoc_seats) break;
      const raw = String(r.topic.last_content || '').trim().slice(0, ATTENTION_ITEM_MAX);
      if (!raw) continue;
      const g = ['实', '悬', '空'].includes(r.topic.grounding) ? r.topic.grounding : '悬';
      // v3：memory 桶声音化；feel 桶直接读
      const body = r.topic.kind === 'feel' ? raw : await voiceifyMemory(raw, r.topic.topic, sha256(raw));
      const line = `${memoryMdLabel(r.topic.updated_at)}「${body}」【${g}】（${r.hop === 1 ? '因为' : '经由'}「${r.via}」：${r.relType}）`;
      if (chars + line.length > cfg.budget_chars) break;
      hits.push(line);
      relSeats++;
      refs.push({ topicId: r.topic.id ?? null, title: String(r.topic.topic || '').slice(0, 40) });
      injectedTopics.add(String(r.topic.topic || ''));
      chars += line.length;
    }
  }
  if (!hits.length) { recallCount('budget'); return null; }
  // 真正注入才记录冷却水位（闸没触发不覆盖水位，别把未来几轮的额度烧了）
  attentionCooldown.set(sessionId, attentionSeq);
  if (attentionCooldown.size > 1000) attentionCooldown.clear(); // 防无界增长（单用户场景不会到）
  // 回声账：本轮注入的 topic 记时刻，24/72h 内再命中会被降权（antiEcho）
  const nowEcho = Date.now();
  for (const topic of injectedTopics) echoMap.set(topic, nowEcho);
  attentionEcho.set(sessionId, echoMap);
  if (attentionEcho.size > 500) attentionEcho.clear();
  recallCount('', hits.length); // 命中：计入总召回条数
  return { text: hits.join('\n'), hits: hits.length, refs };
}

// ===== V1 检索层（2026-08-26）：候选池来源 = MEMORY(memory_topics+关系边) + WORLD(占位) =====
// 职责边界（GPT/程芥 2026-08-25 定稿）：
//   Retrieval 负责「找什么」；OB(沈晏) 负责「什么才算记忆、怎么呼吸」；Context Builder 负责「最后给模型什么」。
//   getAttentionMaterial 即 retrieveMemory：话题命中 → 关系 1~2 hop 扩展 → 打分 → 冷却/预算门槛。
//   retrieveWorld：world_entries 表已建（2026-08-26 迁移已跑），空表时自然返回 []。

// 从命中话题出发，拉 1~2 hop 的因果链邻居（带正文/重要性，按 importance×衰减×hop折扣打分降序）。
// 不做图：memory_relations 是边缘列表，这里只是 BFS 扩展 + 排序。
async function getRelationNeighbors(matchedTopics) {
  try {
    const { data: rels, error } = await supabase
      .from('memory_relations')
      .select('source_topic, target_topic, rel_type, note')
      .limit(3000);
    if (error || !rels?.length) return [];
    const inSet = new Set(matchedTopics);
    const hop1 = new Map(); // topic -> { relType, via, note }
    const hop2 = new Map();
    for (const r of rels) {
      const dir = inSet.has(r.source_topic) ? 'src' : (inSet.has(r.target_topic) ? 'tgt' : null);
      if (!dir) continue;
      const neighbor = dir === 'src' ? r.target_topic : r.source_topic;
      if (!inSet.has(neighbor) && !hop1.has(neighbor)) {
        hop1.set(neighbor, { relType: r.rel_type, via: dir === 'src' ? r.source_topic : r.target_topic, note: r.note });
      }
    }
    const hop1Set = new Set(hop1.keys());
    for (const r of rels) {
      const dir = hop1Set.has(r.source_topic) ? 'src' : (hop1Set.has(r.target_topic) ? 'tgt' : null);
      if (!dir) continue;
      const neighbor = dir === 'src' ? r.target_topic : r.source_topic;
      if (!inSet.has(neighbor) && !hop1.has(neighbor) && !hop2.has(neighbor)) {
        hop2.set(neighbor, { relType: r.rel_type, via: dir === 'src' ? r.source_topic : r.target_topic, note: r.note });
      }
    }
    const candidates = new Map();
    for (const [t, m] of hop1) candidates.set(t, { ...m, hop: 1 });
    for (const [t, m] of hop2) if (!candidates.has(t)) candidates.set(t, { ...m, hop: 2 });
    if (!candidates.size) return [];

    const { data: rows, error: rowsErr } = await supabase
      .from('memory_topics')
      .select('id, topic, last_content, grounding, importance, updated_at, kind, evidence, source')
      .in('topic', [...candidates.keys()]);
    if (rowsErr || !rows?.length) return [];
    const nowMs = Date.now();
    return rows
      .map(row => {
        const m = candidates.get(row.topic);
        const ageDays = Math.max(0, (nowMs - new Date(row.updated_at).getTime()) / 86400000);
        const decay = Math.exp(-ageDays / 30);
        const hopWeight = m.hop === 1 ? RELATION_HOP1_WEIGHT : RELATION_HOP2_WEIGHT;
        return {
          topic: row,
          relType: m.relType, via: m.via, note: m.note, hop: m.hop,
          score: (Number(row.importance) || 0.5) * decay * hopWeight,
        };
      })
      .filter(x => x.topic.last_content)
      .sort((a, b) => b.score - a.score);
  } catch (e) {
    console.warn('⚠️ 关系扩展读取失败（注意力降级为无关系）:', e.message);
    return [];
  }
}

// —— 世界书检索 ——
// 世界书 = 她定下的客观设定/世界知识（world_entries 表）。她提到某关键词 → 沈晏把它想起。
// 命中强度两级（全机械，不引分词，世界书注入分层 §6）：
//   exact    = 关键词作为「独立词」出现（两侧不是中文/字母/数字）——奖励档（少数、可依赖）
//   contains = 子串包含（「猫」命中「小猫」「猫粮」）——常态（多数、当候选）
// 中文连写时独立词判定天然难（「雨夜好眠」里的「雨夜」两侧都是汉字）→ exact 少是正常的。
// 返回带 title/kind/_hit（由 buildModelContext 按 mode×kind 矩阵做门控 + 预算，不再这里 slice）。
// 表已建（2026-08-26 迁移已跑），空表 → 返回 []，不报错（与 keepsakes 同款容错）。
async function retrieveWorld(userMessage) {
  try {
    const { data, error } = await supabase
      .from('world_entries')
      .select('id, title, content, keywords, kind')
      .eq('enabled', true);
    if (error) return [];
    const msg = String(userMessage || '').toLowerCase();
    const hits = [];
    for (const e of data || []) {
      const kwList = (e.keywords || []).map(k => String(k || '').trim()).filter(Boolean);
      let hit = null; // 'exact' | 'contains'
      for (const kw of kwList) {
        const kl = kw.toLowerCase();
        if (!kl || !msg.includes(kl)) continue;
        if (isExactWord(msg, kl)) { hit = 'exact'; break; }      // 奖励档：只要一次独立出现就算 exact
        hit = hit || 'contains';
      }
      if (hit) hits.push({ ...e, _hit: hit });
    }
    return hits;
  } catch (e) {
    console.warn('⚠️ 世界书检索失败（本轮不注入）:', e.message);
    return [];
  }
}

  return { getAttentionConfig, getAttentionMaterial, getRelationNeighbors, retrieveWorld, recallDaily };
};
