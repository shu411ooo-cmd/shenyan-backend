const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((Number(value) || 0) * scale) / scale;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values, average = mean(values)) {
  if (!values.length) return 0;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function downsample(samples, sourceRate, targetRate = 16000) {
  if (sourceRate <= targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    output[index] = samples[Math.floor(index * ratio)];
  }
  return output;
}

function estimatePitch(frame, sampleRate) {
  const minLag = Math.floor(sampleRate / 500);
  const maxLag = Math.min(frame.length - 2, Math.ceil(sampleRate / 60));
  let bestLag = 0;
  let bestCorrelation = 0;

  let frameMean = 0;
  for (let index = 0; index < frame.length; index += 1) frameMean += frame[index];
  frameMean /= frame.length;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    const limit = frame.length - lag;
    for (let index = 0; index < limit; index += 1) {
      const left = frame[index] - frameMean;
      const right = frame[index + lag] - frameMean;
      correlation += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const normalized = correlation / Math.sqrt(leftEnergy * rightEnergy || 1);
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }

  return bestCorrelation >= 0.58 && bestLag ? sampleRate / bestLag : 0;
}

export function getRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取录音失败'));
    reader.readAsDataURL(blob);
  });
}

export async function analyzeVoiceBlob(blob) {
  if (blob.size > MAX_RECORDING_BYTES) throw new Error('录音太长了，请控制在一分钟以内');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return { duration_s: 0 };

  const context = new AudioContextClass();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0));
    const source = audioBuffer.getChannelData(0);
    const sampleRate = Math.min(audioBuffer.sampleRate, 16000);
    const samples = downsample(source, audioBuffer.sampleRate, sampleRate);
    const duration = samples.length / sampleRate;
    if (duration < 0.25) return { duration_s: round(duration, 1) };

    const frameSize = Math.max(320, Math.floor(sampleRate * 0.04));
    const hopSize = Math.max(160, Math.floor(sampleRate * 0.02));
    const frames = [];
    const rmsValues = [];
    for (let offset = 0; offset + frameSize <= samples.length; offset += hopSize) {
      const frame = samples.subarray(offset, offset + frameSize);
      let energy = 0;
      for (let index = 0; index < frame.length; index += 1) energy += frame[index] ** 2;
      frames.push(frame);
      rmsValues.push(Math.sqrt(energy / frame.length));
    }

    const energyMean = mean(rmsValues);
    const energyVar = deviation(rmsValues, energyMean);
    const silenceThreshold = Math.max(0.0025, percentile(rmsValues, 0.2) * 1.6, energyMean * 0.12);
    const voicedFrames = frames
      .map((frame, index) => ({ frame, rms: rmsValues[index] }))
      .filter(({ rms }) => rms > silenceThreshold);

    const pitchFrames = [];
    const stride = Math.max(1, Math.ceil(voicedFrames.length / 72));
    for (let index = 0; index < voicedFrames.length; index += stride) {
      const pitch = estimatePitch(voicedFrames[index].frame, sampleRate);
      if (pitch >= 60 && pitch <= 500) pitchFrames.push(pitch);
    }

    let positiveEnergyChange = 0;
    for (let index = 1; index < rmsValues.length; index += 1) {
      positiveEnergyChange += Math.max(0, rmsValues[index] - rmsValues[index - 1]);
    }
    const pitchMean = mean(pitchFrames);

    return {
      duration_s: round(duration, 1),
      pitch_mean_hz: round(pitchMean, 1),
      pitch_var: round(deviation(pitchFrames, pitchMean), 1),
      energy_mean: round(energyMean, 4),
      energy_var: round(energyVar, 4),
      pause_ratio: round(rmsValues.filter((value) => value <= silenceThreshold).length / Math.max(1, rmsValues.length), 2),
      tempo_strength: round(positiveEnergyChange / Math.max(energyMean, 0.001) / Math.max(1, rmsValues.length), 2),
      voiced_ratio: round(voicedFrames.length / Math.max(1, frames.length), 2),
    };
  } finally {
    context.close().catch(() => {});
  }
}

export function getVoiceInputError(error) {
  if (error?.name === 'NotAllowedError') return '需要先允许麦克风权限';
  if (error?.name === 'NotFoundError') return '没有找到可用的麦克风';
  if (error?.name === 'NotReadableError') return '麦克风正在被其他应用占用';
  return error?.message || '录音失败，请再试一次';
}
