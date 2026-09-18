const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOmbreHeaders } = require('../lib/ombre-auth');

test('Ombre headers send the configured token through both supported auth headers', () => {
  const headers = buildOmbreHeaders({ OMBRE_STATIC_TOKEN: 'secret-token' }, {
    'Mcp-Session-Id': 'session-1',
  });

  assert.deepEqual(headers, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer secret-token',
    'Ombre-MCP-Token': 'secret-token',
    'Mcp-Session-Id': 'session-1',
  });
});

test('Ombre headers do not emit empty credentials', () => {
  const headers = buildOmbreHeaders({});

  assert.equal(Object.hasOwn(headers, 'Authorization'), false);
  assert.equal(Object.hasOwn(headers, 'Ombre-MCP-Token'), false);
});
