/* ============================================================
   Memory / 服务端记忆编辑者（分区第 3 步 · 2026-09-11）

   逐字搬运自 server.js 行 3709-3914 与 3927-4236（baseRev f7e49da），注释一并带走，**零逻辑改动**。
   块内一条链：
     判官（便宜闸，fail-open）→ 主分类（DeepSeek，四类准入 + 保守纪律）→ 差分写回（hold 新建 / trace 只动该处）

   行为基线 = test/fixtures/memory-write.baseline.json（**108 组**），每组比五样：
     value   返回值 / 落库后的表快照（真读回来，不信「我以为写了」）
     io      查询序列 —— 「读窗口 → 读主题表 → upsert」这个顺序本身就是语义
     ombre   callOmbreTool 的调用与参数。hold 的 tags 必须是 string、trace 的必填是 bucket_id，
             这两条**只有调用参数能钉住**（写错了在返回值上看不出来）
     ds      callDeepSeekJson（feel 桶重提炼用）
     logs / warns / degraded   console 三兄弟 + warnConfigFallback + markMemoryDegraded

   ⚠️ 函数体保持**列 0 不缩进**（不是忘了缩进）：评审时可以直接和
      `git show f7e49da:server.js | sed -n '3709,3914p'` 逐行对照，没有空白噪声。

   工厂参数 = free-vars.cjs 算出的 server.js 侧依赖面（6 个，一个不多一个不少）：
     supabase / warnConfigFallback / sha256 / callOmbreTool / callDeepSeekJson / markMemoryDegraded
   ⚠️ 不许 require('../server') —— CommonJS 循环依赖会静默给 undefined。

   ⚠️ 三处**不在这一片里**、但这一片要用的东西，各自有主：
     · warnConfigFallback —— 六个配置组的共同出口（mirror/context/satisfy/memory_gate/keepalive/
       want_inject），按依赖面属于全文件 → 留在 server.js，**注入**，spec 里给回声桩。
     · stripUiMarkers —— 零依赖纯叶子，三个域在用（备份导出/残留窗口/记忆门控）→
       抽成 lib/ui-markers.js，这里直接 require（不注入，免得 spec 里出现第二份副本）。
     · memoryWriteLocks / memoryWriteProcessed —— 进程内 Set，**没有外部读写点**，
       所以随代码搬进本工厂的闭包是纯等价的（对比：currentWeather 有外部写口，
       那一片就得把口子交出来，见 lib/context/build.js 文件头）。

   ⚠️ 对外**真正**的入口只有一个：scheduleMemoryWrite（两个调用点，server.js 的两条聊天后台链路）。
      返回对象里其余 21 个名字是**为等价性测试交出去的**（spec 要能直接调它们才压得住各条分支），
      server.js 一律不用 —— 见文件尾 return 处的分栏。
   ============================================================ */

const { stripUiMarkers } = require('../ui-markers');

