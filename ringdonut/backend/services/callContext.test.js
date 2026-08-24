const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CALL_CONTEXT_TOKEN_BUDGET,
    buildCallContext,
    buildCallSystemPrompt,
    formatChatHandoff,
    getCallTokenBudgets,
    tokenCount,
} = require('./callContext');

test('builds a stable phone capsule from persona, notes, memory, and recent chat', () => {
    const prompt = buildCallSystemPrompt({
        systemPrompt: 'Companion core persona and relationship rules.',
        memorySummary: 'User and Companion trust each other.',
        notes: [{ content: 'User deploys on Render.' }],
        recentChat: [{ role: 'user', content: '今晚打电话吗？' }, { role: 'assistant', content: '好。' }],
    });
    assert.match(prompt, /live private phone call/);
    assert.match(prompt, /Companion core persona/);
    assert.match(prompt, /Render/);
    assert.match(prompt, /今晚打电话吗/);
    assert.match(prompt, /clear, warm goodbye/);
    assert.match(prompt, /Never hang up merely because User pauses/);
});

test('reserves a cacheable 4k-plus stable prefix for supported Opus models', () => {
    assert.deepEqual(getCallTokenBudgets('claude-opus-4.6'), {
        tokenBudget: 5632,
        systemTokenBudget: 4352,
    });
    assert.deepEqual(getCallTokenBudgets('claude-opus-4.7'), {
        tokenBudget: 5632,
        systemTokenBudget: 4352,
    });
    assert.deepEqual(getCallTokenBudgets('claude-opus-5'), {
        tokenBudget: 5632,
        systemTokenBudget: 4352,
    });
    assert.deepEqual(getCallTokenBudgets('claude-sonnet-4.6'), {
        tokenBudget: 4096,
        systemTokenBudget: 2900,
    });

    const huge = '长期稳定的 Companion 人设与关系背景。'.repeat(1200);
    const opus = buildCallContext({
        systemPrompt: huge,
        memorySummary: huge,
        notes: [{ content: huge }],
        recentChat: [{ role: 'user', content: huge }, { role: 'assistant', content: huge }],
    }, [{ role: 'user', content: '喂？' }], 5632, 4352);
    assert.ok(tokenCount(opus.systemPrompt) >= 4096);
    assert.ok(opus.estimatedTokens <= 5632);
});

test('uses only the configured number of recent text-chat messages', () => {
    const handoff = formatChatHandoff(Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `line-${index}`,
    })));
    assert.doesNotMatch(handoff, /line-3/);
    assert.match(handoff, /line-4/);
    assert.match(handoff, /line-9/);
});

test('keeps the complete request capsule within 4096 estimated input tokens', () => {
    const huge = '这是一段很长的上下文。'.repeat(1800);
    const turns = Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `${index}: ${huge.slice(0, 1200)}`,
    }));
    const context = buildCallContext({
        systemPrompt: huge,
        memorySummary: huge,
        notes: [{ content: huge }],
        recentChat: turns,
    }, turns);

    assert.ok(context.estimatedTokens <= CALL_CONTEXT_TOKEN_BUDGET);
    assert.ok(tokenCount(context.systemPrompt) <= 2900);
    assert.equal(context.messages.at(-1).role, 'assistant');
});
