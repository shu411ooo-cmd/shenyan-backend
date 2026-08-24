import { useCallback, useEffect, useRef, useState } from 'react';
import { analyzeVoiceBlob, blobToBase64, getRecordingMimeType, getVoiceInputError } from '../services/voiceInput.js';
import CallPortrait from './CallPortrait.jsx';

const STATUS_COPY = {
  connecting: 'connecting your hearts…',
  listening: 'Companion is listening',
  transcribing: 'catching your words…',
  thinking: 'Companion is thinking',
  speaking: 'Companion is speaking',
  muted: 'microphone muted',
  error: 'the line went quiet',
};

function formatDuration(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function assertOk(response) {
  if (response.ok) return response;
  let message = `HTTP ${response.status}`;
  try {
    const data = await response.json();
    if (data?.error) message = data.error;
  } catch {}
  throw new Error(message);
}

function PhoneIcon({ down = false }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={down
        ? 'M5.7 15.2c3.9-3 8.7-3 12.6 0l1.8 1.4c.6.5.7 1.3.2 1.9l-1.2 1.5c-.4.5-1.1.7-1.7.4l-3-1.5v-2.1a9.8 9.8 0 0 0-4.8 0v2.1l-3 1.5c-.6.3-1.3.1-1.7-.4l-1.2-1.5c-.5-.6-.4-1.4.2-1.9l1.8-1.4Z'
        : 'M7.2 3.8 9.4 7c.4.6.3 1.4-.2 1.9l-1.4 1.3c1.2 2.5 3.2 4.5 5.7 5.8l1.4-1.5c.5-.5 1.3-.6 1.9-.2l3.2 2.2c.6.4.8 1.1.5 1.8l-.8 1.8c-.3.7-1 1.1-1.7 1-8.2-.9-14.7-7.4-15.6-15.6-.1-.7.3-1.4 1-1.7L5.2 3c.7-.3 1.5 0 2 .8Z'} />
    </svg>
  );
}

