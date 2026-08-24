const axios = require('axios');
const { callOpenAI, getApiConfig } = require('../adapters/llm');
const { parseElevenLabsError } = require('./voice');

const VOICE_INPUT_EMOTIONS = new Set([
    'happy', 'sad', 'angry', 'tired', 'tender', 'excited', 'anxious', 'neutral',
]);

const ALLOWED_AUDIO_TYPES = new Set([
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg',
    'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac',
]);

const AUDIO_EXTENSIONS = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
};

function clampNumber(value, min, max, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function normalizeMediaType(value) {
    return String(value || '').toLowerCase().split(';')[0].trim();
}

function sanitizeAcousticFeatures(value) {
    const input = value && typeof value === 'object' ? value : {};
    return {
        duration_s: Math.round(clampNumber(input.duration_s, 0, 90) * 10) / 10,
        pitch_mean_hz: Math.round(clampNumber(input.pitch_mean_hz, 0, 600) * 10) / 10,
        pitch_var: Math.round(clampNumber(input.pitch_var, 0, 300) * 10) / 10,
        energy_mean: Math.round(clampNumber(input.energy_mean, 0, 1) * 10000) / 10000,
        energy_var: Math.round(clampNumber(input.energy_var, 0, 1) * 10000) / 10000,
        pause_ratio: Math.round(clampNumber(input.pause_ratio, 0, 1) * 100) / 100,
        tempo_strength: Math.round(clampNumber(input.tempo_strength, 0, 10) * 100) / 100,
        voiced_ratio: Math.round(clampNumber(input.voiced_ratio, 0, 1) * 100) / 100,
    };
}

function decodeAudioPayload(audio) {
    const mediaType = normalizeMediaType(audio?.mediaType);
    if (!ALLOWED_AUDIO_TYPES.has(mediaType)) {
        throw Object.assign(new Error('不支持这种录音格式'), { statusCode: 400 });
    }

    const encoded = String(audio?.data || '').trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw Object.assign(new Error('录音数据无效'), { statusCode: 400 });
    }

    const buffer = Buffer.from(encoded, 'base64');
    const maxBytes = Number(process.env.VOICE_INPUT_MAX_BYTES || 8 * 1024 * 1024);
    if (!buffer.length) throw Object.assign(new Error('录音是空的'), { statusCode: 400 });
    if (buffer.length > maxBytes) {
        throw Object.assign(new Error('录音太长了，请控制在一分钟以内'), { statusCode: 413 });
    }

    return { buffer, mediaType, extension: AUDIO_EXTENSIONS[mediaType] || 'webm' };
}

async function transcribeWithGroq(audio) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        throw Object.assign(new Error('语音输入还缺少 GROQ_API_KEY'), { statusCode: 503 });
    }

    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mediaType }), `voice.${audio.extension}`);
    form.append('model', process.env.VOICE_INPUT_TRANSCRIPTION_MODEL || 'whisper-large-v3');
    form.append('language', process.env.VOICE_INPUT_LANGUAGE || 'zh');
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const baseUrl = String(process.env.GROQ_API_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    const response = await axios.post(`${baseUrl}/audio/transcriptions`, form, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: Number(process.env.VOICE_INPUT_TRANSCRIPTION_TIMEOUT_MS || 75000),
        maxBodyLength: Number(process.env.VOICE_INPUT_MAX_BYTES || 8 * 1024 * 1024) + 1024 * 1024,
    });

    const text = String(response.data?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw Object.assign(new Error('没有听清内容，可以再说一次'), { statusCode: 422 });
    return text.slice(0, 4000);
}

