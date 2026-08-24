const router = require('express').Router();
const host = require('../adapters/host');
const { normalizeReason, formatCallRecord, splitSpokenSegments, parseCallDirectives } = require('../services/callLifecycle');
const { buildCallContext, CALL_CONTEXT_TOKEN_BUDGET, CALL_RECENT_CHAT_MESSAGES, getCallTokenBudgets } = require('../services/callContext');
const {
    buildTranscriptEvidence,
    selectGroundedExcerpts,
    buildGroundedCallSummary,
    validateAbstractiveSummary,
} = require('../services/callSummary');
const { sanitizeMessagesForAI } = require('../services/messageUtils');
const { formatVoiceToneContext } = require('../services/voiceInput');
const {
    normalizeVoiceSourceText,
    getCallVoiceConfig,
    hashVoiceSource,
    translateForCompanionVoice,
    synthesizeElevenLabsSpeech,
} = require('../services/voice');
const { getApiConfig, callAnthropicNative, parseAnthropicResponse, callOpenAI } = require('../adapters/llm');

router.use(async (req, res, next) => {
    try {
        await host.authorizeRequest(req);
        next();
    } catch (error) {
        res.status(401).json({ error: error.message || 'Unauthorized' });
    }
});

async function summarizeCall(turns) {
    const evidence = buildTranscriptEvidence(turns);
    if (!evidence.length) return '';
    const source = evidence.map(line => `[${line.id}] ${line.speaker}: ${line.text}`).join('\n').slice(0, 16000);
    const config = {
        ...getApiConfig(process.env.CALL_SUMMARY_MODEL || 'your-summary-model'),
        model: process.env.CALL_SUMMARY_MODEL || 'your-summary-model',
        timeoutMs: 15000,
        provider: 'Companion Call Summary',
    };
    const response = await callOpenAI(config, [
        {
            role: 'system',
            content: [
                '你不是总结作者，只是从私人电话的分句证据中选出最值得记住的2到3个短片段。',
                'excerpt 必须是对应 ID 文本中连续存在的原文，4到42个字；不得改写、补全、解释或新增事实。',
                '优先保留一个 User 的核心细节和一个 Companion 的有意义回应；略过“嗯”“好”等口头填充。没有值得保留的内容时返回空数组。',
                '只输出严格 JSON：{"highlights":[{"id":"B1","excerpt":"完全照抄的短片段"},{"id":"E1","excerpt":"完全照抄的短片段"}]}',
            ].join('\n'),
        },
        { role: 'user', content: source },
    ], [], 220, 0);
    const selected = selectGroundedExcerpts(response.choices?.[0]?.message?.content, evidence);
    const fallback = buildGroundedCallSummary(selected);
    if (!selected.length) return fallback;

    const verifiedSource = selected
        .map(line => `[${line.id}] ${line.speaker}: ${line.text}`)
        .join('\n');
    try {
        const summaryResponse = await callOpenAI(config, [
            {
                role: 'system',
                content: [
                    '你是私人通话摘要编辑。下面只有已经逐字核验过的通话片段；你的每个事实都必须来自这些片段。',
                    '用1到2句自然、连贯的中文概括共同主题、User的重要近况或感受，以及Companion有意义的回应。可以压缩和改写，但不能推断原因、情绪、时间、数量或后续结果。',
                    '不要写成逐句流水账，不使用引号，不写“User说 / Companion说 / 刚刚打了电话”，也不要添加片段之外的常识。控制在30到110个汉字。',
                    '只输出严格 JSON：{"summary":"自然摘要"}',
                ].join('\n'),
            },
            { role: 'user', content: verifiedSource },
        ], [], 180, 0);
        return validateAbstractiveSummary(summaryResponse.choices?.[0]?.message?.content, selected) || fallback;
    } catch (error) {
        console.warn('[Call Summary] 自然摘要生成失败，使用核验片段:', error.message);
        return fallback;
    }
}

