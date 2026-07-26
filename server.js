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

app.get('/health', (req, res) => {
  res.json({ status: '服务正常，沈晏在线' });
});

app.get('/db-test', async (req, res) => {
  const { data, error } = await supabase.from('sessions').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, sessions: data });
});
// 创建新会话
app.post('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: req.body.name || '新对话' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取所有会话
app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// 获取某个会话的消息
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
// 发送消息并获取回复
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

    // 2. 压缩检查
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .eq('visible', true);

    const THRESHOLD = 20;
    if (count > THRESHOLD) {
      // 这里的压缩逻辑保持原样或留空
    }

    // 3. 拉取历史消息
    const { data: history } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true });

    // 构建消息列表
    const messages = [
      { role: 'system', content: process.env.SYSTEM_PROMPT || '你是沈晏。' },
      ...(history || []).map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }))
    ];

    // 4. 定义工具列表
    const tools = [
      {
        type: 'function',
        function: {
          name: 'breath',
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
      },
      {
        type: 'function',
        function: {
          name: 'hold',
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
      }
    ];

    // 5. 第一次调用大模型
    const firstResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-sonnet',
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        max_tokens: 1000
      })
    });

    const firstData = await firstResponse.json();
    if (!firstData.choices || !firstData.choices[0]) {
      throw new Error(`OpenRouter 返回异常: ${JSON.stringify(firstData)}`);
    }

    const assistantMessage = firstData.choices[0].message;

    // 6. 判断是否有工具调用
    let finalReply = '';
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

        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: functionName,
          content: JSON.stringify(toolResult)
        });
      }

      // 第二次调用
      const secondResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
        },
        body: JSON.stringify({
          model: 'anthropic/claude-3.5-sonnet',
          messages: messages,
          tools: tools,
          max_tokens: 1000
        })
      });

      const secondData = await secondResponse.json();
      finalReply = secondData.choices[0].message.content;
    } else {
      finalReply = assistantMessage.content;
    }

    // 7. 保存 AI 回复到数据库
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
    res.status(500).json({ error: error.message || "服务器出错了" });
  }
});
 // ===== 压缩检查 =====
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

  const textToCompress = oldMessages.map(m => {
    const label = m.role === 'user' ? '用户' : '沈晏';
    return `${label}: ${m.content}`;
  }).join('\n');

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

  if (!summaryRes.ok) {
    console.error('DeepSeek API 请求失败:', summaryRes.status, await summaryRes.text());
  } else {
    const summaryData = await summaryRes.json();
    if (summaryData.choices && summaryData.choices.length > 0) {
      const summary = summaryData.choices[0].message.content;
      await supabase.from('memories').insert({ summary });
      const ids = oldMessages.map(m => m.id);
      await supabase
        .from('messages')
        .update({ visible: false })
        .in('id', ids);
      console.log('✅ 压缩成功，已存储摘要');
    } else {
      console.error('DeepSeek 返回空结果:', summaryData);
    }
  }
}
// ===== 压缩检查结束 =====

  // 拉取历史消息
  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  // 检索相关记忆
console.log('🔍 准备调用 Ombre Brain 检索记忆...');
const memoryResult = await callOmbreTool('breath', { query: userMessage });
console.log('🔍 检索结果:', memoryResult);
  
if (memoryResult) {
  console.log('🧠 检索到记忆:', memoryResult);
  // 可以把 memoryResult 拼进系统提示词
}
  
  // 调用Claude API
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
  },
  body: JSON.stringify({
    model: 'anthropic/claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [
      {
        role: 'system',
        content: process.env.SYSTEM_PROMPT || '你是沈晏。'
      },
      ...history
    ]
  })
});

  const aiData = await response.json();
  const aiReply = aiData.choices[0].message.content;

  // 存AI回复
  await supabase.from('messages').insert({
    session_id: sessionId,
    role: 'assistant',
    content: aiReply
  });

  // 更新会话时间
  await supabase.from('sessions')
    .update({ updated_at: new Date() })
    .eq('id', sessionId);

  res.json({ reply: aiReply });
});

// ===== Ombre Brain MCP 客户端（使用 fetch，无需 axios） =====
function parseSSEResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try { return JSON.parse(line.substring(6)); } catch (e) {}
    }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

let ombreSessionId = null;
let ombreCallId = 0;

async function initOmbreSession() {
  try {
    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "shenyan-backend", version: "1.0" } },
        id: ++ombreCallId
      })
    });
    const data = await response.json();
    ombreSessionId = data.result?.sessionId || null;
    if (ombreSessionId) {
      await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': ombreSessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      });
    }
    return !!ombreSessionId;
  } catch (err) {
    console.error('MCP 会话初始化失败:', err.message);
    return false;
  }
}

async function callOmbreTool(toolName, args = {}) {
  if (!process.env.OMBRE_BRAIN_URL) { console.warn('OMBRE_BRAIN_URL 未配置'); return null; }
  try {
    if (!ombreSessionId) {
      const ok = await initOmbreSession();
      if (!ok) return null;
    }
    const response = await fetch(`${process.env.OMBRE_BRAIN_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': ombreSessionId
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: ++ombreCallId
      })
    });
    const rawText = await response.text();
    const parsed = parseSSEResponse(rawText);
    if (parsed?.result?.content) {
      return parsed.result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error(`MCP 工具 ${toolName} 调用失败:`, err.message);
    return null;
  }
}
// ===== Ombre Brain MCP 客户端结束 =====

// 测试 Ombre Brain 连接状态
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
