/* ============================================================
   Ombre MCP authentication headers

   Ombre deployments may accept the configured static token through either
   the standard Bearer header or the legacy Ombre-MCP-Token header. Keep both
   on every MCP request so initialize and tools/call cannot drift apart.
   ============================================================ */

function buildOmbreHeaders(env = process.env, extraHeaders = {}) {
  const token = String(env.OMBRE_STATIC_TOKEN || '');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['Ombre-MCP-Token'] = token;
  }

  return { ...headers, ...extraHeaders };
}

module.exports = { buildOmbreHeaders };
