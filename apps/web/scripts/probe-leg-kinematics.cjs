const { chromium } = require("@playwright/test");

const baseUrl = process.argv[2] || "http://127.0.0.1:5173/character";
const phase = process.argv[3] || "0.25";

async function main() {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 445, height: 727 } });
  const url = new URL(baseUrl);
  url.searchParams.set("window", "pet");
  url.searchParams.set("pet", "1");
  url.searchParams.set("transparent", "1");
  url.searchParams.set("walk", "1");
  url.searchParams.set("direction", "1");
  url.searchParams.set("debug", "1");
  url.searchParams.set("walkPhase", phase);

  await page.goto(url.toString(), { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__charDebug), null, { timeout: 60000 });
  await page.waitForTimeout(2500);

  const data = await page.evaluate(() => {
    const { vrm, model } = window.__charDebug;
    const round = (value) => Number(value.toFixed(5));
    const vector = (value) => value.toArray().map(round);
    const describe = (name) => {
      const node = vrm.scene.getObjectByName(name);
      if (!node) return null;
      const world = node.position.clone();
      node.getWorldPosition(world);
      return {
        name,
        parent: node.parent?.name ?? null,
        localPosition: vector(node.position),
        localQuaternion: vector(node.quaternion),
        modelPosition: vector(model.worldToLocal(world)),
      };
    };

    const names = ["足DL", "ひざDL", "足首DL", "足DR", "ひざDR", "足首DR"];
    const bones = Object.fromEntries(names.map((name) => [name, describe(name)]));
    const lengths = {};
    for (const side of ["L", "R"]) {
      const hip = vrm.scene.getObjectByName(`足D${side}`);
      const knee = vrm.scene.getObjectByName(`ひざD${side}`);
      const ankle = vrm.scene.getObjectByName(`足首D${side}`);
      if (hip && knee && ankle) {
        const hipWorld = hip.position.clone();
        const kneeWorld = knee.position.clone();
        const ankleWorld = ankle.position.clone();
        hip.getWorldPosition(hipWorld);
        knee.getWorldPosition(kneeWorld);
        ankle.getWorldPosition(ankleWorld);
        lengths[side] = {
          upper: round(hipWorld.distanceTo(kneeWorld)),
          lower: round(kneeWorld.distanceTo(ankleWorld)),
          hipToAnkle: round(hipWorld.distanceTo(ankleWorld)),
        };
      }
    }
    const weightNames = [
      "足L",
      "ひざL",
      "足首L",
      "足DL",
      "ひざDL",
      "足首DL",
      "足R",
      "ひざR",
      "足首R",
      "足DR",
      "ひざDR",
      "足首DR",
    ];
    const weights = Object.fromEntries(weightNames.map((name) => [name, { vertices: 0, sum: 0 }]));
    const meshWeights = [];
    model.traverse((object) => {
      if (!object.isSkinnedMesh) return;
      const index = object.geometry.getAttribute("skinIndex");
      const weight = object.geometry.getAttribute("skinWeight");
      if (!index || !weight) return;
      const local = Object.fromEntries(weightNames.map((name) => [name, { vertices: 0, sum: 0 }]));
      const lookup = new Map();
      for (const name of weightNames) {
        const boneIndex = object.skeleton.bones.findIndex((bone) => bone.name === name);
        if (boneIndex >= 0) lookup.set(boneIndex, name);
      }
      for (let vertex = 0; vertex < index.count; vertex += 1) {
        for (let slot = 0; slot < 4; slot += 1) {
          const boneIndex = index.getComponent(vertex, slot);
          const name = lookup.get(boneIndex);
          if (!name) continue;
          const value = weight.getComponent(vertex, slot);
          if (value <= 0.0001) continue;
          local[name].vertices += 1;
          local[name].sum += value;
          weights[name].vertices += 1;
          weights[name].sum += value;
        }
      }
      const total = Object.values(local).reduce((sum, item) => sum + item.sum, 0);
      if (total > 0.0001) meshWeights.push({ name: object.name, total: round(total), local });
    });
    meshWeights.sort((a, b) => b.total - a.total);
    return { bones, lengths, weights, meshWeights: meshWeights.slice(0, 8), walk: window.__walkDebug ?? null };
  }).catch(async () => {
    return page.evaluate(() => {
      const { vrm, model } = window.__charDebug;
      const round = (value) => Number(value.toFixed(5));
      const vector = (value) => value.toArray().map(round);
      const describe = (name) => {
        const node = vrm.scene.getObjectByName(name);
        if (!node) return null;
        const world = node.getWorldPosition(model.position.clone());
        return {
          name,
          parent: node.parent?.name ?? null,
          localPosition: vector(node.position),
          localQuaternion: vector(node.quaternion),
          modelPosition: vector(model.worldToLocal(world)),
        };
      };
      const names = ["足DL", "ひざDL", "足首DL", "足DR", "ひざDR", "足首DR"];
      const bones = Object.fromEntries(names.map((name) => [name, describe(name)]));
      return { bones, lengths: null, walk: window.__walkDebug ?? null };
    });
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