function MicIcon({ off = false }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15.5a4 4 0 0 0 4-4V6a4 4 0 1 0-8 0v5.5a4 4 0 0 0 4 4Zm-6-4a6 6 0 0 0 12 0M12 17.5V21M9 21h6" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function SpeakerIcon({ off = false }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 10v4h4l5 4V6L9 10H5Zm12-1a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

export function IncomingCallCard({ invite, onAccept, onDecline }) {
  const [declining, setDeclining] = useState(false);
  if (!invite) return null;
  return (
    <div className="incoming-call-backdrop" role="dialog" aria-modal="true" aria-label="Companion 来电">
      <div className="incoming-call-card">
        <span className="incoming-call-kicker">Companion is calling</span>
        <span className="incoming-call-kicker-rule" />
        <CallPortrait />
        <h2 className="call-who">Companion</h2>
        <p className="incoming-call-reason">{invite.reason || '想听听你的声音'}</p>
        {declining ? (
          <div className="incoming-decline-list">
            {['现在有点忙', '我在外面', '我们先打字聊'].map((note) => (
              <button type="button" key={note} onClick={() => onDecline(note)}>{note}</button>
            ))}
            <button type="button" onClick={() => setDeclining(false)}>返回</button>
          </div>
        ) : (
          <div className="incoming-call-actions">
            <div className="call-action-wrap">
              <button type="button" className="incoming-call-round incoming-decline" onClick={() => setDeclining(true)} aria-label="拒接"><PhoneIcon down /></button>
              <span className="call-action-label">decline</span>
            </div>
            <div className="call-action-wrap">
              <button type="button" className="incoming-call-round incoming-accept" onClick={onAccept} aria-label="接听"><PhoneIcon /></button>
              <span className="call-action-label">answer</span>
            </div>
          </div>
        )}
        {!declining && <small className="incoming-call-note">a private line, just for you</small>}
      </div>
    </div>
  );
}

export default function CallOverlay({
  open,
  onClose,
  apiUrl,
  sessionId,
  selectedModel,
  onFinish,
}) {
  const [phase, setPhase] = useState('connecting');
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [liveLine, setLiveLine] = useState('');
  const [companionLine, setCompanionLine] = useState('');
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [lingering, setLingering] = useState(false);

  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const speakerRef = useRef(true);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordingStartedRef = useRef(0);
  const audioContextRef = useRef(null);
  const meterFrameRef = useRef(null);
  const turnTimeoutRef = useRef(null);
  const audioRef = useRef(null);
  const beginListeningRef = useRef(null);
  const hangUpRef = useRef(null);
  const lingerTimeoutRef = useRef(null);
  const secondsRef = useRef(0);
  const callIdRef = useRef('');

  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => {
    speakerRef.current = speakerOn;
    if (audioRef.current) audioRef.current.muted = !speakerOn;
  }, [speakerOn]);

  const stopMeter = useCallback(() => {
    if (meterFrameRef.current) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    setLevel(0);
  }, []);

  const stopRecorder = useCallback(() => {
    clearTimeout(turnTimeoutRef.current);
    stopMeter();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [stopMeter]);

  const releaseMedia = useCallback(() => {
    clearTimeout(lingerTimeoutRef.current);
    stopRecorder();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
  }, [stopRecorder]);

  const endCall = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    onFinish?.({ duration: secondsRef.current, callId: callIdRef.current });
    releaseMedia();
    onClose();
  }, [onClose, onFinish, releaseMedia]);

  useEffect(() => { hangUpRef.current = endCall; }, [endCall]);

  const processTurn = useCallback(async (blob, duration) => {
    if (!activeRef.current || mutedRef.current) return;
    if (blob.size < 800 || duration < 0.35) {
      window.setTimeout(() => beginListeningRef.current?.(), 220);
      return;
    }

    setPhase('transcribing');
    clearTimeout(lingerTimeoutRef.current);
    setLingering(false);
    try {
      const [features, audioData] = await Promise.all([
        analyzeVoiceBlob(blob).catch(() => ({ duration_s: duration })),
        blobToBase64(blob),
      ]);
      const transcription = await fetch(`${apiUrl}/api/voice-input/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          audio: { data: audioData, mediaType: blob.type || 'audio/webm' },
          features,
        }),
      });
      await assertOk(transcription);
      const heard = await transcription.json();
      const transcript = String(heard.text || '').trim();
      if (!transcript) {
        window.setTimeout(() => beginListeningRef.current?.(), 220);
        return;
      }
      if (!activeRef.current) return;

      setLiveLine(transcript);
      setCompanionLine('');
      setPhase('thinking');

      if (!callIdRef.current) throw new Error('通话还没有连接好');
      const replyResponse = await fetch(`${apiUrl}/api/call/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId: callIdRef.current,
          message: transcript,
          sessionId,
          voiceTone: heard.tone || undefined,
          duration,
        }),
      });
      await assertOk(replyResponse);
      const replyData = await replyResponse.json();
      const reply = String(replyData.reply || '').trim();
      if (!reply || !replyData.turnId) throw new Error('Companion 没有接上这一句');
      if (!activeRef.current) return;

      setCompanionLine(reply);
      const voiceResponse = await fetch(`${apiUrl}/api/call/speak/${replyData.turnId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: callIdRef.current, sessionId, text: reply }),
      });
      await assertOk(voiceResponse);
      const reader = voiceResponse.body.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';
      let playback = Promise.resolve();
      const playSegment = (audioUrl) => new Promise((resolve, reject) => {
        if (!activeRef.current) return resolve();
        const audio = new Audio(audioUrl);
        audioRef.current = audio;
        audio.muted = !speakerRef.current;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (audioRef.current === audio) audioRef.current = null;
          resolve();
        };
        audio.onended = finish;
        audio.onpause = finish;
        audio.onerror = () => {
          if (settled) return;
          settled = true;
          if (audioRef.current === audio) audioRef.current = null;
          reject(new Error('通话音频播放失败'));
        };
        setPhase('speaking');
        audio.play().catch(() => reject(new Error('点一下扬声器，再继续听 Companion')));
      });

      while (activeRef.current) {
        const { done, value } = await reader.read();
        if (done) break;
        streamBuffer += decoder.decode(value, { stream: true });
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type === 'segment' && event.audioUrl) playback = playback.then(() => playSegment(event.audioUrl));
          if (event.type === 'error') throw new Error(event.error || '通话语音失败');
        }
      }
      await playback;
      if (!activeRef.current) return;
      if (replyData.call?.hangup) {
        setLingering(true);
        if (!mutedRef.current) beginListeningRef.current?.();
        lingerTimeoutRef.current = setTimeout(() => hangUpRef.current?.(), 18_000);
      } else if (!mutedRef.current) beginListeningRef.current?.();
    } catch (turnError) {
      if (!activeRef.current) return;
      setError(turnError.name === 'AbortError' ? '这一轮等太久了' : getVoiceInputError(turnError));
      setPhase('error');
    }
  }, [apiUrl, sessionId]);

  const beginListening = useCallback(async () => {
    if (!activeRef.current || mutedRef.current || recorderRef.current) return;
    try {
      let stream = streamRef.current;
      if (!stream?.active) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
      }

      const mimeType = getRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recordingStartedRef.current = Date.now();
      setError('');
      setPhase('listening');

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const duration = Math.max(0.1, (Date.now() - recordingStartedRef.current) / 1000);
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        recorderRef.current = null;
        chunksRef.current = [];
        processTurn(blob, duration);
      };
      recorder.start(200);

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = audioContextRef.current || new AudioContextClass();
        audioContextRef.current = context;
        if (context.state === 'suspended') await context.resume();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        let speechStartedAt = 0;
        let lastVoiceAt = 0;
        const meter = () => {
          if (recorderRef.current !== recorder || recorder.state === 'inactive') return;
          analyser.getByteTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) energy += ((sample - 128) / 128) ** 2;
          const rms = Math.sqrt(energy / samples.length);
          setLevel(Math.min(1, rms * 9));
          const now = Date.now();
          if (rms > 0.024) {
            if (!speechStartedAt) speechStartedAt = now;
            lastVoiceAt = now;
          }
          if (speechStartedAt && now - speechStartedAt > 260 && now - lastVoiceAt > 1250) {
            stopRecorder();
            return;
          }
          meterFrameRef.current = requestAnimationFrame(meter);
        };
        meterFrameRef.current = requestAnimationFrame(meter);
      }
      turnTimeoutRef.current = setTimeout(stopRecorder, 25000);
    } catch (mediaError) {
      if (!activeRef.current) return;
      setError(getVoiceInputError(mediaError));
      setPhase('error');
    }
  }, [processTurn, stopRecorder]);

  useEffect(() => { beginListeningRef.current = beginListening; }, [beginListening]);

  useEffect(() => {
    if (!open) return undefined;
    activeRef.current = true;
    mutedRef.current = false;
    setMuted(false);
    setSeconds(0);
    secondsRef.current = 0;
    callIdRef.current = '';
    setLingering(false);
    setLiveLine('');
    setCompanionLine('');
    setError('');
    setPhase('connecting');
    const timer = setInterval(() => setSeconds((value) => {
      secondsRef.current = value + 1;
      return value + 1;
    }), 1000);
    let cancelled = false;
    let starter = null;
    let heartbeatTimer = null;
    fetch(`${apiUrl}/api/call/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, model: selectedModel }),
    })
      .then(assertOk)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !activeRef.current) return;
        callIdRef.current = String(data.callId || '');
        if (!callIdRef.current) throw new Error('通话连接没有返回 callId');
        heartbeatTimer = setInterval(() => {
          fetch(`${apiUrl}/api/call/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId: callIdRef.current, sessionId }),
          }).catch(() => {});
        }, 15000);
        starter = setTimeout(() => beginListeningRef.current?.(), 120);
      })
      .catch((startError) => {
        if (cancelled || !activeRef.current) return;
        setError(getVoiceInputError(startError));
        setPhase('error');
      });
    return () => {
      cancelled = true;
      activeRef.current = false;
      clearInterval(timer);
      clearInterval(heartbeatTimer);
      clearTimeout(starter);
      releaseMedia();
    };
  }, [apiUrl, open, releaseMedia, selectedModel, sessionId]);

  const hangUp = () => endCall();

  const toggleMute = () => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      stopRecorder();
      setPhase('muted');
    } else if (phase !== 'speaking' && phase !== 'thinking' && phase !== 'transcribing') {
      beginListeningRef.current?.();
    }
  };

  const retry = () => {
    setError('');
    if (audioRef.current) {
      audioRef.current.muted = !speakerRef.current;
      audioRef.current.play().then(() => setPhase('speaking')).catch(() => {});
    } else if (!mutedRef.current) beginListeningRef.current?.();
  };

  if (!open) return null;

  return (
    <div className="call-overlay" role="dialog" aria-modal="true" aria-label="与 Companion 通话">
      <div className="call-topline">
        <span>private line</span>
        <strong>{formatDuration(seconds)}</strong>
      </div>

      <CallPortrait speaking={phase === 'speaking'} />
      <h2 className="call-who">Companion</h2>
      <p className="call-status">{lingering ? 'staying for a few more breaths…' : (STATUS_COPY[phase] || STATUS_COPY.connecting)}</p>

      <div className={`call-wave ${phase === 'listening' || phase === 'speaking' ? 'is-live' : ''}`} aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => (
          <i key={index} style={{ '--wave': Math.min(1, Math.max(0.12, level * (0.55 + ((index * 7) % 10) / 10))) }} />
        ))}
      </div>

      <div className="call-caption-card" aria-live="polite">
        {companionLine ? <p className="call-caption-companion">{companionLine}</p> : null}
        {companionLine && liveLine ? <span className="call-caption-rule" /> : null}
        {liveLine ? <p className="call-caption-you"><span>you</span>{liveLine}</p> : null}
        {!companionLine && !liveLine && <p className="call-caption-empty">Say something when you’re ready.</p>}
        {error && <button type="button" className="call-retry" onClick={retry}>{error} · try again</button>}
      </div>

      <div className="call-spacer" />
      <div className="call-controls">
        <div className="call-action-wrap">
          <button type="button" className={`call-control ${muted ? 'is-off' : ''}`} onClick={toggleMute} aria-label={muted ? '打开麦克风' : '静音'}>
            <MicIcon off={muted} />
          </button>
          <span className="call-action-label">{muted ? 'unmute' : 'mute'}</span>
        </div>
        <div className="call-action-wrap">
          <button type="button" className="call-control call-hangup" onClick={hangUp} aria-label="挂断电话">
            <PhoneIcon down />
          </button>
          <span className="call-action-label">end</span>
        </div>
        <div className="call-action-wrap">
          <button type="button" className={`call-control ${speakerOn ? '' : 'is-off'}`} onClick={() => setSpeakerOn((value) => !value)} aria-label="切换扬声器">
            <SpeakerIcon off={!speakerOn} />
          </button>
          <span className="call-action-label">speaker</span>
        </div>
      </div>
    </div>
  );
}
