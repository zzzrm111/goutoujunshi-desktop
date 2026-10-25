/**
 * 验证 3D 角色渲染：截图 + 画布像素检查。
 * 用法：node scripts/verify-character.cjs [url] [输出图片路径]
 */
const { chromium } = require("@playwright/test");

const url = process.argv[2] || "http://127.0.0.1:5173/character";
const outPath = process.argv[3] || "character-verify.png";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

  // 等待画布出现并让模型完成加载；主界面在顾问模式下不渲染角色，因此允许缺失
  const hasCanvas = await page
    .waitForSelector("canvas", { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(6000);

  // 截图后用 2D 画布解码，统计像素分布。
  // 直接读 WebGL 缓冲在 preserveDrawingBuffer=false 时恒为空，不可靠。
  const shot = await page.screenshot({ path: outPath, timeout: 60000 });
  const stats = await page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);

    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    // 背景色直接从画面左上角取样，CSS 改版后不用再同步改脚本里的常量
    const bgR = data[0];
    const bgG = data[1];
    const bgB = data[2];
    const colors = new Set();
    let nonBlank = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      total += 1;
      if (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB) > 60) nonBlank += 1;
      colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
    }
    return {
      width: image.width,
      height: image.height,
      background: [bgR, bgG, bgB],
      samples: total,
      characterPixels: nonBlank,
      characterRatio: Number((nonBlank / Math.max(total, 1)).toFixed(3)),
      distinctColors: colors.size,
    };
  }, `data:image/png;base64,${shot.toString("base64")}`);

  const debugText = await page.locator(".character-debug").count().catch(() => 0);
  const hintText = await page.locator(".character-stage-hint").allTextContents().catch(() => []);

  console.log("URL:", url);
  console.log("Canvas found:", hasCanvas);
  console.log("Canvas:", JSON.stringify(stats));
  console.log("Debug panel present:", debugText > 0);
  console.log("Stage hints:", hintText.join(" | ") || "(none)");
  console.log("Console errors:", errors.length ? errors.slice(0, 5).join("\n  ") : "(none)");
  console.log("Screenshot:", outPath);

  await browser.close();
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
