/**
 * 角色材质调色实验台。
 *
 * MToon 的 shadeColorFactor 是一块平色，不参与贴图乘算，因此"阴影区偏白"
 * 会直接把整只角色洗成灰雾。这个脚本在不重新导出 40MB 模型的前提下，
 * 逐组改材质/灯光参数并量化角色像素的饱和度，用来挑选最终参数。
 *
 * 用法：node scripts/tune-character-color.cjs [url] [输出目录]
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";
const outDir = process.argv[3] || path.join(__dirname, "..", "color-lab");

// 每一组：材质参数 + 灯光参数，null 表示"保持原样"
// 每项先复位再应用，保证各组之间互不影响。
const RESET = { shadingShift: 0.0, toony: 0.9, gi: 0.4, shade: [0.86, 0.87, 0.92] };

const VARIANTS = [
  {
    name: "10-shift100-key115",
    note: "全亮 + 主光 1.15（防过曝）",
    material: { shadingShift: 1.0, toony: 0.9, gi: 0.9 },
    lights: { key: 1.15, fill: 0.42, rim: 0.4, ambient: 0.5 },
  },
  {
    name: "11-shift100-key135",
    note: "全亮 + 主光 1.35",
    material: { shadingShift: 1.0, toony: 0.9, gi: 0.9 },
    lights: { key: 1.35, fill: 0.5, rim: 0.45, ambient: 0.55 },
  },
  {
    name: "12-shift140",
    note: "全亮再抬高，阴影几乎消失",
    material: { shadingShift: 1.4, toony: 0.9, gi: 1.0 },
    lights: { key: 1.3, fill: 0.48, rim: 0.42, ambient: 0.55 },
  },
  {
    name: "13-shift070-soft",
    note: "保留一点体积感的柔和全亮",
    material: { shadingShift: 0.7, toony: 0.6, gi: 0.85 },
    lights: { key: 1.3, fill: 0.48, rim: 0.45, ambient: 0.5 },
  },
  {
    name: "14-shift085-key120",
    note: "折中：全亮 + 主光 1.2",
    material: { shadingShift: 0.85, toony: 0.85, gi: 0.9 },
    lights: { key: 1.2, fill: 0.45, rim: 0.42, ambient: 0.52 },
  },
];

function applyVariant(page, variant) {
  return page.evaluate((spec) => {
    const debug = window.__charDebug;
    if (!debug) return { error: "no __charDebug" };
    const materials = debug.listMaterials();
    let mtoon = 0;
    const reset = spec.reset;
    for (const material of materials) {
      if (!material.isMToonMaterial && material.type !== "MToonMaterial") continue;
      mtoon += 1;
      if (reset) {
        material.shadingShiftFactor = reset.shadingShift;
        material.shadingToonyFactor = reset.toony;
        material.giEqualizationFactor = reset.gi;
        material.shadeColorFactor.setRGB(reset.shade[0], reset.shade[1], reset.shade[2]);
      }
      if (!spec.material) continue;
      const { shadingShift, toony, gi, shade } = spec.material;
      if (shadingShift !== undefined) material.shadingShiftFactor = shadingShift;
      if (toony !== undefined) material.shadingToonyFactor = toony;
      if (gi !== undefined) material.giEqualizationFactor = gi;
      if (shade) material.shadeColorFactor.setRGB(shade[0], shade[1], shade[2]);
      material.needsUpdate = true;
    }
    if (spec.lights) {
      const { key, fill, rim, ambient } = spec.lights;
      const { keyLight, fillLight, rimLight } = debug.lights;
      if (key !== undefined) keyLight.intensity = key;
      if (fill !== undefined) fillLight.intensity = fill;
      if (rim !== undefined) rimLight.intensity = rim;
      if (ambient !== undefined) {
        debug.scene.traverse((object) => {
          if (object.isAmbientLight) object.intensity = ambient;
        });
      }
    }
    return { materials: materials.length, mtoon };
  }, { ...variant, reset: RESET });
}

function measure(page, pngBuffer) {
  // 直接读 WebGL 画布在 preserveDrawingBuffer=false 时恒为空，
  // 因此改成对 Playwright 截图（带 alpha）解码统计。
  return page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const off = document.createElement("canvas");
    off.width = image.width;
    off.height = image.height;
    const ctx = off.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, off.width, off.height);
    let n = 0;
    let satSum = 0;
    let lumSum = 0;
    let vivid = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    const hist = new Array(10).fill(0);
    for (let i = 0; i < data.length; i += 4) {
      // 透明背景下的角色像素：alpha 足够高才算数，避免把透明像素拉低均值
      if (data[i + 3] < 160) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx <= 0 ? 0 : (mx - mn) / mx;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n += 1;
      satSum += sat;
      lumSum += lum;
      rSum += r;
      gSum += g;
      bSum += b;
      if (sat > 0.25) vivid += 1;
      hist[Math.min(9, Math.floor(sat * 10))] += 1;
    }
    const safe = Math.max(n, 1);
    return {
      pixels: n,
      meanSat: Number((satSum / safe).toFixed(4)),
      meanLum: Number(((lumSum / safe) * 255).toFixed(1)),
      meanRGB: [Math.round((rSum / safe) * 255), Math.round((gSum / safe) * 255), Math.round((bSum / safe) * 255)],
      vividRatio: Number((vivid / safe).toFixed(4)),
      hist: hist.map((v) => Number((v / safe).toFixed(3))),
    };
  }, `data:image/png;base64,${pngBuffer.toString("base64")}`);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const url = new URL(baseUrl);
  url.searchParams.set("transparent", "1");
  url.searchParams.set("debug", "1");
  url.searchParams.set("pet", "0");

  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    document.querySelectorAll(".character-debug, .character-stage-hint").forEach((el) => el.remove());
  });

  const rows = [];
  for (const variant of VARIANTS) {
    const applied = await applyVariant(page, variant);
    await page.waitForTimeout(450);
    const file = path.join(outDir, `${variant.name}.png`);
    const shot = await page.screenshot({ path: file, omitBackground: true });
    const stats = await measure(page, shot);
    rows.push({ variant, applied, stats });
    console.log(
      `${variant.name.padEnd(20)} sat=${String(stats.meanSat).padEnd(7)} lum=${String(stats.meanLum).padEnd(6)} ` +
        `vivid=${String(stats.vividRatio).padEnd(7)} rgb=${stats.meanRGB.join(",")}  // ${variant.note}`,
    );
  }

  console.log("console errors:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");
  console.log("screenshots:", outDir);
  await browser.close();
}

main().catch((error) => {
  console.error("tune failed:", error.message);
  process.exit(1);
});
