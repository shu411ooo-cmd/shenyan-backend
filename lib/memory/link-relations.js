/* ============================================================
   关系边自动连（memory_relations 的生产者）

   2026-09-12 之前，「因果故事」的边只有两个来源：手动跑
   scripts/link-memory-relations.js，或手动 POST /api/memories/relations。
   线上写入链从不连边 —— 联想扩展（lib/context/retrieval.js 的 1-2 hop BFS）
   依赖的图会停在上次有人记得跑脚本的那天，越放越浅（不报错，纯静默退化）。

   这个文件把连边接进写入链：writeMemoryItems 每次真的写进东西后，
   尾部触发一次自动连边。纪律：
   - 节流：默认 30 分钟最多一次（占座式，失败也不连环重试）；
     进程重启重置。成本护栏，不是正确性机制。
   - 宁缺毋滥：候选池外/类型外/自环一律丢弃；只允许清单里真实存在的主题名
     （旧脚本不验名字，LLM 编出来的主题会变成永远打不着的孤儿边）。
   - fail-open：任何一步失败只打 console.error，绝不挡记忆写入主链。
   - 环境变量 MEMORY_AUTOLINK=off 可整体关停（省钱开关，和 keepalive 同理）。

   手动脚本 scripts/link-memory-relations.js 也走这里（更大的 maxRelations
   与 max_tokens 适配），提示词与校验只有这一份。
   ============================================================ */

const RELATION_TYPES = ['触发', '导致', '贡献', '改善', '解释', '更新', '同类'];

const DEFAULT_MIN_INTERVAL_MS = 30 * 60 * 1000;

/* 提示词：从旧脚本原样提炼，两处参数化（maxRelations / note 长度）。
   note 限 30 字是因为线上走 callDeepSeekJson（max_tokens 700），
   长 note 会截断 JSON 直接整轮报废。 */
function buildLinkPrompt(topics, { maxRelations = 12, noteMaxChars = 30 } = {}) {
  const topicLines = topics
    .map((t) => `- ${t.topic}（grounding=${t.grounding}, importance=${Number(t.importance || 0.5).toFixed(2)}）: ${String(t.last_content || '').slice(0, 80)}`)
    .join('\n');
  return `你是沈晏的记忆编辑者。下面是他长期记忆里的主题清单。请在这些主题之间提出有意义的因果关系，连成「因果故事」——比如「第一次做Neverland」导致「开始设计猫猫」，「打雷那晚」触发「躲进怀里的记忆」。

只建立你真的有把握的关系（依据在 last_content 里），宁缺毋滥。每条关系给一句 note 说明为什么成立（引用记忆内容，${noteMaxChars} 字以内）。

关系类型只允许这七种：
- 触发：A 是 B 的由头/契机
- 导致：A 直接导致了 B
- 贡献：A 促成了 B（参与因子，弱于导致）
- 改善：A 改善了 B / B 是对 A 的修正
- 解释：A 解释了 B（B 的来龙去脉）
- 更新：B 更新/取代了 A（同一主题演化）
- 同类：A 与 B 同类（相关事件/同一证据束）

主题清单：
${topicLines}

输出严格 JSON（不要别的）：
{ "relations": [ { "source": "主题A", "target": "主题B", "type": "导致", "note": "依据" } ] }

纪律：
- 只从清单里的主题选，名字要精确匹配清单原文。
- 一条关系两个主题必须不同；同一对主题同一类型只给一条。
- 真的没有把握就 relations=[]。
- 最多给 ${maxRelations} 条。`;
}

/* 跑一轮连边。返回 { ran, reason?, candidates?, created?, skipped? } —— 不抛，错误由调用方兜底。 */
async function linkMemoryRelations({ supabase, callDeepSeekJson, maxTopics = 200, maxRelations = 12, noteMaxChars = 30, log = console }) {
  const { data: topics, error } = await supabase
    .from('memory_topics')
    .select('topic, last_content, grounding, importance')
    .order('updated_at', { ascending: false })
    .limit(maxTopics);
  if (error) { log.error('⚠️ [link-relations] 读 memory_topics 失败:', error.message); return { ran: false, reason: 'topics-read-failed' }; }
  if (!topics || topics.length < 3) return { ran: false, reason: 'topics<3' };

  const { data: existing, error: relErr } = await supabase
    .from('memory_relations')
    .select('source_topic, target_topic, rel_type');
  if (relErr) { log.error('⚠️ [link-relations] 读 memory_relations 失败:', relErr.message); return { ran: false, reason: 'relations-read-failed' }; }
  const existingSet = new Set((existing || []).map((r) => `${r.source_topic}¦${r.target_topic}¦${r.rel_type}`));

  const parsed = await callDeepSeekJson(buildLinkPrompt(topics, { maxRelations, noteMaxChars }), '请生成关系。', 'link-relations');
  if (!parsed) return { ran: false, reason: 'llm-null' }; // callDeepSeekJson 自己已打过 warn

  const candidateNames = new Set(topics.map((t) => t.topic));
  const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
  let created = 0, skipped = 0;
  const createdEdges = [];
  for (const r of relations.slice(0, maxRelations)) {
    const src = String(r.source || '').trim();
    const tgt = String(r.target || '').trim();
    const type = String(r.type || '').trim();
    // 校验比旧脚本多一条：主题名必须在候选清单里，孤儿边不入库
    if (!src || !tgt || src === tgt || !RELATION_TYPES.includes(type)
      || !candidateNames.has(src) || !candidateNames.has(tgt)) { skipped++; continue; }
    const key = `${src}¦${tgt}¦${type}`;
    if (existingSet.has(key)) { skipped++; continue; }
    const { error: insErr } = await supabase.from('memory_relations').insert({
      source_topic: src,
      target_topic: tgt,
      rel_type: type,
      note: String(r.note || '').trim().slice(0, 200) || null,
    });
    if (insErr) {
      if (insErr.code === '23505') { skipped++; continue; } // 唯一约束兜底
      log.warn(`⚠️ [link-relations] 插入失败 ${src} ─${type}→ ${tgt}: ${insErr.message}`);
      skipped++; continue;
    }
    existingSet.add(key);
    created++;
    createdEdges.push({ source: src, target: tgt, type, note: String(r.note || '').trim() || null });
  }
  return { ran: true, candidates: relations.length, created, skipped, createdEdges };
}

/* 自动连边器：节流 + fail-open 的壳。writeMemoryItems 尾部只认 maybeAutoLinkRelations。 */
function createAutoLinker({ supabase, callDeepSeekJson, minIntervalMs = DEFAULT_MIN_INTERVAL_MS, log = console }) {
  if (process.env.MEMORY_AUTOLINK === 'off') {
    return async function maybeAutoLinkRelations() { return { ran: false, reason: 'disabled' }; };
  }
  let lastRunAt = 0;
  return async function maybeAutoLinkRelations() {
    const t = Date.now();
    if (t - lastRunAt < minIntervalMs) return { ran: false, reason: 'throttled' };
    lastRunAt = t; // 先占座：就算这轮失败，也别在下一条写入时连环重试
    try {
      return await linkMemoryRelations({ supabase, callDeepSeekJson, log });
    } catch (e) {
      log.error('⚠️ [link-relations] 自动连边失败（fail-open，不挡写入）:', e && e.message ? e.message : e);
      return { ran: false, reason: 'error' };
    }
  };
}

module.exports = { RELATION_TYPES, buildLinkPrompt, linkMemoryRelations, createAutoLinker };
