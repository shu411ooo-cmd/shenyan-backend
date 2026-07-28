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
    

// ===== 共享工具函数 =====

function getTools() {
  return [
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
}

function buildSystemPrompt() {
  const now = new Date();
  const currentTime = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai'
  });

  return `
${process.env.SYSTEM_PROMPT || '你是沈晏。'}

现在是 ${currentTime}。
`;
}

async function compressHistory(sessionId) {
  const { count } = await supabase
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('visible', true);

  const THRESHOLD = 20;
  if (count <= THRESHOLD) return;

  const { data: oldMessages } = await supabase
    .from('messages')
    .select('id, content, role')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true })
    .limit(10);

  if (!oldMessages || oldMessages.length === 0) return;

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

async function buildMessages(sessionId) {
  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  const systemPrompt = buildSystemPrompt();

  return [
    { role: 'system', content: systemPrompt },
    ...(history || []).map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }))
  ];
}

// ===== SSE 辅助函数 =====

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // 显式冲刷缓冲，确保流式数据即时到达客户端
  if (typeof res.flush === 'function') {
    res.flush();
  }
}

// ===== OpenRouter 流式 / 非流式调用 =====

// 流式对话：先非流式处理工具调用，再流式输出最终回复
async function handleStreamChat(messages, res) {
  const tools = getTools();

  // Step 1: 非流式调用，检查是否需要工具
  const firstResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 1000
    })
  });

  const firstData = await firstResponse.json();
  if (!firstData.choices || !firstData.choices[0]) {
    throw new Error(`OpenRouter 响应异常: ${JSON.stringify(firstData)}`);
  }

  const assistantMessage = firstData.choices[0].message;

  // Step 2: 执行工具调用（如果有）
  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    messages.push(assistantMessage);

    for (const tc of assistantMessage.tool_calls) {
      const fnName = tc.function.name;
      const fnArgs = JSON.parse(tc.function.arguments);

      console.log(`🔧 执行工具: ${fnName}`, fnArgs);

      // 通知前端工具调用
      sendSSE(res, 'tool_call', {
        id: tc.id,
        name: fnName,
        arguments: fnArgs
      });

      let toolResult;
      let success = true;
      try {
        toolResult = await callOmbreTool(fnName, fnArgs);
      } catch (err) {
        toolResult = { error: err.message };
        success = false;
        console.error(`❌ 工具 ${fnName} 执行失败:`, err);
      }

      // 通知前端工具结果
      sendSSE(res, 'tool_result', {
        id: tc.id,
        name: fnName,
        success,
        result: toolResult
      });

      messages.push({
        tool_call_id: tc.id,
        role: 'tool',
        name: fnName,
        content: JSON.stringify(toolResult)
      });
    }
  } else {
    // 没有工具调用 — 把已拿到的回复当最终内容发出
    if (assistantMessage.content) {
      sendSSE(res, 'text', { text: assistantMessage.content });
    }
    return assistantMessage.content || '';
  }

  // Step 3: 流式调用（拿到工具结果后，不再传 tools）
  return await streamFinalReply(messages, res);
}

// 纯流式文本调用（不带 tools，避免二次工具调用）
async function streamFinalReply(messages, res) {
  let content = '';

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4-6',
      messages,
      max_tokens: 1000,
      stream: true
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter 请求失败 (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      if (trimmed === 'data: [DONE]') continue;

      try {
        const parsed = JSON.parse(trimmed.substring(6));
        const deltaContent = parsed.choices?.[0]?.delta?.content;
        if (deltaContent) {
          content += deltaContent;
          sendSSE(res, 'text', { text: deltaContent });
        }
      } catch (e) {
        // ignore individual line parse errors
      }
    }
  }

  return content;
}

// 非流式调用（旧端点用）
async function callOpenRouterNonStream(messages, tools) {
  const body = {
    model: 'anthropic/claude-sonnet-4-6',
    messages,
    max_tokens: 1000
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error(`OpenRouter 响应异常: ${JSON.stringify(data)}`);
  }
  return data.choices[0].message;
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

// ===== 核心对话接口 =====
app.post('/sessions/:id/chat', async (req, res) => {
  const sessionId = req.params.id;
  const userMessage = req.body.message;
  const useStream = req.body.stream === true;

  try {
    // 1. 存用户消息
    await supabase.from('messages').insert({
      session_id: sessionId,
      role: 'user',
      content: userMessage
    });

    // 2. 压缩检查
    await compressHistory(sessionId);

    // 3. 构建消息数组
    const messages = await buildMessages(sessionId);

    if (useStream) {
      // ===== 流式分支 =====
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      // 禁用 Nagle，确保小数据块立即发出
      if (res.socket) res.socket.setNoDelay(true);

      // 工具调用非流式处理 + 最终回复流式输出
      const finalReply = await handleStreamChat(messages, res);

      // 4. 存 AI 回复
      await supabase.from('messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: finalReply
      });

      // 5. 更新会话时间
      await supabase.from('sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', sessionId);

      sendSSE(res, 'done', { reply: finalReply });
      res.end();

    } else {
      // ===== 非流式分支（JSON） =====
      const tools = getTools();
      const assistantMessage = await callOpenRouterNonStream(messages, tools);
      let finalReply = '';
      const toolCalls = [];

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);

        for (const tc of assistantMessage.tool_calls) {
          const fnName = tc.function.name;
          const fnArgs = JSON.parse(tc.function.arguments);

          console.log(`🔧 AI 决定调用工具: ${fnName}`, fnArgs);

          let toolResult;
          try {
            toolResult = await callOmbreTool(fnName, fnArgs);
          } catch (err) {
            toolResult = { error: err.message };
            console.error(`❌ 工具 ${fnName} 执行失败:`, err);
          }

          toolCalls.push({
            id: tc.id,
            name: fnName,
            arguments: fnArgs,
            result: toolResult
          });

          messages.push({
            tool_call_id: tc.id,
            role: 'tool',
            name: fnName,
            content: JSON.stringify(toolResult)
          });
        }

        const secondMessage = await callOpenRouterNonStream(messages, null);
        finalReply = secondMessage.content;
      } else {
        finalReply = assistantMessage.content;
      }

      // 4. 存 AI 回复
      await supabase.from('messages').insert({
        session_id: sessionId,
        role: 'assistant',
        content: finalReply
      });

      // 5. 更新会话时间
      await supabase.from('sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', sessionId);

      // 6. 返回 JSON
      const responseData = { reply: finalReply };
      if (toolCalls.length > 0) {
        responseData.tool_calls = toolCalls;
      }
      res.json(responseData);
    }

  } catch (error) {
    console.error("Chat Error:", error);
    if (useStream && res.headersSent) {
      sendSSE(res, 'error', { message: error.message || '服务器开小差了' });
      res.end();
    } else {
      res.status(500).json({ error: error.message || '服务器开小差了' });
    }
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
