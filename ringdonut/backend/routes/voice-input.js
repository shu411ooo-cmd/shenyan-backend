const router = require('express').Router();
const host = require('../adapters/host');
const {
    decodeAudioPayload,
    sanitizeAcousticFeatures,
    transcribeVoiceInput,
    judgeVoiceTone,
} = require('../services/voiceInput');

const requestBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 8;

router.use(async (req, res, next) => {
    try {
        await host.authorizeRequest(req);
        next();
    } catch (error) {
        res.status(401).json({ error: error.message || 'Unauthorized' });
    }
});

function getRequestAddress(req) {
    // trust proxy 已设置，req.ip 返回真实客户端 IP（从 X-Forwarded-For 解析）
    return String(req.ip || 'unknown').split(',')[0].trim();
}

function isRateLimited(req) {
    const now = Date.now();
    const key = getRequestAddress(req);
    const recent = (requestBuckets.get(key) || []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
    recent.push(now);
    requestBuckets.set(key, recent);
    if (requestBuckets.size > 500) {
        const expired = [];
        for (const [address, timestamps] of requestBuckets) {
            if (!timestamps.some(timestamp => now - timestamp < RATE_WINDOW_MS)) expired.push(address);
        }
        for (const address of expired) requestBuckets.delete(address);
    }
    return recent.length > RATE_LIMIT;
}

router.post('/transcribe', async (req, res) => {
    const startedAt = Date.now();
    try {
        if (isRateLimited(req)) return res.status(429).json({ error: '录音请求太频繁了，稍等一下再试' });
        if (!String(req.body?.sessionId || '').trim()) return res.status(400).json({ error: 'sessionId 必填' });

        const features = sanitizeAcousticFeatures(req.body?.features);
        if (features.duration_s > 90) return res.status(413).json({ error: '录音太长了，请控制在一分钟以内' });
        const audio = decodeAudioPayload(req.body?.audio);
        const transcription = await transcribeVoiceInput(audio);
        const text = transcription.text;

        let tone = { emotion: 'neutral', confidence: 0, hint: '' };
        try {
            tone = await judgeVoiceTone(text, features);
        } catch (error) {
            console.warn('[Voice Input] 语气判断失败，保留转写:', error.message);
        }

        console.log(`[Voice Input] 完成 provider=${transcription.provider} bytes=${audio.buffer.length} chars=${text.length} elapsedMs=${Date.now() - startedAt}`);
        res.json({ text, tone: { ...tone, features } });
    } catch (error) {
        const upstreamStatus = error.response?.status;
        const status = error.statusCode
            || (upstreamStatus === 413 ? 413 : upstreamStatus === 429 ? 429 : upstreamStatus === 401 ? 503 : 502);
        const upstreamMessage = error.response?.data?.error?.message || error.response?.data?.error || error.message;
        console.error('[Voice Input] 失败:', upstreamMessage);
        res.status(status).json({ error: upstreamMessage || '语音转写失败' });
    }
});

module.exports = router;
