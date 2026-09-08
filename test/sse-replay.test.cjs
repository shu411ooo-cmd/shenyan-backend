// ===== SSE 轨迹回放测试（Kelivo 工程方法借鉴 2026-09-03）=====
// 每个 <sse-traces>/<provider>/<case>/ 目录 = 一条真实录制（或合成）的轨迹：
//   events.jsonl   —— 每行一帧 payload（不含「data: 」前缀，[DONE] 用哨兵）
//   expected.json  —— 同路径下合并后的期望输出
// 回放：把每帧原样喂给与 server.js 同源的 sse-parser，断言最终合并结果。
// 改解析器后先跑这个测试，再看要不要更新期望快照。
// 运行：node --test test/  （或 npm run test:sse）

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createFramer, createChatStreamMerger } = require('../sse-parser');

const TRACES_DIR = path.join(__dirname, '..', 'sse-traces');

function reasoningKeysFor(provider) {
  if (provider === 'deepseek') return ['reasoning_content'];
  return ['reasoning', 'reasoning_summary', 'thinking']; // openrouter / synthetic
}

function listCases() {
  const cases = [];
  for (const provider of fs.readdirSync(TRACES_DIR)) {
    const pdir = path.join(TRACES_DIR, provider);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const caseName of fs.readdirSync(pdir)) {
      const cdir = path.join(pdir, caseName);
      if (!fs.statSync(cdir).isDirectory()) continue;
      if (!fs.existsSync(path.join(cdir, 'events.jsonl'))) continue;
      cases.push({ provider, caseName, dir: cdir });
    }
  }
  return cases;
}

for (const { provider, caseName, dir } of listCases()) {
  test(`回放 ${provider}/${caseName}`, () => {
    const rawLines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n');
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));

    const framer = createFramer();
    const merger = createChatStreamMerger({ reasoningKeys: reasoningKeysFor(provider) });
    for (const line of rawLines) {
      if (line === '') continue; // 文件末尾换行
      // 还原真实线路形态：data: <payload>\n
      const frames = framer.push('data: ' + line + '\n');
      for (const f of frames) merger.processDataLine(f);
    }
    assert.deepStrictEqual(merger.result(), expected, `轨迹 ${provider}/${caseName} 合并结果与 expected.json 不一致`);
  });
}