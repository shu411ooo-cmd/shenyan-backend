# memory_topics v2 —— Schema 设计

> 2026-08-29。目标：给 memory_topics 增加**来源隔离**（Chat vs Music）与**音乐对象身份键**（song_key），
> 同时解决两个已被证实的问题：
> 1. Chat 分类器的候选集混入音乐桶 → 事实/经历互相污染（GPT 指出的类型边界破坏）。
> 2. 同一首歌「点歌」与「写笔记」因 topic 措辞不同被拆成两个桶（含包回退不命中）。
>
> 本文只讲 schema 设计与取舍。执行（DDL / 迁移 / 代码配套）另行决定。

## 现状盘点（真实数据，2026-08-29 拉取）

- `memory_topics` **82 条**，实际列：`id, topic, bucket_id, grounding, evidence, importance, last_content, snapshot_hash, created_at, updated_at, event_time, conversation_time`（`sql/memory_topics.sql` 已过时：缺 `event_time/conversation_time` 两列，注释仍是旧的【实】标签方案）。
- 82 条里**真正的音乐沉淀桶只有 2 条**（第一人称「我们/我」+ 歌/瞬间主题）：
  - `一起听歌的温柔`（08-19, bucket=266e622327a4）—— 内容无歌名。
  - `红豆与雨夜`（08-19, bucket=1341e35e3d66）—— 内容含《红豆》，歌手未知。
- 其余 80 条全部是 Chat 分类器第三人称写法（「她…」），包括 `音乐室新功能`/`换用开源音乐`/`今晚一起听歌`/`音乐室建成` 等——这些是**关于她做音乐室这件事的事实**，来自 Chat，不是音乐沉淀。
- `music_songs` 表只有 **1 条**（Moon River | Audrey Hepburn，8/29 今天），说明历史听歌数据基本没落库，且存量音乐桶早于该表落地。
- 存量重复桶活证据：`GitHub账号被封` 与 `GitHub账号封禁` **共享同一 bucket** `366aa7012c76`，`GH账号被封` 是**另一个桶** `43e43bbb0f83`；`沉迷Junk journ` / `Junk journal` / `沉迷古董布和蕾丝` 三个 topic 是同一件事。

## Schema 目标（两个新列 + 唯一性设计）

```sql
ALTER TABLE memory_topics
  ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'chat',  -- 'chat' | 'music'
  ADD COLUMN IF NOT EXISTS song_key TEXT;                          -- 音乐桶专用：'歌名|歌手'（与前端 keyOf / music_songs.key 对齐）；chat 桶为 NULL
```

- **source**：所有写入方必须显式带。默认 'chat' 兼容存量/防漏标。
- **song_key**：音乐桶的**身份键**，不是展示字段。解析器按它精确匹配，**彻底不碰自然语言 topic**。

## 唯一性：定稿（方案 2）

音乐桶的 identity 是 `song_key`（一首歌一个桶），topic 只是最新一次动作的措辞展示。
Chat 桶的 identity 仍是 `topic`。两者可能撞 topic（概率低：音乐 topic 必带歌名、chat topic 是概念词），但撞了就是互相覆盖。

**2026-08-29 程芥拍板：方案 2。**

```sql
ALTER TABLE memory_topics DROP CONSTRAINT IF EXISTS memory_topics_topic_key;
ALTER TABLE memory_topics ADD CONSTRAINT uq_memory_topics_source_topic UNIQUE (source, topic);
```

- 唯一性升级为 `(source, topic)`：Chat 与 Music 各自独立，**从根上杜绝类型互相覆盖**。
- 配套：`upsertMemoryTopic` 的 `onConflict` 改为 `['source','topic']`，且函数内兜底 `row.source = row.source || 'chat'`（保证冲突判定始终带来源，旧调用不传也能工作）。这是本 schema 变更唯一必需的代码改动。
- 音乐桶唯一性仍靠部分唯一索引（见迁移第 2 步），两者不冲突，可叠加。

## 写入/解析的配套改动点（本设计的前提，另行落代码）

1. `/api/music/moment` 接收并透传 `key`（song_key）——前端 `songFor()` 已经算了 `key`，只是没发。
2. `sedimentMusicMoment` 把 `key` 带进 `writeMemoryItems` → 写 `song_key`，且写入前按 song_key 匹配（先查后写）。
3. Music 的匹配不再走 `findExistingMemoryTopic` 的 containment，走 `source='music' AND song_key=?` 精确查。
4. Chat 分类器喂给模型的候选集、`findExistingMemoryTopic` 的查询，**过滤 `source='music'`**——杜绝 Chat 把歌名桶当 update_topic 候选、把事实写进经历桶。
5. `memory_topics` 查询统一加 `source` 条件。

## 不做的（明确边界）

- 不从自然语言 topic 里解析歌名/song_key——存量已经证明补不来（见迁移方案），对象身份必须从源头（前端 song 对象）带下来。
- 不合并现有重复桶（GitHub / Junk journal 那几组）——那是独立的存量清理，不属于本 schema 变更。
- 「第一人称/第三人称」只是**本次历史回填的人工/脚本判别依据**，**不进 runtime 逻辑**——runtime 靠 `source` 字段隔离，不靠人称判断。

