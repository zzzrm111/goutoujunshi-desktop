/**
 * 在桌宠窗口尺寸下冻结走路相位，检查腿部姿态和模型是否半透明。
 *
 * 用法：node scripts/inspect-pet-frames.cjs [baseUrl] [输出目录]
 */
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";
const outDir = process.argv[3] || path.join(__dirname, "..", "pet-frames");
const PHASES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 445, height: 727 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  for (const phase of PHASES) {
    const url = new URL(baseUrl);
    url.searchParams.set("window", "pet");
    url.searchParams.set("pet", "1");
    url.searchParams.set("transparent", "1");
    url.searchParams.set("walk", "1");
    url.searchParams.set("direction", "1");
    url.searchParams.set("debug", "1");
    url.searchParams.set("walkPhase", String(phase));

    await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
    await page.waitForTimeout(2500);

    const info = await page.evaluate(() => {
      const debug = window.__charDebug;
      const materials = debug.listMaterials();
      return {
        pixelRatio: debug.renderer.getPixelRatio(),
        size: [debug.renderer.domElement.width, debug.renderer.domElement.height],
        mtoon: materials.filter((m) => m.isMToonMaterial || m.type === "MToonMaterial").length,
        transparent: materials.filter((m) => m.transparent).length,
        depthWriteOff: materials.filter((m) => !m.depthWrite).length,
        walk: window.__walkDebug ?? null,
      };
    });

    const file = path.join(outDir, `phase-${phase.toFixed(3)}.png`);
    await page.screenshot({ path: file, omitBackground: true, timeout: 90000 });
    console.log(
      `phase=${phase.toFixed(3)} pixelRatio=${info.pixelRatio} size=${info.size.join("x")} ` +
        `mtoon=${info.mtoon} transparent=${info.transparent} depthWriteOff=${info.depthWriteOff} ` +
        `knee=${info.walk ? JSON.stringify(info.walk.leftLowerLeg) : "-"}`,
    );
  }

  console.log("errors:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");
  console.log("frames:", outDir);
  await browser.close();
}

main().catch((error) => {
  console.error("inspect failed:", error.message);
  process.exit(1);
});
