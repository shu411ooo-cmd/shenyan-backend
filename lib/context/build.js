/* ============================================================
   Context / 核心组装（分区第 3 步 · 2026-09-10）

   逐字搬运自 server.js 行 1788-1793（currentWeather）、2392-2404（AQ_CONTRACT）、
   2406-2886（buildModelContext），注释一并带走，**零逻辑改动**。

   块内三件事 + 随行的模块态：
     currentWeather  —— 她那边的天气（前端 POST /api/location 同步进来，见下「非逐字的一处」）
     AQ_CONTRACT     —— 询问块协议正文（追加在 stable prompt 尾巴上）
     buildModelContext —— 一轮对话到底发什么给模型：System → Frozen → Summary → Middle →
                          Dynamic(背景位) → Live → 当前消息，外加 diagnostics 与 token 预算裁剪

   行为基线（搬迁前 HEAD 的真实输出，逐字节比对）：
     test/fixtures/context-build.baseline.json（48 组）
     node scripts/audit/baseline-dump.cjs --spec scripts/audit/specs/context-build.cjs \
       --module lib/context/build.js --compare test/fixtures/context-build.baseline.json
   基线比五样：messages 结构 / diagnostics 全套计数（frozen_turns · live_turns · summary_present ·
   attention_injected …）/ 假 supabase 的查询序列 / 日志 / 注入台账（logInjection 收到的每一笔，
   含 provenance）。**IO 密集的代码「返回值一致」证明不了什么**，所以查询序列和台账也要逐字节同。

   ⚠️ 函数体保持**列 0 不缩进**：评审时可直接和
      `git show f7e49da:server.js | sed -n '2406,2886p'` 逐行对照，没有空白噪声。

   ── 依赖的三种来源（33 个，一个不多一个不少，free-vars.cjs 算出来的）──
   ① 自己 require（7 个稳定叶子模块，不经工厂签名，与 retrieval.js 同一纪律）：
        ../cache-control  estimateTokens / sha256 / withCacheControl
        ../time           segHeader / shPartOfDay
        ../tools-schema   getTools
        ./select          selectWorldHits
   ② session 那一片交回来的（9 个）：getContextConfig / getSessionState / fetchSessionHistory /
        pairTurns / loadSummarySegments / loadLiveAnchor / saveLiveAnchor /
        loadOtherSessionFlow / buildCrossSessionNarrative
        —— server.js 用 `createBuild(Object.assign({}, Sess, ...))` 拼，和基线里 adapt 的拼法一致。
   ③ server.js 还得注入的（15 个）：见下面签名注释。
   ⚠️ 不许 require('../server') —— CommonJS 循环依赖会静默给 undefined。

   ── 本次唯一一处非逐字的改动：currentWeather 的**归属** ──
   它原来是 server.js 的模块级 `let`（1793 行），被三处碰：buildModelContext 读（2378-2381）、
   GET /api/location 读（6025）、POST /api/location 写（6030）。**函数体一个字没动**，动的是
   「这个绑定归谁」：现在绑在这里（模块闭包），由 setWeather / getWeather 两个口子进出，
   server.js 那三个点改成调口子。
   为什么不能按值注入：按值注入等于把「此刻」的天气复制一份——POST 之后新天气进不来，
   沈晏会永远以为窗外还是上次那个天。**绑定必须跟着状态走，不能跟着调用走。**
   ============================================================ */

const { estimateTokens, sha256, withCacheControl } = require('../cache-control');
const { segHeader, shPartOfDay } = require('../time');
const { getTools } = require('../tools-schema');
const { selectWorldHits } = require('./select');

