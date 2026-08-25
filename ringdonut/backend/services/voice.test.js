const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeVoiceSourceText,
    cleanSpokenText,
    sanitizeDirectedSpokenText,
    parseVoiceDirectionResponse,
    formatVoiceConversationContext,
    parseElevenLabsError,
    buildElevenLabsRequestBody,
} = require('./voice');

test('normalizes visible Companion text before voice generation', () => {
    const text = normalizeVoiceSourceText(' **过来。** \n[choices]抱我|等等[/choices]\n[companion-sticker:come] ');
    assert.equal(text, '过来。');
});

test('cleans wrapper text from an English spoken adaptation', () => {
    assert.equal(cleanSpokenText('```text\nEnglish: “Come here. You do not have to explain.”\n```'), 'Come here. You do not have to explain.');
});

test('settles an unpunctuated spoken line with a period', () => {
    assert.equal(cleanSpokenText('Stay with me'), 'Stay with me.');
    assert.equal(cleanSpokenText('I am right here,'), 'I am right here.');
    assert.equal(cleanSpokenText('Are you all right?'), 'Are you all right?');
});

test('settles Chinese spoken lines with Chinese punctuation', () => {
    assert.equal(cleanSpokenText('我一直都在'), '我一直都在。');
    assert.equal(cleanSpokenText('我就在这儿，'), '我就在这儿。');
    assert.equal(cleanSpokenText('你还好吗？'), '你还好吗？');
    assert.equal(cleanSpokenText('真的假的……'), '真的假的……');
});

test('strips Chinese wrapper prefixes from a spoken adaptation', () => {
    assert.equal(cleanSpokenText('```\n翻译：过来。\n```'), '过来。');
    assert.equal(cleanSpokenText('中文：我一直都在。'), '我一直都在。');
});

test('formats recent chat context without hidden sticker instructions', () => {
    const context = formatVoiceConversationContext([
        { role: 'user', content: '[sticker:user-hug]\n[sticker-meaning]hidden instruction[/sticker-meaning]\n抱抱我' },
        { role: 'assistant', content: '过来。\n[companion-sticker:come]' },
    ]);
    assert.equal(context, 'User: [sticker:user-hug] 抱抱我\nCompanion: 过来。');
});

test('parses a structured voice direction with a supported emotion', () => {
    const direction = parseVoiceDirectionResponse('```json\n{"spokenText":"[surprised] Wait... you got them? [chuckles]","emotion":"surprised"}\n```');
    assert.deepEqual(direction, {
        spokenText: '[surprised] Wait... you got them?',
        emotion: 'surprised',
        previousText: '',
    });
});

test('falls back to calm and removes unsupported stage directions', () => {
    const direction = parseVoiceDirectionResponse('{"spokenText":"(seductively) Come here. (whimpers)","emotion":"tender"}');
    assert.deepEqual(direction, { spokenText: 'Come here.', emotion: 'calm', previousText: '' });
});

test('rejects malformed structured output instead of reading JSON syntax aloud', () => {
    assert.throws(
        () => parseVoiceDirectionResponse('{"spokenText":"Come here.","emotion":"calm"'),
        /无效 JSON/,
    );
});

test('keeps only three Eleven v3 performance tags and removes a trailing tag', () => {
    const text = sanitizeDirectedSpokenText('[warmly] I know. [whispers] I am here. [hacking] Stay. [sighs] Again. [firmly] Now. [low voice] Easy. [laughs] Extra. [gasps] Overflow.');
    assert.equal(text, '[warmly] I know. [whispers] I am here. Stay. [sighs] Again. Now. Easy. Extra. Overflow.');
});

test('converts legacy MiniMax markup before ElevenLabs synthesis', () => {
    const text = sanitizeDirectedSpokenText('(inhale) I know. <#0.25#> I am here. (chuckle)');
    assert.equal(text, '[inhales] I know. … I am here.');
});

test('removes unsupported multi-word parenthesized stage directions', () => {
    const text = sanitizeDirectedSpokenText('Stay with me. (deep physical action) Eyes here. (heavy breathing)');
    assert.equal(text, 'Stay with me. Eyes here.');
});

test('returns silent English continuity context without performance directions', () => {
    const direction = parseVoiceDirectionResponse('{"spokenText":"[softly] Stay here.","emotion":"calm","previousText":"[concerned] You looked tired. (quietly)"}');
    assert.deepEqual(direction, {
        spokenText: '[softly] Stay here.',
        emotion: 'calm',
        previousText: 'You looked tired.',
    });
});

test('decodes ElevenLabs JSON errors returned as an audio response buffer', () => {
    const error = {
        message: 'Request failed with status code 400',
        response: {
            data: Buffer.from(JSON.stringify({
                detail: { status: 'quota_exceeded', message: 'You have 0 weighted tokens left' },
            })),
        },
    };
    assert.deepEqual(parseElevenLabsError(error), {
        code: 'quota_exceeded',
        message: 'ElevenLabs 额度不足，请充值、升级套餐或启用按量计费',
    });
});

test('explains a restricted ElevenLabs key missing Speech to Text scope', () => {
    const error = {
        response: {
            data: {
                detail: {
                    type: 'authentication_error',
                    code: 'insufficient_permissions',
                    message: 'The API key lacks the permission speech_to_text',
                },
            },
        },
    };
    assert.deepEqual(parseElevenLabsError(error), {
        code: 'insufficient_permissions',
        message: '当前 ElevenLabs API Key 没有开启 Speech to Text 权限',
    });
});

test('never sends unsupported previous_text to Eleven v3', () => {
    const body = buildElevenLabsRequestBody('Stay here.', {
        ttsModel: 'eleven_v3',
        stability: 0.5,
    }, { previousText: 'I am right here.' });
    assert.equal(body.previous_text, undefined);
    assert.equal(body.text, 'Stay here.');
});

test('keeps continuity available for models that support previous_text', () => {
    const body = buildElevenLabsRequestBody('Stay here.', {
        ttsModel: 'eleven_multilingual_v2',
        stability: 0.5,
    }, { previousText: 'I am right here.' });
    assert.equal(body.previous_text, 'I am right here.');
});

test('marks Chinese spoken text as zh so the voice does not use English pronunciation', () => {
    const zh = buildElevenLabsRequestBody('今天下雨了，我有点想你。', {
        ttsModel: 'eleven_flash_v2_5',
        stability: 0.5,
    });
    assert.equal(zh.language_code, 'zh');
    assert.equal(zh.text, '今天下雨了，我有点想你。');
    // 英文路径保持原行为 en
    const en = buildElevenLabsRequestBody('Stay here. I am listening.', {
        ttsModel: 'eleven_flash_v2_5',
        stability: 0.5,
    });
    assert.equal(en.language_code, 'en');
});
