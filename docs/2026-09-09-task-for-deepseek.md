# 交接任务单（给 DeepSeek）· 2026-09-09

写给一个**没有本次会话上下文**的执行者。所有前提都写在下面，不需要去问、也不需要去猜。
两件任务互不依赖，可以分开做。**任务 A 优先。**

---

## 背景（30 秒读完）

`shenyan-backend/server.js` 原来是 9600 行的单文件，正在拆分：

- **第 1 步（已完成）**：抽纯函数到 `lib/` —— `tools-schema.js` / `cache-control.js` / `time.js` / `share-parse.js`
- **第 2 步（进行中）**：抽路由域到 `routes/` —— 已完成 `backup` / `music` / `calendar` / `share`

拆分靠一条护栏保命：`test/routes.test.cjs` 会加载 `server.js`、遍历 Express 真实路由栈，
与 `test/routes.snapshot.json`（84 条）逐条比对。**跑 `npm test` 必须 9/9 全绿。**

---

## ⛔ 绝对不要做的事

1. **不要动 `routes/auth.js` 相关的任何东西，也不要去抽鉴权路由。**
   鉴权中间件的注册顺序决定了「哪些请求需要登录」，搬错位置 = 把门拆了。这块留给人做。
2. **不要动 `server.js` 里任何路由的注册顺序。** 本项目已经因为路由顺序出过 P0
   （`POST /api/keepalive/check` 被 `/api/keepalive/:action` 遮蔽，外部 cron 入口死了很久）。
3. **不要修改任何现有函数的逻辑。** 本次两个任务都是**只增不改**。
4. **不要更新 `test/routes.snapshot.json`。** 那是行为不变式，任务 A/B 都不该让它变。
   如果它变了，说明你改错了东西，回退。

---

## 任务 A：给 `lib/` 四个模块补单元测试

### 为什么值得做
这四个模块是从 9600 行里搬出来的，搬运时**用临时脚本验过一次行为一致**，但那些验证脚本
是一次性的、没有入库。现在它们没有任何常驻测试保护 —— 下次有人改 `markCacheTail`
或时间格式化，没有任何东西会拦住他。

### 要做什么
在 `test/` 下新建 **4 个文件**，用 `node:test`（项目已有的测试框架，不要引入新依赖）：

| 新文件 | 测试对象 |
|---|---|
| `test/lib-time.test.cjs` | `lib/time.js` 的 12 个函数 |
| `test/lib-cache-control.test.cjs` | `lib/cache-control.js` 的 6 个函数 |
| `test/lib-share-parse.test.cjs` | `lib/share-parse.js` 的 7 个函数 |
| `test/lib-tools-schema.test.cjs` | `lib/tools-schema.js` 的 `getTools()` |

### 写法参照
照抄 `test/sse-parser.test.cjs` 的风格：`require('node:test')` + `require('node:assert')`，
中文测试名说清「测的是什么行为」。

### 每个文件必须覆盖的点

**`lib-time.test.cjs`**（⚠️ 必须用**固定时间戳**，不能用 `Date.now()`，否则结果不可复现）
- `shPartOfDay`：凌晨 / 上午 / 午后 / 晚上 四档各至少一例
- `relativeTimeLabel(ts, nowMs)`：今天 / 昨天 / 更早 三档
- `coarseAgo`：0、30 秒、45 分钟、3 小时、26 小时、5 天、40 天
- `humanizeDuration`：不到 1 分钟 / 分钟 / 小时 / 小时+分 / 天+小时
- `shDateKey`：**同一天的两个不同时刻必须得到相同的键**（它的唯一用途就是同日比较）
- 跨 UTC 日界的例子（上海 UTC+8，所以 UTC 19:30 已经是次日凌晨）

**`lib-cache-control.test.cjs`**
- `estimateTokens`：空串、null、纯 ASCII、纯中文、混合
- `withCacheControl`：`role:'tool'` 必须**原样返回不加断点**；字符串 content 会被包成数组；
  数组 content 只在**最后一块**加 `cache_control`
- `countCacheControlBlocks`：null、空数组、多条消息累加
- `markCacheTail`：**这是命中率那条线的关键**，必须覆盖
  - 正常情况：断点挂在**倒数第二条** user 消息上（不是最后一条）
  - 只有一条 user：不挂
  - 空数组：不炸
  - `content` 为 null 的 assistant 消息要被跳过
- `stripCacheControl`：有/无 `cache_control` 字段两种

**`lib-share-parse.test.cjs`**（自己造 HTML 字符串，**不要发网络请求**）
- `stripHtml`：`<script>`/`<style>` 内容要被去掉；HTML 实体要还原
- `extractMetaHtml`：og 系列、twitter 系列、JSON-LD 三种来源各一例；相对图片 URL 要转成绝对
- `resolveAbsUrl`：相对路径 `/a.png`、绝对 URL、协议相对 `//cdn/x.png`
- `lenientJsonParse`：合法 JSON、非法 JSON（应返回 null 或不抛）
- `digXhsNote`：给一个不含 `__INITIAL_STATE__` 的 HTML，应安全返回空值而不抛