async function loadCallSnapshot(sessionId, settings) {
    const [memories, recentMessages, notesResult] = await Promise.all([
        host.loadMemories(),
        host.loadMessagesForAI(sessionId),
        host.supabase.from('notes').select('content, created_at').order('created_at', { ascending: false }).limit(8),
    ]);
    const latestMemory = memories.at(-1) || null;
    const recentChat = recentMessages.slice(-CALL_RECENT_CHAT_MESSAGES).map(message => ({ ...message }));
    sanitizeMessagesForAI(recentChat);
    return {
        systemPrompt: String(settings?.system_prompt || '').trim(),
        memorySummary: String(latestMemory?.summary || '').trim(),
        notes: (notesResult.data || []).slice().reverse(),
        recentChat,
        capturedAt: new Date().toISOString(),
    };
}

async function loadOwnedCall(callId, sessionId, requireActive = true) {
    let query = host.supabase.from('call_sessions').select('*').eq('id', callId).eq('session_id', sessionId);
    if (requireActive) query = query.eq('status', 'active');
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data;
}

async function getDnd(sessionId) {
    const { data, error } = await host.supabase
        .from('call_preferences').select('dnd').eq('session_id', sessionId).maybeSingle();
    if (error) throw error;
    return data?.dnd === true;
}

async function notifyIncomingCall(sessionId, reason) {
    return host.notifyIncomingCall({
        sessionId,
        reason: normalizeReason(reason),
    });
}

async function createInvite({ sessionId, reason, source = 'companion', force = false }) {
    if (!force && await getDnd(sessionId)) return { ok: false, dnd: true };
    const { data: existing } = await host.supabase
        .from('call_invites').select('*').eq('session_id', sessionId).eq('status', 'pending')
        .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (existing) return { ok: true, invite: existing, duplicate: true };

    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const { data, error } = await host.supabase.from('call_invites').insert({
        session_id: sessionId,
        reason: normalizeReason(reason),
        source,
        expires_at: expiresAt,
    }).select().single();
    if (error) throw error;
    notifyIncomingCall(sessionId, data.reason).catch(error => console.warn('[Call] 来电推送失败:', error.message));
    return { ok: true, invite: data };
}

async function expireMissedInvites(sessionId) {
    const now = new Date().toISOString();
    const { data: expired, error } = await host.supabase
        .from('call_invites').select('*').eq('session_id', sessionId).eq('status', 'pending').lte('expires_at', now);
    if (error) throw error;
    for (const invite of expired || []) {
        const { data: claimed } = await host.supabase.from('call_invites')
            .update({ status: 'missed', answered_at: now }).eq('id', invite.id).eq('status', 'pending').select('id').maybeSingle();
        if (claimed) {
            await host.saveMessage('assistant', `📞 未接来电\n没接到你。${invite.reason}——不急，回来再跟我说。`, {}, sessionId);
        }
    }
}

router.get('/invite', async (req, res) => {
    try {
        const sessionId = String(req.query.sessionId || '').trim();
        if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
        await expireMissedInvites(sessionId);
        const { data, error } = await host.supabase.from('call_invites').select('*')
            .eq('session_id', sessionId).eq('status', 'pending').gt('expires_at', new Date().toISOString())
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        res.json({ invite: data || null, dnd: await getDnd(sessionId) });
    } catch (error) {
        res.status(500).json({ error: error.message || '读取来电失败' });
    }
});

router.post('/invite', async (req, res) => {
    try {
        const sessionId = String(req.body.sessionId || '').trim();
        if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
        res.json(await createInvite({
            sessionId,
            reason: req.body.reason,
            source: req.body.source || 'companion',
            force: req.body.force === true,
        }));
    } catch (error) {
        res.status(500).json({ error: error.message || '创建来电失败' });
    }
});

router.post('/answer', async (req, res) => {
    try {
        const id = Number(req.body.id);
        const action = req.body.action === 'accept' ? 'accepted' : req.body.action === 'decline' ? 'declined' : '';
        if (!Number.isSafeInteger(id) || !action) return res.status(400).json({ error: '来电或操作无效' });
        const note = Array.from(String(req.body.note || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
        const { data, error } = await host.supabase.from('call_invites').update({
            status: action,
            decline_note: action === 'declined' ? note || null : null,
            answered_at: new Date().toISOString(),
        }).eq('id', id).eq('status', 'pending').select('*').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: '这通来电已经结束了' });
        if (action === 'declined' && note) await host.saveMessage('user', `[来电未接：${note}]`, {}, data.session_id);
        res.json({ ok: true, invite: data });
    } catch (error) {
        res.status(500).json({ error: error.message || '处理来电失败' });
    }
});

