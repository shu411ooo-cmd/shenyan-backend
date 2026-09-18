const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMemoryMcpHeaders,
  resolveMemoryMcpConfig,
} = require('../lib/memory-mcp');

test('memory MCP config preserves the legacy Ombre deployment contract', () => {
  const env = {
    OMBRE_BRAIN_URL: 'https://ombre.example/',
    OMBRE_STATIC_TOKEN: 'legacy-secret',
  };

  assert.deepEqual(resolveMemoryMcpConfig(env), {
    provider: 'ombre',
    endpoint: 'https://ombre.example/mcp',
    token: 'legacy-secret',
    configured: true,
    usesLegacyEnvironment: true,
  });
  assert.deepEqual(buildMemoryMcpHeaders(env), {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer legacy-secret',
    'Ombre-MCP-Token': 'legacy-secret',
  });
});

test('generic memory MCP variables override legacy values for Serein previews', () => {
  const env = {
    MEMORY_PROVIDER: 'serein',
    MEMORY_MCP_URL: 'https://memory.example/serein/mcp/',
    MEMORY_MCP_TOKEN: 'preview-secret',
    OMBRE_BRAIN_URL: 'https://old-ombre.example',
    OMBRE_STATIC_TOKEN: 'old-secret',
  };

  assert.deepEqual(resolveMemoryMcpConfig(env), {
    provider: 'serein',
    endpoint: 'https://memory.example/serein/mcp',
    token: 'preview-secret',
    configured: true,
    usesLegacyEnvironment: false,
  });
  assert.deepEqual(buildMemoryMcpHeaders(env, { 'Mcp-Session-Id': 'session-1' }), {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer preview-secret',
    'Mcp-Session-Id': 'session-1',
  });
});

test('memory MCP headers do not emit empty credentials', () => {
  const headers = buildMemoryMcpHeaders({ MEMORY_PROVIDER: 'ombre' });

  assert.equal(Object.hasOwn(headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(headers, 'Ombre-MCP-Token'), false);
});
