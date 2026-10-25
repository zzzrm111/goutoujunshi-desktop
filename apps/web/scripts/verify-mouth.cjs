/**
 * 验证音频能量驱动口型：在真实浏览器里合成一段带静音段的音频，
 * 走 computeEnvelope / trackElementMouth 同一条链路，确认开口幅度随音量变化。
 *
 * 用法：node scripts/verify-mouth.cjs
 */
const { chromium } = require("@playwright/test");

const url = process.argv[2] || "http://127.0.0.1:5173/character?debug=1";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

  const result = await page.evaluate(async () => {
    const module = await import("/src/character/audio-mouth.ts");

    // 合成 2 秒单声道 WAV：前 0.6 秒静音，中段 0.8 秒 440Hz 正弦，末段静音
    const sampleRate = 16000;
    const seconds = 2;
    const total = sampleRate * seconds;
    const samples = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      const t = i / sampleRate;
      if (t >= 0.6 && t < 1.4) samples[i] = 0.55 * Math.sin(2 * Math.PI * 440 * t);
    }
    const wav = new ArrayBuffer(44 + total * 2);
    const view = new DataView(wav);
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + total * 2, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, total * 2, true);
    for (let i = 0; i < total; i += 1) {
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    }

    const blob = new Blob([wav], { type: "audio/wav" });
    const envelope = await module.computeEnvelope(blob);
    if (!envelope) return { ok: false, reason: "computeEnvelope returned null" };

    const at = (seconds) => envelope[Math.min(envelope.length - 1, Math.round(seconds * 30))];
    const silenceStart = at(0.2);
    const loud = Math.max(at(0.7), at(0.9), at(1.1));
    const silenceEnd = at(1.8);

    // 真实播放一遍，确认 trackElementMouth 输出的最大值出现在有声段
    const audio = new Audio(URL.createObjectURL(blob));
    const holder = { current: envelope };
    const seen = [];
    const tracker = module.trackElementMouth(audio, holder, (value) => seen.push(value));
    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    tracker.stop();
    audio.pause();

    return {
      ok: true,
      frames: envelope.length,
      silenceStart: Number(silenceStart.toFixed(4)),
      loud: Number(loud.toFixed(4)),
      silenceEnd: Number(silenceEnd.toFixed(4)),
      trackedFrames: seen.length,
      trackedMax: Number(Math.max(0, ...seen).toFixed(4)),
      trackedMin: Number(Math.min(...(seen.length ? seen : [0])).toFixed(4)),
    };
  });

  console.log("Envelope result:", JSON.stringify(result));
  if (!result.ok) throw new Error(result.reason);
  if (!(result.loud > 0.5 && result.silenceStart < 0.05 && result.silenceEnd < 0.05)) {
    throw new Error("envelope did not separate loud speech from silence");
  }
  if (!(result.trackedMax > 0.4 && result.trackedMin <= 0.05)) {
    throw new Error("tracked mouth values did not follow the audio energy");
  }
  console.log("Console errors:", errors.length ? errors.join("\n  ") : "(none)");
  console.log("Mouth sync verification: PASS");

  await browser.close();
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
