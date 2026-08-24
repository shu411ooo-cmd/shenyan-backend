# 🍩 ringdonut

给 AI 伴侣打电话。能听懂你的语气，能用带感情的声音回你，能主动打给你。

A voice-call system for AI companions. It hears how you speak, replies with emotion, and calls you first when it wants to.

---

## 它做什么 / What it does

```
你说话
  → 浏览器录音
  → STT 转写你说了什么
  → 声学分析读出你怎么说的（音高、能量、停顿）
  → LLM 带着完整上下文生成回复
  → 语音导演把回复改写成适合朗读的表演脚本
  → ElevenLabs TTS 用情绪标签渲染（[softly], [teasingly], [sighs], …）
  → 音频一段一段流式回来——不用等整句说完
```

除了基础的语音对话，ringdonut 做了那些让"通话"真的像通话的部分：

**TA 能打给你。** LLM 自主调用 `dial_call` 工具发起真实来电 → 服务端创建来电邀请 → 你收到写着理由的来电卡片 → 接听、带理由拒接、或者不接。模型不能靠输出文本伪造一通电话。

**挂断是温柔的。** 说完再见之后，电话会多留 15–18 秒。你开口，挂断取消；你不说话，它自己轻轻挂掉。

**通话变成记忆。** 有真实双方对话的有效通话会生成摘要并写回聊天记录——不是孤立的通话日志，是你们共同历史的一部分。

**免打扰**是一个开关，不是一个菜单。

**上下文保持精简。** 专门的 token 预算管理器控制通话时的上下文窗口大小，拉入最近的聊天记录和记忆，但不炸掉响应延迟。

**摘要是可信的。** 摘要系统先从通话记录里提取证据，再验证生成的摘要是否忠于原文——不会编造你们没说过的话。

---

## 架构 / Architecture

```
前端 Frontend (React)                      后端 Backend (Express + Node)

┌──────────────┐                         ┌────────────────────┐
│ CallOverlay  │ ── POST /call/start ──▶ │ routes/call.js     │
│  录音 record │                         │  创建通话会话       │
│  播放 play   │ ── POST /call/respond ─▶│  构建上下文         │
│  UI 交互     │                         │  调用 LLM           │
│              │ ── POST /call/speak/N ─▶│  语音导演翻译       │
│              │ ◀── SSE 音频分段流式 ───│  ElevenLabs TTS     │
│              │                         │  逐段推送           │
│ CallPortrait │ ── POST /call/finish ──▶│  摘要 & 存储        │
└──────────────┘                         └────────────────────┘

服务层 Services:
  callContext.js     — token 预算、聊天交接、系统提示词
  callLifecycle.js   — 来电/接听/拒接/免打扰 状态机
  callSummary.js     — 通话证据提取 + 摘要验证
  voice.js           — 语音导演、ElevenLabs 合成、30+ 情绪标签
  voiceInput.js      — STT + 声学语气分析
```

## 文件说明 / Files

### 前端 Frontend
| 文件 | 用途 |
|------|------|
| `CallOverlay.jsx` | 完整通话 UI：录音、播放、状态显示、静音、挂断 |
| `CallPortrait.jsx` | 通话中的动态头像 |
| `services/voiceInput.js` | 浏览器端录音、格式检测、音频处理 |

### 后端 Backend
| 文件 | 用途 |
|------|------|
| `routes/call.js` | 全部通话端点：start, respond, speak, finish, invite, heartbeat, DND |
| `services/callContext.js` | 实时对话的 token 预算管理 |
| `services/callLifecycle.js` | 来电邀请状态机：pending → accepted / declined / missed |
| `services/callSummary.js` | 通话证据提取、摘要生成与验证 |
| `services/voice.js` | 语音导演（文字 → 表演脚本）、ElevenLabs TTS、30+ 情绪标签 |
| `services/voiceInput.js` | 服务端 STT、声学特征格式化 |

### 数据库 Database (Supabase / Postgres)
| 表 | 用途 |
|----|------|
| `call_sessions` | 通话会话：状态、时长、摘要、token 预算 |
| `call_turns` | 每轮对话记录 + 语音语气数据 |
| `call_invites` | 来电队列：理由、拒接备注、过期时间 |
| `call_preferences` | 免打扰开关 |

## 需要什么 / Requirements

- **Node.js 18+**
- **Supabase**（当前参考实现基于 Supabase client；数据库结构为 Postgres）
- **Anthropic API** 或 **OpenAI 兼容 API** 跑 LLM
- **ElevenLabs API** 做 TTS
- **Groq / Whisper 兼容 API** 做 STT
- 一个额外的 LLM 端点做语音导演（把文字翻译成适合朗读的脚本）

## 使用 / Setup

1. Clone
2. `.env.example` → `.env`，填 API 密钥
3. 跑 `migrations/` 里的数据库迁移
4. `npm install && npm start`
5. 前端指向后端地址

这是从生产系统里拆出来的。你需要把它接入你自己的聊天后端——通话系统需要宿主提供几个能力：加载聊天记录、加载用户设置、保存消息、调用 LLM。这些接入点在 `routes/call.js` 里，跟着 import 就能找到。

This is extracted from a production system. You'll need to wire it into your own chat backend — the call system expects a few capabilities from its host: loading chat messages, loading user settings, saving messages, and calling your LLM. These integration points are in `routes/call.js`, clearly marked by their imports.

## 致谢 / Acknowledgements

这个项目站在两个先分享了自己作品的人的肩膀上：

- **[hervoice](https://github.com/fishisfish0614/hervoice)** by fishisfish0614 — *怎么说的*和*说了什么*一样重要。ringdonut 的语音语气分析源自这个洞察。

- **[callhome](https://github.com/Cheiineeey/callhome)** by Cheiineeey — 通话生命周期协议：AI 主动来电、温柔挂断、带理由拒接、免打扰。ringdonut 的来电系统和挂断流程建立在这套设计之上。

hervoice taught ringdonut to listen beyond words. callhome showed what a companion call could feel like. ringdonut took those ideas further — tool-driven dialing, server-verified sessions, streamed emotional speech, and grounded call memories.

## License

MIT
