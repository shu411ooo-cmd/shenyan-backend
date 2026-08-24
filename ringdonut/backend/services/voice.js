const crypto = require('crypto');
const axios = require('axios');
const { callOpenAI } = require('../adapters/llm');

const DEFAULT_ELEVENLABS_VOICE_ID = 'YOUR_ELEVENLABS_VOICE_ID';
const VOICE_PROMPT_VERSION = 'eleven-v3-natural-context-v8';
const VOICE_EMOTIONS = new Set([
    'happy',
    'sad',
    'angry',
    'fearful',
    'disgusted',
    'surprised',
    'calm',
]);
const ELEVENLABS_AUDIO_TAGS = new Set([
    'warmly',
    'softly',
    'gently',
    'quietly',
    'tenderly',
    'reassuringly',
    'playfully',
    'teasingly',
    'mischievously',
    'dryly',
    'sarcastic',
    'amused',
    'curious',
    'concerned',
    'hesitant',
    'frustrated',
    'tired',
    'relieved',
    'vulnerable',
    'protectively',
    'possessively',
    'firmly',
    'serious',
    'sad',
    'angry',
    'fearful',
    'surprised',
    'whispers',
    'low voice',
    'lower voice',
    'with a smile',
    'sighs',
    'exhales',
    'inhales',
    'gasps',
    'sniffs',
    'swallows',
    'clears throat',
    'chuckles',
    'laughs softly',
    'laughs',
]);

