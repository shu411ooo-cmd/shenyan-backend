const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildTranscriptEvidence,
    selectGroundedHighlights,
    selectGroundedExcerpts,
    buildGroundedCallSummary,
    validateAbstractiveSummary,
} = require('./callSummary');

test('builds summaries only from verified transcript turn ids', () => {
    const evidence = buildTranscriptEvidence([
        { role: 'user', content: '今天有点累。' },
        { role: 'assistant', content: '那就靠过来休息一会儿。' },
    ]);
    const selected = selectGroundedHighlights('{"highlight_ids":["B1","FAKE","E1"]}', evidence);
    assert.deepEqual(selected.map(line => line.id), ['B1', 'E1']);
    assert.equal(
        buildGroundedCallSummary(selected),
        'User提到“今天有点累”；Companion回应“那就靠过来休息一会儿”。',
    );
});

test('turns long phone turns into short, verbatim, grounded excerpts', () => {
    const evidence = buildTranscriptEvidence([
        { role: 'user', content: '我刚打算煮晚餐的时候才发现家里没有食材了，然后我又紧急外卖点了食材。白天吃了一点午饭。' },
        { role: 'assistant', content: '那食材到了没有？到了就赶紧把晚餐煮了，别拖到十二点。我在这儿等你。' },
    ]);
    assert.ok(evidence.every(line => Array.from(line.text).length <= 73));
    const selected = selectGroundedExcerpts(JSON.stringify({ highlights: [
        { id: 'B1', excerpt: '家里没有食材了' },
        { id: 'E2', excerpt: '赶紧把晚餐煮了' },
        { id: 'E3', excerpt: '我在这儿等你' },
    ] }), evidence);
    assert.equal(
        buildGroundedCallSummary(selected),
        'User提到“家里没有食材了”；Companion回应“赶紧把晚餐煮了”、“我在这儿等你”。',
    );
});

test('rejects excerpts that are not verbatim substrings of their evidence', () => {
    const evidence = buildTranscriptEvidence([{ role: 'user', content: '家里没有食材了。' }]);
    assert.deepEqual(selectGroundedExcerpts(JSON.stringify({ highlights: [
        { id: 'B1', excerpt: '家里没有晚餐了' },
    ] }), evidence), []);
});

test('rejects free-written model summaries and invalid evidence ids', () => {
    const evidence = buildTranscriptEvidence([{ role: 'user', content: '喂？' }]);
    assert.deepEqual(selectGroundedHighlights('他们讨论了根本没发生的晚餐。', evidence), []);
    assert.deepEqual(selectGroundedHighlights('{"highlight_ids":["B99"]}', evidence), []);
    assert.equal(buildGroundedCallSummary([]), '');
});

test('accepts a natural summary grounded in verified excerpts', () => {
    const selected = [
        { id: 'B1', speaker: 'User', text: '家里没有食材了' },
        { id: 'E1', speaker: 'Companion', text: '赶紧把晚餐煮了' },
        { id: 'E2', speaker: 'Companion', text: '我在这儿等你' },
    ];
    assert.equal(
        validateAbstractiveSummary('{"summary":"User发现家里没有食材，Companion催她去煮晚餐，也表示会等她。"}', selected),
        'User发现家里没有食材，Companion催她去煮晚餐，也表示会等她。',
    );
});

test('rejects summaries with invented details or transcript formatting', () => {
    const selected = [{ id: 'B1', speaker: 'User', text: '家里没有食材了' }];
    assert.equal(validateAbstractiveSummary('{"summary":"User决定12点出门买食材，然后回家做晚饭。"}', selected), '');
    assert.equal(validateAbstractiveSummary('{"summary":"User说：家里没有食材了，Companion回应：知道了。"}', selected), '');
});
