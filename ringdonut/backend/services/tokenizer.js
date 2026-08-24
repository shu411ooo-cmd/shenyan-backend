let encoding;

function getTokenizer() {
    if (!encoding) {
        const { getEncoding } = require('js-tiktoken');
        encoding = getEncoding('cl100k_base');
    }
    return encoding;
}

function countTokens(messages) {
    const text = messages.map(m => m.content || '').join(' ');
    return getTokenizer().encode(text).length;
}

module.exports = { countTokens };
