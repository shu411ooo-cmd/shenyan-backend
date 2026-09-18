/* ============================================================
   Memory MCP connection configuration

   MEMORY_* is the provider-neutral configuration surface. The legacy
   OMBRE_* variables remain supported so current deployments do not change.
   Tool-name/schema adaptation is deliberately separate: today the backend
   still exposes the Ombre tool contract, while a future Serein adapter can
   reuse this transport configuration without another environment migration.
   ============================================================ */

function clean(value) {
  return String(value || '').trim();
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
}

function resolveMemoryMcpConfig(env = process.env) {
  const provider = clean(env.MEMORY_PROVIDER || 'ombre').toLowerCase() || 'ombre';
  const genericEndpoint = stripTrailingSlashes(clean(env.MEMORY_MCP_URL));
  const legacyBaseUrl = stripTrailingSlashes(clean(env.OMBRE_BRAIN_URL));
  const endpoint = genericEndpoint || (legacyBaseUrl ? `${legacyBaseUrl}/mcp` : '');
  const token = clean(env.MEMORY_MCP_TOKEN || env.OMBRE_STATIC_TOKEN);

  return {
    provider,
    endpoint,
    token,
    configured: Boolean(endpoint),
    usesLegacyEnvironment: !genericEndpoint && Boolean(legacyBaseUrl),
  };
}

function buildMemoryMcpHeaders(env = process.env, extraHeaders = {}) {
  const config = resolveMemoryMcpConfig(env);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
    // Ombre 2.x accepts both forms. Other providers such as Serein use the
    // standard Bearer header and should not receive a provider-specific one.
    if (config.provider === 'ombre') headers['Ombre-MCP-Token'] = config.token;
  }

  return { ...headers, ...extraHeaders };
}

module.exports = {
  buildMemoryMcpHeaders,
  resolveMemoryMcpConfig,
};