**`lib-tools-schema.test.cjs`**
- `getTools()` 返回数组，长度 **24**
- 每一项结构完整：有 `function.name`、`function.description`、`function.parameters`
- 工具名**唯一**（不能有重名）
- 每个 `parameters.required` 里列的字段，必须都在 `parameters.properties` 里存在
  （这条最有价值：它能抓出「必填字段写错名字」这类改契约时的手滑）

### 完成标准（缺一不可）
1. `npm test` 全绿，且**总用例数比现在多**（现在是 9）
2. `test/routes.snapshot.json` **没有被修改**（`git diff` 里不该出现它）
3. `git diff --stat` 里**只有新增的 4 个 test 文件 + package.json**，
   `server.js`、`lib/*`、`routes/*` 一行都不能改
4. 如果发现某个函数的真实行为和你的预期不符 —— **以代码为准写测试，不要去改代码**。
   把这类发现写进下面的「发现记录」，交回给人判断。

### package.json 要改的一处
把 `scripts.test` 里的文件列表加上这 4 个新文件（保持现有的都在）。

---

## 任务 B：同步《整体框架·当前状态净本》里已知过期的三处

文件在**前端仓库**：`angel-garden-diary/整体框架·当前状态净本.md`

2026-09-09 的审计发现文档与代码有出入。**只改这三处，不要顺手改别的**：

1. **§4「嘴」缓存锚定那条**：写着 `live_max_tokens`「默认 20k」，
   代码里实际是 **40000**（见 `server.js` 的 `getContextConfig` 里 `defaults`）。以代码为准。

2. **§4 缓存锚定那条末尾**：写着「**验证中**：等真实对话流水对比（2026-08-30 已部署，未实测）」。
   已经实测过了，改成：
   > **已验证（2026-09-09）**：拿 `request_stats` 实测，锚定生效当天单请求命中率
   > **中位数 99.5%**，75 分位 99.8%，>90% 的占 65%，<20% 的占 18%（冷启动全写）。
   > 锚点只在塌缩时推进，是设计行为。
   > ⚠️ 别用日聚合看命中率 —— 它按 token 加权，一次 38k 冷启动全写抵得过几十次
   > 99.8% 命中，日均只有 76.4%，严重低估。

3. **§4 保温 Keeper 那条**：文档说它「治冷启动全写」，说大了。补一句边界：
   > 边界：只覆盖 **50 分钟 ~ 6 小时**的空档（<50min 缓存还新鲜；>6h 判定不回来了自停省钱），
   > 且 snapshot 是进程内 Map、重启即失。**离开一天以上回来，第一条消息必然是冷启动全写**，
   > 这是设计取舍不是缺陷。

### 完成标准
- 只有这一个 `.md` 文件被改动
- 不要改动文档里其他任何章节

---

## 发现记录（做任务时如果发现别的问题，写在这里，不要自行修）

<!-- 格式：文件:行号 —— 发现了什么 —— 为什么觉得不对 -->
- lib/time.js:108-110 —— `memoryMdLabel` 跨年输入返回 `[2025年年8月25日]`（双「年」）—— `toLocaleDateString(zh-CN,{year:'numeric'})` 已自带「年」后缀，模板里又拼了一个 `年`。只在日期属往年时触发（2026 年看 2025 的旧记忆就会中）。测试只锁了「今年不带年」的形态，没把 bug 冻进断言。
- 任务单「shPartOfDay 四档」写的是「凌晨/上午/午后/晚上」，代码里 14–17 点实际返回「下午」不是「午后」—— 任务单笔误，测试按代码写「下午」。
- lib/share-parse.js `lenientJsonParse` —— 任务单说「非法 JSON 应返回 null 或不抛」，真实行为是**抛 SyntaxError**（它只把 undefined/NaN/Infinity 清成 null，救不了真正的垃圾）。链路安全是因为 digXhsNote 内部 try/catch。测试如实断言 `assert.throws`。
- 任务 B target 3 —— 任务单说「§4 保温 Keeper 那条：文档说它治冷启动全写」，但 `angel-garden-diary/整体框架·当前状态净本.md` 里**不存在这样一条**：全文 + git 全史 + worktree 副本都搜不到「保温/Keeper/治冷启动全写」，Keeper 独有措辞（5min 巡检/≥50min 闲置/6h 自停/占位续 TTL）也零命中。整份净本只有 §4 嘴段一条「缓存锚定」bullet（行 147，本次已改 40000 + 已验证两处）。「保温 Keeper 治冷启动全写 + 50min~6h 边界」的描述实际只写在 CHANGELOG-框架审.md「2026-09-01」节（锚定落档后唯一同步渠道）。净本从 09-01 起就缺 Keeper 这条库存行——**建议由 opus 判断**：target 3 的边界注挂在 CHANGELOG 那节即可，还是净本该补一条 Keeper 的「存在」行（含你给的边界句），我不擅自加。

