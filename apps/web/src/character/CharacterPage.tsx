import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MessageCircle, Moon, Power } from "lucide-react";
import { CharacterStage } from "./CharacterStage";
import { CHARACTER_MODEL_URL } from "./model-source";
import { inferEmotion, inferIntensity, type CharacterVisualState, type Emotion, type Gesture, type RelationshipSnapshot } from "./types";
import { createCompanionChannel, type SharedCharacterState } from "./companion-channel";
import "./character-page.css";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1";

/** 气泡最多显示这么多字，超出截断，避免遮挡整个角色。 */
const BUBBLE_MAX_CHARS = 90;

interface TauriBridge {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen?: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
}

interface GaitPayload {
  walking: boolean;
  direction: number;
  depth: number;
  speed: number;
}

/**
 * 桌面壳注入的全局 API。浏览器里不存在，所以调用方一律按"可选能力"处理，
 * 网页版不依赖这些接口也能完整使用。
 */
function getTauriBridge(): TauriBridge | null {
  const api = (window as unknown as {
    __TAURI__?: {
      core?: { invoke?: TauriBridge["invoke"] };
      event?: { listen?: TauriBridge["listen"] };
    };
  }).__TAURI__;
  if (!api) return null;
  return {
    invoke: api.core?.invoke,
    listen: api.event?.listen,
  };
}

function useQuery() {
  return useMemo(() => new URLSearchParams(window.location.search), []);
}

