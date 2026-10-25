/**
 * 验证走路动画（VRMA）真的在驱动角色。
 *
 * 走路是前后摆腿，正面镜头下像素变化很小，所以主要依据是角色页在
 * `?debug=1` 下发布的 window.__walkDebug：采样大腿/膝盖骨骼的四元数，
 * 换算成相对首帧的旋转角度。角度随相位周期变化说明动画在驱动骨骼；
 * 一直为 0 说明动画没加载成功，或者混音器权重没上去。
 *
 * 用法：node scripts/verify-walk.cjs [url] [输出目录]
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";
const outDir = process.argv[3] || path.join(__dirname, "..", "walk-frames");

const SAMPLES = 12;
const SAMPLE_INTERVAL_MS = 110;

function urlWithFlags(raw) {
  const url = new URL(raw);
  url.searchParams.set("window", "pet");
  url.searchParams.set("pet", "1");
  url.searchParams.set("transparent", "1");
  url.searchParams.set("walk", "1");
  url.searchParams.set("direction", "1");
  url.searchParams.set("debug", "1");
  return url.toString();
}

/** 两个四元数之间的夹角（度），忽略 q 与 -q 的等价性。 */
function angleBetween(a, b) {
  if (!a || !b) return null;
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

async function analyse(page, dataUrl) {
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);

    // 只统计下半身：上半身几乎不动，腿部的摆动才是判据
    const top = Math.floor(image.height * 0.55);
    let weight = 0;
    let sumX = 0;
    let leftHalf = 0;
    let rightHalf = 0;
    let opaque = 0;
    const rowWidths = [];

    for (let y = top; y < image.height; y += 1) {
      let rowMin = -1;
      let rowMax = -1;
      for (let x = 0; x < image.width; x += 1) {
        const alpha = data[(y * image.width + x) * 4 + 3];
        if (alpha < 24) continue;
        opaque += 1;
        weight += 1;
        sumX += x;
        if (x < image.width / 2) leftHalf += 1;
        else rightHalf += 1;
        if (rowMin < 0) rowMin = x;
        rowMax = x;
      }
      if (rowMin >= 0) rowWidths.push(rowMax - rowMin + 1);
    }

    const meanWidth = rowWidths.length
      ? rowWidths.reduce((a, b) => a + b, 0) / rowWidths.length
      : 0;
    return {
      width: image.width,
      height: image.height,
      lowerOpaque: opaque,
      centroidX: weight ? Number((sumX / weight).toFixed(2)) : 0,
      lowerMeanRowWidth: Number(meanWidth.toFixed(2)),
      balance: Number(((rightHalf - leftHalf) / Math.max(weight, 1)).toFixed(4)),
    };
  }, dataUrl);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 380, height: 620 } });
  const url = urlWithFlags(baseUrl);

  const messages = [];
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    messages.push(`requestfailed: ${request.url()} (${request.failure()?.errorText ?? "?"})`);
  });

  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForSelector("canvas", { timeout: 30000 });
  // 模型和走路动画都要加载完，留足时间
  await page.waitForTimeout(9000);

  const debug = await page.evaluate(() => window.__stageDebug ?? null);
  console.log("URL:", url);
  console.log("Stage debug:", JSON.stringify(debug));

  const samples = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const sample = await page.evaluate(() => window.__walkDebug ?? null);
    if (sample) samples.push(sample);
    if (index !== SAMPLES - 1) await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  if (!samples.length) {
    console.error("没有拿到 window.__walkDebug，角色可能没加载出来");
    await browser.close();
    process.exit(1);
  }

  const first = samples[0];
  console.log(
    `animationLoaded=${first.animationLoaded} cycleSeconds=${first.cycleSeconds} ` +
      `walkBlend(first)=${first.walkBlend}`,
  );

  let maxLeft = 0;
  let maxRight = 0;
  let maxKnee = 0;
  let minFootGap = Infinity;
  let maxFootGap = -Infinity;
  for (const [index, sample] of samples.entries()) {
    const left = angleBetween(first.leftUpperLeg, sample.leftUpperLeg);
    const right = angleBetween(first.rightUpperLeg, sample.rightUpperLeg);
    const knee = angleBetween(first.leftLowerLeg, sample.leftLowerLeg);
    const footGap = sample.leftFootForward - sample.rightFootForward;
    minFootGap = Math.min(minFootGap, footGap);
    maxFootGap = Math.max(maxFootGap, footGap);
    maxLeft = Math.max(maxLeft, left ?? 0);
    maxRight = Math.max(maxRight, right ?? 0);
    maxKnee = Math.max(maxKnee, knee ?? 0);
    console.log(
      `sample ${String(index).padStart(2)} phase=${sample.walkPhase.toFixed(2)} ` +
        `weight=${sample.actionWeight} blend=${sample.walkBlend} ` +
        `leftLeg=${left.toFixed(2)}° rightLeg=${right.toFixed(2)}° knee=${knee.toFixed(2)}° ` +
        `footGap=${footGap.toFixed(3)}`,
    );
  }

  console.log(`max hip swing: left=${maxLeft.toFixed(2)}° right=${maxRight.toFixed(2)}°`);
  console.log(`max knee bend: ${maxKnee.toFixed(2)}°`);
  console.log(`foot fore/aft gap range: ${minFootGap.toFixed(3)} .. ${maxFootGap.toFixed(3)} units`);

  // 在页面里连续采样两个步态周期，量出单脚的前后总位移。
  // 这个数字就是身体一个周期前进的距离，桌面壳的移动速度按它换算。
  const advance = await page.evaluate(async () => {
    const min = { left: Infinity, right: Infinity };
    const max = { left: -Infinity, right: -Infinity };
    const started = performance.now();
    return await new Promise((resolve) => {
      const tick = () => {
        const sample = window.__walkDebug;
        if (sample) {
          for (const side of ["left", "right"]) {
            const value = sample[`${side}FootForward`];
            if (typeof value === "number") {
              min[side] = Math.min(min[side], value);
              max[side] = Math.max(max[side], value);
            }
          }
        }
        if (performance.now() - started > 2600) {
          resolve({
            left: max.left - min.left,
            right: max.right - min.right,
            samples: Number.isFinite(max.left),
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  const advancePerCycle = (advance.left + advance.right) / 2;
  console.log(
    `measured advance per cycle: left=${advance.left.toFixed(3)} ` +
      `right=${advance.right.toFixed(3)} avg=${advancePerCycle.toFixed(3)} units`,
  );

  // 相机取景换算：垂直世界跨度 = 2 * 距离 * tan(fov/2)，对应窗口高度像素
  if (debug) {
    const halfFov = (30 * Math.PI) / 180 / 2;
    const pxPerUnit = debug.host[1] / (2 * debug.distance * Math.tan(halfFov));
    const yaw = Math.PI * 0.34;
    const expected = (advancePerCycle / first.cycleSeconds) * pxPerUnit * Math.sin(yaw);
    console.log(
      `px per world unit=${pxPerUnit.toFixed(1)} -> expected ground speed ` +
        `${expected.toFixed(1)} logical px/s (main.rs GROUND_SPEED should match)`,
    );
  }

  const rows = [];
  for (let index = 0; index < 4; index += 1) {
    const shot = await page.screenshot({
      omitBackground: true,
      path: path.join(outDir, `frame-${String(index).padStart(2, "0")}.png`),
      timeout: 60000,
    });
    rows.push(await analyse(page, `data:image/png;base64,${shot.toString("base64")}`));
    if (index !== 3) await page.waitForTimeout(250);
  }

  for (const [index, row] of rows.entries()) {
    console.log(
      `frame ${index}: lowerPixels=${row.lowerOpaque} centroidX=${row.centroidX} ` +
        `meanRowWidth=${row.lowerMeanRowWidth} balance=${row.balance}`,
    );
  }

  const centroids = rows.map((row) => row.centroidX);
  const spread = Math.max(...centroids) - Math.min(...centroids);
  const widths = rows.map((row) => row.lowerMeanRowWidth);
  const widthSpread = Math.max(...widths) - Math.min(...widths);
  console.log(`centroid spread over ${rows.length} frames: ${spread.toFixed(2)} px`);
  console.log(`lower-body width spread: ${widthSpread.toFixed(2)} px`);

  console.log("Messages:", messages.length ? messages.slice(0, 8).join("\n  ") : "(none)");
  console.log("Frames:", outDir);
  if (process.argv.includes("--sweep")) await sweepPhases(browser, baseUrl, outDir);
  await browser.close();
}

/**
 * 冻结步态相位抓四个关键姿势，用来肉眼核对腿和手臂的摆向。
 * 0 = 左脚最前，0.5 = 右脚最前，0.25 / 0.75 = 两腿交错的中途。
 */
async function sweepPhases(browser, baseUrl, outDir) {
  const phases = [0, 0.25, 0.5, 0.75];
  for (const phase of phases) {
    const url = new URL(urlWithFlags(baseUrl));
    url.searchParams.set("walkPhase", String(phase));
    const page = await browser.newPage({ viewport: { width: 380, height: 620 } });
    await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForSelector("canvas", { timeout: 30000 });
    await page.waitForTimeout(9000);
    const target = path.join(outDir, `phase-${String(phase).replace(".", "_")}.png`);
    await page.screenshot({ omitBackground: true, path: target, timeout: 60000 });
    const debug = await page.evaluate(() => window.__walkDebug ?? null);
    console.log(
      `phase ${phase}: leftLeg=${JSON.stringify(debug?.leftUpperLeg)} ` +
        `knee=${JSON.stringify(debug?.leftLowerLeg)} -> ${target}`,
    );
    await page.close();
  }
}

main().catch((error) => {
  console.error("verify-walk failed:", error.message);
  process.exit(1);
});