router.post('/dnd', async (req, res) => {
    try {
        const sessionId = String(req.body.sessionId || '').trim();
        if (!sessionId || typeof req.body.dnd !== 'boolean') return res.status(400).json({ error: '参数无效' });
        const { data, error } = await host.supabase.from('call_preferences').upsert({
            session_id: sessionId, dnd: req.body.dnd, updated_at: new Date().toISOString(),
        }, { onConflict: 'session_id' }).select().single();
        if (error) throw error;
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message || '勿扰设置失败' });
    }
});

router.post('/start', async (req, res) => {
    try {
        const sessionId = String(req.body.sessionId || '').trim();
        const model = String(req.body.model || process.env.DEFAULT_CALL_MODEL || 'your-model').trim();
        if (!sessionId) return res.status(400).json({ error: 'sessionId 必填' });
        const settings = await host.loadSettings();
        const contextSnapshot = await loadCallSnapshot(sessionId, settings);
        const budgets = getCallTokenBudgets(model);
        const preview = buildCallContext(contextSnapshot, [], budgets.tokenBudget, budgets.systemTokenBudget);
        const { data, error } = await host.supabase.from('call_sessions').insert({
            session_id: sessionId,
            model,
            context_snapshot: contextSnapshot,
            token_budget: budgets.tokenBudget,
            system_token_budget: budgets.systemTokenBudget,
        }).select('id, model, token_budget, system_token_budget, started_at').single();
        if (error) throw error;
        console.log(`[Call Context] 建立 callId=${data.id} model=${model} systemTokens=${preview.estimatedTokens} budget=${data.token_budget}`);
        res.json({ callId: data.id, model: data.model, tokenBudget: data.token_budget });
    } catch (error) {
        console.error('[Call] 建立通话失败:', error.message);
        res.status(500).json({ error: error.message || '建立通话失败' });
    }
});

router.post('/respond', async (req, res) => {
    try {
        const callId = String(req.body.callId || '').trim();
        const sessionId = String(req.body.sessionId || '').trim();
        const message = String(req.body.message || '').trim();
        if (!callId || !sessionId || !message) return res.status(400).json({ error: '通话参数不完整' });
        const call = await loadOwnedCall(callId, sessionId, true);
        if (!call) return res.status(409).json({ error: '这通电话已经结束了' });

        const toneContext = formatVoiceToneContext(req.body.voiceTone);
        const userContent = toneContext ? `${toneContext}\n\nUser just said:\n${message}` : message;
        const { error: userError } = await host.supabase.from('call_turns').insert({
            call_id: callId,
            role: 'user',
            content: message,
            voice_tone: req.body.voiceTone || null,
            duration_seconds: Number.isFinite(Number(req.body.duration)) ? Number(req.body.duration) : null,
        });
        if (userError) throw userError;

        const { data: turns, error: turnsError } = await host.supabase.from('call_turns')
            .select('id, role, content, voice_tone, created_at').eq('call_id', callId)
            .order('created_at', { ascending: true }).order('id', { ascending: true });
        if (turnsError) throw turnsError;
        const modelTurns = turns.map((turn, index) => ({
            role: turn.role,
            content: index === turns.length - 1 && turn.role === 'user' ? userContent : turn.content,
        }));
        const fallbackBudgets = getCallTokenBudgets(call.model);
        const context = buildCallContext(
            call.context_snapshot || {},
            modelTurns,
            call.token_budget || fallbackBudgets.tokenBudget || CALL_CONTEXT_TOKEN_BUDGET,
            call.system_token_budget || fallbackBudgets.systemTokenBudget,
        );
        console.log(`[Call Context] callId=${callId} turns=${turns.length} inputTokens~${context.estimatedTokens}/${context.tokenBudget}`);

        const apiConfig = getApiConfig(call.model);
        let reply = '';
        if (apiConfig.type === 'anthropic') {
            const raw = await callAnthropicNative(
                apiConfig,
                context.messages,
                context.systemPrompt,
                [],
                320,
                0.72,
                false,
                { ttl: '5m', usageLabel: `电话 ${callId.slice(0, 8)}` },
            );
            const parsed = parseAnthropicResponse(raw);
            reply = parsed.text;
        } else {
            const raw = await callOpenAI(apiConfig, [
                { role: 'system', content: context.systemPrompt },
                ...context.messages,
            ], [], 320, 0.72);
            reply = raw.choices?.[0]?.message?.content || '';
        }

        const lifecycle = parseCallDirectives(reply);
        const cleanReply = lifecycle.cleanedText || String(reply || '').trim();
        if (!cleanReply) throw new Error('Companion 没有接上这一句');
        const { data: assistantTurn, error: assistantError } = await host.supabase.from('call_turns').insert({
            call_id: callId,
            role: 'assistant',
            content: cleanReply,
        }).select('id').single();
        if (assistantError) throw assistantError;
        const now = new Date().toISOString();
        await host.supabase.from('call_sessions').update({ updated_at: now, last_heartbeat_at: now }).eq('id', callId);
        res.json({
            reply: cleanReply,
            turnId: assistantTurn.id,
            call: { hangup: lifecycle.hangup },
        });
    } catch (error) {
        console.error('[Call] 独立回复失败:', error.message);
        res.status(500).json({ error: error.message || '通话回复失败' });
    }
});