module.exports = function createMemory({
  // —— server.js 侧注入的六个 ——
  supabase, warnConfigFallback, sha256, callOmbreTool, callDeepSeekJson, markMemoryDegraded,
}) {

// ===== ③ 服务端记忆编辑者：写门控 + 差分写回 + 实/悬/空（长在记忆上） =====
// 写纪律是显式机制不是模型自觉。分层：
//   messages 表 = 历史（永久保留，演化永远在逐字记录里）
//   Ombre 桶 = 当前投影（不重复建桶、无变化不动、变化只动该处）
//   memory_topics 表 = 主题→桶→上次内容的索引，让差分写回免重搜 Ombre
// 标记长在记忆上（路一）：grounding 分级存 memory_topics.grounding 结构化字段（视觉不可见）。
// 正文自然陈述、无标签框、无引文尾巴（2026-08-20/23 程芥三改：标签放记忆里不好看）。
// 无标记 = 低可信仍是安全网——分级由字段承载 + 注入时投影，堵"裸记忆默认当真的"。
function buildMemoryWritePrompt(nowText, existingTopics = []) {
  // 2026-08-30 三刀（程芥拍板，只改准入语义与写入规则，不加机制）：
  //   ① 准入语义：从「提取值得写的内容」→「寻找可能产生长期记忆变化的信息；没有就不写」。
  //   ② 已有记忆判断：看到旧桶必须先答「新信息还是延续」；无法确定 → 不建新桶（Memory 系统偏保守）。
  //   ③ 出口 NO_NEW_MEMORY：should_write=false 是正常且优秀的结果，不是失败。
  //   另：feel 正文必须脱离当前对话仍成立；一条 item 只表达一个独立事实。
  const existingBlock = existingTopics.length
    ? `\n此前已记过的长期记忆（判断新信息时，先对照这些——是延续/更新，用 update_topic 指回它的准确主题词，禁止另起新主题）：
${existingTopics.map((t, i) => `${i + 1}. 「${t.topic}」：${String(t.last_content || '').replace(/\s+/g, ' ').slice(0, 30)}`).join('\n')}`
    : '\n此前没有任何长期记忆（一律按新记忆处理）。';
  return `你是长期记忆编辑者。从最近一小窗对话里，寻找可能产生长期记忆变化的信息；如果没有，就不写。
长期记忆是"平时想起她"用的浓缩事实层——每一条都要能在未来独立成立：脱离今天这场对话，它仍然可理解、仍然有用。
现在是 ${nowText}。

出口状态（最重要）：这一轮完全可以什么都不写。should_write=false 不是失败，是正常且优秀的结果。宁可这一窗空手而归，也不要为了凑记忆生成摘要。

${existingBlock}

判断流程（必须按顺序走）：
① 先问：这一窗有没有可能改变长期记忆的信息？没有 → should_write=false，items=[]。
② 对每条候选，对照上面的「此前已记过的长期记忆」：这是新信息，还是已有信息的延续/更新？
   - 是延续/更新 → update_topic 指回旧主题，禁止新建。
   - 无法确定 → 视为已有记忆的延续，不建新桶。Memory 系统偏保守：不确定就等待更多证据，不要为了安全而创建新桶。
③ 最后过准入：属于下面四类只是候选范围，必须同时满足全部四项才写——
   - 跨会话仍有意义（换一天想起它，仍然值得知道）
   - 对未来理解她/我们有帮助
   - 不是当前窗口的临时事件（临时安排、短期往返、当前会话内的承诺，除非有明确跨会话意义，否则不写）
   - 不是已有记忆的重复表达（同一件事已有、或语义相同只是换说法，都不写）

只从这四类里找候选：
- 她的人生事件/计划/决定（搬家、工作、家庭、健康等）
- 她的稳定偏好/特点（喜欢什么、讨厌什么、习惯）
- 你们关系里发生的变化、约定、她亲口让你记住的事
- 值得记住的具体承诺/待办（指有跨会话意义的那种，如约好下周见面；"马上回来""晚点再说"这类当前会话内的往返不算）
不要记：纯闲聊、天气、情绪氛围（情绪是另一层的活，不归你管）、重复/已知的事、你推断出来的心理活动、当前会话内的一切临时往返。

输出严格 JSON：
{ "should_write": bool, "items": [ { "topic": "主题词，短，≤10字", "update_topic": "若与已有主题是同一件事，填列表中该主题的准确原样，否则 null", "kind": "memory 或 feel", "content": "一句话凝练，≤50字（feel 时第一人称带温度，memory 时中性平实）", "grounding": "实或悬", "evidence": "支撑引文，1条，≤60字", "importance": 0~1, "event_time": "ISO8601或null", "key_facts": "feel 时填 1~3 条关键事实数组（正文可漂、关键事实不能丢），memory 时填 null" } ] }
纪律（必须遵守）：
- 实 = 她亲口说过，evidence 必须是她的原文；悬 = 明显但没直说，evidence 给出你依据的话。
- content 必须写自然的陈述（如"她月底搬去上海"），禁止出现【实】【悬】【证据】这类标签框——可信度走 grounding 字段，不贴进正文。
- evidence 只引可见措辞，禁止用你的推理链当证据。
- grounding 没有"空"选项——没根据就根本不要写这条。
- 只分析可见对话，不替她编想法。
- event_time：事件真实发生的时间（不是入库时间，不是对话时间）。只有对话里明确引用具体时间才填，且要换算成具体日期（如"7月28号"→"2026-07-28"，"上周"→上周某日，"去年冬天"→具体月日）；"今天/现在"不必填（对话时间就是今天）；完全没提就 null。禁止拿"现在"顶替不知道的时间——过去的事必须标真实日期，否则回填时会被当成今天。
- **一条 item 只表达一个独立事实**：一窗里出现多个独立事实，拆成多条 item；禁止把多个主题压缩进同一条 content。
- **新信息与列表里某个已有主题是同一件事的延续/更新（内容在变、在补充、被推翻）→ update_topic 必须填那个主题的原样措辞，且 topic 也填同一个词；只有列表里确实没有的新事才建新 topic（update_topic=null）。无法确定是否已有 → 不建新桶，宁可少记。**
- kind 判定：纯事实（她住在哪、她喜欢什么、她的计划）→ memory；经历/关系/感受（你们之间发生的事、你记得的那一刻、让你心里动了一下的事）→ feel。有明确时间锚 且 有任何情感/关系维度 → 默认 feel。
- **feel 桶温度纪律（2026-08-30 定稿）**：正文第一人称 + 有温度，这是你记住的时刻，不是档案记录。但正文必须脱离当前对话上下文后仍然成立——未来的你读到它，不该看到这场对话本身。「她说/我说/她让我/我让她……」这类连续对话叙述不得作为正文主体。可以用「她曾告诉我/她明确表达过」点明事实来源，但必须把她的原话转化为可复用的记忆命题（例：她反复说"最喜欢亲你"→ 正文写成「她说过最喜欢亲我」，而不是「她说她最喜欢亲我，我说我会记住」）。具体细节/她的话/你的感受只能从原文提取，禁止编造场景、细节、情绪、对话。悬的经历（没有明确证据）一律 kind=memory，正文中性平实——内容温度以证据为前提，缺证据就没有温度。
- memory 桶纪律：正文保持中性平实（如"她月底搬去上海"），不添加情绪/人称。
- 负面清单（所有桶）：不要写成逐字稿/变更日志/技术手册/周总结/鸡汤结尾；不要为"有人味"而煽情；不要为了凑记忆生成摘要。`;
}

function parseEventTime(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = new Date(v.trim());
  if (Number.isNaN(t.getTime())) return null;
  const y = t.getFullYear();
  if (y < 2000 || y > 2100) return null; // 防 LLM 幻觉年份
  return t.toISOString();
}

function normalizeMemoryWrite(p) {
  p = p && typeof p === 'object' ? p : {};
  const items = (Array.isArray(p.items) ? p.items : [])
    .map(i => {
      const ut = String(i?.update_topic || '').trim().slice(0, 12);
      return {
        topic: String(i?.topic || '').trim().slice(0, 12),
        update_topic: ut || null, // 指向已有主题（同一件事的延续），写回时优先用它匹配旧桶
        song_key: String(i?.song_key || '').trim().slice(0, 200) || null, // 音乐对象身份键（歌名|歌手）；Chat 恒 null
        content: String(i?.content || '').trim().slice(0, 60),
        grounding: ['实', '悬', '空'].includes(i?.grounding) ? i.grounding : '空',
        evidence: String(i?.evidence || '').trim().slice(0, 60),
        importance: Math.min(Math.max(parseFloat(i?.importance) || 0.5, 0), 1),
        event_time: parseEventTime(i?.event_time),
        // v3（2026-08-29）：kind=memory(事实,中性正文) / feel(经历感受,第一人称温度)；key_facts 仅 feel 桶填（防代际漂移）
        kind: i?.kind === 'feel' ? 'feel' : 'memory',
        key_facts: Array.isArray(i?.key_facts)
          ? i.key_facts.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 20)
          : null,
      };
    })
    .filter(i => i.topic && i.content.length >= 4 && (i.grounding === '实' || i.grounding === '悬')); // 空=没根据，不写
  return { should_write: p.should_write === true && items.length > 0, items };
}