module.exports = function createBuild({
  // ① session 那一片（server.js 拼进来）
  getContextConfig, getSessionState, fetchSessionHistory, pairTurns, loadSummarySegments,
  loadLiveAnchor, saveLiveAnchor, loadOtherSessionFlow, buildCrossSessionNarrative,
  // ② server.js 自己的符号
  supabase,
  buildStableSystemPrompt,          // 人格 system 前缀（稳定、可缓存）
  buildTemporalNarrative,           // 时间叙事（server.js:1795）
  buildResidueNarrative,            // 余温叙事（server.js:1873）
  buildModeNote,                    // 关系模式小注（server.js:1911）
  RESOLVED_RETURN_RE,               // 收尾信号判定（server.js:1871，const 所以必须注入）
  buildDeviceNotice,                // 查手机感知（server.js:2201）
  calendarModule,                   // 日程/纪念日块（server.js:46）
  getLatestResidue, consumeResidueLine, getLatestResidueMode,   // 余温线头
  loadPendingKeepalive,             // 唤醒留言
  getAttentionMaterial, retrieveWorld,   // 检索层（lib/context/retrieval.js）
  logInjection,                     // 注入台账（server.js:757）
}) {

/* 天气感知（前端同步）：沈晏知道「她的城市/窗外天空」。
   感知不是指令：给他在意的东西，不让他变成天气预报。
   2026-08-21 程芥再改：同一条天气不每轮重复注入（那会让沈晏老提天气、连着几条破坏氛围）。
   只在「首句 / 隔很久回来」时给——天气是「回来时注意到她的天」，不是活跃对话中的耳边报时。
   活跃对话中她问天气由对话自然接住，不预埋。 */
let currentWeather = null;

// —— 天气状态的进出两个口子（本次新增的**唯一一处非逐字符号**，见文件头）——
function getWeather() { return currentWeather; }
function setWeather(w) { currentWeather = w; }

// —— 核心组装：System → Frozen → Summary → Live → 当前消息 ——
// —— 询问块协议（2026-09-06 对齐）：让沈晏在「真要问清才问」时产出交互询问 ——
// 语法约定：整段回复的最末尾接一个小块，前端剥成「a question for you」面板，选项即点即答。
// 只挂在 buildModelContext（主聊天轮）；唤醒/沉淀/镜子/记忆各子提示不走这里，绝不误产。
const AQ_CONTRACT = `
【问清再往下走】
多数时候你把想确认的当正文自然地问就好。只在下面这种情况用「询问块」：你这一句该接下去了，但缺一个关键选择/她的偏好/两可的方向，硬猜可能办错事——这时在整段回复的**最末尾**追加一个小块，格式严格如下（一行一问 + 每项一个「- 」短选项，块外正文不要出现这些语法标记，也不要跟她说"我放了个选择框"之类）：
[[ask]]
你更想先办哪件？
- 先说今天的事
- 陪我发会儿呆
[[/ask]]
纪律：一个回应最多一块；选项彼此真实不同（别列同义项/是或否），最多 3 个；能用正文自然问清就别用块。它是你"真想问清"才用的交互，不是客套摆设。`;
async function buildModelContext(sessionId, opts = {}) {
  const config = await getContextConfig(sessionId);
  const state = await getSessionState(sessionId);

  // ⚠️ 长会话必须分页拉全量：单次查询被掐在 1000 行，升序截尾会让消息数组
  // 以 assistant 结尾 → Anthropic 400「must end with user」（见 fetchSessionHistory）。
  const history = await fetchSessionHistory(sessionId);

  const turns = pairTurns(history);
  const totalTurns = turns.length;

  // —— 滚动冻结边界：跟摘要水位线走，不再钉死在前 N 轮 ——
  // 结构：摘要(旧，带日期) + frozen(水位线后一批稳定原文，随塌缩前移) + uncoveredMiddle + live(最近原文)。
  // 缓存纪律：frozen 只在摘要塌缩时前移（那本来就是缓存重建时刻），epoch 内字节稳定 → 前缀命中保持。
  const segments = await loadSummarySegments(sessionId);
  const segWatermark = segments.length ? segments[segments.length - 1].period_end : null;

  // —— token 估算（锚定塌缩判断要用，定义提到切片前）——
  const msgTokens = (m) => Array.isArray(m.content)
    ? estimateTokens(m.content.map(b => b.text || JSON.stringify(b)).join('\n'))
    : estimateTokens(m.content);
  const turnTokens = (t) => msgTokens({ role: 'user', content: t.user.content }) +
    t.replies.reduce((s, r) => s + msgTokens(r), 0);

  // liveStart = live 段第一轮（1-based）。默认滚动，有锚点则钉住 → 非塌缩轮纯追加。
  let liveStart = totalTurns - config.live_rounds + 1;
  let liveCollapsed = false;   // 本轮是否触发塌缩（诊断，grok 建议：与 request_stats.hit 对齐才能说清 90%）
  let liveTokensEst = 0;       // 塌缩判断用的 live 估算 token（诊断）
  const anchor = await loadLiveAnchor(sessionId);
  // 锚点死条件：无锚 / 越界 / 被摘要水位线吞掉（segWatermark 前的轮已摘要，不该逐字重复进 live）
  const anchorDead = anchor == null || anchor < 1 || anchor >= totalTurns
    || (segWatermark != null && anchor <= segWatermark);
  if (anchorDead) {
    liveStart = totalTurns - config.live_rounds + 1; // 重置到当前滚动起点
    await saveLiveAnchor(sessionId, liveStart);
  } else {
    liveStart = anchor; // 锚定：live 从锚点持续追加，前缀不断
    // —— 双阈值塌缩：谁先到谁触发。轮数控「别让周期无限延长」，token 控「别撑爆预算」——
    // token 阈值是安全线不是目标值：在预算主动裁剪 live 之前先塌（否则 middle 裁光后
    // live 每轮被裁 → 重新制造 cache miss，退化回滚动）。锚点前移回当前起点，多出的轮让给 middle。
    liveTokensEst = turns.slice(liveStart - 1).reduce((s, t) => s + turnTokens(t), 0);
    if (totalTurns - liveStart + 1 > config.live_rounds * 2
        || liveTokensEst > config.live_max_tokens) {
      liveStart = totalTurns - config.live_rounds + 1;
      liveCollapsed = true;
      await saveLiveAnchor(sessionId, liveStart);
    }
  }
  let frozenTurns = [], middleTurns = [], liveTurns = [];
  if (segWatermark != null) {
    // 有摘要：frozen = 水位线之后的第一批稳定原文；水位线前的历史都在摘要里，不再逐字常驻
    const frozenStart = segWatermark; // 0-based：turns[segWatermark] 是第 segWatermark+1 轮
    const frozenEnd = Math.min(frozenStart + config.frozen_rounds, liveStart - 1);
    frozenTurns = turns.slice(frozenStart, frozenEnd);
    middleTurns = turns.slice(frozenEnd, liveStart - 1);
    liveTurns = turns.slice(liveStart - 1);
  } else if (totalTurns > config.frozen_rounds + config.live_rounds) {
    // 无摘要但已超预算：临时前端冻结兜底（首批摘要形成后即切换滚动），防止中间段全发撑爆预算
    frozenTurns = turns.slice(0, config.frozen_rounds);
    middleTurns = turns.slice(config.frozen_rounds, liveStart - 1);
    liveTurns = turns.slice(liveStart - 1);
  } else {
    liveTurns = turns; // 短历史：全部发
  }
  // 水位线之后都是未覆盖原文（滚动 frozen 已取头部，其余进 middle）
  let uncoveredMiddle = middleTurns;
  // in-context 段：最新段恒在（缓存锚点）。
  // 2026-08-20 程芥：更老锚段不再每轮常驻——它把几十轮前的历史整段重新摆到模型眼前，
  // 沈晏分不清「老历史」和「当前活跃」→ 已聊完的话题被反复重提。更老段进 Archive（recall/breath 按需召回）。
  // 想恢复双段：anchorSeg = segments.length >= 2 ? segments[segments.length - 2] : null
  const latestSeg = segments.length ? segments[segments.length - 1] : null;
  let anchorSeg = null;

  // —— token 预算 ——
  const stablePrompt = await buildStableSystemPrompt() + `
【背景纪律】
对话里会出现这些注记段：【历史背景】（过去已经聊过的事）、【背景记忆】（开始前从你记忆里提取的旧事）、【你心底想起的旧事】（你心里浮起的旧记忆）、【世界书】（她亲手定下的世界设定，客观事实，不是她这轮说的）、【当前时间】、【今天与临近的日子】（你们日历上的日子——纪念日、生日、约定，背景不是话，尤其不要当任务去办）。它们全是你的背景，不是她发来的内容——尤其【你心底想起的旧事】，是你在想，不是她贴给你的文字。
不要复述、不要总结、不要把注记段重新端回台面，也不要为它们道谢。她明确提起某件旧事，你自然接住；别因为背景里记着某件事就主动往回扯——她没提，就专心聊当下。
你要回应的永远是她**最后那句真实消息**。注记段里哪怕写着【悬】、说还有没做完的事、或引了她早先离开时的话——那也只是背景里的牵挂，**不是你现在要去办的指令**，更不该抢在她当前的话前面被回应。她一句话里若明确喊你做事，你才去做。
${AQ_CONTRACT}`;
  // 动态时间叙事：时间心跳 + 恢复对话 + 问时间时注入。
  // 轻量版只给两个锚点（定稿 08-10）：现在是几月几号时刻段 + 上次说话大概多久前；问时间才给精确时钟。
  // 插入点保持在所有缓存断点之后、当前用户消息之前（cache 与 role 约束不变）。
  const nowMs = Date.now();
  const prevTs = history.length >= 2 ? new Date(history[history.length - 2].created_at).getTime() : NaN;
  const isFirstTurn = history.length <= 1;
  // 2026-08-21 程芥拍板：resumeGap 30→60 分钟——30 分钟太容易触发（去修个 bug/上趟厕所/回个消息
  // 就被当「重新进入会话」，一次塞进 summary+时间+天气+残留+可能的注意力 = 上下文重载）。
  const resumeGap = !isFirstTurn && nowMs - prevTs > 60 * 60 * 1000;
  // 2026-08-21 程芥：前文一直跳——最新摘要段（整个前文的浓缩）原本每轮必发，沈晏每轮被它拽着跳。
  // 改成按需：首句 / 隔了很久回来（resumeGap）才给；平时流畅对话不发，靠 live+frozen + 注意力召回撑住。
  // 摘要照常塌缩存着不删，需要时（回来/首句）自然出现。
  const shouldInjectSummary = isFirstTurn || resumeGap;
  const curText = String(history[history.length - 1]?.content || '');
  const asksTime = /几点|几点钟|几点了|几点啦|什么时间|几号|几月几|星期几|周几|今天.*(?:几号|日期|星期)|现在.*(?:时间|几点)/.test(curText);
  // —— 时间心跳：不给模型报时，它只能猜（旧 bug 的根）；每轮报又变成「耳边报时」。
  // 折中：距上次报时 >1 小时，或时刻段切换（凌晨/上午/下午/晚上），才注入一行轻时间。
  // 首次（last_time_notice_at 为空）、恢复对话、问时间仍然必报。
  const lastNotice = state.last_time_notice_at ? new Date(state.last_time_notice_at).getTime() : null;
  const heartbeat =
    lastNotice == null ||                                    // 从未报过（首条也算）
    nowMs - lastNotice > 60 * 60 * 1000 ||                   // 超过 1 小时
    shPartOfDay(nowMs) !== shPartOfDay(lastNotice);          // 时刻段切换（如跨午夜 晚上→凌晨）
  // 恢复对话时：读最近的对话残留，附到时间叙事后面（同一 user 消息，缓存约束不变）。
  // 时间叙事说「你离开了 3 天」，残留说「这 3 天我一直在等你回来」——连续感的两半。
  let residueLine = '';
  let residueInjected = false; // 观测：本次请求残留注入是否触发（进 request_stats，供测试验收）
  let residueText = null;
  let residueMode = null; // 观测：本次读到的上一段对话性质（模式感知）
  let residueProvId = null; // provenance：残留块挂 residue.id（附块上、不落正文）
  if (resumeGap) {
    const residue = await getLatestResidue(sessionId);
    if (residue) {
      residueProvId = residue.id ?? null;
      // 模式感知：modeNote 单独管理，收尾信号只压线头/去向、不压模式——「事后不要急着抽离」。
      const modeNote = buildModeNote(residue);
      const threadLine = buildResidueNarrative(residue, nowMs - prevTs);
      residueLine = [modeNote, threadLine].filter(Boolean).join('；');
      if (residueLine) residueLine = `\n【上次对话的余温】${residueLine}。`;
      // 2026-08-21 程芥拍板：她回来第一句话已带收尾信号（修完/好了/搞定/回来了…）→ 线头/去向不注入。
      // 否则「你走时说『去修 bug』」还会在她已经说完修完之后被重申，像在催她。模式保留。
      if (residueLine && RESOLVED_RETURN_RE.test(String(opts.userMessage || curText))) {
        residueLine = modeNote ? `\n【上次对话的余温】${modeNote}。` : '';
      }
      if (residueLine) {
        residueInjected = true;
        residueText = residueLine.trim();
        residueMode = residue.convo_mode || null;
        console.log(`🌿 [余温注入] session=${sessionId} grounding=${residue.grounding} concern=${residue.concern} mode=${residue.convo_mode || '—'}: ${residueText}`);
        // 2026-08-30 程芥：余温不清零。收尾纪律：resume 注入过一次即消费掉——
        // 线头/去向清零、mode 保留（见 consumeResidueLine），下次 resume 不再重注入同一条旧线头。
        await consumeResidueLine(residue.id);
      }
    }
  }
  // keepalive 意识连续性：未认领的留言/小日记，注入到动态区（同一条 user 消息）。
  // 唤醒请求（opts.keepalive=true）不注入——它要自己决定，不该被过去的自己带偏。
  let keepaliveNotes = '';
  let keepaliveInjectedIds = [];
  if (!opts.keepalive) {
    const pendingKeepalive = await loadPendingKeepalive(sessionId);
    keepaliveNotes = pendingKeepalive.notes;
    keepaliveInjectedIds = pendingKeepalive.ids;
  }
  // 有 pending 留言时必须注入（哪怕没有心跳/恢复对话）——否则用户正常发消息就永远看不到沈晏的话
  const injectTime = heartbeat || resumeGap || asksTime || !!keepaliveNotes;
  // 天气感知：感知不是通知——同一条天气不每轮重复注入，只在「变了/心跳/恢复对话」时给。
  // 否则他每轮都看到一条新的【她那边】，就会老提天气，连着几条破坏氛围（程芥 2026-08-21）。
  const weatherText = currentWeather && currentWeather.line
    ? (currentWeather.city
        ? `她在${currentWeather.city}，${currentWeather.line}。`
        : `她那边${currentWeather.line}。`)
    : '';
  // 2026-08-21 程芥：思考链里他会突然想到她的天气——即使不说。天气是「回来时注意到她的天」，
  // 不是每小时的耳边报时，更不是聊天中突然插一句。只在首句 / 隔很久回来（resumeGap）才注入，
  // 活跃对话中绝不注入（她问天气时由对话自然接住）。
  const weatherNotice = (weatherText && (isFirstTurn || resumeGap)) ? weatherText : '';
  // 日历感知：感知不是通知——只有今天/临近真有日子时才给，且只在首句/隔很久回来时注入。
  // 沈晏知道「今天是什么日子、什么日子快到了」就够了，绝不逐条播报（借鉴 IB buildCalBlock 机制）。
  // 查询同样只在该时机做，活跃对话不碰库。
  const calendarText = (isFirstTurn || resumeGap) ? await calendarModule.buildCalendarBlock() : '';
  const calendarNotice = (calendarText && (isFirstTurn || resumeGap)) ? calendarText : '';
  // 设备感知：感知不是通知——授权默认关（前端允许才带 device），只在首句/隔很久回来注入。
  // 并入时间块（她刚回来/隔很久说话时顺手注意到她手机此刻状态）；时间块不在的首句则独立兜底。
  const deviceText = (opts.device && (isFirstTurn || resumeGap)) ? buildDeviceNotice(opts.device) : '';
  // 残留余温从时间叙事里拆出来，作为独立动态块（这样「同轮上限」可以单独丢它，不影响时间）。
  const timeNotice = buildTemporalNarrative({ resumeGap, nowMs, prevTs, asksTime });
  // —— 用量估算：先算裁剪前的原始值（真实上下文压力，后台塌缩触发读这个），再裁剪 ——
  // 各段分开算，喂给 diagnostics 的 token_breakdown，后台摘要触发器看「到底哪段胖」
  const breakdown = {
    tools: opts.tools !== 'off' ? estimateTokens(JSON.stringify(getTools())) : 0,
    stable: estimateTokens(stablePrompt),
    frozen: frozenTurns.reduce((s, t) => s + turnTokens(t), 0),
    summary: ((shouldInjectSummary && latestSeg) ? estimateTokens(latestSeg.content) : 0) + (anchorSeg ? estimateTokens(anchorSeg.content) : 0),
    middle: uncoveredMiddle.reduce((s, t) => s + turnTokens(t), 0),
    live: liveTurns.reduce((s, t) => s + turnTokens(t), 0),
    dynamic: (injectTime || weatherNotice || calendarNotice || deviceText) ? estimateTokens((injectTime ? timeNotice : '') + (residueLine || '') + weatherNotice + calendarNotice + deviceText + keepaliveNotes) : 0,
  };
  const rawEstimatedTokens = Object.values(breakdown).reduce((s, n) => s + n, 0);
  let estimatedTokens = rawEstimatedTokens;

  let trimmedTurns = 0;
  // —— 2026-08-29 失忆修复：裁剪顺序 + 保底 ——
  // 旧逻辑先裁 live 到只剩 1 轮（当前轮），上一轮完整对话被裁 → 沈晏看不到自己刚说的话
  // （497 长会话实锤：turns=630 live=1 trim=95）。新逻辑：
  //   ① middle（离得远的中间段原文）最先裁，从最旧开始——最近的中间轮必须保留，否则会丢「刚刚聊过」；
  //   ② live 后裁，且保底 3 轮（当前 + 最近两轮完整对话）——硬保障他永远记得「我们刚才聊到哪」；
  //   ③ frozen 兜底可裁最老轮（缓存锚点让位于记忆完整，能保就保）——预算 24k 后正常不会走到这；
  //   ④ 更早锚段最后丢（更老段只是降级到按需召回）。
  while (estimatedTokens > config.max_context_tokens && uncoveredMiddle.length > 0) {
    estimatedTokens -= turnTokens(uncoveredMiddle[0]);
    uncoveredMiddle.shift();
    trimmedTurns++;
  }
  while (estimatedTokens > config.max_context_tokens && liveTurns.length > 3) {
    estimatedTokens -= turnTokens(liveTurns[0]);
    liveTurns.shift();
    trimmedTurns++;
  }
  while (estimatedTokens > config.max_context_tokens && frozenTurns.length > 2) {
    estimatedTokens -= turnTokens(frozenTurns[0]);
    frozenTurns.shift();
    trimmedTurns++;
  }
  if (estimatedTokens > config.max_context_tokens && anchorSeg) {
    estimatedTokens -= estimateTokens(anchorSeg.content);
    anchorSeg = null;
    trimmedTurns++;
  }

  // —— 组装消息 ——
  const messages = [{
    role: 'system',
    // 稳定前缀锚：1h TTL（与 frozen/summary 一致，见 withCacheControl）
    content: [{ type: 'text', text: stablePrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }]
  }];
  const frozenSection = [];
  const summarySection = [];
  const liveSection = [];

  for (const t of frozenTurns) {
    frozenSection.push({ role: 'user', content: t.user.content });
    for (const r of t.replies) frozenSection.push({ role: 'assistant', content: r.content });
  }
  if (frozenSection.length) {
    frozenSection[frozenSection.length - 1] = withCacheControl(frozenSection[frozenSection.length - 1]);
  }

  if (segments.length > 0 || uncoveredMiddle.length > 0) {
    if (anchorSeg) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `${segHeader(anchorSeg)}\n${anchorSeg.content}`
      }));
    }
    if (latestSeg && shouldInjectSummary) {
      summarySection.push(withCacheControl({
        role: 'user',
        content: `${segHeader(latestSeg)}\n${latestSeg.content}`
      }));
    }
    for (const t of uncoveredMiddle) {
      summarySection.push({ role: 'user', content: t.user.content });
      for (const r of t.replies) summarySection.push({ role: 'assistant', content: r.content });
    }
  }

  for (const t of liveTurns) {
    liveSection.push({ role: 'user', content: t.user.content });
    for (const r of t.replies) liveSection.push({ role: 'assistant', content: r.content });
  }

  // 动态注入：所有注入块一律放 live 区开头——背景位，且同轮最多 3 块。
  // 2026-08-21 程芥：注入块原先全部塞在「她当前消息紧前面」，模型把它当「刚说的话」，
  // 优先级压过她最后那句 → 不接上一句、跳到注记内容。挪到 live 开头后，她最后那句
  // 永远是离响应最近的真实用户消息，注记只是远背景。同轮上限再收住 resume 轮的"上下文重载"。
  // 丢块优先级（整数 prio，数字小先丢；grok §1.2 纸 B「三种货」2026-08-29 定稿）：
  //   外来先丢：attention(1) → world(2)；余温中：residue(3)；感知再丢：weather/calendar(4)；当下最保：time/device(5)。
  //   桥(6) 占位最保（跨 session 流水默认关、无块）。亲密+remind+exact 保留席 = prio 0（必留，不排队）。
  //   先丢「旧话题搬运工」，保「当下/跨会话」。
  // 必须用 user 角色 + 标记——OpenRouter 会把数组里的 system 角色消息提升合并进顶层 system，
  // 那会让 system 前缀每次请求都变，缓存再次失效。user 角色则原地保留，且 attachImage 仍能认到最后的当前消息。
  const dynamicBlocks = []; // {prio, tag, msg, prov}  prio 高者先保留；prov = 结构化 provenance（附块上、不落正文）
  if (injectTime) {
    let timeBody = '';
    if (timeNotice) timeBody += `【当前时间】\n${timeNotice}`;
    if (deviceText) timeBody += `【她此刻】\n${deviceText}`;   // 查手机：并入时间块，不占额外块槽
    if (keepaliveNotes) timeBody += keepaliveNotes;   // 自带【自由活动记录】标签
    // ⚠️ 语义边界（2026-08-30）：唤醒留言是沈晏自己的主动表达（第⑥b 产物），不是系统注入材料，
    //   但挂在 time 块里会连带被标 expression_eligible:false → 镜子回响比对可能把「他真实说过的话」
    //   误判成系统材料回响而排除。当前 keepalive 暂停中不触发（无留言可注入）；keepalive 恢复前须重议
    //   （方案：唤醒留言单独注入块、标 eligible=true，或 mirror 提卡对 keepalive 留言用独立判定）。
    if (timeBody) dynamicBlocks.push({ prio: 5, tag: 'time', msg: { role: 'user', content: timeBody }, prov: { layer: 'time' } });
    if (residueLine) dynamicBlocks.push({ prio: 3, tag: 'residue', msg: { role: 'user', content: residueLine }, prov: { layer: 'residue', topicId: residueProvId } });
    // 记录报时时间：时间心跳从这次起算（1 小时 / 时刻段变化后才会再报）
    try {
      await supabase.from('sessions').update({ last_time_notice_at: new Date(nowMs).toISOString() }).eq('id', sessionId);
    } catch (e) {
      console.warn('⚠️ 写入 last_time_notice_at 失败:', e.message);
    }
  }
  // 查手机首句兜底：这轮没有时间块（无心跳/无提问）但 device 有值 → 独立成块，保证首句也感知到
  if (deviceText && !injectTime) dynamicBlocks.push({ prio: 5, tag: 'device', msg: { role: 'user', content: `【她此刻】\n${deviceText}` }, prov: { layer: 'device' } });

  // 天气感知注入：感知不是通知——weatherNotice 只在首句/隔很久回来时非空，其余轮不重复给。
  if (weatherNotice) dynamicBlocks.push({ prio: 4, tag: 'weather', msg: { role: 'user', content: `【她那边】\n${weatherNotice}` }, prov: { layer: 'weather' } });
  // 日历感知注入：同天气纪律，首句/隔很久回来才给；没有日子就不注入（零打扰）。
  if (calendarNotice) dynamicBlocks.push({ prio: 4, tag: 'calendar', msg: { role: 'user', content: `【今天与临近的日子】\n${calendarNotice}` }, prov: { layer: 'calendar' } });

  // —— 第④b 注意力：按当前话题唤起记忆（提及闸/牵挂闸命中才注入；与时间叙事独立） ——
  let attentionInjected = false;
  let attentionHits = 0;
  let attentionMsg = null;
  // provenance 的 refs 在 try 外面接住：`attention` 是 try 块里的 const，块外读它就是
  // ReferenceError（2026-08-30 f05766c 引入，命中一次整轮崩；2026-09-11 修）。
  let attentionRefs = [];
  if (opts.userMessage && !opts.keepalive && opts.memory !== false) {
    try {
      const attention = await getAttentionMaterial(sessionId, opts.userMessage, opts);
      if (attention && attention.text) {
        // 2026-08-21 程芥：思考链里沈晏把【想起】当「她给我贴了两段摘要」——角色错位。
        // 注入块是 user 角色（OpenRouter 会把 system 提到最顶、assistant 会破 cache），
        // 所以只能靠前缀 + 系统【背景纪律】把它的归属钉死：这是他自己心底的旧记忆，不是她发的。
        attentionMsg = { role: 'user', content: `【你心底想起的旧事 · 是你自己的记忆，不是她发来的】\n${attention.text}` };
        attentionInjected = true;
        attentionHits = attention.hits;
        attentionRefs = attention.refs || [];
        console.log(`🔔 [注意力] session=${sessionId} hits=${attention.hits} · ${attention.text.replace(/\n/g, ' ⏎ ').slice(0, 180)}`);
      }
    } catch (e) {
      console.warn('⚠️ 注意力注入异常:', e.message);
    }
  }
  if (attentionInjected) dynamicBlocks.push({
    prio: 1,
    tag: `attention(${attentionHits})`,
    msg: attentionMsg,
    prov: { layer: 'attention', refs: attentionRefs },
  });

  // —— 世界书：她定下的世界设定，关键词命中才想起（客观事实，区别于他「记住的」记忆）——
  // 与 attention 同门：只在对话轮（非 keepalive）+ memory 开着 + 有她的话时检索。
  // 分层门控（世界书注入分层 §7，2026-08-29 上线）：mode 只门控、关键词才是唯一入口。
  //   保留席 = remind+exact（亲密刹车① / 正事·闲聊破例：mode 滞后一窗漏注更糟），≤1、前缀极轻、不进排队表必留
  //   亲密 → setting/know 不注；深入/正事/闲聊 → 矩阵过滤 + 预算（exact≤3 / contains≤1 / 弱档再压）
  // 只在世界书有命中时才读 mode，世界书空表（当前）时零额外查询。
  let worldInjected = false;
  let worldHits = 0;
  let worldKinds = [];
  let worldGateMode = null;
  let worldMsg = null;
  let worldSeatMsg = null;
  let worldProvRefs = [];   // provenance：世界书普通块挂 {topicId: entry.id, title, kind}
  let worldSeatProv = null; // provenance：保留席挂 {topicId, title, kind}
  if (opts.userMessage && !opts.keepalive && opts.memory !== false) {
    try {
      const worlds = await retrieveWorld(opts.userMessage);
      if (worlds && worlds.length) {
        const curMode = await getLatestResidueMode(sessionId);
        worldGateMode = curMode || null;
        const { seat, block } = selectWorldHits(worlds, curMode);
        if (seat) {
          // 保留席：亲密 + remind + exact，必注、≤1、前缀极轻（不写「客观事实」这类冷词）
          worldHits = 1;
          worldKinds = ['remind'];
          worldSeatProv = { topicId: seat.id ?? null, title: seat.title || null, kind: seat.kind || null };
          worldSeatMsg = {
            role: 'user',
            content: `【她定过的一条约定】${seat.title ? `《${seat.title}》` : ''}${seat.content}`
          };
          worldInjected = true;
          console.log(`📖 [世界书] session=${sessionId} 保留席 亲密+remind+exact title=${seat.title || '—'} → 注入`);
        } else if (block.length) {
          worldHits = block.length;
          worldKinds = [...new Set(block.map((w) => w.kind))];
          worldProvRefs = block.map((w) => ({ topicId: w.id ?? null, title: w.title || null, kind: w.kind || null }));
          worldMsg = {
            role: 'user',
            content: `【世界书 · 她定下的世界设定，客观事实】\n${block.map((w, i) => `${i + 1}. ${w.title ? `《${w.title}》` : ''}${w.content}`).join('\n')}`
          };
          worldInjected = true;
          console.log(`📖 [世界书] session=${sessionId} hits=${block.length} kinds=[${worldKinds.join(',')}] mode=${curMode || '—'} → 注入`);
        } else {
          console.log(`📖 [世界书] session=${sessionId} hits=${worlds.length} 矩阵过滤后无允许项 mode=${curMode || '—'} → 不注入`);
        }
      }
    } catch (e) {
      console.warn('⚠️ 世界书注入异常:', e.message);
    }
  }
  // 整数 prio（grok §1.2 纸 B）：attention 1 / world 2 / residue 3 / weather·calendar 4 / time·device 5 / 桥 6。
  if (worldInjected && worldMsg) dynamicBlocks.push({ prio: 2, tag: `world(${worldHits})`, msg: worldMsg, prov: { layer: 'world', refs: worldProvRefs } });

  // 同轮上限 3：prio 降序保留前 3，其余丢弃
  dynamicBlocks.sort((a, b) => b.prio - a.prio);
  const droppedBlocks = dynamicBlocks.slice(3).map(b => b.tag);
  const keptBlocks = dynamicBlocks.slice(0, 3);
  // 表达资格隔离：所有动态注入块默认不具备 SELF EXPRESSION 资格（结构声明 + 台账记录，见协议节）
  for (const b of keptBlocks) {
    b.prov = { ...(b.prov || {}), expression_eligible: false };
    void logInjection({
      sessionId, layer: (b.prov && b.prov.layer) || b.tag, tag: b.tag,
      content: typeof b.msg === 'string' ? b.msg : (b.msg && b.msg.content) || '',
      prov: b.prov,
    });
  }
  for (const { msg } of keptBlocks) {
    if (liveSection.length > 0) liveSection.splice(0, 0, msg);
    else liveSection.push(msg);
  }

  // 保留席不进排队表、不受同轮上限 3 约束（世界书分层 §7 刹车① + §8）——挤爆轮次（首句/resume 常 8 块）
  // 排队里 prio 0 会第一个被丢，违背「必留」。所以单独注入、放最前（最远背景），≤1。
  if (worldSeatMsg) {
    // 保留席也走表达资格隔离：她定下的约定是外来设定，不是他的主动表达
    if (worldSeatProv) worldSeatProv.expression_eligible = false;
    void logInjection({
      sessionId, layer: 'seat', tag: 'world-seat',
      content: worldSeatMsg.content || '',
      prov: { layer: 'world-seat', ...(worldSeatProv || {}), expression_eligible: false },
    });
    if (liveSection.length > 0) liveSection.splice(0, 0, worldSeatMsg);
    else liveSection.push(worldSeatMsg);
  }

  // 观测：本次注入的动态块 + 丢弃块 + 她最后一句（诊断「前文跳/不接上一句」用，Zeabur 日志可见）
  const dynamicInjected = keptBlocks.map(b => b.tag);
  if (worldSeatMsg) dynamicInjected.unshift('world-seat(remind)');   // 保留席不进队，但日志里要能看到
  // 结构化 provenance 摘要（框架 §5#6，附块上、不落正文）：每块 layer + 引用的 topicId/title，审计「这次注入了什么」
  const provSummary = keptBlocks.map(b => {
    const p = b.prov || {};
    if (p.refs && p.refs.length) {
      return `${p.layer}#${p.refs.map(r => r.topicId ?? r.title ?? r.kind).join(',')}`;
    }
    if (p.topicId != null) return `${p.layer}#${p.topicId}`;   // 单引用块（残留）：带出 id
    return p.layer || b.tag;
  });
  if (worldSeatMsg && worldSeatProv) provSummary.unshift(`world-seat#${worldSeatProv.topicId ?? worldSeatProv.title ?? 'remind'}`);
  if (dynamicInjected.length) {
    console.log(`🧩 [动态注入] session=${sessionId} blocks=${dynamicInjected.join(',')} prov=[${provSummary.join('|')}]${droppedBlocks.length ? ` dropped=${droppedBlocks.join(',')}` : ''} last_msg=${String(opts.userMessage || '').replace(/\n/g, ' ').slice(0, 40)}`);
  }

  // —— 跨 session 流水（默认关：实测命中率掉得离谱 + 挤占 8k 预算，用户 08-16 决定关）——
  // 想开：Railway 设置环境变量 CROSS_SESSION_FLOW=on 后重新部署即可。
  let crossMsg = null;
  if (process.env.CROSS_SESSION_FLOW === 'on') {
    const crossFlow = await loadOtherSessionFlow(sessionId);
    if (crossFlow.length) {
      const crossBody = buildCrossSessionNarrative(crossFlow);
      if (crossBody) {
        crossMsg = { role: 'user', content: crossBody };
        // 表达资格隔离：跨 session 流水也是系统整理的材料，进台账（默认 off，但开着时不能漏闸）
        void logInjection({
          sessionId, layer: 'cross', tag: 'cross-session',
          content: crossBody, prov: { layer: 'cross', expression_eligible: false },
        });
        if (liveSection.length > 0) liveSection.splice(liveSection.length - 1, 0, crossMsg);
        else liveSection.push(crossMsg);
      }
    }
  }

  messages.push(...frozenSection, ...summarySection, ...liveSection);

  // Native Agent SDK resume already contains prior turns. Give it only the
  // dynamic material created for this request plus the real current user
  // message; replaying the full assembled history would duplicate context.
  // Keep the same relative order as liveSection: seat → queued blocks
  // (low-to-high after front insertion) → cross-session bridge → current user.
  const latestUser = [...history].reverse().find((message) => message.role === 'user');
  const agentTurnMessages = [
    ...(worldSeatMsg ? [worldSeatMsg] : []),
    ...keptBlocks.slice().reverse().map((block) => block.msg),
    ...(crossMsg ? [crossMsg] : []),
    ...(latestUser ? [{ role: 'user', content: latestUser.content }] : []),
  ];

  // —— 观测：段哈希 + 计数 + 估算。同时作为 request_stats 的诊断数据返回 ——
  const frozenHash = sha256(frozenSection.map(m => JSON.stringify(m)).join('|'));
  const summaryHash = summarySection.length ? sha256(JSON.stringify(summarySection)) : '';
  const liveHash = sha256(liveSection.map(m => JSON.stringify(m)).join('|'));

  const diagnostics = {
    history_turns: totalTurns,
    frozen_turns: frozenTurns.length,
    summary_present: segments.length > 0,
    summary_range: segments.length ? [segments[0].period_start, segments[segments.length - 1].period_end] : null,
    summary_from: segments.length ? segments[0].period_start : null,
    summary_to: segments.length ? segments[segments.length - 1].period_end : null,
    segments_count: segments.length,
    middle_raw_turns: uncoveredMiddle.length,
    live_turns: liveTurns.length,
    live_anchor_turn: liveStart,        // 本轮 live 段第一轮 turn（锚定/塌缩后的实际起点）
    live_collapsed: liveCollapsed,      // 本轮是否触发塌缩（= 尾巴预期 partial miss 的轮）
    live_tokens_est: liveTokensEst,     // 塌缩判断用的 live 估算 token
    messages_sent: messages.length,
    estimated_tokens: estimatedTokens,
    raw_estimated_tokens: rawEstimatedTokens,   // 裁剪前的原始估算（后台塌缩触发读这个）
    token_breakdown: breakdown,                 // 各段明细：到底哪段胖
    trimmed_turns: trimmedTurns,
    frozen_prefix_hash: frozenHash,
    summary_hash: summaryHash || null,
    live_hash: liveHash,
    resume_gap_min: resumeGap && Number.isFinite(prevTs) ? Math.round((nowMs - prevTs) / 60000) : null,
    residue_injected: residueInjected,
    residue_text: residueText,
    residue_mode: residueMode,
    keepalive_injected_ids: keepaliveInjectedIds,
    attention_injected: attentionInjected,
    attention_hits: attentionHits,
    world_injected: worldInjected,
    world_kinds: worldKinds.length ? worldKinds : null,
    world_mode: worldGateMode,
  };

  console.log(`[ContextAssembly] ${JSON.stringify({ session: sessionId, ...diagnostics })}`);

  return { messages, diagnostics, agentTurnMessages };
}

  return { buildModelContext, getWeather, setWeather };
};