router.post('/heartbeat', async (req, res) => {
    try {
        const callId = String(req.body.callId || '').trim();
        const sessionId = String(req.body.sessionId || '').trim();
        if (!callId || !sessionId) return res.status(400).json({ error: '通话参数不完整' });
        const call = await loadOwnedCall(callId, sessionId, true);
        if (!call) return res.status(409).json({ error: '这通电话已经结束了' });
        const now = new Date().toISOString();
        const { error } = await host.supabase.from('call_sessions')
            .update({ last_heartbeat_at: now, updated_at: now }).eq('id', callId).eq('status', 'active');
        if (error) throw error;
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '通话心跳失败' });
    }
});

router.post('/finish', async (req, res) => {
    try {
        const callId = String(req.body.callId || '').trim();
        const sessionId = String(req.body.sessionId || '').trim();
        const duration = Number(req.body.duration);
        if (!callId || !sessionId || !Number.isFinite(duration)) return res.status(400).json({ error: '通话参数不完整' });
        const call = await loadOwnedCall(callId, sessionId, false);
        if (!call) return res.status(404).json({ error: '找不到这通电话' });
        if (call.status === 'ended' && call.chat_message_id) {
            return res.json({ ok: true, saved: true, messageId: call.chat_message_id, content: formatCallRecord(call.duration_seconds, call.summary) });
        }
        if (call.status !== 'active') return res.status(409).json({ error: '这通电话不是活动状态' });
        const nowMs = Date.now();
        const startedAtMs = new Date(call.started_at).getTime();
        const heartbeatAtMs = new Date(call.last_heartbeat_at || call.updated_at || call.started_at).getTime();
        const serverDuration = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
        const heartbeatAge = Math.max(0, Math.round((nowMs - heartbeatAtMs) / 1000));
        if (!Number.isFinite(startedAtMs) || !Number.isFinite(heartbeatAtMs) || heartbeatAge > 40 || Math.abs(serverDuration - duration) > 45) {
            await host.supabase.from('call_sessions').update({
                status: 'failed', summary_status: 'skipped', ended_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            }).eq('id', callId).eq('status', 'active');
            console.warn(`[Call] 拒绝失真的 finish callId=${callId} clientDuration=${duration} serverDuration=${serverDuration} heartbeatAge=${heartbeatAge}`);
            return res.status(409).json({ error: '通话状态已经过期，不生成记录' });
        }
        const { data: turns, error: turnsError } = await host.supabase.from('call_turns')
            .select('role, content, created_at').eq('call_id', callId)
            .order('created_at', { ascending: true });
        if (turnsError) throw turnsError;

        const hasUserTurn = turns?.some(turn => turn.role === 'user');
        const hasAssistantTurn = turns?.some(turn => turn.role === 'assistant');

        if (duration < 3 || !hasUserTurn || !hasAssistantTurn) {
            await host.supabase.from('call_sessions').update({
                status: 'ended', duration_seconds: Math.max(0, Math.round(duration)),
                summary_status: 'skipped', ended_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            }).eq('id', callId);
            return res.json({ ok: true, saved: false });
        }
        let summary = '';
        let summaryStatus = duration >= 20 ? 'pending' : 'skipped';
        const initialRecord = formatCallRecord(duration, '');
        const saved = await host.saveMessage('assistant', initialRecord, {
            tool_calls: JSON.stringify({ event_type: 'call_record', call_id: String(callId) }),
        }, sessionId);
        if (!saved?.id) throw new Error('通话记录写入主对话失败');
        const endedAt = new Date().toISOString();
        await host.supabase.from('call_sessions').update({
            status: 'ended',
            duration_seconds: Math.max(0, Math.round(duration)),
            summary_status: summaryStatus,
            chat_message_id: saved.id,
            ended_at: endedAt,
            updated_at: endedAt,
        }).eq('id', callId);

        if (duration >= 20) {
            try {
                summary = await summarizeCall(turns);
                summaryStatus = summary ? 'complete' : 'failed';
            } catch (error) {
                summaryStatus = 'failed';
                console.warn('[Call] 通话小结生成失败，原始转录已保留:', error.message);
            }
        }
        const record = formatCallRecord(duration, summary);
        if (record !== initialRecord) {
            const { error: recordError } = await host.supabase.from('messages').update({ content: record }).eq('id', saved.id);
            if (recordError) throw recordError;
        }
        await host.supabase.from('call_sessions').update({
            summary: summary || null,
            summary_status: summaryStatus,
            updated_at: new Date().toISOString(),
        }).eq('id', callId);
        res.json({ ok: true, saved: true, messageId: saved.id, content: record, createdAt: saved.created_at });
    } catch (error) {
        res.status(500).json({ error: error.message || '保存通话记录失败' });
    }
});

