import type { Gesture } from "./types";

/**
 * 主界面与独立角色窗口之间的本地状态通道。
 * 除了手势，还要传递口型开合与头顶气泡文本，桌面角色窗口才能和音频同步。
 */
export const COMPANION_CHANNEL = "companion-character-state";

export interface SharedCharacterState {
  gesture?: Gesture;
  speaking?: boolean;
  mouthOpen?: number;
  bubble?: string;
}

export function createCompanionChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(COMPANION_CHANNEL);
  } catch {
    return null;
  }
}
