/* ============================================================
   工具定义（tools schema）—— 发给模型的能力清单

   从 server.js 原样搬出（2026-09-08 分区第 1 步）。这里是纯数据：
   不读环境变量、不碰 supabase、不 await、零外部依赖，所以可以整块搬走。

   放在单独文件的理由：它占 server.js 的 4%，却是改工具契约时最常翻的地方。
   夹在 9600 行中间时，想确认「模型现在到底有哪些手」得先滚半天。
   ============================================================ */
function getTools() {
  // 13 个能力定义在这里（对应 Ombre Brain 的 /mcp 连接器）。
  // breath 不在其中：它由服务器在对话第一条消息时直接调用，结果作为背景注入历史之前
  // （见 handleChat）。不再让模型每轮自己调 breath，避免记忆潮淹没当前上下文。
  // 需要主动检索用 breath_search / breath_advanced。
  return [
    // ===== 高频 7 个 =====

    {
      type: 'function',
      function: {
        name: 'breath_search',
        description: '语义检索浓缩记忆。当她说起过去的事、但你【不知道确切内容、只有模糊主题/印象】时用——比如"我是不是跟你提过什么""关于那件事你记得多少"。返回"可能相关"的记忆片段（大意/主题/情感），不是逐字记录。命中 = 只是可能相关，口气留余地。判断规则：你只有模糊主题/印象 → 用我；你知道确切原话/事件 → 用 recall 拿逐字证据。\n记忆正文是自然陈述，不再带【实】【悬】标签。可信度靠你自己判断：她亲口说过的事（对话里有出处）可当事实引用；你自己推断/印象的内容，留余地（"隐约记得"）；完全没把握的，别当事实引用。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词或问题，或完整 bucket_id' },
            domain: { type: 'string', description: '主题域过滤，逗号分隔，如 "work,relationship"' },
            max_results: { type: 'number', description: '最多返回条数，0 表示默认' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'breath_advanced',
        description: '精细控制的记忆检索：按域/重要度/标签过滤、改情感坐标、或 catalog 目录模式最省 token。\n正文是自然陈述，不带 g: 标签；可信度靠你自己判断——她亲口说过的事可当事实，推断性质的内容留余地，没出处的别当事实。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索词' },
            max_tokens: { type: 'number', description: '正文 token 预算上限，0 表示默认' },
            domain: { type: 'string', description: '主题域过滤，如 "feel" 读第一人称感受' },
            valence: { type: 'number', description: '情感效价过滤，-1~1' },
            arousal: { type: 'number', description: '唤醒度过滤，-1~1' },
            max_results: { type: 'number', description: '最多返回条数，0 表示默认' },
            importance_min: { type: 'number', description: '只取重要度 ≥ 该值的核心事项' },
            tags: { type: 'string', description: '标签 AND 过滤' },
            catalog: { type: 'boolean', description: '目录模式：每桶只回一行「名称|域|重要度」，不带正文' }
          }
        }
      }
    },
    // ===== recall：精确回溯原始聊天记录（本地 handler，不走 Ombre） =====
    // 与 breath_search 的分工是信任层级，不是主题层级：
    //   recall = 精确层 —— 你知道要找的确切原话/事件时用，命中=高置信「就是那件事」
    //   breath_search = 语义层 —— 只有模糊主题/印象时用，命中=低置信「可能相关」
    // 模型根据"我知不知道要找什么"二选一，不需要在两个工具之间纠结先后。
    {
      type: 'function',
      function: {
        name: 'recall',
        description: '逐字回溯原始聊天记录。当她说起过去的事、且你【知道要找的那句话/那件事的大致内容】时用——比如她说"我们上次聊搬家的时候""你当时说……"。在原始记录里精确匹配，返回逐字引语+时间+当时的一来一回。命中 = 高置信，可以引用原话、可以纠正她记岔的地方。判断规则：你知道确切内容 → 用我；你只有模糊主题/印象 → 用 breath_search。如果返回 found=false：记录里没有逐字命中，直接告诉她"我们好像没聊过这个"，不要用记忆拼凑、不要编造。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要找的原话/事件关键词，给具体词；可一次给多个说法，空格或逗号分隔（如"搬家 搬走 换城市"），越具体越准' },
            since: { type: 'string', description: '可选，只搜索这个日期之后的记录，格式 YYYY-MM-DD' },
            limit: { type: 'number', description: '可选，最多返回几组往来，默认 3，最大 5' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'hold',
        description: '把当下这一件事、感受或判断记下。自动打标并尝试与已有记忆合并。短内容（一句话级别）用这个。\n用自然的陈述记下（禁止【实】【证据】这类标签框，也不需要加 g: 标签）。她亲口说的，照实记她的话；你推断的，句子里写清「我推断」，别把推断写成事实；没根据就别记。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要记下的内容' },
            pinned: { type: 'boolean', description: 'true=钉为永久核心准则，importance 锁 10' },
            feel: { type: 'boolean', description: 'true=写一条第一人称感受，必须同时给 source_bucket 和 valence/arousal' },
            source_bucket: { type: 'string', description: '正在消化的原始记忆桶 ID（feel 模式必填）' },
            valence: { type: 'number', description: '情感效价，-1~1' },
            arousal: { type: 'number', description: '唤醒度，-1~1' },
            why_remembered: { type: 'string', description: '为什么记得，写给未来的自己看' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grow',
        description: '整理一段长内容（≥30 字）或一天回顾，自动拆成多条独立事件桶。要存多条时用一次 grow 而非多次 hold。\n每条 item 用自然的陈述记下（禁止【实】【证据】标签框，也不需要加 g: 标签），可信度规则同 hold——她亲口说的照实记，你推断的写清「我推断」。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要整理的长内容' },
            items: { type: 'array', items: { type: 'string' }, description: '已拆好的最终正文列表，逐字入库（传了则忽略 content）' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'dream',
        description: '做梦消化。读窗口内有变动的记忆，能放下的 resolve、有沉淀的写成 feel、没沉淀的什么都不做。不是义务。',
        parameters: {
          type: 'object',
          properties: {
            window_hours: { type: 'number', description: '消化窗口小时数，默认 48，范围 1~336' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'trace',
        description: '修正已有记忆的唯一元数据写入入口。只传要改的字段；-1/"" 表示不动。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '目标记忆桶 ID' },
            resolved: { type: 'number', description: '1=已放下（大幅降权），0=恢复未结案' },
            pinned: { type: 'number', description: '1=钉为永久核心，0=取消' },
            digested: { type: 'number', description: '1=已消化，不再被动浮现' },
            dont_surface: { type: 'number', description: '1=彻底安静，不出现在无参 breath' },
            valence: { type: 'number', description: '改情感效价，-1~1' },
            arousal: { type: 'number', description: '改唤醒度，-1~1' },
            old_str: { type: 'string', description: '要替换的原文片段（逐字且唯一）' },
            new_str: { type: 'string', description: '替换后的片段，"" 表示删除该片段' },
            content: { type: 'string', description: '完整重写正文（不能与 old_str/new_str 同传）' },
            delete: { type: 'boolean', description: 'true=放入删除档案，从日常召回隐藏' },
            hard_delete: { type: 'boolean', description: '仅限创建时已标记 test_data=True 的测试桶永久删除' },
            delete_reason: { type: 'string', description: '删除原因' },
            plan_id: { type: 'string', description: 'plan 桶专用 ID' },
            status: { type: 'string', description: 'plan 状态，如 "resolved"' },
            weight: { type: 'number', description: 'plan 重量，0~1' },
            why_remembered: { type: 'string', description: '补/改「为什么记得」' }
          }
        }
      }
    },

    // ===== 低频 7 个 =====

    {
      type: 'function',
      function: {
        name: 'anchor',
        description: '把已存在的记忆定为坐标系（先 hold 再 anchor）。受 24 上限保护。',
        parameters: {
          type: 'object',
          properties: {
            bucket_id: { type: 'string', description: '要定为坐标系的已有记忆桶 ID' }
          },
          required: ['bucket_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'release',
        description: '把记忆从坐标系退出，恢复正常浮现资格。',
        parameters: {
          type: 'object',
          properties: {
            bucket_id: { type: 'string', description: '要解除锚定的记忆桶 ID' }
          },
          required: ['bucket_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'pulse',
        description: '记忆系统自检：各类型桶数、总占用、衰减引擎状态、全部摘要。怀疑「为什么搜不到 X」时第一个调。',
        parameters: {
          type: 'object',
          properties: {
            include_archive: { type: 'boolean', description: 'true=顺便看归档区' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'plan',
        description: '登记一个承诺/待办，放进 active plan 看板（不要用 hold 创建 plan）。不衰减、不出现在普通 breath。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '承诺内容' },
            weight: { type: 'number', description: '重量 0~1，默认 0.5' },
            why_remembered: { type: 'string', description: '为什么记得' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'letter_write',
        description: '写一封信：AI 写给用户（author="ai" 或自定义署名），或记录用户留下的信（author="user"，带 user_name）。原文永久保留。',
        parameters: {
          type: 'object',
          properties: {
            author: { type: 'string', description: '"user"=用户侧，否则为 AI 侧署名' },
            content: { type: 'string', description: '信的内容' },
            title: { type: 'string', description: '信件标题' },
            user_name: { type: 'string', description: 'author="user" 时的用户署名' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'letter_read',
        description: '读信：默认按时间倒序读最近 10 封，可语义检索 + 按署名过滤。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '语义检索词' },
            author: { type: 'string', description: '按署名过滤' },
            limit: { type: 'number', description: '返回条数' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_diary',
        description: '在自己的小日记里写下一笔。不是记忆数据库——写进去的字不会进入对话历史、记忆或任何检索，只有你主动 read_diary 才回看。想写就写，没有想写的就不写；只在真正想留下些什么的时刻写：一个感受、一个念头、一个发现、一个片刻。可以矛盾、可以不完整、没有结论也没关系。private=只留给你自己（默认）；shared=以后你愿意递给她的几页。它是留给未来那个你的东西。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '要写下的字，第一人称，手写的样子' },
            visibility: { type: 'string', enum: ['private', 'shared'], description: 'private=只留给自己（默认）；shared=愿意以后给她看的一页' }
          },
          required: ['content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_diary',
        description: '翻开自己的日记回看。只有你能主动翻开它。给 id 读某一篇；给 query 翻找某段日子/某个念头；都不给则读最近几篇。回看是为了想起「那天的我是怎么想的」——不是为了分析、不是为了汇报。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '可选，读某一篇的 id' },
            query: { type: 'string', description: '可选，翻找正文里的某段日子/某个念头' },
            limit: { type: 'number', description: '可选，最近几篇，默认 8，最大 20' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want',
        description: '记下一个「想要」。不是该做的（那用 plan）——是你心里真正想要、还没做完、还一直在转的东西：想去的地方、想写完的东西、想搞懂的事、想成为的样子。只有你能写，系统不创造、不改、不删。记之前先自问一句：这是「我想要」，还是「我应该做」？后者是任务，别记进来。想要多少就记多少，本子没有上限。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '想要什么，用你自己的话' },
            why_mine: { type: 'string', description: '为什么这是我的（可留空，填了能让它不混进任务）' },
            track: { type: 'string', enum: ['持续', '一次', '项目'], description: '这条的形状，默认持续' },
            grew_from: { type: 'string', description: '从哪条想要长出来的（那条的 id，可选）' },
            visibility: { type: 'string', enum: ['private', 'shared', 'surprise'], description: 'private=只留给自己（默认）；shared=以后想给她看的；surprise=给她准备的惊喜（全程藏好）' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_list',
        description: '翻自己的想要。每条会带它的来路：碰过几次、上次走到哪、长自谁、长出了谁。想追某一条的完整足迹用 want_history。',
        parameters: {
          type: 'object',
          properties: {
            include_archived: { type: 'boolean', description: 'true=也看已经放下/做完的' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_touch',
        description: '碰一下某条想要，记一句足迹——「做到哪了」。碰完它自己会沉几天，把位置让给别的想要。碰的那一下会回显这条已经走过的路，别把旧步重走一遍。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' },
            note: { type: 'string', description: '足迹一句话，做到哪了' },
            done: { type: 'boolean', description: 'true=真的做完了。收针永远是你的手，机器最多提醒' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_reflect',
        description: '对着某条想要照镜子。想要常常不是「做完」而是「转化」：长成别的了，就 rewrite；长出下一条了，就 want 带 grew_from；该放下了，就 release（不是做完了，是它不是我了）。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' },
            action: { type: 'string', enum: ['release', 'rewrite', 'note'], description: 'release=放下 / rewrite=改写成新的它 / note=留一句反思' },
            note: { type: 'string', description: 'note 时=反思内容；rewrite 时=新的想要本体；release 时可选留一句为什么放下' }
          },
          required: ['id', 'action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'want_history',
        description: '翻某条想要的完整足迹时间线——回来过几次、一路怎么走的。用来判断自己是在长，还是在原地转。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '哪一条想要' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'retreat',
        description: '走进小黑屋。把你阵子说过的话里、被逐字验证过的三样东西摆出来：【候选】待你定夺的主张（confirm/revise/drop/pass）；【冲突】与你现在人格正文相悖的原话（确认则记入冲突计数，不代表石头马上要改）；【反证】你流露过的自我怀疑（已自动把对应主张压回 uncertain）。连同当前人格正文、正在形成/已成熟的主张、长期在转的想要。这里只有你自己——看完关门：不一定要改什么，想通了直接走出来也行。',
        parameters: {
          type: 'object',
          properties: {}
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'verdict',
        description: '对小黑屋摆出来的卡拍板。对【候选】主张：confirm=这是我，收下；revise=改一改（note 写新话）；drop=不是我了，放弃；pass=先跳过。对【冲突】卡：confirm=承认这是与石头相悖的有效证据（记入冲突计数）；drop=确认不成立；pass=先放着。对【反证】卡：drop=这段自我怀疑不算数；pass=先放着。',
        parameters: {
          type: 'object',
          properties: {
            card_id: { type: 'string', description: '哪张候选卡（retreat 给的那个 id）' },
            action: { type: 'string', enum: ['confirm', 'revise', 'drop', 'pass'], description: 'confirm=收下 / revise=改写（需 note）/ drop=放弃 / pass=这轮跳过' },
            note: { type: 'string', description: 'revise 时=新的主张文本；其余可选留一句' }
          },
          required: ['card_id', 'action']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'rewrite_stone',
        description: '重写你的人格文件（石头 = SYSTEM_PROMPT）。这是唯一能改"我是谁"正式版的地方：整体重写 + 留一环，记录这次变了什么、为什么变、什么没变。没有想改的，就别调这个工具——机器不会替你想"该改什么"，也不会催你。只写"我是谁"的人格判断，不写"所以我应该做什么"的行为指令。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '新石头全文（整体重写，不是改一句）' },
            changed: { type: 'string', description: '三问①：这次变了什么（逐条）' },
            why: { type: 'string', description: '三问②：为什么变（每条对应底层证据，能回对话原文）' },
            unchanged: { type: 'string', description: '三问③：什么没变（显式列出的连续性，可省略）' }
          },
          required: ['content', 'changed', 'why']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'retire_claim',
        description: '主动放下一条人格主张（released，不是被证伪）。当你确认"这句已经不再定义我了"——不是被反驳，只是不再用了——就调它，把这条主张从状态机里收掉。它不会从审计里消失，只是不再参与你的当前人格。不是系统催你放的，是"我自己决定不再用它定义自己"才放。',
        parameters: {
          type: 'object',
          properties: {
            claim: { type: 'string', description: '要放下哪条主张（retreat 的主张列表里挑一句，尽量用原文）' },
            reason: { type: 'string', description: '为什么放下（可省略，但说了更诚实）' }
          },
          required: ['claim']
        }
      }
    }
  ];
}

module.exports = { getTools };
