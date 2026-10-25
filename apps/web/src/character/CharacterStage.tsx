import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  type VRMAnimation,
} from "@pixiv/three-vrm-animation";
import type { CharacterVisualState, Emotion } from "./types";
import "./character-stage.css";

export interface CharacterStageProps {
  modelUrl: string;
  /**
   * 走路动画（VRMA）。缺省时按模型地址推导同目录下的 walk.vrma。
   */
  walkUrl?: string;
  visual: CharacterVisualState;
  transparent?: boolean;
  petMode?: boolean;
  /**
   * 桌宠模式下的"远近"缩放（0 最远、1 最近）。
   *
   * 以前这一步是靠每帧改桌面窗口尺寸实现的，透明窗口被频繁 resize 时
   * WebView 会重排并闪一下，表现为角色"突然消失又出现"。现在窗口尺寸固定，
   * 由三维模型自己缩放：脚底仍在原点，取景不变，投影出来的轮廓也自动正确。
   */
  depthScale?: number;
  /**
   * 实时口型来源。用 ref 而不是 state 传入，避免音频能量每帧刷新触发整页重渲染。
   */
  mouthSource?: { current: number };
  /**
   * 角色轮廓上报：桌面壳用它判断鼠标是否落在角色身上，从而决定窗口是否穿透。
   * 坐标是窗口内的 CSS 像素。
   */
  onHitRegions?: (regions: Array<[number, number, number]>) => void;
  onReady?: () => void;
  onError?: (reason: string) => void;
}

/** 情绪 → VRM 表情预设组合 */
const EMOTION_EXPRESSIONS: Record<Emotion, { name: string; weight: number }[]> = {
  neutral: [],
  happy: [{ name: "happy", weight: 1 }],
  shy: [
    { name: "happy", weight: 0.55 },
    { name: "relaxed", weight: 0.45 },
  ],
  sad: [{ name: "sad", weight: 1 }],
  angry: [{ name: "angry", weight: 1 }],
  cold: [{ name: "relaxed", weight: -0.3 }],
  worried: [
    { name: "sad", weight: 0.55 },
    { name: "surprised", weight: 0.25 },
  ],
};

const EMOTION_KEYS: Emotion[] = ["neutral", "happy", "shy", "sad", "angry", "cold", "worried"];
const MOUTH_KEYS = ["aa", "ih", "ou", "ee", "oh"];

/**
 * 走路周期（秒）。walk.vrma 本身是 1 秒一个周期，这里按需要的步频重采样：
 * 步频决定步速，太快会像小跑，太慢会显得拖沓。
 */
const WALK_CYCLE_SECONDS = 1.1;
const WALK_STRIDE = 0.38;

/**
 * 行走时的侧身角。角色平时正面朝向观众，而走路动画是前后摆腿，
 * 正面投影里几乎看不到腿部移动，看起来就像在滑行。侧身 45° 既能看清
 * 迈步动作，又仍然看得清脸。
 */
const WALK_YAW = Math.PI * 0.285;

/**
 * MMD 模型的实际蒙皮骨和 VRM 人形控制骨不是同一套。
 *
 * VRMA 只会写 VRM 人形骨（足L / ひざL / 足首L），但网格权重主要落在
 * 足DL / ひざDL / 足首DL 这些形变骨上。Blender 里由约束把控制骨的动作
 * 传给形变骨，导出 glTF 后约束不会保留，所以这里在每帧把控制骨的姿态
 * 同步到实际蒙皮骨。否则骨骼数据虽然在动，网格上的腿仍然是直的。
 */
const DEFORM_LEG_CHAINS: Array<Array<{ control: string; deform: string }>> = [
  [
    { control: "leftUpperLeg", deform: "足DL" },
    { control: "leftLowerLeg", deform: "ひざDL" },
    { control: "leftFoot", deform: "足首DL" },
  ],
  [
    { control: "rightUpperLeg", deform: "足DR" },
    { control: "rightLowerLeg", deform: "ひざDR" },
    { control: "rightFoot", deform: "足首DR" },
  ],
];

/**
 * 桌宠的远近显示比例。窗口尺寸固定后，模型在这两个比例之间缩放来体现纵深，
 * 与桌面壳 main.rs 里的 SCALE_FAR / SCALE_NEAR 必须保持一致。
 */
const PET_SCALE_FAR = 0.36;
const PET_SCALE_NEAR = 0.92;

/**
 * 走路动画是前后摆腿，正面镜头下几乎看不出来，只能靠骨骼数据核对。
 * `?debug=1` 时把腿部姿态发布到 window.__walkDebug，供验证脚本读取。
 */
const WALK_DEBUG_ENABLED =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";

/**
 * `?walkPhase=0.25` 把步态冻结在周期的指定位置（0=左脚最前，0.5=右脚最前），
 * 方便截图核对姿势。留空则正常走动。
 */
const WALK_PHASE_OVERRIDE = (() => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("walkPhase");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? ((value % 1) + 1) % 1 : null;
})();

/**
 * 轮廓近似：用骨骼位置 + 半径的圆覆盖角色身体。
 * 半径是身高的比例，投影后换算成像素。
 */
const HIT_BONES: Array<{ bone: string; radius: number }> = [
  { bone: "head", radius: 0.115 },
  { bone: "neck", radius: 0.055 },
  { bone: "chest", radius: 0.155 },
  { bone: "spine", radius: 0.15 },
  { bone: "hips", radius: 0.15 },
  { bone: "leftUpperArm", radius: 0.055 },
  { bone: "leftLowerArm", radius: 0.05 },
  { bone: "leftHand", radius: 0.05 },
  { bone: "rightUpperArm", radius: 0.055 },
  { bone: "rightLowerArm", radius: 0.05 },
  { bone: "rightHand", radius: 0.05 },
  { bone: "leftUpperLeg", radius: 0.075 },
  { bone: "leftLowerLeg", radius: 0.062 },
  { bone: "leftFoot", radius: 0.048 },
  { bone: "rightUpperLeg", radius: 0.075 },
  { bone: "rightLowerLeg", radius: 0.062 },
  { bone: "rightFoot", radius: 0.048 },
];

