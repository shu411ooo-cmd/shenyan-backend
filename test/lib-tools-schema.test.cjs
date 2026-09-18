// ===== lib/tools-schema.js 单元测试（node:test）=====
// 工具清单是纯数据但常被改 —— 结构校验能抓住「必填字段写错名字」这类改契约时的手滑。

const { test } = require('node:test');
const assert = require('node:assert');
const { getTools } = require('../lib/tools-schema.js');

test('getTools：返回 24 个工具', () => {
  assert.ok(Array.isArray(getTools()));
  assert.strictEqual(getTools().length, 24);
});

test('每个工具结构完整：type/function.name/description/parameters 齐全', () => {
  for (const tool of getTools()) {
    assert.strictEqual(tool.type, 'function');
    const fn = tool.function;
    assert.ok(fn, 'function 缺失');
    assert.strictEqual(typeof fn.name, 'string');
    assert.ok(fn.name.length > 0, 'name 为空');
    assert.strictEqual(typeof fn.description, 'string');
    assert.ok(fn.description.length > 0, 'description 为空');
    assert.strictEqual(typeof fn.parameters, 'object');
    assert.ok(fn.parameters, 'parameters 缺失');
    assert.strictEqual(fn.parameters.type, 'object');
    assert.ok(fn.parameters.properties && typeof fn.parameters.properties === 'object', 'properties 缺失');
  }
});

test('工具名唯一（不能有重名）', () => {
  const names = getTools().map((t) => t.function.name);
  assert.strictEqual(new Set(names).size, names.length);
});

test('每个 required 里列的字段都必须在 properties 里存在', () => {
  for (const tool of getTools()) {
    const { parameters } = tool.function;
    for (const requiredField of parameters.required || []) {
      assert.strictEqual(
        typeof requiredField, 'string',
        `${tool.function.name}: required 项应是字符串`
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(parameters.properties, requiredField),
        `${tool.function.name}: required 字段「${requiredField}」不在 properties 里`
      );
    }
  }
});

/* ===== Ombre 契约钉子（2026-09-18）=====
   远端 12 个工具的参数名必须与 Ombre 的 MCP 签名一致——不一致时模型按我们公布的 schema
   传参，会撞上 Ombre 的 required 缺失或 extra="forbid" 而被直接拒。
   实锤过一次：trace 把必填的 bucket_id 写成了 id，还多带一个 plan_id，
   于是「修正已有记忆的唯一入口」对模型完全不可用（内部写回路径却早已改对，两边各改各的）。
   这里只钉参数名这一层（最稳、跨版本不变的部分），不钉护栏力度与返回文案。 */
const OMBRE_CONTRACT = {
  // 工具名: { required: [...必填], forbid: [...绝不能出现的字段] }
  trace: { required: ['bucket_id'], forbid: ['id', 'plan_id'] },
  letter_write: { required: ['author', 'content'], forbid: [] },
  anchor: { required: ['bucket_id'], forbid: [] },
  release: { required: ['bucket_id'], forbid: [] },
};

test('Ombre 远端工具的必填参数名与签名一致', () => {
  for (const [name, contract] of Object.entries(OMBRE_CONTRACT)) {
    const tool = getTools().find((t) => t.function.name === name);
    assert.ok(tool, `${name}: 工具不存在`);
    const { parameters } = tool.function;
    for (const field of contract.required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(parameters.properties, field),
        `${name}: 缺必填参数「${field}」（Ombre 侧无默认值，缺了必被拒）`
      );
    }
    assert.deepStrictEqual(
      [...(parameters.required || [])].sort(),
      [...contract.required].sort(),
      `${name}: required 与 Ombre 签名不一致`
    );
    for (const field of contract.forbid) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(parameters.properties, field),
        `${name}: 不该暴露「${field}」（Ombre 签名里没有，extra=forbid 会拒）`
      );
    }
  }
});
