/**
 * 统计角色材质的透明度设置，判断"模型发虚"是否来自 BLEND 材质。
 *
 * 用法：node scripts/probe-material-alpha.cjs [url]
 */
const { chromium } = require("@playwright/test");

const url =
  process.argv[2] ||
  "http://127.0.0.1:5173/character?window=pet&pet=1&transparent=1&debug=1&noCombine=1";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 445, height: 727 } });
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const materials = window.__charDebug.listMaterials();
    return materials.map((m) => ({
      name: m.name,
      type: m.type,
      transparent: Boolean(m.transparent),
      opacity: Number((m.opacity ?? 1).toFixed(3)),
      depthWrite: m.depthWrite !== false,
      alphaTest: m.alphaTest ?? 0,
      side: m.side,
      hasMap: Boolean(m.map),
      mapFormat: m.map?.format ?? null,
      outline: m.outlineWidthMode ?? null,
    }));
  });

  const blend = rows.filter((r) => r.transparent);
  const depthOff = rows.filter((r) => !r.depthWrite);
  console.log(`total=${rows.length} transparent=${blend.length} depthWriteOff=${depthOff.length}`);
  console.log("opacity<1:", rows.filter((r) => r.opacity < 0.999).length);
  console.log("first 20 transparent:");
  for (const row of blend.slice(0, 20)) console.log(" ", JSON.stringify(row));
  await browser.close();
}

main().catch((error) => {
  console.error("probe failed:", error.message);
  process.exit(1);
});
