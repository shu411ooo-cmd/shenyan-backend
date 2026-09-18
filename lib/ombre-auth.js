/* Backwards-compatible import for callers that still use the old name. */
const { buildMemoryMcpHeaders } = require('./memory-mcp');

function buildOmbreHeaders(env = process.env, extraHeaders = {}) {
  return buildMemoryMcpHeaders({ ...env, MEMORY_PROVIDER: 'ombre' }, extraHeaders);
}

module.exports = { buildOmbreHeaders };