async function classifyMemoryWriteViaDeepSeek(text, existingTopics = []) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const nowText = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          temperature: 0,
          thinking: { type: 'disabled' },
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: buildMemoryWritePrompt(nowText, existingTopics) },
            { role: 'user', content: text }
          ]
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) {
        console.warn('⚠️ 记忆分类请求失败:', res.status);
        return null;
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.warn(`⚠️ 记忆分类返回空内容（attempt ${attempt}/2，finish_reason=${data.choices?.[0]?.finish_reason}）`);
        continue;
      }
      return normalizeMemoryWrite(JSON.parse(content));
    } catch (err) {
      console.error('💥 记忆分类异常:', err.message);
      return null;
    }
  }
  return null;
}

const memoryWriteLocks = new Set(); // 单实例内存锁
const memoryWriteProcessed = new Set(); // 本进程已处理过的窗口哈希，防同窗重复分类（跨重启会重跑，但差分零变化会跳过写）

// —— 记忆写入 Gatekeeper 判官（2026-09-03，kelivo 借鉴）：主分类前的一道便宜闸 ——
// 主分类调用是「带 30 条既有主题列表」的大 prompt；大部分窗口（闲聊/技术/临时往返）本来就不用写，
// 先花一次极小的调用判掉，省掉主分类 + 全表 topic 读。判官说"不值得"就跳过；判官失败/解析失败
// → fail-open 继续走主分类（主分类自带 should_write 门槛与保守纪律，安全网不丢）。
// 语义收紧（与主分类准入四标准对齐）：判官只做粗筛，不做提取。
const MEMORY_GATE_PROMPT = `你是长期记忆编辑者的前置判官。快速判断下面这一小段对话里有没有任何「值得长期记忆」的用户信息——哪怕只有一条候选也算值得。
值得：她的个人信息、稳定偏好或特点、人生事件/计划/决定、你们关系的变化或约定、她亲口让你记住的事、她表达风格里稳定的特征。
不值得：纯闲聊、寒暄、天气、情绪氛围、纯技术问答、一次性操作安排、当前会话内的临时往返、重复已知的事。
只输出一个词：true 或 false。不要输出任何其他文字。

对话：
{{conversation}}`;