/** 需要平滑过渡的表情通道 */
function collectExpressions(): string[] {
  const names = new Set<string>(["blink"]);
  for (const emotion of EMOTION_KEYS) {
    for (const item of EMOTION_EXPRESSIONS[emotion]) names.add(item.name);
  }
  for (const key of MOUTH_KEYS) names.add(key);
  return [...names];
}

/**
 * VRM 模型导出时多为 T-pose（双臂平举），这里把上臂放下形成自然站姿。
 * 数值按常见 VRM 体型调试，后续接入动画文件后可整体替换。
 */
function applyIdlePose(vrm: VRM): void {
  const setRotation = (bone: string, x: number, y: number, z: number) => {
    const node = vrm.humanoid?.getNormalizedBoneNode(bone as Parameters<NonNullable<typeof vrm.humanoid>["getNormalizedBoneNode"]>[0]);
    if (node) node.rotation.set(x, y, z);
  };

  // 上臂从水平放下约 65 度，左右符号相反
  setRotation("leftUpperArm", 0, 0, -1.13);
  setRotation("rightUpperArm", 0, 0, 1.13);
  // 小臂轻微内收并略微前摆，避免僵直与穿模
  setRotation("leftLowerArm", -0.12, -0.22, -0.1);
  setRotation("rightLowerArm", -0.12, 0.22, 0.1);
  // 肩膀略微下沉，让手臂更自然
  setRotation("leftShoulder", 0, 0, -0.06);
  setRotation("rightShoulder", 0, 0, 0.06);
}

