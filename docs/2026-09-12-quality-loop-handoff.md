# 2026-09-12 交接：质量闭环 v1（memory-quality.cjs）+ 前两笔提交备忘

> 写给下一位接手者。本文档回答三件事：今天动了什么、质量报告怎么用、有什么坑。
> 权威现状仍以 `docs/memory-current-state-netting.md` 为准；本文只增量。

---

## 一、今天提交了什么（三笔）

| 提交 | 内容 | 风险 |
|---|---|---|
| `78409d5` | 记忆层三修复：want 四 handler 静默 catch 补日志；`memoryWriteProcessed` 无界增长补 5000 条清理；召回池补 `ORDER BY importance DESC`（原来 `.limit(60)` 无排序，表超 60 行后高分记忆可能根本进不了候选——**静默退化型缺陷**） | 低 |
| `a3a9158` | 关系边自动连：`memory_relations` 此前只有手动脚本一个生产者，联想图停在上次跑脚本那天。现在 `writeMemoryItems` 尾部触发（wroteAny 闸 + 30min 占座节流 + fail-open + `MEMORY_AUTOLINK=off` 关停），比旧脚本多一道「主题名必须在候选清单」校验（孤儿边不入库） | 中低 |
| 本次 | 质量闭环 v1：`scripts/audit/memory-quality.cjs` 只读审计脚本 + 6 组口径测试；顺手修复 78409d5 漏改的 fail-closed 语义断言（一直红着没人发现） | 极低 |

## 二、质量报告怎么用

```bash
node scripts/audit/memory-quality.cjs              # 终端报告
node scripts/audit/memory-quality.cjs --json q.json # 落档，便于留档对比
```

只读、纯机械统计、不调 LLM、单表读不到就跳过该节。建议节奏：**大改前后各跑一次，留 JSON 档对比**。

### 指标口径字典

| 节 | 数据源 | 口径 |
|---|---|---|
| A 写入侧 | `memory_topics` 全表 | 建桶速度看 `created_at`，活跃看 `updated_at`；importance≥0.8 占比是打分通胀探针；重复桶嫌疑=名字互相包含（与写入侧合并规则同尺度） |
| B 召回侧 | `prompt_injections`（150 天窗口）| **注入量≠质量**；「死记忆」=近 30 天台账 `prov.refs[].topicId` 从未覆盖的桶。`refsMissing` 高则此口径不可靠 |
| C 关系侧 | `memory_relations` × 主题名 | 孤儿边=端点主题已不存在（旧脚本不验名字的遗产；新校验已堵源头） |
| D claim 侧 | `personality_claim` | forming 卡死阈值=settings.claim_dormant_days（现 30 天） |
| E 参数看板 | `settings(global)` + 代码硬编码清单 | **密钥/cookie/token/prompt/userid 一律不进报告**；长文本>60 字截断。硬编码清单在脚本 `HARDCODED_KNOBS`，改了代码要同步改清单 |

### 🟡/🔴 是启发式，不是定论

- 🔴 只有一条规则：有对话但台账空（整窗 0 行看 30 天，近 7 天看 7 天）——与 2026-08-30 空转十天事故同形态，与 `server.js checkInjectionsLedgerHealth` 同源。
- 其余全是 🟡 提示，需要人判断。

## 三、限制与坑（重要）

1. **「被提及」没有持久化**。recallDaily 是模块态计数器，唯一出口是每日一行 `📊 [recall]` console.log，进程死了就丢。本报告只能还原**注入侧**，还原不了「注入了她接没接话」。这是质量闭环目前最大的盲区，要补只能加表（本期没做，见风险测评 R2）。
2. **死记忆口径依赖 prov.refs 带 topicId**。若某天注入侧改了 provenance 结构，`refsMissing` 会升高——先修口径再信数字。
3. **台账只有 150 天**（`maybePruneInjections` 偶发清理）。趋势分析别跨窗。
4. **本地库 ≠ 生产库**。本次干跑发现本地 .env 指向的库台账整窗 0 行、近 7 天 0 会话——报告如实 🔴，但这多半是本地库滞后，**别拿本地报告当生产结论**。
5. 脚本无 LLM 抽检：判官准确率、voiceify 忠实度这类「对不对」的问题它回答不了，只能回答「量多少」。这是刻意的成本决定，不是遗漏。

## 四、验证记录

- 全套测试 134→140 绿（新增 6 组口径断言，含「密钥绝不进报告」「台账空转必须 🔴」）
- 真实库干跑通过：89 桶（实×89）、40 条边 58/89 主题有边、importance 均值 0.71、正确喊出 🔴 台账空转
- 未动任何在线行为：脚本是纯外挂，不进 server.js
