/**
 * 检查 VRMA 动画是否真的传到了驱动网格的原始骨骼。
 *
 * three-vrm 的 humanoid 有两套骨骼：mixer 写的是 normalized bone，
 * vrm.update() 再把它同步到 raw bone（真正被 SkinnedMesh 使用）。
 * 如果 normalized 在动而 raw 不动，画面就会"腿没抬"。
 */
const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";

function urlWithPhase(phase) {
  const url = new URL(baseUrl);
  url.searchParams.set("window", "pet");
  url.searchParams.set("pet", "1");
  url.searchParams.set("transparent", "1");
  url.searchParams.set("walk", "1");
  url.searchParams.set("direction", "1");
  url.searchParams.set("debug", "1");
  url.searchParams.set("walkPhase", String(phase));
  if (process.env.NO_COMBINE === "1") url.searchParams.set("noCombine", "1");
  return url.toString();
}

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 445, height: 727 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  for (const phase of [0.25, 0.75]) {
    await page.goto(urlWithPhase(phase), { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {
      const { vrm, model } = window.__charDebug;
      const humanoid = vrm.humanoid;
      const pick = (bone) => {
        const normalized = humanoid.getNormalizedBoneNode(bone);
        const raw = humanoid.getRawBoneNode(bone);
        return {
          normalized: normalized ? normalized.quaternion.toArray().map((v) => Number(v.toFixed(4))) : null,
          raw: raw ? raw.quaternion.toArray().map((v) => Number(v.toFixed(4))) : null,
          normalizedName: normalized?.name ?? null,
          rawName: raw?.name ?? null,
        };
      };

      // 找出 SkinnedMesh 实际引用的骨骼名，确认和 raw bone 是同一套
      let skinned = null;
      const meshes = [];
      model.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        const rawLower = humanoid.getRawBoneNode("leftLowerLeg");
        const rawUpper = humanoid.getRawBoneNode("leftUpperLeg");
        const names = o.skeleton.bones.map((b) => b.name);
        meshes.push({
          name: o.name,
          bones: o.skeleton.bones.length,
          hasLower: o.skeleton.bones.some((b) => b === rawLower),
          hasUpper: o.skeleton.bones.some((b) => b === rawUpper),
        });
        if (skinned) return;
        skinned = {
          name: o.name,
          bones: o.skeleton.bones.length,
          hasLowerLegL: o.skeleton.bones.some((b) => b === rawLower),
          hasUpperLegL: o.skeleton.bones.some((b) => b === rawUpper),
          lowerName: rawLower?.name,
          upperName: rawUpper?.name,
          matchingNames: names.filter((n) => /ひざ|足|もも/.test(n)),
          sample: names.slice(0, 8),
        };
      });

      return {
        legs: { upper: pick("leftUpperLeg"), lower: pick("leftLowerLeg") },
        skinned,
        walk: window.__walkDebug ?? null,
        meshes,
      };
    });
    console.log(`phase=${phase}`, JSON.stringify(data));
  }

  console.log("errors:", errors.length ? errors.slice(0, 3).join(" | ") : "(none)");
  await browser.close();
}

main().catch((error) => {
  console.error("probe failed:", error.message);
  process.exit(1);
});
