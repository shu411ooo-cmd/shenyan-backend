const test = require('node:test');
const assert = require('node:assert/strict');
const {
    decodeAudioPayload,
    sanitizeAcousticFeatures,
    normalizeToneResult,
    formatVoiceToneContext,
} = require('./voiceInput');

test('sanitizeAcousticFeatures clamps untrusted browser measurements', () => {
    assert.deepEqual(sanitizeAcousticFeatures({
        duration_s: 12.34,
        pitch_mean_hz: 9999,
        pitch_var: -10,
        energy_mean: 0.123456,
        pause_ratio: 2,
        voiced_ratio: '0.456',
    }), {
        duration_s: 12.3,
        pitch_mean_hz: 600,
        pitch_var: 0,
        energy_mean: 0.1235,
        energy_var: 0,
        pause_ratio: 1,
        tempo_strength: 0,
        voiced_ratio: 0.46,
    });
});

test('decodeAudioPayload accepts known formats and rejects malformed input', () => {
    const decoded = decodeAudioPayload({ mediaType: 'audio/webm;codecs=opus', data: Buffer.from('voice').toString('base64') });
    assert.equal(decoded.mediaType, 'audio/webm');
    assert.equal(decoded.buffer.toString(), 'voice');
    assert.throws(() => decodeAudioPayload({ mediaType: 'text/plain', data: 'dm9pY2U=' }), /不支持/);
    assert.throws(() => decodeAudioPayload({ mediaType: 'audio/webm', data: '%%%bad' }), /无效/);
});

test('normalizeToneResult only permits supported, bounded hints', () => {
    assert.deepEqual(normalizeToneResult({ emotion: 'DIAGNOSIS', confidence: 9, hint: '<sad>\n声音很轻' }), {
        emotion: 'neutral',
        confidence: 1,
        hint: 'sad 声音很轻',
    });
});

test('formatVoiceToneContext marks inference as uncertain and hidden', () => {
    const context = formatVoiceToneContext({
        emotion: 'tired',
        confidence: 0.72,
        hint: '声音偏低，停顿较多。',
        features: { pitch_mean_hz: 170, pause_ratio: 0.42 },
    });
    assert.match(context, /仅供当轮理解/);
    assert.match(context, /tired/);
    assert.match(context, /可推翻/);
});
