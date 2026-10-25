/**
 * 把正在播放的语音能量换算成 0-1 的开口幅度，供 VRM 口型表情使用。
 *
 * 这里刻意不改动音频播放链路：普通语音先把 Blob 解码成离线包络，
 * 播放时按 currentTime 查表；实时语音直接对每个 PCM 分片取 RMS。
 * 两条路径都只读取数据，不接管音频输出，避免影响现有播放逻辑。
 */

/** 包络采样率，与前端广播口型的频率保持一致。 */
const MOUTH_FPS = 30;

/** 解码包络共用一个 AudioContext，避免每次播放都新建。 */
let envelopeContext: AudioContext | null = null;

function getEnvelopeContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!envelopeContext) {
    try {
      envelopeContext = new Ctor();
    } catch {
      return null;
    }
  }
  return envelopeContext;
}

export interface EnvelopeHolder {
  current: Float32Array | null;
}

export interface MouthTracker {
  stop(): void;
}

/**
 * 解码音频 Blob，输出归一化后的 RMS 包络。失败时返回 null，
 * 调用方会退回到正弦模拟，保证没有声音时口型也不会完全静止。
 */
export async function computeEnvelope(blob: Blob): Promise<Float32Array | null> {
  const context = getEnvelopeContext();
  if (!context || !blob.size) return null;
  try {
    const raw = await blob.arrayBuffer();
    const buffer = await context.decodeAudioData(raw.slice(0));
    const channelData = buffer.getChannelData(0);
    const frames = Math.max(1, Math.round(buffer.duration * MOUTH_FPS));
    const step = Math.max(1, Math.floor(channelData.length / frames));
    const envelope = new Float32Array(frames);

    let peak = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const start = frame * step;
      let sum = 0;
      let count = 0;
      for (let index = start; index < start + step && index < channelData.length; index += 4) {
        const value = channelData[index];
        sum += value * value;
        count += 1;
      }
      const rms = Math.sqrt(sum / Math.max(count, 1));
      envelope[frame] = rms;
      if (rms > peak) peak = rms;
    }

    // 归一化到 0-1：说话音量整体偏小时也能带动口型。
    if (peak > 0.0005) {
      const scale = 1.25 / peak;
      for (let frame = 0; frame < frames; frame += 1) {
        envelope[frame] = Math.min(1, envelope[frame] * scale);
      }
    }
    return envelope;
  } catch {
    return null;
  }
}

/** 音频播放期间按 currentTime 查包络，输出平滑后的开口幅度。 */
export function trackElementMouth(
  audio: HTMLAudioElement,
  holder: EnvelopeHolder,
  onValue: (value: number) => void,
): MouthTracker {
  let raf = 0;
  let value = 0;
  const startedAt = performance.now();

  const tick = () => {
    raf = requestAnimationFrame(tick);
    const envelope = holder.current;
    let target: number;

    if (envelope && envelope.length > 0) {
      const seconds = Number.isFinite(audio.currentTime)
        ? audio.currentTime
        : (performance.now() - startedAt) / 1000;
      const index = Math.min(envelope.length - 1, Math.max(0, Math.floor(seconds * MOUTH_FPS)));
      target = envelope[index];
    } else {
      // 包络还没解码好时先用正弦过渡，避免开口瞬间停住。
      const seconds = (performance.now() - startedAt) / 1000;
      target = 0.32 + 0.28 * Math.sin(seconds * 11) * Math.sin(seconds * 3.3);
    }

    // 张嘴快、闭嘴慢，比对称平滑更像真实说话。
    const rate = target > value ? 0.55 : 0.2;
    value += (target - value) * rate;
    onValue(Math.max(0, Math.min(1, value)));
  };

  raf = requestAnimationFrame(tick);
  return {
    stop() {
      cancelAnimationFrame(raf);
      onValue(0);
    },
  };
}

export interface PcmMouth {
  pulse(energy: number): void;
  stop(): void;
}

/** 实时语音分片驱动：每个分片给一次能量，之后按时间自然衰减。 */
export function createPcmMouth(onValue: (value: number) => void): PcmMouth {
  let raf = 0;
  let value = 0;
  let target = 0;
  let lastFrame = performance.now();

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const delta = Math.min(0.12, Math.max(0.008, (now - lastFrame) / 1000));
    lastFrame = now;

    if (target > value) value += (target - value) * Math.min(1, delta * 22);
    else value += (target - value) * Math.min(1, delta * 7);

    target = Math.max(0, target - delta * 2.4);
    onValue(Math.max(0, Math.min(1, value)));
  };

  raf = requestAnimationFrame(tick);
  return {
    pulse(energy: number) {
      const normalized = Math.max(0, Math.min(1, energy));
      if (normalized > target) target = normalized;
    },
    stop() {
      cancelAnimationFrame(raf);
      onValue(0);
    },
  };
}

/** 从 16 位 PCM 分片估算响度，用于实时语音口型。 */
export function pcmEnergy(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] / 32768;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  // 语音 RMS 通常在 0.02-0.25 之间，放大后映射到 0-1。
  return Math.max(0, Math.min(1, rms * 4.5));
}
