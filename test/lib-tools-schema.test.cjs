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