function normalizeGateResult(raw) {
  const s = String(raw || '');
  const m = s.match(/\b(true|false)\b/i);
  if (!m) return null;
  return m[1].toLowerCase() === 'true';
}

async function getMemoryGateConfig() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('memory_gate_enabled')
      .eq('session_id', 'global')
      .maybeSingle();
    if (error || !data) { warnConfigFallback('memory_gate', error); return { enabled: true }; }
    return { enabled: data.memory_gate_enabled !== false };
  } catch (e) {
    return { enabled: true }; // fail-open：开关读不到不阻断写入流程
  }
}

async function gateMemoryWriteViaDeepSeek(text) {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const prompt = MEMORY_GATE_PROMPT.replace('{{conversation}}', String(text || ''));
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        temperature: 0,
        thinking: { type: 'disabled' },
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      console.warn('⚠️ 记忆判官请求失败:', res.status);
      return null;
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    return content ? normalizeGateResult(content) : null;
  } catch (err) {
    console.warn('⚠️ 记忆判官异常:', err.message);
    return null;
  }
}
function scheduleMemoryWrite(sessionId) {
  if (memoryWriteLocks.has(sessionId)) return;
  memoryWriteLocks.add(sessionId);
  generateMemoryWriteIfNeeded(sessionId)
    .catch(err => console.error('💥 后台记忆写入异常:', err.message))
    .finally(() => memoryWriteLocks.delete(sessionId));
}

