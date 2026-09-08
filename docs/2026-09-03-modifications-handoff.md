# 2026-09-03 修改交接文档

> 本轮会话的全部代码改动记录（bug 修复 + WrenWen/Kelivo 设计借鉴落地）。
> 未提的 = 没动。所有 JS 文件语法检查通过；SSE 测试 7/7 通过。

## 需要执行的 SQL（Supabase SQL Editor 各跑一遍，均幂等）

1. `migrations/2026-08-17-settings-columns.sql`（已改）：UNIQUE 约束幂等化 + DELETE 限 global
2. `migrations/2026-09-03-attention-satisfy-tuning.sql`（新增）：注意力/满足回落 9 个调参列
3. `migrations/2026-09-03-perf-indexes.sql`（新增）：5 个性能索引

---

## 一、server.js

### 安全 / 稳定性
- 鉴权中间件包 try-catch；新增全局 Express 错误处理器（路由全部注册之后）
- 启动校验 SUPABASE_URL / SUPABASE_KEY，缺失直接退出
- 登录接口加限流：同 IP 15 秒 5 次（429），定时清理
- `SITE_KEY` 兜底只认 `x-site-key` header，移除 query 参数通道
- Ombre 3 处 fetch 加 `AbortSignal.timeout(30s/15s)`
- `mcpPending` 每 2 分钟清过期条目（防内存泄漏）
- `memoryWriteProcessed` >5000 丢最旧一半（防无界增长）
- `voiceCache` 满 2000 淘汰最旧一半（原为全清）
- 修复 `extractJsonWindow(html, marker, startPos)` 缺失的第三参数（小红书多状态块挖掘）

### 人格层 fail-closed（WrenWen 借鉴）
- `getSystemPrompt()`：DB 查询出错 → 抛错（本轮不发生）；DB 空才回退 env；两边都空 → 抛错。不再退 hardcode 空壳人格
- 下游适配：`runMirrorOnce` / `handleRetreat` / `handleRewriteStone` 转各自身份的错误返回

### 采样温度（防人格漂移）
- `callDeepSeek` / `callReplyModel` 默认温度 0.8 → 0.7
- 朋友圈回复 / 评论回复显式 0.9 → 0.7（共 4 处）

### 注意力召回（WrenWen 借鉴，参数已入 settings 表）
- antiEcho：同 topic 24h 内注入过 → 打分×0.5；72h 内 → ×0.8；注入后记回声账
- 近 N 天位限：最近记忆最多占 `recent_seats` 位，超出让位给远期
- 联想独立 `assoc_seats` 席：关系扩展不吃主召回名额
- `recallDaily` 补 `recentCap` / `echoDemoted` 计数字段
- 参数读取走 `getAttentionConfig()`（列不存在时回退同款默认）

### 欲望/唤醒（WrenWen 借鉴）
- unavailable 纪律：`buildInnerState` 读驱动账失败 → 大声报警 + `degraded` 标记；`pickWakeIntent` 返回 rest+unavailable；`runKeepalive` 遇 unavailable 关闭主动留言出口（不落库）
- 满足回落：她 6h 内来过 → attachment/social/libido ×0.8（`getSatisfyConfig()`，settings 可调）

### 性能
- `handleWantList` N+1 批量化：400 次查询 → 1 次 `in` 查询内存分桶

### 备份 / 恢复（Kelivo 借鉴，新 API）
- `POST /api/backup/export`：17 张白名单表全量导出 JSON（翻页拉全量）
- `POST /api/backup/import`：白名单校验 + `wipe=true` 才清空 + 分批插入（500/批）

### 流式（Kelivo 工程方法借鉴）
- `streamOpenRouter` / `streamDeepSeek` 的解析逻辑抽到纯模块 `sse-parser.js`（分帧 + delta 合并，行为零变化）
- text SSE 事件新增 `sentence_end` 标记字段（句末标点启发式，纯附加，前端可选消费）
- 非流式路径：工具二轮思考链不再丢，与首轮拼接进响应/入库

---

## 二、新增文件

| 文件 | 用途 |
|---|---|
| `sse-parser.js` | 纯流式解析模块（回放测试对象） |
| `scripts/record-sse-trace.cjs` | 轨迹录制：`npm run record:sse -- --provider openrouter --case xxx --prompt "…"`（key 只读环境变量，不落盘） |
| `test/sse-parser.test.cjs` | 单测 6 项（分帧/合并/sentence_end） |
| `test/sse-replay.test.cjs` | 轨迹回放：扫 `sse-traces/*/*/` 断言 expected.json |
| `sse-traces/synthetic/basic/` | 合成轨迹 fixture（离线可跑） |
| 3 个迁移文件 | 见文首 |

- `package.json`：新增 `test:sse`、`record:sse` 脚本
- `.gitignore`：`sse-traces/*`（真实轨迹敏感，不入 git），synthetic 除外

## 三、ringdonut（语音通话子系统）

- `backend/server.js`：`app.listen` 加 error 处理；`trust proxy` 开启
- `backend/routes/call.js`：LLM 失败回滚已写入的用户 turn；心跳 update 错误显式日志；`/finish` 查询加 limit(2000)
- `backend/adapters/host.js`：4 处空 catch 补错误日志；SITE_KEY 去 query 通道
- `backend/adapters/llm.js`：`cache_control` 从请求体顶层移入 system content block（缓存现在真正生效）
- `backend/routes/voice-input.js`：用 `req.ip`（trust proxy 后）替代可伪造的 X-Forwarded-For；Map 清理循环改安全写法
- `backend/services/voiceInput.js`：base64 解码前先验大小（DoS）

## 四、迁移 / 脚本 / SQL

- `sql/` 下 4 个 schema 文件移除 `DISABLE ROW LEVEL SECURITY`（与 2026-08-13 RLS 迁移统一）
- `migrations/2026-08-17-settings-columns.sql`：UNIQUE 约束用 DO 块幂等化；DELETE 去重限 `global`
- `scripts/seed-diary-temp.js`：insert 返回空 data 时不再崩溃
- `scripts/link-memory-relations.js`：模型名曾误改 `deepseek-chat`，已**撤回**恢复 `deepseek-v4-flash`（无净变更）

## 五、前端需要配合的点（本仓库无前端源码）

1. **`sentence_end`**：text 事件多了一个 `sentence_end: true/false`，前端可在 true 时才折行/markdown 重排；老前端忽略即行为不变
2. **根治引号/省略号分流**：后端已给信号，真正的平滑还需前端 delta 级 ~200ms 攒批缓冲
3. **非流式 thinking**：后端响应一直带 `thinking` 字段，前端非流式模式若没渲染思考块是纯前端缺
4. **备份入口**：`/api/backup/export` / `import` 已可用，前端可加"导出/恢复"按钮