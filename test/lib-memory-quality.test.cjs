// ===== scripts/audit/memory-quality.cjs 纯计算层测试（node:test）=====
//
// 钉的是质量报告的口径（2026-09-12 质量闭环 v1）：
//   ① 死记忆口径 = 近 30 天注入台账 refs 从未覆盖的桶（refs 缺 topicId 时口径要标不可靠）
//   ② 重复桶嫌疑 = 名字互相包含（与写入侧合并规则同尺度）
//   ③ 孤儿边 = 端点主题已不存在（旧脚本不验名字的遗产探针）
//   ④ 密钥类字段（cookie/token/key/…）绝不进报告
//   ⑤ 「有对话但台账 0 行」必须升级成 🔴（与启动健康检查同源，不许静默）

const { test } = require('node:test');
const assert = require('node:assert');

const { analyzeTopics, analyzeInjections, analyzeRelations, analyzeClaims, analyzeSettings, buildReport } =
  require('../scripts/audit/memory-quality.cjs');

const NOW = Date.parse('2026-09-12T00:00:00Z');
const DAYS = 86400000;
const ago = (d) => new Date(NOW - d * DAYS).toISOString();

const TOPICS = [
  { id: 1, topic: '打雷那晚', grounding: '实', importance: 0.9, created_at: ago(60), updated_at: ago(2), event_time: '2026-07-01' },
  { id: 2, topic: '打雷', grounding: '实', importance: 0.5, created_at: ago(10), updated_at: ago(10), event_time: null }, // 与上一条互含 → 重复桶嫌疑
  { id: 3, topic: '悬而未决的事', grounding: '悬', importance: 0.85, created_at: ago(3), updated_at: ago(1), event_time: null },
];

const INJ = (layer, created_at, refs, extra = {}) => ({
  layer, tag: `${layer}(1)`, created_at,
  prov: refs ? { layer, refs } : { layer },
  expression_eligible: false, ...extra,
});

test('写入侧：分布/速度/importance 统计/重复桶嫌疑', () => {
  const r = analyzeTopics(TOPICS, NOW);
  assert.strictEqual(r.total, 3);
  assert.deepStrictEqual(r.grounding, { '实': 2, '悬': 1 });
  assert.strictEqual(r.created7, 1);   // 只有 id=3
  assert.strictEqual(r.created30, 2);  // id=2,3
  assert.strictEqual(r.updated7, 2);   // id=1,3
  assert.strictEqual(r.importance.ge08, 2);
  assert.strictEqual(r.withEventTime, 1);
  assert.deepStrictEqual(r.dupPairs, [['打雷那晚', '打雷']], '互含桶对必须被抓出来');
});

test('召回侧：死记忆口径 + 头部集中 + eligible 违例', () => {
  const rows = [
    INJ('attention', ago(1), [{ topicId: 1 }]),
    INJ('attention', ago(2), [{ topicId: 1 }]),
    INJ('attention', ago(3), [{ topicId: 1 }]),
    INJ('attention', ago(5), [{}]),            // refs 缺 topicId → refsMissing
    INJ('world', ago(1), null),
    INJ('residue', ago(40), [{ topicId: 3 }]), // 40 天前 → 不进 30 天窗
    INJ('attention', ago(1), [{ topicId: 999 }]), // 对不上现存的桶
    INJ('seat', ago(1), null, { expression_eligible: true }), // 铁律违例样本
  ];
  const r = analyzeInjections(rows, TOPICS, NOW);
  assert.strictEqual(r.aliveTopics30, 1, '近30天只有 id=1 被想起');
  assert.strictEqual(r.deadTopics30, 2);
  assert.strictEqual(r.refsMissing, 1);
  assert.strictEqual(r.unknownTopicIds, 1);
  assert.strictEqual(r.eligibleTrue, 1);
  assert.strictEqual(r.top5Topics30[0].topic, '打雷那晚');
  assert.strictEqual(r.top5Share30, 1); // 命中全在 id=1（999 不计入 top5，但占比分母只算已知桶）
  assert.strictEqual(r.byLayer30.world, 1);
});

