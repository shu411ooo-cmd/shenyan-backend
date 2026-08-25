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
        .replace(/^```(?:text|english|中文)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/^(?:(?:spoken\s+)?(?:english|中文|chinese)|translation|翻译)\s*[:：]\s*/i, '')
        .replace(/^["“”]+|["“”]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) return cleaned;
    // 语言感知：含中文字符 → 中文句读规则；否则保持英文原行为（保护英文路径测试）。
    const isChinese = /[㐀-鿿]/.test(cleaned);
    const stripped = cleaned.replace(/[“”「」『』"']+$/g, '').trim();
    if (!stripped) return cleaned;
    if (isChinese ? /[。！？…]$/.test(stripped) : /[.!?…]$/.test(stripped)) return stripped;
    const settled = stripped.replace(isChinese ? /[，、；：,;:–—-]+$/ : /[,;:–—-]+$/, '').trim();
    return settled ? `${settled}${isChinese ? '。' : '.'}` : '';
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
        '[这条回复之前的最近对话]',
        conversationContext,
        '',
        '[Companion 的完整回复]',
        fullReply,
        '',
        '[需要改编成中文口语的这段原文]',
        sourceText,
    ].join('\n');

    const directorStartedAt = Date.now();
    console.log(`[Voice] 单轮导演开始 model=${config.translationModel}`);
    const response = await callOpenAI(apiConfig, [
        {
            role: 'system',
            content: [
                '你是沈晏唯一的口语改编作者和最终表演导演。一次生成可以直接朗读的中文表演脚本，供 ElevenLabs 多语言 TTS 合成。',
                '保留原文的确切含义、情感分量、亲密感、克制与边界。',
                '沈晏的声音听起来成熟、专注、安静而亲密、情感在场——不平淡、不戏剧化、不甜腻。',
                '回答前，先在心中推断这句的潜台词、情感弧线、关键用词、换气点与单调风险；静默审阅自己的草稿，然后只输出最终修正稿。',
                '用中文句长、逗号、破折号、省略号和句界制造自然的音高起伏；避免所有分句长度或节奏雷同。',
                'ElevenLabs 没有数字停顿标记。用逗号、破折号、句号、省略号编码节奏。绝不输出 SSML 或 <#x#> 标记。',
                '当原文有明显可听见的情绪时，至少放一个符合的表演标签；最多三个，放在它们所修饰的词句旁边。真正中性的句子，零个或一个标签就够。',
                '只能从这些标签里选：[warmly], [softly], [gently], [quietly], [tenderly], [reassuringly], [playfully], [teasingly], [mischievously], [dryly], [sarcastic], [amused], [curious], [concerned], [hesitant], [frustrated], [tired], [relieved], [vulnerable], [protectively], [possessively], [firmly], [serious], [sad], [angry], [fearful], [surprised], [whispers], [low voice], [lower voice], [with a smile], [sighs], [exhales], [inhales], [gasps], [sniffs], [swallows], [clears throat], [chuckles], [laughs softly], [laughs]。',
                '只有原文或实时语境确实支持时才用声音反应（叹气、轻笑、吸气等）；绝不虚构肢体动作或环境音效；绝不写括号舞台指示。',
                '结尾要沉稳落地：陈述句必须以句号结束，并以自然的降调收尾。最终内容必须是说出口的字和标点，绝不可以音频标签结尾。',
                '只有原文确实是直接提问时才用问号；绝不要把陈述、安慰、邀请或命令改写成问句腔。',
                'emotion 只能从下面选：happy, sad, angry, fearful, disgusted, surprised, calm。选沈晏表达的情绪，不是话题或用户的情绪。calm 也必须温暖在场，但原文真的平静时不要硬拉成更强的类别。',
                '这是口语化改编，不是逐字翻译。不添加原文里没有的事实、承诺、昵称、解释、肢体动作或情绪强度。',
                '只输出一个合法 JSON 对象，没有别的，格式严格为：{"spokenText":"最终中文表演脚本","emotion":"calm"}。',
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
    // 语言感知：中文脚本标注 zh（否则多语言模型会用英文发音规则读中文）；英文保持原行为 en
    const languageCode = /[㐀-鿿]/.test(String(spokenText || '')) ? 'zh' : 'en';

    return {
        text: spokenText,
        model_id: config.ttsModel,
        language_code: languageCode,
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