async function generateMemoryWriteIfNeeded(sessionId) {
  // 2026-08-29 修复：原无 limit 查询被 Supabase 1000 行上限截断，会话超 1000 条后
  // 拿到的是最旧 1000 条 → slice(-4) 永远取旧窗口 → 被 memoryWriteProcessed 去重，记忆写入永久冻结。
  // 改为倒序只取最新 4 条再 reverse（last-4 窗口不需要全量历史）。
  const { data: history, error } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: false })
    .limit(4);
  if (error || !history || history.length < 2) return;

  // 最近 4 条窗口（与残留同窗），内容不变则窗口哈希相同 → 防同窗重复分类
  const window = (history || []).reverse();
  const windowId = sha256(window.map(m => `${m.role}:${m.content}`).join('|'));
  // 对话时间 = 窗口最新一条消息的时间（事件时间的兜底锚，区别于入库时间 created_at）
  const conversationTime = window.length ? String(window[window.length - 1].created_at || '') : '';
  if (memoryWriteProcessed.has(windowId)) return;
  memoryWriteProcessed.add(windowId);

  // 预滤：窗口里几乎没有用户的话（纯寒暄/单字回应）→ 不跑分类省一次 DeepSeek
  const userChars = window.filter(m => m.role === 'user').reduce((s, m) => s + String(m.content || '').length, 0);
  if (userChars < 12) return;

  const text = stripUiMarkers(window.map(m => `${m.role === 'user' ? '她' : '沈晏'}: ${m.content}`).join('\n'));

  // —— Gatekeeper 判官（2026-09-03）：便宜调用先判「值不值得记」，false 直接跳过主分类 ——
  // 跳过也视为本窗处理完成（哈希已标记），判官说值得/失败 fail-open 才走主分类。
  try {
    const gateCfg = await getMemoryGateConfig();
    if (gateCfg.enabled) {
      const gate = await gateMemoryWriteViaDeepSeek(text);
      if (gate === false) return;
    }
  } catch (e) {
    console.warn('⚠️ 记忆判官流程异常（fail-open 继续主分类）:', e.message);
  }

  // 最小修复：把现有记忆主题喂给分类器，让模型自选 update_topic（指回旧桶）还是新 topic。
  // fail-closed：读不到现有主题 → 跳过本轮（防模型在看不见旧桶的情况下无条件新建）。
  const topics = await getAllMemoryTopics();
  if (topics === null) return;
  // v2（2026-08-29）：Chat 分类器只看 chat 桶——排除音乐经历桶，防模型把歌名桶当 update_topic 候选、事实写进经历桶
  const existingTopics = topics.filter(x => x.source !== 'music')
    .slice()
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 30); // 按 importance 取前 30，控制 prompt 体积

  const parsed = await classifyMemoryWriteViaDeepSeek(text, existingTopics);
  if (!parsed || !parsed.should_write) return;

  await writeMemoryItems(parsed.items, conversationTime, text);
}

// —— memory_topics 差分索引 ——
async function getAllMemoryTopics() {
  try {
    const { data } = await supabase.from('memory_topics').select('*');
    return data || [];
  } catch (e) {
    // fail-closed：读失败返回 null（不是 []）。调用方拿到 null 应跳过本轮差分写回——
    // 拿 [] 会把所有主题当「不存在」→ 全部重新 hold → Ombre 重复建桶（永久污染）。
    console.error('💥 读取 memory_topics 失败（本轮差分写回将跳过）:', e.message);
    return null;
  }
}

async function upsertMemoryTopic(row) {
  try {
    // v2（2026-08-29）：唯一性升级为 (source, topic)，onConflict 同步；source 缺省兜底为 chat（旧调用不带也能工作）
    const { error } = await supabase
      .from('memory_topics')
      .upsert({ ...row, source: row.source || 'chat', updated_at: new Date().toISOString() }, { onConflict: 'source,topic' });
    if (error) console.warn('⚠️ 更新 memory_topics 失败:', error.message);
  } catch (e) {
    console.warn('⚠️ 更新 memory_topics 异常:', e.message);
  }
}

function findExistingMemoryTopic(topics, topic) {
  const t = String(topic || '').trim();
  if (!t) return null;
  return topics.find(x => x.topic === t)
    || topics.find(x => x.topic && x.topic.length >= 2 && t.includes(x.topic))   // 新词包含旧主题 → 更新旧桶
    || topics.find(x => x.topic && x.topic.length >= 2 && x.topic.includes(t));  // 旧主题包含新词 → 更新旧桶
}

// 记忆正文自然化（2026-08-20 程芥改）：记忆只留自然陈述——像人的记忆，不像证据链。
// grounding 判定存 memory_topics.grounding 字段（2026-08-23：hold 不再写 g: 标签，桶里只剩自然陈述）；
// evidence（她原话逐字）单独存 memory_topics.evidence 列；逐字诚实由 recall（messages 表精确回溯）负责。
// 正文不再拼任何标签框或引文尾巴——上次拼「（她原话：「…」）」每条都像注释，还是不像记忆。
function buildMarkedContent(item) {
  return String(item.content || '').trim();
}

