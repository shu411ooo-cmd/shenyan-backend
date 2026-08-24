function cleanTurnText(value, maxChars = 90) {
    const text = String(value || '')
        .replace(/[⟪《〖\[]\s*(?:拨号|dial|挂断|hangup|勿扰|dnd)[^⟫》〗\]]*[⟫》〗\]]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    const chars = Array.from(text);
    return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text;
}

function splitEvidenceUnits(value, maxChars = 72) {
    const text = cleanTurnText(value, 4000);
    if (!text) return [];
    const sentences = text.match(/[^。！？!?]+[。！？!?]?/g)?.map(item => item.trim()).filter(Boolean) || [text];
    const units = [];
    for (const sentence of sentences) {
        if (Array.from(sentence).length <= maxChars) {
            units.push(sentence);
            continue;
        }
        const clauses = sentence.match(/[^，,；;]+[，,；;]?/g)?.map(item => item.trim()).filter(Boolean) || [sentence];
        let current = '';
        for (const clause of clauses) {
            const combined = current ? `${current}${clause}` : clause;
            if (current && Array.from(combined).length > maxChars) {
                units.push(cleanTurnText(current, maxChars));
                current = clause;
            } else {
                current = combined;
            }
        }
        if (current) units.push(cleanTurnText(current, maxChars));
    }
    return units.filter(Boolean).slice(0, 80);
}

function buildTranscriptEvidence(turns) {
    let userIndex = 0;
    let companionIndex = 0;
    const evidence = [];
    for (const turn of Array.isArray(turns) ? turns : []) {
        if (!['user', 'assistant'].includes(turn?.role)) continue;
        const speaker = turn.role === 'user' ? 'User' : 'Companion';
        for (const text of splitEvidenceUnits(turn.content)) {
            const id = turn.role === 'user' ? `B${++userIndex}` : `E${++companionIndex}`;
            evidence.push({ id, speaker, text });
        }
    }
    return evidence;
}

function parseJsonObject(value) {
    const source = String(value || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(source.slice(start, end + 1)); }
    catch { return null; }
}

function selectGroundedHighlights(modelOutput, evidence, maxHighlights = 4) {
    const parsed = parseJsonObject(modelOutput);
    const requested = Array.isArray(parsed?.highlight_ids) ? parsed.highlight_ids : [];
    const byId = new Map(evidence.map(line => [line.id, line]));
    const selected = [];
    const seen = new Set();
    for (const rawId of requested) {
        const id = String(rawId || '').toUpperCase().trim();
        if (!byId.has(id) || seen.has(id)) continue;
        selected.push(byId.get(id));
        seen.add(id);
        if (selected.length >= maxHighlights) break;
    }
    return selected.sort((a, b) => evidence.indexOf(a) - evidence.indexOf(b));
}

function selectGroundedExcerpts(modelOutput, evidence, maxHighlights = 3) {
    const parsed = parseJsonObject(modelOutput);
    const requested = Array.isArray(parsed?.highlights) ? parsed.highlights : [];
    const byId = new Map(evidence.map(line => [line.id, line]));
    const selected = [];
    const seen = new Set();
    for (const item of requested) {
        const id = String(item?.id || '').toUpperCase().trim();
        const source = byId.get(id);
        const excerpt = String(item?.excerpt || '').replace(/\s+/g, ' ').trim();
        const excerptLength = Array.from(excerpt).length;
        if (!source || !excerpt || excerptLength < 4 || excerptLength > 42) continue;
        if (!source.text.includes(excerpt)) continue;
        const key = `${id}:${excerpt}`;
        if (seen.has(key)) continue;
        selected.push({ ...source, text: excerpt });
        seen.add(key);
        if (selected.length >= maxHighlights) break;
    }
    return selected;
}

function buildGroundedCallSummary(highlights) {
    if (!Array.isArray(highlights) || highlights.length === 0) return '';
    const user = [];
    const companion = [];
    for (const line of highlights.slice(0, 3)) {
        const excerpt = cleanTurnText(line.text, 42).replace(/[。！？!?；;，,]+$/g, '');
        if (!excerpt) continue;
        (line.speaker === 'User' ? user : companion).push(`“${excerpt}”`);
    }
    const parts = [];
    if (user.length) parts.push(`User提到${user.join('、')}`);
    if (companion.length) parts.push(`Companion回应${companion.join('、')}`);
    return parts.length ? `${parts.join('；')}。` : '';
}

function validateAbstractiveSummary(modelOutput, highlights) {
    const parsed = parseJsonObject(modelOutput);
    const summary = String(parsed?.summary || '').replace(/\s+/g, ' ').trim();
    const length = Array.from(summary).length;
    if (!summary || length < 12 || length > 150) return '';
    if (/[“”"「」『』]|```|\n|\r/.test(summary)) return '';
    if (/(?:User|Companion)\s*(?:说|问|答|回应|提到|表示)?\s*[:：]/i.test(summary)) return '';

    const source = (Array.isArray(highlights) ? highlights : [])
        .map(line => String(line?.text || ''))
        .join(' ');
    if (!source) return '';

    // Numbers and unfamiliar Latin names are particularly easy for a model to invent.
    const numberTokens = summary.match(/\d+(?:[.:：]\d+)?/g) || [];
    if (numberTokens.some(token => !source.includes(token))) return '';
    const latinTokens = summary.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    if (latinTokens.some(token => !['user', 'companion'].includes(token.toLowerCase()) && !source.toLowerCase().includes(token.toLowerCase()))) return '';

    // Require a meaningful amount of the summary's content vocabulary to occur in
    // the verified excerpts. This still permits paraphrasing, while catching a new topic.
    const glue = new Set(Array.from('的了和也并又就都还很更让把被在对与及而但因为所以然后已经一个一些这那她他它自己表示提到回应觉得认为进行关于'));
    const contentChars = Array.from(summary).filter(char => /[\u3400-\u9fff]/u.test(char) && !glue.has(char));
    const groundedChars = contentChars.filter(char => source.includes(char));
    if (contentChars.length >= 6 && (groundedChars.length < 4 || groundedChars.length / contentChars.length < 0.32)) return '';
    return summary;
}

module.exports = {
    cleanTurnText,
    splitEvidenceUnits,
    buildTranscriptEvidence,
    parseJsonObject,
    selectGroundedHighlights,
    selectGroundedExcerpts,
    buildGroundedCallSummary,
    validateAbstractiveSummary,
};
