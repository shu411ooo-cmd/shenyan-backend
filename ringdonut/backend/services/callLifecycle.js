const CALL_MARKER_PATTERN = /[⟪《〖\[]\s*(拨号|dial|挂断|hangup|勿扰|dnd)\s*(?:[:：]\s*([^⟫》〗\]]*))?\s*[⟫》〗\]]/gi;
const CALL_RECORD_PATTERN = /^📞\s*语音通话\s*·\s*[^\n]+(?:\n[\s\S]*)?$/;
const CALL_RECORD_BLOCK_PATTERN = /(^|\n{2,})📞\s*语音通话\s*·\s*[^\n]+(?:\n(?!\n)[^\n]*)*/g;

function normalizeReason(value, fallback = '想听听你的声音') {
    const text = String(value || '')
        .replace(/[\r\n<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return Array.from(text || fallback).slice(0, 80).join('');
}

function isDirectCallRequest(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;

    const dialPhrase = '(?:给我打(?:个|一通)?电话|打(?:个|一通)?电话给我|给我拨(?:个|一通)?电话|拨给我|打过来)';
    const refusal = new RegExp(`(?:别|不要|不用|不许|先别|暂时别|不想).{0,8}${dialPhrase}`, 'i');
    const redialRefusal = /(?:别|不要|不用|不许|先别|暂时别|不想).{0,8}(?:再|重新)(?:给我)?(?:打|拨)/i;
    if (refusal.test(text) || redialRefusal.test(text) || /(?:don't|do not|dont)\s+(?:call|phone)\s+me/i.test(text)) return false;

    const directRequest = new RegExp(
        `(?:^|[，。！？,.!?]\s*)(?:companion[，,\s]*)?(?:现在|马上|快点|赶紧|直接|就)?\s*${dialPhrase}(?:吧|呀|啊|哦|好不好|可以吗|行吗)?[。！？.!?]*$`,
        'i'
    );
    const politeRequest = new RegExp(
        `(?:可以|能不能|能|要不|要不要|可不可以|愿不愿意)\s*(?:现在)?\s*${dialPhrase}`,
        'i'
    );
    const desireRequest = /(?:我想|我现在想|想要)(?:让你)?(?:给我打(?:个|一通)?电话|和你打电话|听听你的声音)/i;
    const impatientRequest = /(?:怎么还|为什么还|不是说)(?:不)?(?:给我打电话|打过来)/i;
    const redialRequest = /(?:再|重新)(?:给我)?(?:打|拨)(?:一次|一个|一通)?(?:电话)?(?:过来|给我)?(?:吧|呀|啊|哦)?[。！？.!?]*$/i;
    const englishRedialRequest = /(?:^|[,.!?]\s*)(?:please\s+)?(?:call|phone)\s+(?:me\s+)?again[.!?]*$/i;
    const englishRequest = /(?:^|[,.!?]\s*)(?:(?:(?:can|could|would|will)\s+you\s+)(?:please\s+)?|please\s+)?(?:call|phone)\s+me(?:\s+(?:now|please))?[.!?]*$/i;

    return directRequest.test(text)
        || politeRequest.test(text)
        || desireRequest.test(text)
        || impatientRequest.test(text)
        || redialRequest.test(text)
        || englishRequest.test(text)
        || englishRedialRequest.test(text);
}

function parseMessageMetadata(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function isCallRecordContent(value) {
    return CALL_RECORD_PATTERN.test(String(value || '').trim());
}

function isTrustedCallRecordMetadata(value) {
    const metadata = parseMessageMetadata(value);
    return metadata.event_type === 'call_record'
        && typeof metadata.call_id === 'string'
        && metadata.call_id.trim().length > 0;
}

function stripUntrustedCallRecordBlocks(value) {
    const source = String(value || '');
    const cleaned = source.replace(CALL_RECORD_BLOCK_PATTERN, '$1').replace(/\n{3,}/g, '\n\n').trim();
    return {
        text: cleaned,
        removed: cleaned !== source.trim(),
    };
}

function parseCallDirectives(value) {
    const directives = { dialReason: '', hangup: false, dnd: null };
    const text = String(value || '');
    const cleanedText = text.replace(CALL_MARKER_PATTERN, (full, command, argument) => {
        const normalized = String(command || '').toLowerCase();
        const arg = String(argument || '').trim().toLowerCase();
        if ((normalized === '拨号' || normalized === 'dial') && !directives.dialReason) {
            directives.dialReason = normalizeReason(argument);
        } else if (normalized === '挂断' || normalized === 'hangup') {
            directives.hangup = true;
        } else if (normalized === '勿扰' || normalized === 'dnd') {
            if (/^(开|on|true|1)$/.test(arg)) directives.dnd = true;
            if (/^(关|off|false|0)$/.test(arg)) directives.dnd = false;
        }
        return '';
    }).replace(/\n{3,}/g, '\n\n').trim();

    return { cleanedText, ...directives };
}

function stripCallMarkersForPreview(value) {
    return String(value || '')
        .replace(CALL_MARKER_PATTERN, '')
        .replace(/[⟪《〖]\s*(?:拨号|dial|挂断|hangup|勿扰|dnd)[^⟫》〗\]]*$/i, '')
        .trimEnd();
}

function formatCallDuration(totalSeconds) {
    const safe = Math.max(0, Math.min(24 * 3600, Math.round(Number(totalSeconds) || 0)));
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

function formatCallRecord(totalSeconds, summary) {
    const line = `📞 语音通话 · ${formatCallDuration(totalSeconds)}`;
    const cleanSummary = Array.from(String(summary || '').replace(/\s+/g, ' ').trim()).slice(0, 600).join('');
    return cleanSummary ? `${line}\n${cleanSummary}` : line;
}

function splitSpokenSegments(value, maxLength = 240) {
    const source = String(value || '').replace(/\s+/g, ' ').trim();
    if (!source) return [];
    // 中英文句读一起切：。！？. ! ? …（中文句号也能正确分句）
    const sentences = source.match(/[^。！？.!?…]+(?:[。！？.!?…]+|$)/g)?.map(item => item.trim()).filter(Boolean) || [source];
    const segments = [];
    for (const sentence of sentences) {
        if (sentence.length <= maxLength) {
            const previous = segments[segments.length - 1];
            // 中文以句读结尾的句子已经是一句完整的话，独立成段立即开播；
            // 英文短句（<18）保持合并，凑成自然长度。
            const previousIsChineseComplete = previous
                && /[㐀-鿿]/.test(previous)
                && /[。！？…]$/.test(previous);
            if (!previousIsChineseComplete && previous && previous.length < 18 && previous.length + 1 + sentence.length <= maxLength) {
                // 中文句子之间不插空格（英文需要空格分隔词，中文不需要）
                const joiner = /[㐀-鿿]/.test(previous) ? '' : ' ';
                segments[segments.length - 1] = `${previous}${joiner}${sentence}`;
            } else {
                segments.push(sentence);
            }
            continue;
        }
        for (let cursor = 0; cursor < sentence.length; cursor += maxLength) {
            segments.push(sentence.slice(cursor, cursor + maxLength).trim());
        }
    }
    return segments.filter(Boolean).slice(0, 12);
}

module.exports = {
    normalizeReason,
    isDirectCallRequest,
    parseCallDirectives,
    stripCallMarkersForPreview,
    formatCallDuration,
    formatCallRecord,
    splitSpokenSegments,
    isCallRecordContent,
    isTrustedCallRecordMetadata,
    stripUntrustedCallRecordBlocks,
};