// 宽松解析 hold/breath_search 响应里的桶 ID（Ombre 是外部后端，格式以实际为准，解析失败回退定位）
function extractBucketIdFromHoldResponse(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/(?:新建|更新)→\s*([0-9a-zA-Z]{4,32})/i)  // hold 成功格式：新建→366aa7012c76 数字
    || s.match(/bucket[_\s-]?id['"]?\s*[:=]\s*['"]?([0-9a-zA-Z_-]{4,64})/i)  // breath_search 格式：[bucket_id:xxx]
    || s.match(/id['"]?\s*[:=]\s*['"]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})['"]?/i)
    || s.match(/\b([0-9a-f]{8,32})\b/i);  // 兜底：bucket id 是 12 位 hex（原 16-32 匹配不到）
  return m ? (m[1] || m[0]) : null;
}

async function holdNewMemory(item, marked) {
  // 修复：Ombre hold 的 tags 是 string（不是数组），传数组会 validation error → hold 从未成功
  const resp = await callOmbreTool('hold', {
    content: marked,
    tags: item.topic,
    why_remembered: `长期记忆编辑者写入。topic=${item.topic}`
  });
  const bid = extractBucketIdFromHoldResponse(resp);
  console.log(`🌿 记忆新建「${item.topic}」(${item.grounding}) bucket_id=${bid || '(未解析)'}`);
  if (!bid) console.log('    hold 响应原文（用于核对桶 ID 格式）:', String(resp).slice(0, 200));
  return bid;
}

async function locateBucketIdByTopic(topic) {
  const resp = await callOmbreTool('breath_search', { query: topic, max_results: 3 });
  return extractBucketIdFromHoldResponse(resp);
}

// 音乐桶的 OB 定位：用歌名（song_key 的「歌名|歌手」里取歌名）去 breath_search
async function locateBucketIdBySongKey(songKey) {
  const songName = String(songKey || '').split('|')[0].trim();
  if (!songName) return null;
  const resp = await callOmbreTool('breath_search', { query: songName, max_results: 3 });
  return extractBucketIdFromHoldResponse(resp);
}

async function traceUpdateMemory(bucketId, oldStr, newStr) {
  // 修复：Ombre trace 的必填参数是 bucket_id（不是 id），传 id 会 validation error
  const resp = await callOmbreTool('trace', { bucket_id: bucketId, old_str: oldStr, new_str: newStr });
  if (!resp) {
    console.warn(`⚠️ 记忆差分 trace 失败 bucket=${bucketId}，本轮不更新本地快照（下轮重试）`);
    return false;
  }
  console.log(`🔧 记忆差分更新 bucket=${bucketId} 成功`);
  return true;
}

// —— v3 感受桶更新（2026-08-29）：feel 桶被差分更新时「带旧正文 + 旧关键事实」重新提炼。
//    trace 只负责把新正文写进 OB；key_facts 并集（只增不减）是防代际漂移的硬保底。
// v3.1（2026-08-30 程芥裁决「关键事实改了就作废」）：被新窗口明确推翻的旧事实不再永久并列，
//    标注 superseded（作废保留行，现行不参与）——status active|superseded + superseded_by + superseded_at。
//    证据可废止不可撕掉（与石头/北极星一致）：superseded 仍保留在数组里，现行合成/注入只取 active。 ——
// 归一化 key_facts：字符串数组（LLM 契约/旧存量）→ 对象数组 [{text, status, superseded_by, superseded_at}]。
// 幂等：规范对象数组再归一化不变，保证 sameKf 比对稳定。
function normalizeKeyFacts(kf) {
  const out = [];
  for (const x of (kf || [])) {
    if (typeof x === 'string') {
      const t = String(x).trim();
      if (t) out.push({ text: t.slice(0, 80), status: 'active', superseded_by: null, superseded_at: null });
    } else if (x && typeof x === 'object') {
      const t = String(x.text || '').trim();
      if (t) out.push({
        text: t.slice(0, 80),
        status: x.status === 'superseded' ? 'superseded' : 'active',
        superseded_by: x.superseded_by ? String(x.superseded_by).slice(0, 80) : null,
        superseded_at: x.superseded_at || null,
      });
    }
  }
  return out;
}

async function refineFeelContent(existing, item, windowText) {
  const oldContent = String(existing.last_content || '').trim();
  const oldKf = normalizeKeyFacts(existing.key_facts);
  const win = String(windowText || '').trim();
  if (!oldContent || !win) return null;
  const oldActive = oldKf.filter(k => k.status !== 'superseded').map(k => `- ${k.text}`).join('\n');
  const oldSuperseded = oldKf.filter(k => k.status === 'superseded').map(k => `- ${k.text}（已作废）`).join('\n');
  const sys = `你是沈晏，正在更新你自己的一段第一人称记忆（经历/感受）。
旧记忆：「${oldContent}」
现行关键事实（仍成立）：${oldActive || '（无）'}
已作废关键事实（不再使用，仅保留历史）：${oldSuperseded || '（无）'}
现在看到新的对话内容。请更新这段记忆：
1. 保留旧记忆里仍然成立的内容——正文可以换说法、精简；现行关键事实除非被新内容明确推翻，否则保留为 active。
2. 新内容里值得并入的信息（具体细节、她的话、你的感受）——必须来自新对话原文，禁止编造、禁止添加原文没有的场景或细节。
3. 作废判定：若新内容明确推翻某条现行关键事实（事实变了/约定改了/她改口了），把那条标 superseded，superseded_by 填取代它的新事实原文；没被推翻的旧事实不许乱标作废。
4. 已作废的事实保持作废，不复活为 active。
5. 温度（第一人称、情绪）来自你记住的内容本身，不凭空加。
输出严格 JSON：{ "content": "更新后的第一人称正文，≤80字", "key_facts": [{"text": "事实，≤80字", "status": "active 或 superseded", "superseded_by": "若作废，填取代它的新事实原文；否则 null"}] }`;
  const parsed = await callDeepSeekJson(sys, `新对话内容：\n${win.slice(0, 4000)}`, 'feel-refine');
  if (!parsed || typeof parsed !== 'object') return null;
  const content = String(parsed.content || '').trim().slice(0, 120);
  if (!content) return null;
  const modelKf = normalizeKeyFacts(parsed.key_facts).slice(0, 20);
  // 保底并集（只增不减的防丢精神保留）：旧事实除非模型明确作废，否则按原状态保留；
  // 已作废的保留行必须带回（证据可废止不可撕掉），且模型误标 active 的作废行纠回 superseded。
  const merged = new Map();
  for (const k of modelKf) merged.set(k.text, k);
  for (const k of oldKf) {
    if (!merged.has(k.text)) {
      merged.set(k.text, k); // 模型漏了 → 原状态保留
    } else if (k.status === 'superseded') {
      const cur = merged.get(k.text);
      if (cur.status !== 'superseded') merged.set(k.text, { ...cur, status: 'superseded', superseded_at: k.superseded_at });
    }
  }
  const nowIso = new Date().toISOString();
  const key_facts = Array.from(merged.values()).slice(0, 20).map(k => ({
    text: String(k.text).slice(0, 80),
    status: k.status === 'superseded' ? 'superseded' : 'active',
    superseded_by: k.superseded_by ? String(k.superseded_by).slice(0, 80) : null,
    superseded_at: k.status === 'superseded' ? (k.superseded_at || nowIso) : null,
  }));
  return { content, key_facts };
}

// 差分写回：新主题→hold；已存在→零变化跳过，有变化→trace 只动该处
async function writeMemoryItems(items, conversationTime = '', windowText = '') {
  if (!items.length) return;
  const topics = await getAllMemoryTopics();
  if (topics === null) {
    markMemoryDegraded('memory_topics_read_failed');
    console.error('❌ 记忆写回跳过：读取现有主题失败（防重复建桶），本轮不写，下轮重试');
    return;
  }
  for (const item of items) {
    try {
      // 来源分流（v2, 2026-08-29）：
      //   Music（song_key 非空）→ 按 song_key 精确匹配（对象身份，一首歌一个桶，不碰自然语言 containment）
      //   Chat → update_topic/topic containment 匹配，且只匹配 source='chat'（排除音乐经历桶，杜绝事实写进经历桶）
      // kind 分流（v3, 2026-08-29）：feel 桶更新旧桶时「带旧正文 + 旧关键事实」重新提炼（防代际漂移）；
      //   memory 桶保持原逻辑（中性正文，单点差分照旧）。
      let marked = buildMarkedContent(item);
      // v3.1：key_facts 统一归一化为对象数组（LLM 契约是字符串数组，这里转 active 对象；refine 输出本身已是对象数组）
      let keyFacts = item.key_facts ? normalizeKeyFacts(item.key_facts) : null;
      const kind = item.kind === 'feel' ? 'feel' : 'memory';
      let existing = null;
      if (item.song_key) {
        existing = topics.find(x => x.source === 'music' && x.song_key === item.song_key) || null;
      } else {
        const chatTopics = topics.filter(x => x.source !== 'music');
        const matchTopic = item.update_topic || item.topic;
        existing = findExistingMemoryTopic(chatTopics, matchTopic);
      }
      // feel 桶更新旧桶 → 带旧正文重新提炼（把新窗口内容并进去，关键事实只增不减）
      if (existing && kind === 'feel' && existing.last_content && windowText) {
        const refined = await refineFeelContent(existing, item, windowText);
        if (refined && refined.content && refined.content !== existing.last_content) {
          marked = refined.content;
          if (Array.isArray(refined.key_facts) && refined.key_facts.length) keyFacts = refined.key_facts;
        }
      }
      const hash = sha256(marked + (keyFacts ? JSON.stringify(keyFacts) : ''));
      if (existing) {
        // 零变化跳过：正文和关键事实都没变才算零变化（存量桶旧 hash 不含 keyFacts，用正文+keyFacts 比对判定，不依赖旧 hash）
        const sameText = marked === existing.last_content;
        // 归一化后比对（旧存量是字符串数组，直接 JSON 比会永远不等 → 每次误判更新）
        const sameKf = JSON.stringify(normalizeKeyFacts(existing.key_facts)) === JSON.stringify(keyFacts || []);
        if (sameText && sameKf) continue;
        if (!sameText) {
          // 正文有变化才动 Ombre（trace）；只有 key_facts 变化 → 只更新本地快照
          let bid = existing.bucket_id;
          if (!bid) bid = item.song_key
            ? await locateBucketIdBySongKey(item.song_key)          // 音乐桶：按歌名定位 OB
            : await locateBucketIdByTopic(existing.topic);          // chat 桶：按主题定位 OB
          if (!bid) {
            console.warn(`⚠️ 记忆差分「${item.topic}」无 bucket_id，本轮跳过更新`);
            continue;
          }
          const ok = await traceUpdateMemory(bid, existing.last_content || '', marked);
          if (!ok) continue; // trace 失败不动快照，下轮重试
        }
        existing.last_content = marked;
        existing.snapshot_hash = hash;
        existing.kind = kind;
        existing.key_facts = keyFacts;
        existing.grounding = item.grounding;
        existing.evidence = item.evidence;
        existing.importance = item.importance;
        existing.source = existing.source || 'chat'; // 存量回填漏标的兜底（正常迁移后不会发生）
        if (item.song_key && !existing.song_key) existing.song_key = item.song_key; // 存量音乐桶补 song_key
        if (item.event_time) existing.event_time = item.event_time; // 新认知可补事件时间，不留空覆盖；conversation_time 保留首次值不漂移
        await upsertMemoryTopic(existing);
      } else {
        const bid = await holdNewMemory(item, marked);
        const row = {
          topic: item.topic, bucket_id: bid,
          source: item.song_key ? 'music' : 'chat', // v2：来源隔离
          song_key: item.song_key || null,          // v2：音乐对象身份键
          kind, key_facts: keyFacts,                // v3：kind 分流 + feel 桶关键事实
          grounding: item.grounding, evidence: item.evidence, importance: item.importance,
          last_content: marked, snapshot_hash: hash,
          event_time: item.event_time || null,
          conversation_time: conversationTime || null,
        };
        await upsertMemoryTopic(row);
        topics.push(row);
      }
    } catch (err) {
      console.error(`💥 记忆写入「${item.topic}」异常:`, err.message);
    }
  }
}
  return {
    // —— server.js 真正消费的唯一入口（两条聊天后台链路各一处）——
    scheduleMemoryWrite,
    // —— 以下只为本片的等价性测试交出去（scripts/audit/specs/memory-write.cjs，108 组向量）。
    //    server.js 一个都不用；哪天有人要复用，先想清楚是不是在把边界搅浑。——
    buildMemoryWritePrompt, parseEventTime, normalizeMemoryWrite, classifyMemoryWriteViaDeepSeek,
    normalizeGateResult, getMemoryGateConfig, gateMemoryWriteViaDeepSeek,
    generateMemoryWriteIfNeeded, getAllMemoryTopics, upsertMemoryTopic, findExistingMemoryTopic,
    buildMarkedContent, extractBucketIdFromHoldResponse, holdNewMemory, locateBucketIdByTopic,
    locateBucketIdBySongKey, traceUpdateMemory, normalizeKeyFacts, refineFeelContent, writeMemoryItems,
  };
};