export function CharacterStage({ modelUrl, walkUrl, visual, transparent, petMode, depthScale, mouthSource, onHitRegions, onReady, onError }: CharacterStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef(visual);
  const depthRef = useRef(depthScale ?? 0.7);
  const hitRegionsRef = useRef(onHitRegions);
  hitRegionsRef.current = onHitRegions;
  const pointerRef = useRef({ x: 0, y: 0 });
  // 动画循环运行在 effect 闭包里，不能读取会变化的 state，否则永远拿到首次渲染的旧值
  const readyRef = useRef(false);

  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState("");

  // 让动画循环始终读取最新状态，而不重建场景
  visualRef.current = visual;
  if (typeof depthScale === "number" && Number.isFinite(depthScale)) depthRef.current = depthScale;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let renderer: THREE.WebGLRenderer;
    try {
      // 始终保留 alpha 通道：不透明模式让 CSS 渐变透上来，透明模式供桌面窗口使用。
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    } catch {
      setStatus("failed");
      setFailure("当前设备或浏览器不支持 WebGL");
      onError?.("webgl-unavailable");
      return;
    }

    let disposed = false;
    let rafId = 0;
    let vrm: VRM | null = null;
    let currentVrmVersion: "0" | "1" = "1";

    const nativePixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    // 自适应降级不能再把像素比压到 1 以下。0.75 会让 445×727 的桌宠窗口
    // 实际只渲染 334×545，再被浏览器放大，轮廓和五官都会明显发糊。
    const minimumPixelRatio = Math.min(nativePixelRatio, 1);
    renderer.setPixelRatio(nativePixelRatio);
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, host.clientWidth / Math.max(host.clientHeight, 1), 0.1, 20);
    camera.position.set(0, 1.35, 1.15);

    // 模型外层容器：走动时整体转向行进方向，不直接改 vrm.scene（VRM 0.x 会占用它的 rotation）
    const modelRoot = new THREE.Group();
    scene.add(modelRoot);

    // 三点布光：主光偏暖、补光偏冷、背后轮廓光。
    //
    // MToon 材质是受光的：贴图是固有色，最终亮度取决于灯光。之前为了配合
    // 自发光方案把强度压得很低，切到 MToon 后整只角色都偏暗发灰，所以这里
    // 按"接近全亮"重新标定，同时保留一点方向性做体积感。
    const keyLight = new THREE.DirectionalLight(0xfff4e6, 1.15);
    keyLight.position.set(1, 2, 1.4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xd8e6ff, 0.42);
    fillLight.position.set(-1.4, 1.1, 0.8);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xf4f8ff, 0.4);
    rimLight.position.set(-0.4, 1.6, -1.6);
    scene.add(rimLight);

    scene.add(new THREE.AmbientLight(0xfff2e8, 0.5));

    // 脚底接触阴影：没有它角色会像"飘"在桌面上。
    // 相机是水平视角，水平地面看不见，所以用一块朝向镜头的柔和椭圆代替。
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = 128;
    shadowCanvas.height = 64;
    const shadowCtx = shadowCanvas.getContext("2d");
    if (shadowCtx) {
      const gradient = shadowCtx.createRadialGradient(64, 32, 2, 64, 32, 62);
      gradient.addColorStop(0, "rgba(28, 36, 48, 0.55)");
      gradient.addColorStop(0.55, "rgba(28, 36, 48, 0.26)");
      gradient.addColorStop(1, "rgba(28, 36, 48, 0)");
      shadowCtx.fillStyle = gradient;
      shadowCtx.fillRect(0, 0, 128, 64);
    }
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    shadowTexture.colorSpace = THREE.SRGBColorSpace;
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.85,
      }),
    );
    shadow.renderOrder = -1;
    shadow.visible = false;
    modelRoot.add(shadow);

    // 视线目标：由一个不可见物体承载，避免直接改骨骼导致的抖动
    const lookTarget = new THREE.Object3D();
    lookTarget.position.set(0, 1.4, 1.2);
    scene.add(lookTarget);

    const clock = new THREE.Clock();
    // 气泡定位复用的临时向量，避免每帧新建对象
    const bubbleAnchor = new THREE.Vector3();
    const expressionValues = new Map<string, number>();
    for (const name of collectExpressions()) expressionValues.set(name, 0);

    let blinkTimer = 1.5 + Math.random() * 3;
    let blinkPhase = 0; // >0 表示正在眨眼
    // 走动：blend 控制动作淡入淡出，phase 驱动一个步态周期
    let walkBlend = 0;
    let walkPhase = 0;
    // 走路动画。VRMA 由 Blender 从同一套骨架烘焙出来，周期与步幅是已知常量，
    // 桌面壳按同一组数字移动窗口，脚底才不会打滑。
    let walkMixer: THREE.AnimationMixer | null = null;
    let walkAction: THREE.AnimationAction | null = null;
    // 实际步态周期，用于推进相位
    let walkCycleSeconds = WALK_CYCLE_SECONDS;
    // 动画文件本身的时长，用于把相位换算成播放位置
    let walkClipSeconds = 1;
    // 真正参与蒙皮的腿骨。VRMA 只负责上半身，腿部在形变骨上使用
    // 独立的前后摆动，避免两套骨骼轴向不同导致交叉步。
    const deformLegBones: Array<
      Array<{
        deform: THREE.Object3D;
        deformRestLocal: THREE.Quaternion;
      }>
    > = [];
    type RestBone = {
      node: THREE.Object3D;
      rest: THREE.Quaternion;
    };
    const armRig: Array<{
      side: 1 | -1;
      shoulder?: RestBone;
      upperArm: RestBone;
      lowerArm: RestBone;
      hand?: RestBone;
    }> = [];
    // 全身取景参数：窗口尺寸变化（桌面角色走近走远）时按同一套参数重算相机距离
    let framing: { height: number; halfWidth: number; focusX: number } | null = null;
    // 轮廓上报节流
    let lastHitReport = 0;
    // 走路调试发布节流
    let lastWalkDebug = 0;
    let lowFpsFrames = 0;
    let qualityReduced = false;
    let stableFpsWindows = 0;
    let readyAt = 0;
    let fpsWindowStart = performance.now();
    let fpsWindowFrames = 0;

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const resolvedWalkUrl = walkUrl ?? modelUrl.replace(/[^/]*$/, "walk.vrma");

    /**
     * 加载走路动画并接管腿部/手臂骨骼。
     *
     * 必须在 applyIdlePose 之后创建 action：three.js 在 action 激活时记录
     * "原始姿态"，权重降到 0 时会回到它，也就是我们摆好的站姿。
     */
    function loadWalkAnimation(activeVrm: VRM) {
      const walkLoader = new GLTFLoader();
      walkLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
      walkLoader.load(
        resolvedWalkUrl,
        (gltf) => {
          if (disposed) return;
          const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
          const vrmAnimation = animations?.[0];
          if (!vrmAnimation) {
            console.warn("[character] walk.vrma 里没有 VRM 动画数据，退回程序化步态");
            return;
          }
          // three-vrm-animation 会按需自动补一个 lookAt 代理；先自己建好，
          // 避免每次加载都在控制台留下一条 "proxy is not found" 警告
          if (activeVrm.lookAt && !activeVrm.scene.getObjectByName("VRMLookAtQuaternionProxy")) {
            const proxy = new VRMLookAtQuaternionProxy(activeVrm.lookAt);
            proxy.name = "VRMLookAtQuaternionProxy";
            activeVrm.scene.add(proxy);
          }
          const clip = createVRMAnimationClip(vrmAnimation, activeVrm);
          walkClipSeconds = clip.duration > 0 ? clip.duration : 1;
          walkCycleSeconds = WALK_CYCLE_SECONDS;
          walkMixer = new THREE.AnimationMixer(activeVrm.scene);
          walkAction = walkMixer.clipAction(clip);
          walkAction.setLoop(THREE.LoopRepeat, Infinity);
          walkAction.setEffectiveWeight(0);
          walkAction.play();
          // 先跑一次 0 秒更新：绑定轨道并把当前站姿登记成权重为 0 时的回落姿态
          walkMixer.update(0);
        },
        undefined,
        () => {
          console.warn(`[character] 走路动画加载失败：${resolvedWalkUrl}，退回程序化步态`);
        },
      );
    }

    /** 记录形变腿骨的静止姿态，供每帧叠加步态旋转。 */
    function captureDeformLegRest(activeVrm: VRM) {
      activeVrm.scene.updateMatrixWorld(true);
      deformLegBones.length = 0;
      for (const chain of DEFORM_LEG_CHAINS) {
        const captured: Array<{
          deform: THREE.Object3D;
          deformRestLocal: THREE.Quaternion;
        }> = [];
        for (const item of chain) {
          const deform = activeVrm.scene.getObjectByName(item.deform);
          if (!deform) continue;
          captured.push({
            deform,
            deformRestLocal: deform.quaternion.clone(),
          });
        }
        if (captured.length) deformLegBones.push(captured);
      }
      armRig.length = 0;
      const capture = (bone: string): RestBone | undefined => {
        const node = activeVrm.humanoid?.getNormalizedBoneNode(
          bone as Parameters<NonNullable<typeof activeVrm.humanoid>["getNormalizedBoneNode"]>[0],
        );
        return node ? { node, rest: node.quaternion.clone() } : undefined;
      };
      for (const [side, suffix] of [
        [1, "L"],
        [-1, "R"],
      ] as const) {
        const upperArm = capture(`leftUpperArm`);
        const lowerArm = capture(`leftLowerArm`);
        const rightUpperArm = suffix === "R" ? capture("rightUpperArm") : undefined;
        const rightLowerArm = suffix === "R" ? capture("rightLowerArm") : undefined;
        const selectedUpperArm = suffix === "L" ? upperArm : rightUpperArm;
        const selectedLowerArm = suffix === "L" ? lowerArm : rightLowerArm;
        if (!selectedUpperArm || !selectedLowerArm) continue;
        armRig.push({
          side,
          shoulder: capture(suffix === "L" ? "leftShoulder" : "rightShoulder"),
          upperArm: selectedUpperArm,
          lowerArm: selectedLowerArm,
          hand: capture(suffix === "L" ? "leftHand" : "rightHand"),
        });
      }
    }

    /**
     * 直接驱动实际蒙皮腿骨。
     *
     * 这套 MMD 骨架带有非均匀父级缩放，按世界空间做 IK 会把脚设到腿长
     * 够不到的位置，再由高度补偿硬拉身体，最终表现成一跳一跳。这里改为
     * 在腿骨自身坐标系里摆髋、屈膝、回正脚踝：摆动腿明确抬膝，支撑腿
     * 从前往后扫过，左右腿严格相差半个周期。
     */
    function applyDeformLegGait(weight: number, phase: number) {
      if (!vrm || deformLegBones.length === 0) return;
      const cycle = ((phase / (Math.PI * 2)) % 1 + 1) % 1;
      const swingRotation = new THREE.Quaternion();
      const kneeRotation = new THREE.Quaternion();
      const ankleRotation = new THREE.Quaternion();
      const xAxis = new THREE.Vector3(1, 0, 0);
      const smooth = (value: number) => value * value * (3 - 2 * value);

      for (const [index, chain] of deformLegBones.entries()) {
        const [hip, knee, ankle] = chain;
        if (!hip || !knee || !ankle) continue;
        const legCycle = (cycle + (index === 0 ? 0 : 0.5)) % 1;
        const stance = legCycle < 0.5;
        const local = stance ? legCycle * 2 : (legCycle - 0.5) * 2;
        const eased = smooth(local);

        const hipAngle = stance
          ? THREE.MathUtils.lerp(-WALK_STRIDE, WALK_STRIDE, eased)
          : THREE.MathUtils.lerp(WALK_STRIDE, -WALK_STRIDE, eased);
        const kneeAngle = stance
          ? 0.035 + Math.sin(local * Math.PI) * 0.045
          : 0.055 + Math.sin(local * Math.PI) * 0.62;
        // 支撑相让鞋底贴地，摆动相允许脚尖略向下，落地前再回正。
        const ankleAngle = stance
          ? -(hipAngle + kneeAngle) * 0.82
          : -(hipAngle + kneeAngle) * 0.58;

        hip.deform.quaternion.copy(hip.deformRestLocal);
        knee.deform.quaternion.copy(knee.deformRestLocal);
        ankle.deform.quaternion.copy(ankle.deformRestLocal);
        swingRotation.setFromAxisAngle(xAxis, hipAngle * weight);
        kneeRotation.setFromAxisAngle(xAxis, kneeAngle * weight);
        ankleRotation.setFromAxisAngle(xAxis, ankleAngle * weight);
        hip.deform.quaternion.multiply(swingRotation);
        knee.deform.quaternion.multiply(kneeRotation);
        ankle.deform.quaternion.multiply(ankleRotation);
      }
      vrm.scene.updateMatrixWorld(true);
    }

    const armEuler = new THREE.Euler();
    const armDelta = new THREE.Quaternion();

    /** 在站姿基础上叠加局部旋转，避免每帧丢失肩膀、肘部和手腕的原始姿态。 */
    function setArmRotation(bone: RestBone | undefined, x: number, y: number, z: number) {
      if (!bone) return;
      armEuler.set(x, y, z, "XYZ");
      armDelta.setFromEuler(armEuler);
      bone.node.quaternion.copy(bone.rest).multiply(armDelta).normalize();
    }

    /**
     * 手臂持续动画。
     *
     * 之前待机时把上臂每帧重置回固定站姿，因此除了很小的走路摆臂外完全不动。
     * 现在把呼吸微摆、走路反向摆臂和倾听/思考/说话手势叠加在同一套骨骼上：
     * 静止时仍有自然的小幅摆动，行走时幅度与步频同步。
     */
    function applyArmPose(
      walkWeight: number,
      phase: number,
      elapsed: number,
      gesture: CharacterVisualState["gesture"],
    ) {
      // 走路时几乎关闭待机微摆，避免小抖动叠加在步态上显得手在抖。
      const idleWeight = 1 - walkWeight * 0.9;
      for (const arm of armRig) {
        const sideWave = Math.sin(elapsed * 0.88 + (arm.side > 0 ? 0.25 : 1.75));
        const microWave = Math.sin(elapsed * 1.47 + (arm.side > 0 ? 0.8 : 2.2));

        let shoulderX = 0;
        let shoulderY = 0;
        let shoulderZ = sideWave * 0.014 * idleWeight;
        let upperX = microWave * 0.044 * idleWeight;
        let upperY = sideWave * 0.022 * idleWeight;
        let upperZ = sideWave * 0.065 * idleWeight;
        let lowerX = 0.055 + Math.sin(elapsed * 1.18 + (arm.side > 0 ? 0.4 : 1.9)) * 0.055 * idleWeight;
        let lowerY = microWave * 0.018 * idleWeight;
        let lowerZ = 0;
        let handX = microWave * 0.018 * idleWeight;
        let handY = 0;

        // 腿部在 phase=0 / 0.5 到达前后极点，因此摆臂也用余弦，而不是
        // 晚四分之一周期的正弦。上臂局部 Y 轴在左右两侧互为镜像，同一个
        // 角度会自然映射成一前一后；当前符号让左臂对左腿反相，避免同手同脚。
        const armSwing = Math.cos(phase);
        // armForward 是相对模型正前方的归一化方向：+1 向前，-1 向后。
        const armForward = -arm.side * armSwing;
        upperY += armSwing * 0.18 * walkWeight;
        // 行走时让上臂离开躯干一点点，避免手臂像两根贴身的摆锤。
        upperZ -= arm.side * (0.024 + Math.max(0, armForward) * 0.014) * walkWeight;

        // 这个模型的肘部局部 Y 轴才是前臂向前上方弯曲的轴；X 轴只会绕
        // 前臂长轴自转，Z 轴会把前臂横向甩开。左右下臂的局部 Y 轴互为
        // 镜像，因此弯曲量要按 side 取反，否则一侧屈肘时另一侧会被拉直。
        // 前臂比上臂晚约 0.18 弧度到达极点：手臂向前时屈肘更多，向后时
        // 接近伸直，但不做成生硬的 max() 分段。手腕只保留很轻的跟随。
        const elbowForward = (-arm.side * Math.cos(phase - 0.12) + 1) * 0.5;
        const elbowFlex = (0.066 + elbowForward * 0.058) * walkWeight;
        lowerY -= arm.side * elbowFlex;
        lowerZ += arm.side * 0.018 * walkWeight;
        handY -= arm.side * elbowFlex * 0.12;
        // 锁骨只做很小的同相位转动，让肩膀跟着手臂略微前送/后收。
        shoulderY += armSwing * 0.013 * walkWeight;
        shoulderZ -= arm.side * (0.004 + Math.max(0, armForward) * 0.004) * walkWeight;

        if (gesture === "speaking") {
          const expressionWave = Math.sin(elapsed * 1.65 + (arm.side > 0 ? 0 : 0.9));
          upperX += arm.side * expressionWave * 0.045;
          upperZ += expressionWave * 0.025;
          lowerX += 0.055 + Math.max(0, expressionWave) * 0.06;
          handX += expressionWave * 0.025;
        } else if (gesture === "thinking") {
          const focus = arm.side < 0 ? 1 : 0.18;
          upperX -= focus * 0.08;
          upperZ += focus * 0.09;
          lowerX += focus * 0.22;
          handX += focus * 0.04;
        } else if (gesture === "listening") {
          const focus = arm.side < 0 ? 1 : 0.15;
          upperZ += focus * (0.055 + Math.sin(elapsed * 0.9) * 0.012);
          lowerX += focus * 0.12;
        }

        setArmRotation(arm.shoulder, shoulderX, shoulderY, shoulderZ);
        setArmRotation(arm.upperArm, upperX, upperY, upperZ);
        setArmRotation(arm.lowerArm, lowerX, lowerY, lowerZ);
        setArmRotation(arm.hand, handX, handY, 0);
      }
    }

    /**
     * 按当前窗口宽高比重新计算全身取景。
     * 桌面角色窗口会随"走近/走远"改变尺寸，所以取景不能只在加载时算一次。
     */
    function applyFraming() {
      if (!framing) return;
      const focusY = framing.height * 0.5;
      const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
      const aspect = Math.max(camera.aspect, 0.2);
      // 垂直方向按"头顶到脚底阴影下沿"取景：脚底阴影和走动时的小幅起伏
      // 都会伸到 y=0 以下，不留余量就会被画布下边缘裁掉
      const belowFeet = framing.height * 0.09;
      const halfVertical = Math.max(framing.height - focusY, focusY + belowFeet) * 1.04;
      const verticalFit = halfVertical / Math.tan(halfFov);
      const horizontalFit = framing.halfWidth / (Math.tan(halfFov) * aspect);
      const distance = Math.max(verticalFit, horizontalFit);
      // 镜头对准胯骨所在的垂直线，而不是模型原点：
      // 模型自带偏移时，按原点取景会把角色挤到窗口一侧
      camera.position.set(framing.focusX, focusY, distance);
      camera.lookAt(framing.focusX, focusY, 0);
      lookTarget.position.set(framing.focusX, focusY + framing.height * 0.22, distance);
      // 调试读数：排查窄窗口取景偏移时用
      (window as unknown as { __stageDebug?: unknown }).__stageDebug = {
        aspect: Number(camera.aspect.toFixed(4)),
        focusX: Number(framing.focusX.toFixed(4)),
        height: Number(framing.height.toFixed(4)),
        halfWidth: Number(framing.halfWidth.toFixed(4)),
        distance: Number(distance.toFixed(4)),
        host: [host?.clientWidth ?? 0, host?.clientHeight ?? 0],
      };
    }

    loader.load(
      modelUrl,
      (gltf) => {
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) {
          setStatus("failed");
          setFailure("模型文件不是有效的 VRM 格式");
          onError?.("invalid-vrm");
          return;
        }

        vrm = loaded;
        currentVrmVersion = "0" in loaded.meta ? "0" : "1";

        // VRM 0.x 默认朝向相反，需要转向镜头；同时优化渲染顺序
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        if (currentVrmVersion === "0") VRMUtils.rotateVRM0(vrm);

        // 不要调用 VRMUtils.combineSkeletons。
        //
        // 这个模型有 MMD 的"形变骨"（足D/ひざD）和 VRM 人形骨（足/ひざ）
        // 两套骨骼，108 个 primitive 共用同一个 686 根的 skin。combineSkeletons
        // 会把骨架压成 479 根，丢掉人形骨，于是 VRMA 动画虽然写进了 humanoid
        // 骨骼，真正驱动网格的那套骨骼却没动——表现就是"走路不抬腿"。
        // 这些 primitive 本来就共用同一个 Skeleton，合并也带不来性能收益。

        // 关闭视锥剔除，避免头发/裙摆等蒙皮网格在镜头边缘突然消失
        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
          const material = (object as THREE.Mesh).material;
          const materials = Array.isArray(material) ? material : material ? [material] : [];
          for (const item of materials) {
            const textured = item as THREE.Material & { map?: THREE.Texture | null };
            if (textured.map) {
              textured.map.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
              textured.map.needsUpdate = true;
            }
          }
        });

        modelRoot.add(vrm.scene);
        vrm.lookAt!.target = lookTarget;

        // 先摆好站姿再量尺寸：VRM 导出时是 T-pose，手臂平举会让包围盒宽度虚高，
        // 按那个宽度取景会把相机推得过远，角色显得很小。
        applyIdlePose(vrm);
        // 控制骨和形变骨的静止姿态差必须在 VRMA 接管之前记录
        captureDeformLegRest(vrm);
        // 站姿就位后再挂走路动画：动画的"回落姿态"取的就是这个站姿
        loadWalkAnimation(loaded);

        // 依据实际站姿做全身取景，并把模型水平居中，
        // 避免模型自带偏移导致角色在窄窗口里被裁到一侧。
        const box = new THREE.Box3().setFromObject(vrm.scene);
        const size = box.getSize(new THREE.Vector3());

        // 水平基准取胯骨：包围盒会被长发和裙摆拉偏，胯骨才是身体中轴
        vrm.scene.updateMatrixWorld(true);
        const hipsNode = vrm.humanoid?.getNormalizedBoneNode("hips");
        const hipsWorld = new THREE.Vector3();
        if (hipsNode) hipsNode.getWorldPosition(hipsWorld);

        framing = {
          height: size.y || 1.6,
          // 转身和摆臂会让轮廓变宽，留一点横向余量
          halfWidth: Math.max(size.x, size.z) * 0.5 * 1.12,
          focusX: hipsNode ? hipsWorld.x : 0,
        };
        applyFraming();

        // 脚底接触阴影贴在双脚位置，宽度约身高的三分之一
        shadow.visible = true;
        shadow.scale.set(framing.height * 0.34, framing.height * 0.1, 1);
        shadow.position.set(framing.focusX, 0.015, 0.02);

        // 材质调试句柄：MToon 的 shadeColorFactor 是平色而不是贴图乘算，
        // 调色时需要在不重新导出模型的前提下实时对比，这里把场景暴露出来。
        if (WALK_DEBUG_ENABLED) {
          (window as unknown as { __charDebug?: unknown }).__charDebug = {
            scene,
            renderer,
            camera,
            lights: { keyLight, fillLight, rimLight },
            model: vrm.scene,
            vrm,
            listMaterials: () => {
              const found: THREE.Material[] = [];
              vrm!.scene.traverse((object) => {
                const material = (object as THREE.Mesh).material;
                if (!material) return;
                if (Array.isArray(material)) found.push(...material);
                else found.push(material);
              });
              return found;
            },
          };
          // 验证工具复用同一个已加载页面，直接切换步态相位。
          // 这样不必为每个相位重新解析 40 MB 的 VRM。
          (window as unknown as { __walkDebugApi?: unknown }).__walkDebugApi = {
            setPhase: (phase: number) => {
              if (!Number.isFinite(phase)) return false;
              walkPhase = ((phase % 1) + 1) % 1 * Math.PI * 2;
              return true;
            },
            getPhase: () => Number((walkPhase / (Math.PI * 2)).toFixed(4)),
          };
        }

        readyRef.current = true;
        readyAt = performance.now();
        setStatus("ready");
        onReady?.();
      },
      undefined,
      () => {
        if (disposed) return;
        setStatus("failed");
        setFailure("角色模型未找到。请把 VRM 放进 apps/web/public/models/，或在 apps/web/.env.local 设置 VITE_CHARACTER_MODEL_URL。");
        onError?.("model-load-failed");
      },
    );

    function onPointerMove(event: PointerEvent) {
      const rect = host!.getBoundingClientRect();
      pointerRef.current = {
        x: ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
        y: ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1,
      };
    }

    function onResize() {
      if (!host) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width === 0 || height === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      applyFraming();
    }

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(host);
    window.addEventListener("pointermove", onPointerMove);

    function onContextLost(event: Event) {
      event.preventDefault();
      setStatus("failed");
      setFailure("图形上下文丢失");
      onError?.("context-lost");
    }
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    function animate() {
      rafId = requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.elapsedTime;
      const state = visualRef.current;

      // 帧率监控：持续低帧时逐级降低渲染分辨率，而不是直接隐藏角色。
      // 只有画质已降到最低仍无法维持时才向上层报告，由上层决定是否提示。
      fpsWindowFrames += 1;
      const now = performance.now();
      if (now - fpsWindowStart >= 3000) {
        const fps = (fpsWindowFrames * 1000) / (now - fpsWindowStart);
        const pastWarmup = readyRef.current && now - readyAt > 6000;
        if (pastWarmup && fps < 24) lowFpsFrames += 1;
        else lowFpsFrames = 0;
        if (pastWarmup && fps >= 45) stableFpsWindows += 1;
        else stableFpsWindows = 0;
        fpsWindowStart = now;
        fpsWindowFrames = 0;

        if (lowFpsFrames >= 2) {
          const currentRatio = renderer.getPixelRatio();
          if (currentRatio > minimumPixelRatio + 0.01) {
            renderer.setPixelRatio(Math.max(minimumPixelRatio, currentRatio - 0.25));
            lowFpsFrames = 0;
          } else if (!qualityReduced) {
            qualityReduced = true;
            onError?.("low-fps");
          }
        }

        // 帧率恢复后逐步回到原生像素比，避免一次降级永久留在模糊状态。
        if (stableFpsWindows >= 2 && renderer.getPixelRatio() < nativePixelRatio) {
          renderer.setPixelRatio(Math.min(nativePixelRatio, renderer.getPixelRatio() + 0.25));
          stableFpsWindows = 0;
        }
      }

      if (vrm && readyRef.current) {
        const manager = vrm.expressionManager;

        // 远近缩放：窗口尺寸固定，纵深完全由模型缩放体现。
        // 缩放围绕模型原点（脚底）进行，脚仍然踩在取景时算好的地面上。
        const depth = THREE.MathUtils.clamp(depthRef.current, 0, 1);
        const wantScale = PET_SCALE_FAR + (PET_SCALE_NEAR - PET_SCALE_FAR) * depth;
        modelRoot.scale.setScalar(wantScale);

        // 走动：优先播放烘焙好的 VRMA 走路动画；动画缺失时退回程序化摆动，
        // 保证任何情况下角色都不会僵在原地滑行。
        //
        // 这一段必须放在呼吸、头部摆动之前：混音器在权重为 0 时会把骨骼写回
        // 激活时登记的站姿，如果排在后面就会把呼吸和视线一并盖掉。
        const wantWalk = state.walking === true;
        walkBlend = THREE.MathUtils.lerp(walkBlend, wantWalk ? 1 : 0, Math.min(1, delta * 3.5));
        // 步频必须与桌面壳的地面速度一致：一个周期前进的距离等于动画里双脚
        // 前后摆幅之和，太快或太慢都会让脚底打滑
        if (walkBlend > 0.001) {
          walkPhase += delta * (walkAction ? (Math.PI * 2) / walkCycleSeconds : 2.5);
        }
        if (WALK_PHASE_OVERRIDE !== null) walkPhase = WALK_PHASE_OVERRIDE * Math.PI * 2;
        if (walkAction && walkMixer) {
          // 这套模型的形变腿骨与 VRM 人形骨轴不一致。走路完全由下面的
          // 局部骨骼步态驱动，VRMA 只保留加载状态，不参与姿态。
          walkAction.time = ((walkPhase / (Math.PI * 2)) % 1) * walkClipSeconds;
          walkAction.setEffectiveWeight(0);
          walkMixer.update(0);
        }
        // 双脚接触地面时重心最低，单脚支撑到中间时重心最高。
        // 幅度只有约 1 厘米，避免旧实现中整只角色上下弹跳的观感。
        modelRoot.position.y =
          walkBlend > 0.001 ? -Math.cos(walkPhase * 2) * 0.01 * walkBlend : 0;
        // 重心随支撑腿左右移动。模型单位下只有约 1.2 厘米，不改变脚底落点，
        // 但能让上半身不再像一块固定不动的板。
        modelRoot.position.x = Math.sin(walkPhase) * 0.012 * walkBlend;
        // 阴影留在地面上，不跟着身体起伏
        shadow.position.y = 0.015 - modelRoot.position.y;

        // 眨眼：随机间隔触发一次快速闭合与缓开
        blinkTimer -= delta;
        if (blinkTimer <= 0 && blinkPhase === 0) {
          blinkPhase = 0.0001;
          blinkTimer = 2 + Math.random() * 4;
        }
        if (blinkPhase > 0) {
          blinkPhase += delta * 6;
          const blinkValue = blinkPhase < 1 ? blinkPhase : Math.max(0, 2 - blinkPhase);
          expressionValues.set("blink", blinkValue);
          if (blinkPhase >= 2) blinkPhase = 0;
        } else {
          expressionValues.set("blink", 0);
        }

        // 情绪通道：按强度缩放后平滑逼近
        const intensity = state.intensity;
        const desired = new Map<string, number>();
        for (const key of EMOTION_KEYS) desired.set(key, 0);
        for (const item of EMOTION_EXPRESSIONS[state.emotion]) {
          desired.set(item.name, (desired.get(item.name) ?? 0) + item.weight * intensity);
        }
        for (const [name, value] of desired) {
          if (name === "blink") continue;
          expressionValues.set(name, THREE.MathUtils.lerp(expressionValues.get(name) ?? 0, value, Math.min(1, delta * 6)));
        }

        // 口型：优先使用外部传入的音频能量；说话中但未接入音频时，用正弦叠加做自然开合
        const autoMouth = 0.5 + 0.5 * Math.sin(elapsed * 11) * Math.sin(elapsed * 3.3);
        const liveMouth = Math.max(state.mouthOpen, mouthSource?.current ?? 0);
        const mouth =
          state.gesture === "speaking" && liveMouth <= 0.001
            ? THREE.MathUtils.clamp(autoMouth, 0, 1)
            : THREE.MathUtils.clamp(liveMouth, 0, 1);
        for (const key of MOUTH_KEYS) {
          const target = key === "aa" ? mouth : mouth * 0.25;
          expressionValues.set(key, THREE.MathUtils.lerp(expressionValues.get(key) ?? 0, target, Math.min(1, delta * 18)));
        }

        if (manager) {
          for (const [name, value] of expressionValues) {
            if (manager.getExpression(name)) manager.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
          }
        }

        // 呼吸：胸腔轻微起伏
        const chest = vrm.humanoid?.getNormalizedBoneNode("chest");
        if (chest) {
          const breath = Math.sin(elapsed * 1.15) * 0.012;
          chest.rotation.x = breath;
          // 骨盆和胸腔做很小幅的反向扭转，形成对侧手脚配合的连续感。
          chest.rotation.y = Math.cos(walkPhase) * 0.028 * walkBlend;
        }
        const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
        if (hips) hips.rotation.y = -Math.cos(walkPhase) * 0.018 * walkBlend;
        applyArmPose(walkBlend, walkPhase, elapsed, state.gesture);

        const facing = state.walkDirection === -1 ? -1 : 1;
        const targetYaw = wantWalk ? facing * WALK_YAW : 0;
        modelRoot.rotation.y = THREE.MathUtils.lerp(modelRoot.rotation.y, targetYaw, Math.min(1, delta * 3));

        // 头部：低频微摆动，叠加鼠标视线方向
        const head = vrm.humanoid?.getNormalizedBoneNode("head");
        if (head) {
          const drift = Math.sin(elapsed * 0.42) * 0.035;
          const driftY = Math.cos(elapsed * 0.31) * 0.03;
          const gazeX = state.lookAt ? state.lookAt.x : pointerRef.current.x;
          const gazeY = state.lookAt ? state.lookAt.y : pointerRef.current.y;
          const gazeScale = 1 - walkBlend * 0.55;
          head.rotation.y = THREE.MathUtils.lerp(head.rotation.y, drift + gazeX * 0.22 * gazeScale, Math.min(1, delta * 2.4));
          head.rotation.x = THREE.MathUtils.lerp(head.rotation.x, driftY + gazeY * 0.12 * gazeScale, Math.min(1, delta * 2.4));
          head.rotation.z = THREE.MathUtils.lerp(head.rotation.z, Math.sin(elapsed * 0.26) * 0.02, Math.min(1, delta * 1.6));
        }

        // 视线目标跟随指针，制造"在看你"的感觉
        lookTarget.position.x = THREE.MathUtils.lerp(lookTarget.position.x, pointerRef.current.x * 0.5, Math.min(1, delta * 3));
        lookTarget.position.y = THREE.MathUtils.lerp(
          lookTarget.position.y,
          (camera.position.y - 0.05) - pointerRef.current.y * 0.25,
          Math.min(1, delta * 3),
        );

        // 气泡跟随头顶：把头部骨骼的世界坐标投影到屏幕，避免气泡固定在画布上方。
        const bubble = bubbleRef.current;
        if (bubble) {
          if (state.bubble && head) {
            head.getWorldPosition(bubbleAnchor);
            bubbleAnchor.y += 0.17;
            bubbleAnchor.project(camera);
            const width = host!.clientWidth;
            const height = host!.clientHeight;
            const screenX = (bubbleAnchor.x * 0.5 + 0.5) * width;
            const screenY = (-bubbleAnchor.y * 0.5 + 0.5) * height;
            const visible = bubbleAnchor.z < 1;
            bubble.style.opacity = visible ? "1" : "0";
            bubble.style.transform = `translate(-50%, -100%) translate(${screenX}px, ${screenY}px)`;
          } else {
            bubble.style.opacity = "0";
          }
        }

        // 轮廓上报：把骨骼位置投影成屏幕上的圆，交给桌面壳做鼠标命中判定。
        // 桌面窗口靠它决定"鼠标在角色身上时接收点击，否则整窗穿透"。
        if (hitRegionsRef.current && framing && now - lastHitReport > 250) {
          lastHitReport = now;
          const width = host!.clientWidth;
          const height = host!.clientHeight;
          const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
          // 角色所在深度处，一个世界单位对应多少像素
          const pxPerUnit = height / (2 * camera.position.z * Math.tan(halfFov));
          const regions: Array<[number, number, number]> = [];
          // 模型按远近缩放过，命中圆的半径也要跟着缩，
          // 否则角色走到"远处"时点击范围会比角色本身大一圈。
          const hitScale = modelRoot.scale.x || 1;
          for (const item of HIT_BONES) {
            const node = vrm!.humanoid?.getNormalizedBoneNode(
              item.bone as Parameters<NonNullable<typeof vrm.humanoid>["getNormalizedBoneNode"]>[0],
            );
            if (!node) continue;
            node.getWorldPosition(bubbleAnchor);
            bubbleAnchor.project(camera);
            regions.push([
              Math.round((bubbleAnchor.x * 0.5 + 0.5) * width),
              Math.round((-bubbleAnchor.y * 0.5 + 0.5) * height),
              Math.max(8, Math.round(item.radius * framing.height * pxPerUnit * hitScale)),
            ]);
          }
          if (regions.length) hitRegionsRef.current(regions);
        }

        // 走路调试：正面镜头看不出前后摆腿，把腿部朝向发布出来供脚本核对
        if (WALK_DEBUG_ENABLED && now - lastWalkDebug > 250) {
          lastWalkDebug = now;
          const debugVrm: VRM = vrm;
          const leftDeformUpperLeg = debugVrm.scene.getObjectByName("足DL");
          const leftDeformLowerLeg = debugVrm.scene.getObjectByName("ひざDL");
          const rightDeformUpperLeg = debugVrm.scene.getObjectByName("足DR");
          const rightDeformLowerLeg = debugVrm.scene.getObjectByName("ひざDR");
          const sample = (node: THREE.Object3D | undefined | null) =>
            node ? [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w].map((v) => Number(v.toFixed(5))) : null;
          // 双脚相对胯骨的前后位移（模型局部空间的 z 轴）。一个周期内单脚的
          // 最大位移就是身体前进的距离，用来校准桌面壳的行走速度
          const forwardOffset = (bone: string) => {
            const node = debugVrm.scene.getObjectByName(bone);
            const hips = debugVrm.humanoid?.getNormalizedBoneNode("hips");
            if (!node || !hips) return null;
            const point = new THREE.Vector3();
            node.getWorldPosition(point);
            modelRoot.worldToLocal(point);
            const hipsPoint = new THREE.Vector3();
            hips.getWorldPosition(hipsPoint);
            modelRoot.worldToLocal(hipsPoint);
            return Number((point.z - hipsPoint.z).toFixed(4));
          };
          (window as unknown as { __walkDebug?: unknown }).__walkDebug = {
            walkBlend: Number(walkBlend.toFixed(4)),
            walkPhase: Number(walkPhase.toFixed(4)),
            animationLoaded: Boolean(walkAction),
            actionWeight: walkAction ? Number(walkAction.getEffectiveWeight().toFixed(4)) : null,
            cycleSeconds: walkCycleSeconds,
            leftFootForward: forwardOffset("足首DL"),
            rightFootForward: forwardOffset("足首DR"),
            leftUpperLeg: sample(leftDeformUpperLeg),
            rightUpperLeg: sample(rightDeformUpperLeg),
            leftLowerLeg: sample(leftDeformLowerLeg),
            leftDeformUpperLeg: sample(leftDeformUpperLeg),
            leftDeformLowerLeg: sample(leftDeformLowerLeg),
            rightDeformUpperLeg: sample(rightDeformUpperLeg),
            rightDeformLowerLeg: sample(rightDeformLowerLeg),
            leftUpperArm: sample(vrm.humanoid?.getNormalizedBoneNode("leftUpperArm")),
            leftLowerArm: sample(vrm.humanoid?.getNormalizedBoneNode("leftLowerArm")),
            rightUpperArm: sample(vrm.humanoid?.getNormalizedBoneNode("rightUpperArm")),
            rightLowerArm: sample(vrm.humanoid?.getNormalizedBoneNode("rightLowerArm")),
            at: Number(now.toFixed(1)),
          };
        }

        vrm.update(delta);
        applyDeformLegGait(walkBlend, walkPhase);
      }

      renderer.render(scene, camera);
    }
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      walkMixer?.stopAllAction();
      walkMixer = null;
      walkAction = null;
      if (vrm) {
        modelRoot.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
    // 模型地址变化才重建场景；visual 通过 ref 传递，不触发重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl, transparent]);

  return (
    <div className={`character-stage ${petMode ? "pet" : ""} ${transparent ? "transparent" : ""}`}>
      <div ref={hostRef} className="character-stage-canvas" />
      {visual.bubble && (
        <div ref={bubbleRef} className="character-bubble">
          {visual.bubble}
        </div>
      )}
      {status === "loading" && <div className="character-stage-hint">角色加载中…</div>}
      {status === "failed" && (
        <div className="character-stage-hint error">
          <span>{failure}</span>
        </div>
      )}
    </div>
  );
}