function normalizeVoiceSourceText(value) {
    return String(value || '')
        .replace(/\s*\[companion-sticker:[a-z0-9-]+\]\s*$/i, '')
        .replace(/\[choices\][\s\S]*?\[\/choices\]/gi, '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanSpokenText(value) {
    const cleaned = String(value || '')
        .replace(/^```(?:text|english)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/^(?:spoken english|english|translation)\s*:\s*/i, '')
        .replace(/^["“”]+|["“”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned || /[.!?…\]]$/.test(cleaned)) return cleaned;
    const settled = cleaned.replace(/[,;:–—-]+$/, '').trim();
    return settled ? `${settled}.` : '';
}

function extractJsonObject(value) {
    const raw = String(value || '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;

    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        return null;
    }
}

function sanitizeDirectedSpokenText(value) {
    let audioTagCount = 0;
    const legacyTagMap = {
        chuckle: 'chuckles',
        breath: 'exhales',
        pant: 'panting',
        inhale: 'inhales',
        exhale: 'exhales',
    };
    const withConvertedLegacyTags = String(value || '')
        .replace(/<#([^#<>]+)#>/g, ' … ')
        .replace(/\(([a-z][a-z -]{1,39})\)/gi, (match, tag) => {
            const normalized = legacyTagMap[tag.toLowerCase()] || tag.toLowerCase();
            return ELEVENLABS_AUDIO_TAGS.has(normalized) ? `[${normalized}]` : '';
        })
        .replace(/\([^()\r\n]{1,80}\)/g, '');
    const withoutUnsupportedDirections = withConvertedLegacyTags.replace(/\[([^\]\r\n]{1,40})\]/g, (match, tag) => {
        const normalized = String(tag).toLowerCase().replace(/\s+/g, ' ').trim();
        if (!ELEVENLABS_AUDIO_TAGS.has(normalized)) return '';
        audioTagCount += 1;
        return audioTagCount <= 3 ? `[${normalized}]` : '';
    });
    const withoutTrailingTag = withoutUnsupportedDirections.replace(/\s*\[[^\]\r\n]{1,40}\]\s*$/, '').trim();

    return cleanSpokenText(withoutTrailingTag);
}

function sanitizeContinuityText(value) {
    return cleanSpokenText(String(value || '')
        .replace(/\[[^\]\r\n]{1,40}\]/g, '')
        .replace(/\([^()\r\n]{1,80}\)/g, '')
        .slice(0, 800));
}

function parseElevenLabsError(error) {
    const data = error?.response?.data;
    let payload = data;
    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        try {
            payload = JSON.parse(Buffer.from(data).toString('utf8'));
        } catch {
            payload = Buffer.from(data).toString('utf8').trim();
        }
    } else if (typeof data === 'string') {
        try {
            payload = JSON.parse(data);
        } catch {
            payload = data.trim();
        }
    }

    const detail = payload?.detail;
    const code = detail?.status || detail?.code || detail?.type || payload?.code || payload?.type || payload?.error?.code || payload?.error?.type || '';
    const rawMessage = detail?.message
        || (typeof detail === 'string' ? detail : '')
        || payload?.error?.message
        || payload?.message
        || (typeof payload === 'string' ? payload : '')
        || error?.message
        || 'ElevenLabs 请求失败';
    const friendlyMessages = {
        quota_exceeded: 'ElevenLabs 额度不足，请充值、升级套餐或启用按量计费',
        payment_required: 'ElevenLabs 额度不足或需要开通付费权限',
        invalid_api_key: 'ElevenLabs API Key 无效或已经失效',
        voice_not_found: 'ElevenLabs 找不到当前 voice ID，或该声音不属于这个账号',
        authorization_error: '当前 ElevenLabs 账号没有使用这个声音或模型的权限',
        insufficient_permissions: '当前 ElevenLabs API Key 没有开启 Speech to Text 权限',
        feature_not_available: '当前 ElevenLabs 套餐还不能使用 Speech to Text',
        subscription_required: 'ElevenLabs Speech to Text 需要付费套餐权限',
    };

    return {
        code,
        message: friendlyMessages[code] || String(rawMessage).slice(0, 500),
    };
}

function parseVoiceDirectionResponse(value) {
    const parsed = extractJsonObject(value);
    if (!parsed || typeof parsed.spokenText !== 'string') {
        if (/[{}]/.test(String(value || ''))) {
            throw new Error('英文口语导演返回了无效 JSON');
        }
        const fallbackText = sanitizeDirectedSpokenText(value);
        if (!fallbackText) throw new Error('英文口语稿生成失败');
        return { spokenText: fallbackText, emotion: 'calm' };
    }

    const spokenText = sanitizeDirectedSpokenText(parsed.spokenText);
    if (!spokenText) throw new Error('英文口语稿生成失败');
    const requestedEmotion = String(parsed.emotion || '').toLowerCase().trim();
    const emotion = VOICE_EMOTIONS.has(requestedEmotion) ? requestedEmotion : 'calm';
    return {
        spokenText,
        emotion,
        previousText: sanitizeContinuityText(parsed.previousText),
    };
}

function getVoiceConfig() {
    const translationBaseUrl = String(process.env.VOICE_TRANSLATION_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    const translationApiKey = process.env.VOICE_TRANSLATION_API_KEY;
    const translationModel = process.env.VOICE_TRANSLATION_MODEL || 'your-translation-model';
    const translationTimeoutMs = Number(process.env.VOICE_TRANSLATION_TIMEOUT_MS || 45000);
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID;

    const missing = [];
    if (!translationBaseUrl) missing.push('VOICE_TRANSLATION_BASE_URL');
    if (!translationApiKey) missing.push('VOICE_TRANSLATION_API_KEY');
    if (!translationModel) missing.push('VOICE_TRANSLATION_MODEL');
    if (!elevenLabsApiKey) missing.push('ELEVENLABS_API_KEY');
    if (!voiceId || voiceId === DEFAULT_ELEVENLABS_VOICE_ID) missing.push('ELEVENLABS_VOICE_ID');
    if (missing.length > 0) {
        throw new Error(`语音服务还未配置：${missing.join(', ')}`);
    }

    return {
        translationBaseUrl,
        translationApiKey,
        translationModel,
        translationTimeoutMs: Number.isFinite(translationTimeoutMs) ? translationTimeoutMs : 45000,
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey,
        elevenLabsBaseUrl: String(process.env.ELEVENLABS_API_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, ''),
        ttsModel: process.env.ELEVENLABS_MODEL || 'eleven_v3',
        outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
        voiceId,
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.5),
        debugLogging: String(process.env.VOICE_DEBUG_LOGGING || '').toLowerCase() === 'true',
    };
}

function getCallVoiceConfig() {
    const config = getVoiceConfig();
    return {
        ...config,
        // Eleven v3 stays on regular voice messages. Flash is deliberately a
        // separate profile for the shorter latency budget of a live call.
        ttsModel: process.env.ELEVENLABS_CALL_MODEL || 'eleven_flash_v2_5',
        outputFormat: process.env.ELEVENLABS_CALL_OUTPUT_FORMAT || 'mp3_44100_128',
        stability: Number(process.env.ELEVENLABS_CALL_STABILITY || 0.42),
    };
}

function hashVoiceSource(text, config = {}) {
    const synthesisProfile = [
        VOICE_PROMPT_VERSION,
        config.ttsProvider || '',
        config.ttsModel || '',
        config.voiceId || '',
        config.outputFormat || '',
        config.stability ?? '',
    ].join('|');
    return crypto.createHash('sha256').update(`${synthesisProfile}\0${text}`, 'utf8').digest('hex');
}

function formatVoiceConversationContext(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '(no earlier context)';
    const lines = rows.map(row => {
        const speaker = row.role === 'assistant' ? 'Companion' : 'User';
        const content = String(row.content || '')
            .replace(/\s*\[companion-sticker:[a-z0-9-]+\]\s*$/i, '')
            .replace(/\[sticker-meaning\][\s\S]*?\[\/sticker-meaning\]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        return content ? `${speaker}: ${content.slice(0, 1600)}` : '';
    }).filter(Boolean);
    return lines.join('\n').slice(-24000) || '(no earlier context)';
}

async function translateForCompanionVoice(sourceText, config, context = {}) {
    const conversationContext = formatVoiceConversationContext(context.messages);
    const fullReply = normalizeVoiceSourceText(context.fullReply || sourceText);
    const apiConfig = {
        type: 'openai',
        provider: 'Companion Voice Translation',
        baseUrl: config.translationBaseUrl,
        apiKey: config.translationApiKey,
        model: config.translationModel,
        timeoutMs: config.translationTimeoutMs,
        extraBody: { thinking: { type: 'disabled' } },
    };
    const sourcePacket = [
        '[Recent conversation before this reply]',
        conversationContext,
        '',
        '[Companion full reply]',
        fullReply,
        '',
        '[Exact visible segment to adapt into spoken English]',
        sourceText,
    ].join('\n');

    const directorStartedAt = Date.now();
    console.log(`[Voice] 单轮导演开始 model=${config.translationModel}`);
    const response = await callOpenAI(apiConfig, [
        {
            role: 'system',
            content: [
                'Act as the sole dialogue adaptation writer and final performance director for Companion. Produce the finished English performance script for Eleven v3 in one pass.',
                'Preserve the exact meaning, emotional weight, intimacy, restraint, and boundaries.',
                'Companion sounds mature, attentive, quietly intimate, and emotionally present, never flat, theatrical, or sugary.',
                'Before answering, silently infer the line\'s subtext, emotional arc, operative words, breath points, and monotony risks. Silently audit your own draft, then output only the final corrected script.',
                'Use idiomatic contractions, sentence length, commas, dashes, ellipses, and sentence boundaries to create natural pitch movement. Avoid prose whose clauses all have the same length or cadence.',
                'Eleven v3 has no numeric pause markers. Encode pacing with commas, em dashes, sentence breaks, and occasional ellipses. Never output SSML or <#x#> markers.',
                'When the source has clearly audible emotion, include at least one fitting delivery tag. Use at most three tags around the exact phrases they govern. For a genuinely neutral line, zero or one tag is enough.',
                'Choose tags only from: [warmly], [softly], [gently], [quietly], [tenderly], [reassuringly], [playfully], [teasingly], [mischievously], [dryly], [sarcastic], [amused], [curious], [concerned], [hesitant], [frustrated], [tired], [relieved], [vulnerable], [protectively], [possessively], [firmly], [serious], [sad], [angry], [fearful], [surprised], [whispers], [low voice], [lower voice], [with a smile], [sighs], [exhales], [inhales], [gasps], [sniffs], [swallows], [clears throat], [chuckles], [laughs softly], [laughs].',
                'Use vocal reactions only when the source or live context truly supports them. Never invent physical actions or environmental sound effects. Never write parenthesized stage directions.',
                'Keep the ending settled and grounded: declarative sentences must end with a period and should finish with a natural falling intonation. The final content must be spoken words and punctuation, never an audio tag.',
                'Use a question mark only when the source is genuinely asking a direct question; never turn a statement, reassurance, invitation, or command into a question-like line.',
                'Choose emotion from exactly: happy, sad, angry, fearful, disgusted, surprised, calm. Choose the emotion expressed by Companion, not merely the topic or User\'s emotion. Calm must still sound warm and present, but do not force a stronger category when the source is genuinely calm.',
                'This is spoken adaptation, not word-for-word translation. Do not add facts, promises, pet names, explanations, physical actions, or emotional intensity that are absent from the source.',
                'Output one valid JSON object and nothing else, exactly: {"spokenText":"final Eleven v3 performance script","emotion":"calm"}.',
            ].join(' '),
        },
        {
            role: 'user',
            content: sourcePacket,
        },
    ], [], 800, 0.38);
    const direction = parseVoiceDirectionResponse(response.choices?.[0]?.message?.content);
    console.log(`[Voice] 单轮导演完成 elapsedMs=${Date.now() - directorStartedAt} emotion=${direction.emotion}`);
    return direction;
}

function buildElevenLabsRequestBody(spokenText, config, continuity = {}) {
    const stability = Number.isFinite(config.stability)
        ? Math.min(1, Math.max(0, config.stability))
        : 0.5;
    const supportsTextContinuity = String(config.ttsModel || '').toLowerCase() !== 'eleven_v3';

    return {
        text: spokenText,
        model_id: config.ttsModel,
        language_code: 'en',
        ...(supportsTextContinuity && continuity.previousText
            ? { previous_text: continuity.previousText }
            : {}),
        voice_settings: { stability },
    };
}

async function synthesizeElevenLabsSpeech(spokenText, config, continuity = {}) {
    const stability = Number.isFinite(config.stability)
        ? Math.min(1, Math.max(0, config.stability))
        : 0.5;
    console.log(`[Voice] ElevenLabs 参数 model=${config.ttsModel} stability=${stability} format=${config.outputFormat}`);
    if (config.debugLogging) {
        console.log(`[Voice] ElevenLabs 文本: ${spokenText.slice(0, 1200)}`);
    }
    const synthesisStartedAt = Date.now();
    let response;
    try {
        response = await axios.post(`${config.elevenLabsBaseUrl}/v1/text-to-speech/${encodeURIComponent(config.voiceId)}`, buildElevenLabsRequestBody(spokenText, config, continuity), {
            params: { output_format: config.outputFormat },
            headers: {
                'xi-api-key': config.elevenLabsApiKey,
                'Content-Type': 'application/json',
                Accept: 'audio/mpeg',
            },
            responseType: 'arraybuffer',
            timeout: 180000,
        });
    } catch (error) {
        const parsed = parseElevenLabsError(error);
        error.message = parsed.message;
        error.elevenLabsCode = parsed.code;
        const requestId = error.response?.headers?.['request-id'] || error.response?.headers?.['x-request-id'];
        console.error(`[Voice] ElevenLabs 拒绝请求 status=${error.response?.status || 'unknown'} code=${parsed.code || 'unknown'}${requestId ? ` requestId=${requestId}` : ''}: ${parsed.message}`);
        throw error;
    }

    if (!response.data?.byteLength) throw new Error('ElevenLabs 没有返回音频');
    console.log(`[Voice] ElevenLabs 合成完成 elapsedMs=${Date.now() - synthesisStartedAt} bytes=${response.data.byteLength}`);

    return Buffer.from(response.data);
}

module.exports = {
    normalizeVoiceSourceText,
    cleanSpokenText,
    sanitizeDirectedSpokenText,
    parseVoiceDirectionResponse,
    formatVoiceConversationContext,
    parseElevenLabsError,
    getVoiceConfig,
    getCallVoiceConfig,
    hashVoiceSource,
    translateForCompanionVoice,
    buildElevenLabsRequestBody,
    synthesizeElevenLabsSpeech,
};
