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

  // 存用户消息
  await supabase.from('messages').insert({
    session_id: sessionId,
    role: 'user',
    content: userMessage
  });

  // 拉取历史消息
  const { data: history } = await supabase
    .from('messages')
    .select('role, content')
    .eq('session_id', sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });

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
  const aiReply = aiData.content[0].text;

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});