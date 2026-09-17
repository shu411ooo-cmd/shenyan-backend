# shenyan-backend

## Claude Agent SDK

主聊天在设置 `CLAUDE_CODE_OAUTH_TOKEN` 后默认使用 Claude Agent SDK；测试模式
（`model` 含 `deepseek`）、图片消息和前端 MCP 委托仍走原有通道。未设置 Token 时
也会保持原有 OpenRouter/DeepSeek 行为。

Zeabur 必需变量：

```text
CLAUDE_CODE_OAUTH_TOKEN=<claude setup-token 生成的值>
```

不要同时设置 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或
`ANTHROPIC_BASE_URL`。适配器会在 Claude 子进程中再次移除这些高优先级变量，
避免订阅认证被静默覆盖。

可选变量：

```text
CLAUDE_AGENT_ENABLED=true
CLAUDE_AGENT_MODEL=claude-sonnet-4-6
CLAUDE_AGENT_MAX_CONCURRENCY=1
CLAUDE_AGENT_TIMEOUT_MS=180000
CLAUDE_AGENT_TOOL_TIMEOUT_MS=30000
CLAUDE_AGENT_MAX_TURNS=4
```

安全边界：SDK 不加载用户/项目设置，不持久化 Claude Code session，不开放 Bash、
Read、Write、Edit 等内置工具，只开放后端 `lib/tools-schema.js` 中定义的领域工具。
