// ===== SSE 聊天流纯解析模块（Kelivo 工程方法借鉴 2026-09-03）=====
// 职责：「分帧 → 单帧解析 → delta 合并」，无网络、无 res、无副作用——
// 轨迹回放测试直接喂帧测这一层；server.js 的 streamOpenRouter/streamDeepSeek 只负责网络与 SSE 转发。
// 行为一对一搬自原 streamOpenRouter / streamDeepSeek 内联实现（2026-09-03 提取时逐行核对）。

// —— 分帧器：把 fetch 流里 decoder 吐出的文本切成完整「data:」帧 ——
// 语义与原实现一致：只有以 \n 结尾的完整行会被处理；结尾换行缺帧不补（协议实际以 [DONE] 收尾）。
function createFramer() {
  let buffer = '';
  return {
    // 喂一段文本，返回本轮处理完成的 payload 数组（已剥掉「data: 」前缀；[DONE] 返回 '[DONE]' 哨兵）
    push(text) {
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      const out = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        if (trimmed === 'data: [DONE]') { out.push('[DONE]'); continue; }
        out.push(trimmed.substring(6));
      }
      return out;
    },
  };
}

// —— 单帧合并器（OpenAI 兼容增量格式）。reasoningKeys 支撑 provider 差异：
//    OpenRouter → ['reasoning', 'reasoning_summary', 'thinking']（原文逻辑：已收全文则不再叠 summary）
//    DeepSeek   → ['reasoning_content']
function createChatStreamMerger({ reasoningKeys = ['reasoning'] } = {}) {
  const state = { content: '', thinkingText: '', usage: null, toolAccum: {} };

  function processDataLine(dataLine, emit = null) {
    if (dataLine === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(dataLine); } catch (e) { return; } // 坏帧静默跳过（原实现行为）
    if (parsed.usage) state.usage = parsed.usage; // 末尾 chunk 带 usage
    const delta = parsed.choices?.[0]?.delta || {};

    // 思考链 token：按 reasoningKeys 优先级取第一个非空字段。
    // reasoning_summary 只在「还没收到推理正文」时生效——已收全文跳过 summary（但继续试 thinking）。
    let think = '';
    for (const k of reasoningKeys) {
      const v = delta[k];
      if (!v) continue;
      if (k === 'reasoning_summary' && state.thinkingText) continue;
      think = v;
      break;
    }
    if (think) {
      state.thinkingText += think;
      if (emit) emit('thinking', { thought: think });
    }

    // 正文 token
    const txt = delta.content;
    if (txt) {
      const prevLen = state.content.length;
      state.content += txt;
      if (emit) {
        // 句末标记（2026-09-03）：本次 delta 内出现了句末标点 → sentence_end=true，
        // 前端只在 true 时做折行/markdown 重排，半截引号/省略号不再乱折行。纯提示字段，可忽略。
        const chunk = state.content.slice(prevLen);
        emit('text', { text: txt, sentence_end: /[。！？!?…~.]/.test(chunk) });
      }
    }

    // 工具调用 delta（增量累积 arguments）
    const dcs = delta.tool_calls;
    if (dcs && dcs.length) {
      for (const dc of dcs) {
        const idx = dc.index;
        if (idx === undefined) continue;
        if (!state.toolAccum[idx]) state.toolAccum[idx] = { id: '', name: '', args: '' };
        if (dc.id) state.toolAccum[idx].id = dc.id;
        if (dc.function?.name) state.toolAccum[idx].name = dc.function.name;
        if (dc.function?.arguments) state.toolAccum[idx].args += dc.function.arguments;
      }
    }
  }

  function result() {
    const toolCalls = Object.values(state.toolAccum).map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.args || '{}'); } catch (e) { /* keep {} */ }
      return { id: tc.id, name: tc.name, arguments: args };
    });
    return { content: state.content, thinkingText: state.thinkingText, toolCalls, usage: state.usage };
  }

  return { state, processDataLine, result };
}

module.exports = { createFramer, createChatStreamMerger };