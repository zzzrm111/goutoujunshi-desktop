/**
 * 验证不同窗口尺寸下角色都完整入画。
 *
 * 桌面角色窗口会随"走近/走远"改变尺寸，取景必须跟着重算，
 * 否则缩小时角色会被裁掉。这里在透明模式下截图，用 alpha 通道
 * 测出角色的实际像素范围，检查它没有贴到画布边缘。
 *
 * 用法：node scripts/verify-framing.cjs
 */
const { chromium } = require("@playwright/test");

const SIZES = [
  { width: 380, height: 620, label: "默认（最近）" },
  { width: 323, height: 527, label: "中距离" },
  { width: 243, height: 396, label: "最远（最小窗口）" },
  { width: 760, height: 620, label: "宽窗口" },
];

async function measure(page, size) {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.waitForTimeout(900);
  // omitBackground 才会保留页面自身的透明通道；
  // 否则 Playwright 会把透明区域合成到白色，测出来整屏都是"角色像素"
  const shot = await page.screenshot({ timeout: 60000, omitBackground: true });
  return page.evaluate(async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    let top = -1;
    let bottom = -1;
    let left = image.width;
    let right = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        // 透明桌宠窗口里 alpha > 0 即角色像素
        if (data[(y * image.width + x) * 4 + 3] > 24) {
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    return { top, bottom, left, right, width: image.width, height: image.height };
  }, `data:image/png;base64,${shot.toString("base64")}`);
}

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 380, height: 620 } });
  await page.goto("http://127.0.0.1:5173/character?window=pet&pet=1&transparent=1", {
    waitUntil: "networkidle",
    timeout: 60000,
  });
  await page.waitForSelector("canvas", { timeout: 30000 });
  await page.waitForTimeout(5000);

  let failed = false;
  for (const size of SIZES) {
    const box = await measure(page, size);
    const marginTop = box.top;
    const marginBottom = box.height - 1 - box.bottom;
    const marginLeft = box.left;
    const marginRight = box.width - 1 - box.right;
    // 角色必须完整在画布内，且四边都留出可见余量
    const fits = marginTop > 0 && marginBottom > 0 && marginLeft > 0 && marginRight > 0;
    if (!fits) failed = true;
    console.log(
      `${size.label} ${size.width}x${size.height}: ` +
        `角色范围 x[${box.left},${box.right}] y[${box.top},${box.bottom}] ` +
        `边距 上${marginTop} 下${marginBottom} 左${marginLeft} 右${marginRight} ` +
        `-> ${fits ? "OK" : "被裁切"}`,
    );
  }

  await browser.close();
  if (failed) {
    console.error("framing verification: FAIL");
    process.exit(1);
  }
  console.log("framing verification: PASS");
}

main().catch((error) => {
  console.error("verify failed:", error.message);
  process.exit(1);
});
