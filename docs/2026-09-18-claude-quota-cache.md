# Claude 订阅额度缓存（后端第一步）

> 日期：2026-09-18  
> 状态：实现完成，待生产真对话取样

## 做了什么

- 每条 Claude Agent 对话建立的 `Query` 收到 `system/init` 后，调用一次实验性 usage API。
- 强制 `skipBehaviors: true`，不扫描最近七天本地 transcript；只取订阅类型与额度窗口。
- 同时接住 SDK 主动发出的 `rate_limit_event`，按窗口更新缓存。
- 新增受登录门保护的 `GET /api/claude-agent/quota`，只返回内存中的 last-known-good。

## 明确不做什么

- 查询接口不会新建 Claude Query、CLI 进程或会话。
- 刷新失败不会清空上一份成功快照，也不会阻断当前聊天。
- 不把 SDK 实验性原对象直接交给前端，不暴露 session cost、行为分析、UUID 或 session id。
- 服务刚重启且尚未发生订阅线路对话时返回 `available:false, reason:"not_observed"`，不会伪造 0%。

## 对外 DTO

```json
{
  "available": true,
  "stale": false,
  "source": "usage",
  "subscriptionType": "pro",
  "windows": [
    {
      "id": "five_hour",
      "scope": "plan",
      "displayName": null,
      "utilization": 42.5,
      "resetsAt": "2026-09-18T20:00:00.000Z",
      "status": null
    }
  ],
  "extraUsage": null,
  "reason": null,
  "updatedAt": "2026-09-18T19:00:00.000Z",
  "lastAttemptAt": "2026-09-18T19:00:00.000Z",
  "lastError": null
}
```

`windows[].id` 当前可能是：`five_hour`、`seven_day`、`seven_day_oauth_apps`、
`seven_day_opus`、`seven_day_sonnet`、`seven_day_overage_included`、`overage`，以及
`model:<服务端名称>`。前端应按已知值翻译，未知值保留而不是丢弃。

## 失效语义

- 15 分钟没有成功观测：`stale:true`，但仍返回最后一份快照。
- API key、第三方 provider 或 OAuth scope 不足：`reason:"rate_limits_unavailable"`。
- SDK 版本不支持实验方法：`reason:"unsupported"`。
- 请求超时且从未成功过：`reason:"timeout"`。
- 已有成功快照后再失败：保留 `available:true`，并通过 `lastError` 标注本次失败。

## 下一刀

生产上发一条普通订阅线路消息后读取接口，确认真实字段。通过后再接前端 Usage 页；
上下文窗口仍不在本接口里，后续单独接 `Query.getContextUsage()`，不能拿应用层 24k 预算代替。
