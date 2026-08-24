/**
 * LLM integration boundary.
 *
 * Implement these functions with your preferred Anthropic or OpenAI-compatible
 * client. Signatures mirror the calls made by the reference services.
 */

function notConfigured(name) {
    throw new Error(`LLM adapter not configured: ${name}`);
}

function getApiConfig(model) {
    return {
        type: process.env.LLM_API_TYPE || 'openai',
        provider: 'Host LLM',
        baseUrl: process.env.LLM_BASE_URL || '',
        apiKey: process.env.LLM_API_KEY || '',
        model: model || process.env.DEFAULT_CALL_MODEL || '',
        timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 45000),
    };
}

async function callOpenAI() { return notConfigured('callOpenAI'); }
async function callAnthropicNative() { return notConfigured('callAnthropicNative'); }

function parseAnthropicResponse(raw) {
    if (!raw) return { text: '', reasoning: null };
    return notConfigured('parseAnthropicResponse');
}

module.exports = {
    getApiConfig,
    callOpenAI,
    callAnthropicNative,
    parseAnthropicResponse,
};
