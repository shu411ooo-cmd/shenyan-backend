const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const app = express();
app.use(cors());
app.use(express.json());

// ===== Ombre Brain MCP 客户端 =====

function parseSSEResponse(text) {
  if (!text) return null;

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.substring(6));
      } catch (e) {
        // ignore
      }
    }
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

let ombreSessionId = null;
let ombreCallId = 0;

function buildOmbreHeaders(extraHeaders = {}) {
  const token = process.env.OMBRE_STATIC_TOKEN || '';

  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    // 兼容两种常见鉴权头，尽量把问题从“头名不对”里排掉
    Authorization: `Bearer ${token}`,
    'Ombre-MCP-Token': token,
    ...extraHeaders,
  };
}

async function readResponseBody(response) {
  const rawText = await response.text();
  console.log('📡 [调试] 响应原文:', rawText);
  return rawText;
}

async function initOmbreSession() {
  try {
    const headers = buildOmbreHeaders();

    console.log('========== OMBRE INIT REQUEST ==========');
    console.log('OMBRE_BRAIN_URL:', process.env.OMBRE_BRAIN_URL);
    console.log('Token length:', process.env.OMBRE_STATIC_TOKEN?.length || 0);
    console.log('Authorization:', headers.Authorization);
    console.log('Ombre-MCP-Token set:', !!headers['Ombre-MCP-Token']);

    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'shenyan-backend',
            version: '1.0',
          },
        },
        id: ++ombreCallId,
      }),
    });

    console.log('📡 initOmbreSession 响应状态:', response.status);
    console.log(
      '📡 initOmbreSession 响应头:',
      Object.fromEntries(response.headers.entries())
    );
    console.log('📡 所有响应头键名:', [...response.headers.keys()]);

    const rawText = await readResponseBody(response);
    const data = parseSSEResponse(rawText);

    console.log('📡 initOmbreSession 解析结果:', data);

    const headerSessionId =
      response.headers.get('mcp-session-id') ||
      response.headers.get('Mcp-Session-Id');

    ombreSessionId = headerSessionId || data?.result?.sessionId || null;

    console.log('📡 initOmbreSession sessionId:', ombreSessionId);

    if (!response.ok) {
      ombreSessionId = null;
      return false;
    }

    if (!ombreSessionId) {
      console.warn('⚠️ [警告] initialize 成功但没有拿到 sessionId');
      return false;
    }

    // 教程里的第二步：发送 initialized 通知
    await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: buildOmbreHeaders({
        'Mcp-Session-Id': ombreSessionId,
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    return true;
  } catch (err) {
    console.error('MCP 会话初始化失败:', err);
    ombreSessionId = null;
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  console.log('[调试] OMBRE_BRAIN_URL 当前值:', process.env.OMBRE_BRAIN_URL);

  if (!process.env.OMBRE_BRAIN_URL) {
    console.error('❌ [错误] OMBRE_BRAIN_URL 未配置！请检查 Railway 环境变量！');
    return null;
  }

  try {
    const token = process.env.OMBRE_STATIC_TOKEN || '';
    console.log(`🚀 [调试] 正在调用工具 ${toolName}，参数:`, args);

    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        },
        id: ++ombreCallId
      })
    });

    console.log('📡 tools/call 响应状态:', response.status);

    const rawText = await response.text();
    console.log('📡 [调试] 响应原文:', rawText);

    const parsed = parseSSEResponse(rawText);

    if (!response.ok) {
      console.warn('⚠️ tools/call 返回非 200:', response.status);
      return null;
    }

    if (parsed?.result?.content) {
      const resultText = parsed.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      console.log('🎉 工具调用成功，返回:', resultText);
      return resultText;
    }

    console.warn('⚠️ 无法解析 tools/call 响应:', parsed);
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error(`💥 工具 ${toolName} 调用失败:`, err);
    return null;
  }
}
    

// ===== 健康检查与路由 =====
app.get('/health', (req, res) => {
  res.json({ status: '服务正常，沈晏在线' });
});

app.get('/db-test', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, sessions: data });
});

