/**
 * 验证桌面角色窗口（窄幅、透明）的取景、头顶气泡与音频口型。
 *
 * 用法：node scripts/verify-pet-window.cjs [输出图片路径]
 */
const { chromium } = require("@playwright/test");

const outPath = process.argv[2] || "pet-window-verify.png";
const url = process.argv[3] || "http://127.0.0.1:5173/character?window=pet&transparent=1&pet=1&debug=1";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  // 与 tauri.conf.json 里的角色窗口尺寸保持一致
  const page = await browser.newPage({ viewport: { width: 380, height: 620 } });

  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(6000);

  // 通过广播通道模拟主界面：说话中 + 口型能量 + 头顶台词
  const bubbleText = "今天也辛苦了，先喝口水吧。";
  await page.evaluate((text) => {
    const channel = new BroadcastChannel("companion-character-state");
    channel.postMessage({ speaking: true, gesture: "speaking", mouthOpen: 0.85, bubble: text });
  }, bubbleText);
  await page.waitForTimeout(1200);

  const bubble = await page.locator(".character-bubble").first();
  const bubbleVisible = await bubble.isVisible().catch(() => false);
  const bubbleBox = bubbleVisible ? await bubble.boundingBox() : null;
  const bubbleTextContent = bubbleVisible ? (await bubble.textContent())?.trim() : "";

  // 气泡定位来自头部骨骼投影，必须落在画布内，否则会被裁掉
  const insideViewport = bubbleBox
    ? bubbleBox.x >= 0 && bubbleBox.y >= 0 && bubbleBox.x + bubbleBox.width <= 380 && bubbleBox.y + bubbleBox.height <= 620
    : false;

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
    let nonBlank = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 53) {
      total += 1;
      // 透明桌宠窗口里 alpha 为 0 表示没有角色像素
      if (data[i + 3] > 12) nonBlank += 1;
    }
    return { width: image.width, height: image.height, opaqueRatio: Number((nonBlank / Math.max(total, 1)).toFixed(3)) };
  }, `data:image/png;base64,${shot.toString("base64")}`);

  console.log("URL:", url);
  console.log("Bubble visible:", bubbleVisible, "| text:", bubbleTextContent);
  console.log("Bubble box:", bubbleBox ? JSON.stringify(bubbleBox) : "(none)", "| inside viewport:", insideViewport);
  console.log("Opaque pixels:", JSON.stringify(stats));
  console.log("Console errors:", errors.length ? errors.slice(0, 5).join("\n  ") : "(none)");
  console.log("Screenshot:", outPath);

  await browser.close();
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