export default function CharacterPage() {
  const query = useQuery();
  const transparent = query.get("transparent") === "1";
  // 桌面角色窗口的 URL 里 window=pet；pet=1 是显式的桌宠标记。
  // 两者都算桌宠模式，避免只改配置里的一处就退化成普通网页行为
  // （那样会既不播放走路动作，也不上报轮廓做鼠标穿透）。
  const petMode = query.get("pet") === "1" || query.get("window") === "pet";
  const debug = query.get("debug") === "1";
  const forcedEmotion = query.get("emotion") as Emotion | null;
  // 调试用：?walk=1 强制播放行走动作，方便截图核对姿态
  const forcedWalk = query.get("walk") === "1";
  const forcedWalkDirection: 1 | -1 = query.get("direction") === "-1" ? -1 : 1;
  const scale = Number(query.get("scale") || "1");

  const [relationship, setRelationship] = useState<RelationshipSnapshot | null>(null);
  const [displayName, setDisplayName] = useState("小满");
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [modelReady, setModelReady] = useState(false);
  const [qualityNotice, setQualityNotice] = useState("");
  const [shared, setShared] = useState<SharedCharacterState>({});
  const [mouthOpen, setMouthOpen] = useState(0);
  const [bubble, setBubble] = useState("");
  const [walking, setWalking] = useState(false);
  const [walkDirection, setWalkDirection] = useState<1 | -1>(-1);
  // 桌宠的"远近"（0 最远、1 最近）。窗口尺寸固定，纵深由模型缩放体现。
  // 初值与桌面壳 walker 的初始 depth 保持一致，避免第一帧跳一下。
  const [depth, setDepth] = useState(0.7);
  const [petMenuOpen, setPetMenuOpen] = useState(false);
  const [destinationPending, setDestinationPending] = useState(false);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const walkingRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hitRegionsRef = useRef<Array<[number, number, number]>>([]);
  const pointerStartRef = useRef<{ x: number; y: number; screenX: number; screenY: number } | null>(null);

  // 透明模式下需要清掉 html/body 的默认底色，否则桌面窗口会显示成灰白底
  useEffect(() => {
    if (!transparent) return;
    document.documentElement.classList.add("character-transparent");
    return () => document.documentElement.classList.remove("character-transparent");
  }, [transparent]);

  // 关系状态：低频轮询，避免角色页需要完整的聊天状态机
  useEffect(() => {
    let cancelled = false;

    async function pull() {
      try {
        const [profileRes, stateRes] = await Promise.all([
          fetch(`${API}/agent/profile`),
          fetch(`${API}/relationship/state`),
        ]);
        if (!profileRes.ok || !stateRes.ok) throw new Error("bad response");
        const profile = await profileRes.json();
        const state = await stateRes.json();
        if (cancelled) return;
        setDisplayName(profile.display_name || "小满");
        setRelationship({
          mood: state.mood,
          trust: state.trust,
          affection: state.affection,
          irritation: state.irritation,
        });
        setConnection("online");
      } catch {
        if (!cancelled) setConnection("offline");
      }
    }

    void pull();
    const timer = window.setInterval(() => void pull(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // 接收主界面广播的交互状态（思考中 / 说话中 / 倾听中）
  useEffect(() => {
    const channel = createCompanionChannel();
    if (!channel) return;
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<SharedCharacterState>) => {
      // 主界面只发增量字段，这里合并，避免口型更新把手势冲掉
      setShared((current) => ({ ...current, ...event.data }));
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, []);

  // 口型直接采用主界面音频能量；没有能量数据时回退到正弦模拟
  useEffect(() => {
    if (!shared.speaking) {
      setMouthOpen(0);
      return;
    }
    if (typeof shared.mouthOpen === "number" && shared.mouthOpen > 0) {
      setMouthOpen(Math.max(0, Math.min(1, shared.mouthOpen)));
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      const value = 0.5 + 0.5 * Math.sin(t * 11) * Math.sin(t * 3.3);
      setMouthOpen(Math.max(0, Math.min(1, value)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shared.speaking, shared.mouthOpen]);

  // 头顶气泡文案：只在说话时显示，过长则截断
  useEffect(() => {
    const text = (shared.bubble || "").trim();
    setBubble(text.length > BUBBLE_MAX_CHARS ? `${text.slice(0, BUBBLE_MAX_CHARS)}…` : text);
  }, [shared.bubble]);

  // 桌面宠物模式：走动状态与方向由桌面壳驱动，这里只负责接收并驱动动画
  useEffect(() => {
    if (!petMode) return;
    const bridge = getTauriBridge();
    if (!bridge?.listen) return;

    let disposed = false;
    let stopWalking: (() => void) | undefined;
    let stopGait: (() => void) | undefined;
    let stopMenuOpen: (() => void) | undefined;
    let stopDestinationMode: (() => void) | undefined;

    void bridge.invoke?.<boolean>("get_pet_walking")
      .then((value) => {
        if (disposed || typeof value !== "boolean") return;
        walkingRef.current = value;
        setWalking(value);
      })
      .catch(() => undefined);

    void bridge.listen<boolean>("pet://walking", (event) => {
      const next = Boolean(event.payload);
      walkingRef.current = next;
      setWalking(next);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopWalking = unlisten;
    }).catch(() => undefined);

    // 步态由桌面壳驱动：走路状态、朝向都来自它算出的地面位置
    void bridge.listen<GaitPayload>("pet://gait", (event) => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      walkingRef.current = Boolean(payload.walking);
      setWalking(Boolean(payload.walking));
      setWalkDirection(Number(payload.direction) < 0 ? -1 : 1);
      if (typeof payload.depth === "number" && Number.isFinite(payload.depth)) {
        setDepth(Math.max(0, Math.min(1, payload.depth)));
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopGait = unlisten;
    }).catch(() => undefined);

    void bridge.listen<boolean>("pet://menu-open", (event) => {
      const open = Boolean(event.payload);
      setPetMenuOpen(open);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopMenuOpen = unlisten;
    }).catch(() => undefined);

    void bridge.listen<boolean>("pet://destination-mode", (event) => {
      setDestinationPending(Boolean(event.payload));
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopDestinationMode = unlisten;
    }).catch(() => undefined);

    return () => {
      disposed = true;
      stopWalking?.();
      stopGait?.();
      stopMenuOpen?.();
      stopDestinationMode?.();
    };
  }, [petMode]);

  // 角色轮廓上报：桌面壳据此决定窗口是否穿透鼠标。
  // 用 ref 保存桥接对象，回调保持稳定，避免每帧重挂监听。
  const hitRegionBridge = useRef<TauriBridge | null>(null);
  useEffect(() => {
    hitRegionBridge.current = petMode ? getTauriBridge() : null;
  }, [petMode]);

  const reportHitRegions = useCallback((regions: Array<[number, number, number]>) => {
    hitRegionsRef.current = regions;
    const bridge = hitRegionBridge.current;
    if (!bridge?.invoke) return;
    void bridge.invoke("set_pet_hit_regions", { regions }).catch(() => undefined);
  }, []);

  const syncPetOverlayBounds = useCallback(() => {
    const bridge = hitRegionBridge.current;
    if (!bridge?.invoke) return;
    const bounds = [menuRef.current]
      .map((element) => element?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0))
      .map((rect) => [rect.left, rect.top, rect.width, rect.height]);
    void bridge.invoke("set_pet_overlay_bounds", { bounds }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!petMode) return;
    const bridge = hitRegionBridge.current;
    void bridge?.invoke?.("set_pet_menu_open", { open: petMenuOpen }).catch(() => undefined);
    const frame = window.requestAnimationFrame(syncPetOverlayBounds);
    let resizeFrame = 0;
    const onResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(syncPetOverlayBounds);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(resizeFrame);
      window.removeEventListener("resize", onResize);
    };
  }, [petMenuOpen, petMode, syncPetOverlayBounds]);

  const closePetMenu = useCallback(() => {
    setPetMenuOpen(false);
  }, []);

  const openPetMenu = useCallback(() => {
    setPetMenuOpen(true);
  }, []);

  const openPetChatWindow = useCallback(() => {
    setPetMenuOpen(false);
    setDestinationPending(false);
    const bridge = hitRegionBridge.current;
    if (!bridge?.invoke) return;
    void bridge.invoke("open_pet_chat").catch(() => undefined);
    void bridge.invoke("set_pet_destination_mode", { enabled: false }).catch(() => undefined);
    void bridge.invoke("set_pet_walking", { enabled: false }).catch(() => undefined);
  }, []);

  const selectPetDestination = useCallback(() => {
    setPetMenuOpen(false);
    setDestinationPending(true);
    const bridge = hitRegionBridge.current;
    if (!bridge?.invoke) return;
    void bridge.invoke("set_pet_destination_mode", { enabled: true }).catch(() => undefined);
  }, []);

  const runPetMenuAction = useCallback((action: "idle" | "chat" | "exit") => {
    closePetMenu();
    if (action === "chat") {
      openPetChatWindow();
      return;
    }
    const bridge = hitRegionBridge.current;
    if (!bridge?.invoke) return;
    if (action === "idle") {
      setDestinationPending(false);
      void bridge.invoke("set_pet_walking", { enabled: false }).catch(() => undefined);
      void bridge.invoke("set_pet_destination_mode", { enabled: false }).catch(() => undefined);
    } else {
      void bridge.invoke("quit_app").catch(() => undefined);
    }
  }, [closePetMenu, openPetChatWindow]);

  const onPetPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!petMode || event.button !== 0) return;
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    };
  }, [petMode]);

  const onPetPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!petMode || event.button !== 0 || !start) return;
    const moved = Math.hypot(event.screenX - start.screenX, event.screenY - start.screenY);
    if (moved > 7) return;
    const insideCharacter = hitRegionsRef.current.some(([x, y, radius]) => {
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      return dx * dx + dy * dy <= radius * radius;
    });
    if (insideCharacter) selectPetDestination();
  }, [petMode, selectPetDestination]);

  const onPetContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!petMode) return;
    const target = event.target as Element;
    if (target.closest(".pet-action-menu")) {
      event.preventDefault();
      return;
    }
    const insideCharacter = hitRegionsRef.current.some(([x, y, radius]) => {
      const dx = event.clientX - x;
      const dy = event.clientY - y;
      return dx * dx + dy * dy <= radius * radius;
    });
    if (!insideCharacter) return;
    event.preventDefault();
    event.stopPropagation();
    openPetMenu();
  }, [openPetMenu, petMode]);

  // 拖动由桌面壳直接接管：按住角色本体时，Rust 侧按鼠标位移移动窗口。
  // 走网页指针事件容易和走动线程抢窗口位置，所以这里不再重复实现。

  const emotion = forcedEmotion || inferEmotion(relationship, true);
  const gesture: Gesture = shared.gesture || "idle";

  const visual: CharacterVisualState = useMemo(
    () => ({
      emotion,
      intensity: inferIntensity(relationship, emotion),
      gesture,
      mouthOpen,
      lookAt: null,
      bubble,
      walking: forcedWalk || (petMode && walking),
      walkDirection: forcedWalk ? forcedWalkDirection : walkDirection,
    }),
    [emotion, relationship, gesture, mouthOpen, bubble, petMode, walking, walkDirection, forcedWalk, forcedWalkDirection],
  );

  const modelUrl = CHARACTER_MODEL_URL;

  return (
    <div
      className={`character-page ${transparent ? "transparent" : ""} ${petMode ? "pet" : ""} ${destinationPending ? "choosing-destination" : ""}`}
      onPointerDown={onPetPointerDown}
      onPointerUp={onPetPointerUp}
      onContextMenu={onPetContextMenu}
      onPointerCancel={() => { pointerStartRef.current = null; }}
    >
      <div className="character-page-stage" style={{ transform: `scale(${Number.isFinite(scale) ? scale : 1})` }}>
        <CharacterStage
          modelUrl={modelUrl}
          visual={visual}
          transparent={transparent}
          petMode={petMode}
          depthScale={petMode ? depth : undefined}
          onHitRegions={petMode ? reportHitRegions : undefined}
          onReady={() => setModelReady(true)}
          onError={(reason) => {
            // 性能类提示不应影响"模型是否已加载"的判断
            if (reason === "low-fps") {
              setQualityNotice("当前设备帧率偏低，已降低渲染负担");
              return;
            }
            setModelReady(false);
            setQualityNotice(reason);
          }}
        />
      </div>

      {petMode && petMenuOpen && (
        <div
          ref={menuRef}
          className="pet-action-menu"
          role="menu"
          aria-label="角色操作"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <div className="pet-action-menu-title">
            <span className="pet-action-menu-status" />
            <span>{displayName}</span>
          </div>
          <button type="button" role="menuitem" title="切换为待机动作" onClick={() => runPetMenuAction("idle")}>
            <Moon aria-hidden="true" />
            <span>待机动作</span>
          </button>
          <button type="button" role="menuitem" title="打开桌宠聊天框" onClick={() => runPetMenuAction("chat")}>
            <MessageCircle aria-hidden="true" />
            <span>聊天框</span>
          </button>
          <button type="button" role="menuitem" title="退出陪伴智能体" onClick={() => runPetMenuAction("exit")}>
            <Power aria-hidden="true" />
            <span>退出</span>
          </button>
        </div>
      )}

      {debug && (
        <div className="character-debug">
          <div>角色：{displayName}</div>
          <div>连接：{connection === "online" ? "已连接" : connection === "offline" ? "未连接" : "连接中"}</div>
          <div>模型：{modelReady ? "已加载" : "未加载"}</div>
          <div>情绪：{emotion}</div>
          <div>动作：{gesture}</div>
          <div>心情：{relationship?.mood ?? "-"}</div>
          <div>信任：{relationship?.trust ?? "-"} 亲密：{relationship?.affection ?? "-"} 烦躁：{relationship?.irritation ?? "-"}</div>
          {qualityNotice && <div>提示：{qualityNotice}</div>}
        </div>
      )}

      {/* 桌宠模式是透明悬浮窗，任何提示条都会像贴纸一样挂在桌面上，这里不显示 */}
      {!debug && !petMode && connection === "offline" && (
        <div className="character-offline">未连接到角色服务</div>
      )}
    </div>
  );
}