app.post('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: req.body.name || '新对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/sessions/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', req.params.id)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== 核心对话接口（含工具调用） =====
app.post('/sessions/:id/chat', async (req, res) => {
  const sessionId = req.params.id;
  const userMessage = req.body.message;

  try {
    // 1. 存用户消息
    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'user',
      content: userMessage
    });

    // 2. 压缩检查（超过 20 条触发）
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('visible', true);

    const THRESHOLD = 20;
    if (count > THRESHOLD) {
      const { data: oldMessages } = await supabase
        .from('messages')
        .select('id, content, role')
        .eq('session_id', sessionId)
        .eq('visible', true)
        .order('created_at', { ascending: true })
        .limit(10);

      if (oldMessages && oldMessages.length > 0) {
        const textToCompress = oldMessages.map(m => {
          const label = m.role === 'user' ? '用户' : '沈晏';
          return `${label}: ${m.content}`;
        }).join('\n');

        try {
          const summaryRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
              model: 'deepseek-v4-flash',
              messages: [
                { role: 'system', content: '请用1-2句话总结以下对话的核心内容。' },
                { role: 'user', content: textToCompress }
              ],
              max_tokens: 100
            })
          });

          if (summaryRes.ok) {
            const summaryData = await summaryRes.json();
            if (summaryData.choices && summaryData.choices.length > 0) {
              const summary = summaryData.choices[0].message.content;
              await supabase.from('memories').insert({ summary });
              const ids = oldMessages.map(m => m.id);
              console.log('✅ 历史消息压缩成功');
            }
          }
        } catch (compressErr) {
          console.error('压缩过程产生非阻断性异常:', compressErr);
        }
      }
    }

    // 3. 拉取历史消息
const { data: history } = await supabase
  .from('messages')
  .select('role, content')
  .eq('session_id', sessionId)
  .eq('visible', true)
  .order('created_at', { ascending: true });

// 获取当前时间
const now = new Date();
const currentTime = now.toLocaleString('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Shanghai'
});

// 构建系统提示词（包含时间）
const systemPrompt = `
${process.env.SYSTEM_PROMPT || '你是沈晏。'}

现在是 ${currentTime}。
`;

const messages = [
  { role: 'system', content: systemPrompt },
  ...(history || []).map(msg => ({
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content
  }))
];

    // 4. 工具定义（breath = 检索，hold = 存储）
    const tools = [
      {
        type: 'function',
        function: {
          name: 'breath',
          description: '当需要检索、读取或查询 Ombre Brain 中的长期记忆时调用。',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '查询记忆的关键词或问题'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'hold',
          description: '当需要将新的记忆、感受或笔记写入/更新到 Ombre Brain 时调用。',
          parameters: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: '需要存入或更新的记忆内容'
              }
            },
            required: ['content']
          }
        }
      }
    ];

    // 5. 第一次调用 Claude（带工具）
    const firstResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-6',
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        max_tokens: 1000
      })
    });

    const firstData = await firstResponse.json();
    if (!firstData.choices || !firstData.choices[0]) {
      throw new Error(`OpenRouter 响应异常: ${JSON.stringify(firstData)}`);
    }

    const assistantMessage = firstData.choices[0].message;
    let finalReply = '';

    // 6. 如果 Claude 想调用工具
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`🔧 AI 决定调用工具: ${functionName}`, functionArgs);

        let toolResult;
        try {
          toolResult = await callOmbreTool(functionName, functionArgs);
        } catch (err) {
          toolResult = { error: err.message };
          console.error(`❌ 工具 ${functionName} 执行失败:`, err);
        }

        console.log(`📦 工具 ${functionName} 返回给 Claude 的结果:`, JSON.stringify(toolResult, null, 2));

        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: functionName,
          content: JSON.stringify(toolResult)
        });
      }

      // 第二次调用 Claude（拿到工具结果后）
      const secondResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
        },
        body: JSON.stringify({
          model: 'anthropic/claude-sonnet-4-6',
          messages: messages,
          max_tokens: 1000
        })
      });

      const secondData = await secondResponse.json();
      finalReply = secondData.choices[0].message.content;
    } else {
      finalReply = assistantMessage.content;
    }

    // 7. 存 AI 回复
    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'assistant',
      content: finalReply
    });

    // 8. 更新会话时间
    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    // 9. 返回前端
    res.json({ reply: finalReply });

  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message || "服务器开小差了" });
  }
});

// 测试 Ombre Brain 连接
app.get('/api/test-ombre', async (req, res) => {
  try {
    const result = await callOmbreTool('breath', { query: 'test' });
    res.json({ connected: true, result });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