router.post('/speak/:messageId', async (req, res) => {
    try {
        const turnId = Number(req.params.messageId);
        const sessionId = String(req.body.sessionId || '').trim();
        const callId = String(req.body.callId || '').trim();
        const sourceText = normalizeVoiceSourceText(req.body.text);
        if (!Number.isSafeInteger(turnId) || !callId || !sessionId || !sourceText) return res.status(400).json({ error: '通话语音参数无效' });

        const call = await loadOwnedCall(callId, sessionId, false);
        if (!call) return res.status(404).json({ error: '找不到这通电话' });
        const { data: message, error: messageError } = await host.supabase.from('call_turns')
            .select('id, role, content, call_id').eq('id', turnId).eq('call_id', callId).single();
        if (messageError || !message || message.role !== 'assistant') return res.status(404).json({ error: '找不到 Companion 的这句回复' });
        if (!normalizeVoiceSourceText(message.content).includes(sourceText)) return res.status(400).json({ error: '朗读文字与原消息不一致' });

        const { data: rows } = await host.supabase.from('call_turns').select('id, role, content')
            .eq('call_id', callId).lte('id', turnId)
            .order('id', { ascending: false }).limit(12);
        const config = getCallVoiceConfig();
        const direction = await translateForCompanionVoice(sourceText, config, {
            messages: (rows || []).filter(row => row.id !== turnId).reverse(),
            fullReply: message.content,
        });
        const spokenText = direction.spokenText.replace(/\[[^\]\r\n]{1,40}\]/g, '').replace(/\s+/g, ' ').trim();
        const segments = splitSpokenSegments(spokenText);
        if (!segments.length) return res.status(500).json({ error: '没有可播放的通话语音' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const sourceHash = hashVoiceSource(spokenText, config).slice(0, 20);
        for (let index = 0; index < segments.length; index += 1) {
            const audio = await synthesizeElevenLabsSpeech(segments[index], config);
            const audioUrl = await host.saveCallAudio({
                callId,
                turnId,
                index,
                sourceHash,
                voiceId: config.voiceId,
                audio,
                contentType: 'audio/mpeg',
            });
            if (!audioUrl) throw new Error('宿主没有返回可播放的私密音频 URL');
            res.write(`data: ${JSON.stringify({ type: 'segment', index, audioUrl })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', spokenText })}\n\n`);
        res.end();
    } catch (error) {
        console.error('[Call] 逐句语音失败:', error.message);
        if (res.headersSent) {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || '通话语音失败' })}\n\n`);
            return res.end();
        }
        res.status(500).json({ error: error.message || '通话语音失败' });
    }
});

module.exports = { router, createInvite, expireMissedInvites, getDnd };