async function transcribeWithElevenLabs(audio) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw Object.assign(new Error('语音输入还缺少 ELEVENLABS_API_KEY'), { statusCode: 503 });
    }

    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mediaType }), `voice.${audio.extension}`);
    form.append('model_id', process.env.VOICE_INPUT_ELEVENLABS_MODEL || 'scribe_v2');
    form.append('tag_audio_events', 'true');
    form.append('diarize', 'false');
    form.append('timestamps_granularity', 'none');
    const language = String(process.env.VOICE_INPUT_ELEVENLABS_LANGUAGE || '').trim();
    if (language) form.append('language_code', language);

    const baseUrl = String(process.env.ELEVENLABS_API_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
    let response;
    try {
        response = await axios.post(`${baseUrl}/v1/speech-to-text`, form, {
            headers: { 'xi-api-key': apiKey },
            timeout: Number(process.env.VOICE_INPUT_TRANSCRIPTION_TIMEOUT_MS || 75000),
            maxBodyLength: Number(process.env.VOICE_INPUT_MAX_BYTES || 8 * 1024 * 1024) + 1024 * 1024,
        });
    } catch (error) {
        const parsed = parseElevenLabsError(error);
        error.message = parsed.message;
        error.elevenLabsCode = parsed.code;
        console.error(`[Voice Input] ElevenLabs Scribe 拒绝请求 status=${error.response?.status || 'unknown'} code=${parsed.code || 'unknown'}: ${parsed.message}`);
        throw error;
    }

    const text = String(response.data?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw Object.assign(new Error('没有听清内容，可以再说一次'), { statusCode: 422 });
    return text.slice(0, 4000);
}

async function transcribeVoiceInput(audio) {
    const requested = String(process.env.VOICE_INPUT_PROVIDER || 'auto').toLowerCase().trim();
    const provider = requested === 'auto'
        ? (process.env.GROQ_API_KEY ? 'groq' : 'elevenlabs')
        : requested;
    if (provider === 'groq') return { text: await transcribeWithGroq(audio), provider };
    if (provider === 'elevenlabs') return { text: await transcribeWithElevenLabs(audio), provider };
    throw Object.assign(new Error('VOICE_INPUT_PROVIDER 只能是 auto、elevenlabs 或 groq'), { statusCode: 503 });
}

function extractJsonObject(value) {
    const raw = String(value || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    } catch {
        return null;
    }
}

function normalizeToneResult(value) {
    const parsed = value && typeof value === 'object' ? value : {};
    const requestedEmotion = String(parsed.emotion || '').toLowerCase().trim();
    const emotion = VOICE_INPUT_EMOTIONS.has(requestedEmotion) ? requestedEmotion : 'neutral';
    const hint = String(parsed.hint || '')
        .replace(/[\r\n<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
    return {
        emotion,
        confidence: Math.round(clampNumber(parsed.confidence, 0, 1) * 100) / 100,
        hint,
    };
}

async function judgeVoiceTone(text, features) {
    if (!process.env.VOICE_TONE_API_KEY && !process.env.VOICE_TRANSLATION_API_KEY) {
        return { emotion: 'neutral', confidence: 0, hint: '' };
    }

    const apiConfig = {
        ...getApiConfig(process.env.VOICE_TONE_MODEL || process.env.VOICE_TRANSLATION_MODEL || 'your-tone-model'),
        apiKey: process.env.VOICE_TONE_API_KEY || process.env.VOICE_TRANSLATION_API_KEY,
        provider: 'Companion Voice Input',
        timeoutMs: Number(process.env.VOICE_INPUT_EMOTION_TIMEOUT_MS || 30000),
    };
    const response = await callOpenAI(apiConfig, [
        {
            role: 'system',
            content: [
                'You cautiously interpret how User sounded in a short voice message.',
                'Use both the transcript and acoustic measurements, but treat microphone level, natural pitch, and very short clips as uncertain.',
                'Never diagnose mental health, infer consent, or invent intentions. Do not equate tenderness with sexual intent.',
                'Pick exactly one emotion from happy, sad, angry, tired, tender, excited, anxious, neutral.',
                'Confidence is epistemic confidence, not emotional intensity. Keep it below 0.65 when evidence conflicts or the clip is under one second.',
                'The hint must be one short, observational Chinese sentence about audible delivery, not a story about why the user feels that way.',
                'Return JSON only: {"emotion":"...","confidence":0.0,"hint":"..."}.',
            ].join(' '),
        },
        {
            role: 'user',
            content: `转写：${text}\n声学特征：${JSON.stringify(features)}`,
        },
    ], [], 180, 0.2);

    return normalizeToneResult(extractJsonObject(response.choices?.[0]?.message?.content));
}

function formatVoiceToneContext(value) {
    const tone = normalizeToneResult(value);
    const features = sanitizeAcousticFeatures(value?.features);
    if (!tone.hint && tone.confidence <= 0) return '';

    return [
        '===== 本轮语音语气线索（仅供当轮理解，不是用户明说的事实）=====',
        `- 粗略情绪：${tone.emotion}`,
        `- 判断把握：${tone.confidence.toFixed(2)}`,
        tone.hint ? `- 可听见的表达方式：${tone.hint}` : '',
        `- 声学摘要：音高均值 ${features.pitch_mean_hz}Hz，音高波动 ${features.pitch_var}，停顿占比 ${features.pause_ratio}，能量均值 ${features.energy_mean}，节奏强度 ${features.tempo_strength}`,
        '- 把它当作柔和、可推翻的线索。若文字内容与语气推断冲突，以用户实际文字和明确表达为准；不要向用户复述这些测量值。',
    ].filter(Boolean).join('\n');
}

module.exports = {
    VOICE_INPUT_EMOTIONS,
    decodeAudioPayload,
    sanitizeAcousticFeatures,
    transcribeVoiceInput,
    transcribeWithGroq,
    transcribeWithElevenLabs,
    judgeVoiceTone,
    normalizeToneResult,
    formatVoiceToneContext,
};
