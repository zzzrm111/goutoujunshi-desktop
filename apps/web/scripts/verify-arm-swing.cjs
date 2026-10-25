/**
 * 验证左右手臂是否真正交替摆动。
 *
 * 页面以固定步态运行，脚本通过 __walkDebugApi 切换相位，读取手掌在模型
 * 局部空间中的前后坐标。两条手臂应围绕相反方向交替，而不是同时前伸或后摆。
 *
 * 用法：node scripts/verify-arm-swing.cjs [url]
 */
const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";

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

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 445, height: 727 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(urlWithFlags(baseUrl), { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(
    () => Boolean(window.__charDebug && window.__walkDebugApi),
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(2500);

  const rows = [];
  const phases = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
  for (const phase of phases) {
    const row = await page.evaluate(async (value) => {
      window.__walkDebugApi.setPhase(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const { vrm, model } = window.__charDebug;
      const sample = (bone) => {
        const node = vrm.humanoid.getNormalizedBoneNode(bone);
        if (!node) return null;
        const world = node.getWorldPosition(node.position.clone());
        const local = model.worldToLocal(world.clone());
        return {
          quaternion: node.quaternion.toArray().map((item) => Number(item.toFixed(5))),
          x: Number(local.x.toFixed(4)),
          y: Number(local.y.toFixed(4)),
          z: Number(local.z.toFixed(4)),
        };
      };
      const hips = vrm.humanoid.getNormalizedBoneNode("hips");
      const hipsWorld = hips.getWorldPosition(hips.position.clone());
      const hipsLocal = model.worldToLocal(hipsWorld.clone());
      const sampleDeformFoot = (name) => {
        const node = vrm.scene.getObjectByName(name);
        if (!node) return null;
        const world = node.getWorldPosition(node.position.clone());
        const local = model.worldToLocal(world.clone());
        return Number((local.z - hipsLocal.z).toFixed(4));
      };
      return {
        phase: value,
        leftHand: sample("leftHand"),
        rightHand: sample("rightHand"),
        leftUpperArm: sample("leftUpperArm"),
        rightUpperArm: sample("rightUpperArm"),
        leftFoot: { z: sampleDeformFoot("足首DL") },
        rightFoot: { z: sampleDeformFoot("足首DR") },
      };
    }, phase);
    rows.push(row);
  }

  for (const row of rows) {
    console.log(
      `phase=${row.phase.toFixed(2)} ` +
        `leftHand z=${row.leftHand.z} x=${row.leftHand.x} ` +
        `rightHand z=${row.rightHand.z} x=${row.rightHand.x} ` +
        `leftFoot z=${row.leftFoot.z} rightFoot z=${row.rightFoot.z}`,
    );
  }

  const axes = await page.evaluate(() => {
    const { vrm, model } = window.__charDebug;
    const sampleNode = vrm.humanoid.getNormalizedBoneNode("hips");
    const modelInverse = model.getWorldQuaternion(sampleNode.quaternion.clone()).invert();
    const describe = (bone) => {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (!node) return null;
      const worldQuaternion = node.getWorldQuaternion(node.quaternion.clone());
      const localQuaternion = modelInverse.clone().multiply(worldQuaternion);
      const vector = node.position.clone();
      return {
        x: vector.set(1, 0, 0).applyQuaternion(localQuaternion).toArray(),
        y: vector.set(0, 1, 0).applyQuaternion(localQuaternion).toArray(),
        z: vector.set(0, 0, 1).applyQuaternion(localQuaternion).toArray(),
      };
    };
    return {
      leftUpperArm: describe("leftUpperArm"),
      rightUpperArm: describe("rightUpperArm"),
    };
  });
  console.log("model-local bone axes:", JSON.stringify(axes));

  const leftRange =
    Math.max(...rows.map((row) => row.leftHand.z)) -
    Math.min(...rows.map((row) => row.leftHand.z));
  const rightRange =
    Math.max(...rows.map((row) => row.rightHand.z)) -
    Math.min(...rows.map((row) => row.rightHand.z));
  const phase025 = rows.find((row) => row.phase === 0.25);
  const phase075 = rows.find((row) => row.phase === 0.75);
  const leftDelta = phase075.leftHand.z - phase025.leftHand.z;
  const rightDelta = phase075.rightHand.z - phase025.rightHand.z;

  console.log(`hand z range: left=${leftRange.toFixed(4)} right=${rightRange.toFixed(4)}`);
  console.log(`phase 0.75-0.25: left=${leftDelta.toFixed(4)} right=${rightDelta.toFixed(4)}`);
  console.log(`alternating=${leftDelta * rightDelta < 0}`);
  const extreme = (values) => {
    let best = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (Math.abs(values[index]) > Math.abs(values[best])) best = index;
    }
    return best;
  };
  const leftHandPeak = extreme(rows.map((row) => row.leftHand.z - rows[0].leftHand.z));
  const leftFootPeak = extreme(rows.map((row) => row.leftFoot.z - rows[0].leftFoot.z));
  const phaseGap = Math.min(
    Math.abs(leftHandPeak - leftFootPeak),
    phases.length - Math.abs(leftHandPeak - leftFootPeak),
  );
  console.log(
    `peak phases: leftHand=${phases[leftHandPeak]} leftFoot=${phases[leftFootPeak]} gap=${phaseGap}/${phases.length}`,
  );
  const center = (values) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return values.map((value) => value - mean);
  };
  const leftHandCentered = center(rows.map((row) => row.leftHand.z));
  const leftFootCentered = center(rows.map((row) => row.leftFoot.z));
  const numerator = leftHandCentered.reduce(
    (sum, value, index) => sum + value * leftFootCentered[index],
    0,
  );
  const denominator = Math.sqrt(
    leftHandCentered.reduce((sum, value) => sum + value * value, 0) *
      leftFootCentered.reduce((sum, value) => sum + value * value, 0),
  );
  const sameSideCorrelation = denominator > 0 ? numerator / denominator : 0;
  console.log(`same-side arm/leg correlation=${sameSideCorrelation.toFixed(3)} (want < 0)`);
  console.log(`errors=${errors.length ? errors.slice(0, 3).join(" | ") : "(none)"}`);

  await browser.close();
  if (!(leftRange > 0.01 && rightRange > 0.01 && leftDelta * rightDelta < 0 && sameSideCorrelation < -0.6)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("verify-arm-swing failed:", error.message);
  process.exit(1);
});
