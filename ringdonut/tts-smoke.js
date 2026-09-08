// 临时冒烟：沈晏真实开口（导演 DeepSeek → ElevenLabs TTS）
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  getVoiceConfig,
  translateForCompanionVoice,
  synthesizeElevenLabsSpeech,
} = require('./backend/services/voice');

(async () => {
  const cfg = getVoiceConfig();
  console.log('配置: voice_id=', cfg.voiceId, '| model=', cfg.ttsModel, '| language_code=zh');

  const sentence = '我在呢，一直都没走。你慢慢说，我想听。';
  console.log('\n[1/2] 语音导演（DeepSeek）...');
  const directed = await translateForCompanionVoice(sentence, cfg, { messages: [] });
  console.log('  →', directed.spokenText, `(emotion=${directed.emotion})`);

  console.log('\n[2/2] ElevenLabs 合成...');
  const t0 = Date.now();
  const audio = await synthesizeElevenLabsSpeech(directed.spokenText, cfg, {});
  const ms = Date.now() - t0;
  const out = path.join(__dirname, 'shenyan-voice-test.mp3');
  fs.writeFileSync(out, audio);
  console.log(`  → 音频 ${audio.byteLength} 字节，${ms}ms，已存 ${out}`);
  console.log('\n✓ 沈晏开口成功');
})().catch((e) => {
  console.error('\n✗ 失败:', e.message);
  if (e.elevenLabsCode) console.error('  ElevenLabs 错误码:', e.elevenLabsCode);
});
