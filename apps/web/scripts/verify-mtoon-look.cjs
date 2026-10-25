/**
 * 校验角色材质与配色是否落在目标区间。
 *
 * 起因：MToon 的 shadeColorFactor 是平色而不是贴图乘算，参数写错时整只角色
 * 会被洗成灰雾，而画面上只是"看着发灰"，很难用肉眼判断改对了没有。这里直接
 * 读材质参数，并把角色像素的饱和度和源贴图对比。
 *
 * 用法：node scripts/verify-mtoon-look.cjs [url]
 */
const { chromium } = require("@playwright/test");

const url = process.argv[2] || "http://127.0.0.1:5173/character?transparent=1&debug=1";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
  await page.waitForTimeout(4000);

  const material = await page.evaluate(() => {
    const materials = window.__charDebug.listMaterials();
    const mtoon = materials.filter((m) => m.isMToonMaterial || m.type === "MToonMaterial");
    const sample = mtoon[0];
    return {
      total: materials.length,
      mtoon: mtoon.length,
      shadingShiftFactor: sample?.shadingShiftFactor,
      shadingToonyFactor: sample?.shadingToonyFactor,
      giEqualizationFactor: sample?.giEqualizationFactor,
      outlineWidthMode: sample?.outlineWidthMode,
      lights: (() => {
        const { keyLight, fillLight, rimLight } = window.__charDebug.lights;
        let ambient = null;
        window.__charDebug.scene.traverse((o) => {
          if (o.isAmbientLight) ambient = o.intensity;
        });
        return { key: keyLight.intensity, fill: fillLight.intensity, rim: rimLight.intensity, ambient };
      })(),
    };
  });

  // 先移除调试面板再量像素：它是接近纯白的半透明块，会把饱和度均值拉低。
  await page.evaluate(() => {
    document.querySelectorAll(".character-debug, .character-stage-hint").forEach((el) => el.remove());
  });
  await page.waitForTimeout(300);
  const cleanShot = await page.screenshot({ omitBackground: true, timeout: 90000 });
  const stats = await page.evaluate(async (dataUrl) => {
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
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 160) continue;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      satSum += mx <= 0 ? 0 : (mx - mn) / mx;
      lumSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if ((mx - mn) / Math.max(mx, 1e-6) > 0.25) vivid += 1;
      n += 1;
    }
    const safe = Math.max(n, 1);
    return {
      pixels: n,
      meanSat: Number((satSum / safe).toFixed(4)),
      meanLum: Number(((lumSum / safe) * 255).toFixed(1)),
      vividRatio: Number((vivid / safe).toFixed(4)),
    };
  }, `data:image/png;base64,${cleanShot.toString("base64")}`);

  console.log("materials:", JSON.stringify(material));
  console.log("character pixels:", JSON.stringify(stats));
  console.log("source texture reference: dress meanSat=0.255 meanLum=141.5");
  console.log("console errors:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");

  // 判定：洗白时饱和度会掉到 0.09 左右，正常应该在 0.14 以上
  const ok = material.mtoon > 0 && material.shadingShiftFactor >= 1 && stats.meanSat > 0.13;
  console.log(ok ? "PASS: 材质参数与配色在目标区间" : "FAIL: 仍然偏灰或材质参数未生效");
  await browser.close();
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
