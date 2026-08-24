/**
 * Host integration boundary.
 *
 * Replace these functions with your own database, message-history, settings,
 * storage, and notification implementations. The call routes intentionally do
 * not contain credentials or assumptions about a specific application.
 */

function notConfigured(name) {
    throw new Error(`Host adapter not configured: ${name}`);
}

const supabase = {
    from: () => notConfigured('supabase.from'),
    storage: {
        from: () => notConfigured('supabase.storage.from'),
    },
};

async function loadMemories() { return notConfigured('loadMemories'); }
async function loadMessagesForAI() { return notConfigured('loadMessagesForAI'); }
async function loadSettings() { return notConfigured('loadSettings'); }
async function saveMessage() { return notConfigured('saveMessage'); }
async function authorizeRequest() { return notConfigured('authorizeRequest'); }
async function saveCallAudio() { return notConfigured('saveCallAudio'); }

// Optional integration point. A no-op is safer than embedding a production
// push provider or device identifier in the reference implementation.
async function notifyIncomingCall() { return false; }

module.exports = {
    supabase,
    loadMemories,
    loadMessagesForAI,
    loadSettings,
    saveMessage,
    authorizeRequest,
    saveCallAudio,
    notifyIncomingCall,
};
