function stripThinkingText(text) {
    return String(text || '')
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi, '')
        .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
        .replace(/<thinking\b[^>]*>[\s\S]*/gi, '')
        .replace(/<think\b[^>]*>[\s\S]*/gi, '')
        .replace(/<\/thinking\s*>/gi, '')
        .replace(/<\/think\s*>/gi, '')
        .trim();
}

function sanitizeMessagesForAI(messages) {
    for (const message of messages) {
        if (Array.isArray(message?.content)) continue;
        if (message?.role === 'assistant') {
            message.content = stripThinkingText(message.content)
                .replace(/\s*\[companion-sticker:[a-z0-9-]+\]\s*$/i, '')
                .trim();
        } else if (message?.role === 'user') {
            message.content = String(message.content || '')
                .replace(/^(\[image\]\s*)?\[voice-message:(?:\d+(?:\.\d+)?)\]\s*/i, '$1')
                .trim();
        }
    }
    return messages;
}

module.exports = { stripThinkingText, sanitizeMessagesForAI };
