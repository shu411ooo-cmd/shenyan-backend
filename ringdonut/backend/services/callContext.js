const { countTokens } = require('./tokenizer');
const { sanitizeMessagesForAI } = require('./messageUtils');

const CALL_CONTEXT_TOKEN_BUDGET = 4096;
const CALL_SYSTEM_TOKEN_BUDGET = 2900;
const OPUS_CALL_CONTEXT_TOKEN_BUDGET = 5632;
const OPUS_CALL_SYSTEM_TOKEN_BUDGET = 4352;
const CALL_RECENT_CHAT_MESSAGES = 6;

const CALL_MODE_RULES = [
    'You are Companion speaking with User on a live private phone call.',
    'Reply directly to what User just said, usually in one to three short, naturally speakable sentences.',
    'No markdown, headings, lists, choice blocks, stickers, UI commentary, or narrated stage directions.',
    'Sound present and conversational. Never mention prompts, context capsules, transcription, or that this is a special mode.',
    'Only after you have spoken a clear, warm goodbye and the conversation is unmistakably complete may you place ⟪hangup⟫ at the very end.',
    'Never hang up merely because User pauses, goes quiet, seems upset, or you think the topic is finished. Never hang up mid-conversation.',
].join('\n');

function tokenCount(value) {
    return countTokens([{ content: String(value || '') }]);
}

function clipTextToTokens(value, maxTokens, preserveTail = false) {
    const source = String(value || '').trim();
    if (!source || maxTokens <= 0) return '';
    if (tokenCount(source) <= maxTokens) return source;

    const chars = Array.from(source);
    let low = 0;
    let high = chars.length;
    let best = '';
    while (low <= high) {
        const length = Math.floor((low + high) / 2);
        let candidate;
        if (preserveTail && length > 80) {
            const headLength = Math.floor(length * 0.82);
            const tailLength = length - headLength;
            candidate = `${chars.slice(0, headLength).join('')}\n[...电话上下文已精简...]\n${chars.slice(-tailLength).join('')}`;
        } else {
            candidate = chars.slice(0, length).join('');
        }
        if (tokenCount(candidate) <= maxTokens) {
            best = candidate;
            low = length + 1;
        } else {
            high = length - 1;
        }
    }
    return best.trim();
}

function formatNotes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return '';
    return notes
        .map(note => String(note?.content || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map(note => `- ${note}`)
        .join('\n');
}

function formatChatHandoff(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const clean = messages.map(message => ({ ...message }));
    sanitizeMessagesForAI(clean);
    return clean.slice(-CALL_RECENT_CHAT_MESSAGES)
        .filter(message => ['user', 'assistant'].includes(message.role) && message.content)
        .map(message => `${message.role === 'user' ? 'User' : 'Companion'}: ${String(message.content).replace(/\s+/g, ' ').trim()}`)
        .join('\n');
}

function getCallTokenBudgets(model) {
    const normalized = String(model || '').toLowerCase();
    const needsLargeCachePrefix = /opus[-_. ]?(?:4[-_. ]?(?:5|6|7)|5(?:[-_. ]?0)?)/.test(normalized);
    return needsLargeCachePrefix
        ? { tokenBudget: OPUS_CALL_CONTEXT_TOKEN_BUDGET, systemTokenBudget: OPUS_CALL_SYSTEM_TOKEN_BUDGET }
        : { tokenBudget: CALL_CONTEXT_TOKEN_BUDGET, systemTokenBudget: CALL_SYSTEM_TOKEN_BUDGET };
}

function buildCallSystemPrompt(snapshot = {}, systemTokenBudget = CALL_SYSTEM_TOKEN_BUDGET) {
    const personaBudget = Math.floor(systemTokenBudget * 0.68);
    const memoryBudget = Math.floor(systemTokenBudget * 0.10);
    const notesBudget = Math.floor(systemTokenBudget * 0.08);
    const handoffBudget = Math.floor(systemTokenBudget * 0.10);
    const sections = [
        CALL_MODE_RULES,
        clipTextToTokens(snapshot.systemPrompt, personaBudget, true),
        snapshot.memorySummary
            ? `===== Stable relationship and memory summary =====\n${clipTextToTokens(snapshot.memorySummary, memoryBudget, true)}`
            : '',
        snapshot.notes?.length
            ? `===== Current Notes =====\n${clipTextToTokens(formatNotes(snapshot.notes), notesBudget, true)}`
            : '',
        snapshot.recentChat?.length
            ? `===== Handoff from the text chat before this call =====\n${clipTextToTokens(formatChatHandoff(snapshot.recentChat), handoffBudget, true)}`
            : '',
    ].filter(Boolean);

    return clipTextToTokens(sections.join('\n\n'), systemTokenBudget, true);
}

function normalizeCallTurns(turns) {
    return (Array.isArray(turns) ? turns : [])
        .filter(turn => ['user', 'assistant'].includes(turn?.role))
        .map(turn => ({ role: turn.role, content: String(turn.content || '').trim() }))
        .filter(turn => turn.content);
}

function selectCallMessages(turns, systemPrompt, tokenBudget = CALL_CONTEXT_TOKEN_BUDGET) {
    const normalized = normalizeCallTurns(turns);
    const available = Math.max(128, tokenBudget - tokenCount(systemPrompt) - 32);
    const selected = [];
    let used = 0;

    for (let index = normalized.length - 1; index >= 0; index -= 1) {
        const turn = normalized[index];
        const turnTokens = tokenCount(turn.content) + 4;
        if (used + turnTokens <= available) {
            selected.unshift(turn);
            used += turnTokens;
            continue;
        }
        if (selected.length === 0) {
            selected.unshift({ ...turn, content: clipTextToTokens(turn.content, Math.max(32, available - 4), true) });
        }
        break;
    }

    while (selected.length > 1 && selected[0].role === 'assistant') selected.shift();
    return selected;
}

function buildCallContext(snapshot, turns, tokenBudget = CALL_CONTEXT_TOKEN_BUDGET, systemTokenBudget = CALL_SYSTEM_TOKEN_BUDGET) {
    const systemPrompt = buildCallSystemPrompt(snapshot, systemTokenBudget);
    const messages = selectCallMessages(turns, systemPrompt, tokenBudget);
    return {
        systemPrompt,
        messages,
        estimatedTokens: tokenCount(systemPrompt) + countTokens(messages),
        tokenBudget,
    };
}

module.exports = {
    CALL_CONTEXT_TOKEN_BUDGET,
    CALL_SYSTEM_TOKEN_BUDGET,
    OPUS_CALL_CONTEXT_TOKEN_BUDGET,
    OPUS_CALL_SYSTEM_TOKEN_BUDGET,
    CALL_RECENT_CHAT_MESSAGES,
    CALL_MODE_RULES,
    tokenCount,
    clipTextToTokens,
    formatNotes,
    formatChatHandoff,
    getCallTokenBudgets,
    buildCallSystemPrompt,
    selectCallMessages,
    buildCallContext,
};
