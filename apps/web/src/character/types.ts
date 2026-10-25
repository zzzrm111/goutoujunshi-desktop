export type Emotion = "neutral" | "happy" | "shy" | "sad" | "angry" | "cold" | "worried";
export type Gesture = "idle" | "listening" | "thinking" | "speaking";

export interface CharacterVisualState {
  emotion: Emotion;
  intensity: number;
  gesture: Gesture;
  mouthOpen: number;
  lookAt: { x: number; y: number } | null;
  /** 说话时浮在头顶的台词，空字符串表示不显示气泡。 */
  bubble?: string;
  /** 桌面走动状态：true 时播放行走动作并让角色朝向行进方向。 */
  walking?: boolean;
  /** 行进方向：1 向右，-1 向左。 */
  walkDirection?: 1 | -1;
}

export interface RelationshipSnapshot {
  mood: string;
  trust: number;
  affection: number;
  irritation: number;
}

/**
 * 由关系状态推导角色情绪。与主界面共用同一套规则，避免两处表现不一致。
 */
export function inferEmotion(relationship: RelationshipSnapshot | null, isGirlfriendMode: boolean): Emotion {
  if (!relationship || !isGirlfriendMode) return "neutral";

  const { mood, irritation, trust, affection } = relationship;

  if (irritation >= 30) return "angry";
  if (irritation >= 18) return "cold";
  if (mood === "担心" || mood === "焦虑") return "worried";
  if (mood === "委屈" || mood === "难过") return "sad";
  if (affection >= 70 && trust >= 60) return "happy";
  if (affection >= 50 && mood.includes("害羞")) return "shy";
  if (trust >= 40 && affection >= 40) return "happy";
  return "neutral";
}

/**
 * 情绪强度：用于控制表情幅度，避免所有情绪都拉满。
 */
export function inferIntensity(relationship: RelationshipSnapshot | null, emotion: Emotion): number {
  if (!relationship || emotion === "neutral") return 0;
  if (emotion === "angry") return Math.min(1, 0.5 + relationship.irritation / 100);
  if (emotion === "cold") return Math.min(1, 0.4 + relationship.irritation / 100);
  if (emotion === "happy") return Math.min(1, 0.4 + relationship.affection / 150);
  return 0.6;
}