test('关系侧：孤儿边被抓、有边主题计数', () => {
  const edges = [
    { source_topic: '打雷那晚', target_topic: '打雷', rel_type: '触发' },
    { source_topic: '不存在的主题', target_topic: '打雷', rel_type: '导致' },
  ];
  const r = analyzeRelations(edges, TOPICS.map((t) => t.topic));
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.byType, { '触发': 1, '导致': 1 });
  assert.strictEqual(r.orphans.length, 1);
  assert.match(r.orphans[0], /不存在的主题/);
  assert.strictEqual(r.topicsWithEdge, 2); // 打雷那晚、打雷
});

test('claim 侧：forming 超过 dormantDays 算卡死；无状态列要显式标注', () => {
  const claims = [
    { state: 'forming', claim: '我在意她', updated_at: ago(40) },
    { state: 'forming', claim: '新形成的', updated_at: ago(2) },
    { state: 'anchored', claim: '稳的', updated_at: ago(100) },
  ];
  const r = analyzeClaims(claims, 30, NOW);
  assert.deepStrictEqual(r.byState, { forming: 2, anchored: 1 });
  assert.deepStrictEqual(r.stuckForming, ['我在意她']);
  const r2 = analyzeClaims([{ claim: '无状态列样本', updated_at: ago(1) }], 30, NOW);
  assert.ok(r2.byState['（无状态列）'] === 1, '没状态列不能静默当正常');
});

test('settings 看板：密钥/人格文本不进报告，长文本截断', () => {
  const s = analyzeSettings({
    id: 1, session_id: 'global', created_at: 'x', updated_at: 'y',
    memory_gate_enabled: true, attention_recent_seats: 2,
    netease_cookie: 'SECRET', deepseek_api_key: 'SECRET', some_token: 'SECRET',
    system_prompt: '我是沈晏。'.repeat(30), // 人格文本：既不是密钥也不是旋钮，绝不进报告
    kugou_userid: '1160967118',
    long_note: 'x'.repeat(80),
  });
  assert.strictEqual(s.memory_gate_enabled, true);
  assert.strictEqual(s.attention_recent_seats, 2);
  assert.ok(!('netease_cookie' in s) && !('deepseek_api_key' in s) && !('some_token' in s), '密钥泄漏到报告 = 事故');
  assert.ok(!('system_prompt' in s) && !('kugou_userid' in s), '人格文本/用户ID 也不是审计报告的料');
  assert.match(String(s.long_note), /长文本 80 字/);
});

test('整合：有对话但台账 0 行必须 🔴；全绿时提示区为空', () => {
  const empty = buildReport(
    { topics: TOPICS, injections: [], relations: [], claims: [], settings: { memory_gate_enabled: true }, sessions7: 3, sessions30: 10, turns30: 50, claimsDormantDays: 30 },
    NOW,
  );
  assert.ok(empty.findings.some((f) => f.startsWith('🔴')), '台账空转不许降级成普通数字');
  // 真实库踩过的形态：近 7 天没人聊（sessions7=0），但近 30 天有会话、台账整窗 0 行 —— 同样是空转，不许漏
  const stale = buildReport(
    { topics: TOPICS, injections: [], relations: [], claims: [], settings: {}, sessions7: 0, sessions30: 7, turns30: 0, claimsDormantDays: 30 },
    NOW,
  );
  assert.ok(stale.findings.some((f) => f.includes('整窗 0 行')), '近7天没对话但近30天有、台账整窗空，也要 🔴');
  const healthyRows = [INJ('attention', ago(1), [{ topicId: 1 }]), INJ('attention', ago(1), [{ topicId: 2 }]), INJ('attention', ago(1), [{ topicId: 3 }])];
  const ok = buildReport(
    { topics: TOPICS.map((t, i) => ({ ...t, topic: ['甲', '乙', '丙'][i] })), // 去掉互含，排除重复桶嫌疑
      injections: healthyRows, relations: [], claims: [], settings: {}, sessions7: 3, sessions30: 10, turns30: 50, claimsDormantDays: 30 },
    NOW,
  );
  assert.deepStrictEqual(ok.findings, [], '健康时不许制造警报噪音');
});
