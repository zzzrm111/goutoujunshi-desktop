import { FormEvent, MouseEvent, useEffect, useRef, useState } from "react";
import { Heart, Image as ImageIcon, MessageSquarePlus, Mic, Pause, Phone, PhoneOff, Play, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Square, StopCircle, Trash2, UserRound, Volume2, X } from "lucide-react";
import { consumeSseResponse } from "./lib/sse";
import { type Emotion, type Gesture } from "./CharacterState";
import { CharacterStage } from "./character/CharacterStage";
import { CHARACTER_MODEL_URL } from "./character/model-source";
import { inferIntensity } from "./character/types";
import { createCompanionChannel, type SharedCharacterState } from "./character/companion-channel";
import { computeEnvelope, createPcmMouth, pcmEnergy, trackElementMouth, type EnvelopeHolder, type MouthTracker, type PcmMouth } from "./character/audio-mouth";
import "./character-layout.css";
import "./profile.css";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1";
const API_ORIGIN = API.replace(/\/api\/v1\/?$/, "");
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
/** 头顶气泡最多显示的字符数，过长会截断，避免遮住角色。 */
const BUBBLE_MAX_CHARS = 90;

type ChatSession = { id: string; title: string; mode: "girlfriend" | "advisor"; updated_at: string };
type MessageAttachment = { id: string; kind: string; original_name: string; mime_type: string; size: number; analysis_status: string; summary: string; created_at: string; url: string };
type Message = { id: string; role: "user" | "assistant"; content: string; created_at: string; attachments?: MessageAttachment[] };
type UiMessage = Message & { pending?: boolean; error?: string };
type PendingAttachment = MessageAttachment & { uploading: boolean; error?: string };
type MemoryStatus = { allowed: boolean; paused: boolean };
type Memory = { id: string; kind: string; content: string; created_at: string; updated_at: string };
type AdultStatus = { confirmed: boolean };
type MemoryCandidate = { kind: string; content: string; source: string };
type AgentProfile = {
  id: string;
  display_name: string;
  personality: string;
  background: string;
  interests: string;
  boundaries: string;
  speech_style: string;
  inner_mood: string;
  current_focus: string;
  recent_plan: string;
  avoid_topics: string;
  autonomy_level: number;
  initiative_level: number;
  initiative_cooldown_minutes: number;
  last_initiative_at?: string | null;
  anger_sensitivity: number;
  silent_duration_minutes: number;
  updated_at: string;
};
type RelationshipState = { id?: string; mood: string; trust: number; affection: number; irritation: number; conflict_count: number; last_trigger: string; silence_until?: string | null; updated_at?: string };
type AgentMemory = { id: string; kind: string; content: string; source: string; importance: number; enabled: boolean; created_at: string; updated_at: string };
type RelationshipEvent = { id: string; event_type: string; trigger: string; user_message: string; mood_before: string; mood_after: string; trust_delta: number; affection_delta: number; irritation_delta: number; resolved: boolean; resolution_note: string; created_at: string; resolved_at?: string | null };
type RelationshipRule = { id: string; name: string; match_text: string; event_type: string; trigger: string; trust_delta: number; affection_delta: number; irritation_delta: number; needs_distance: boolean; silence_minutes: number; priority: number; enabled: boolean; created_at: string; updated_at: string };
type SsePayload = Record<string, unknown>;
type RealtimeState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";
type SpeechStyleSnapshot = { name: string; instruct: string; speed: number; emotion_vector: number[] };

function createClientId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") return uuid.call(globalThis.crypto);
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
function focusInput(input: HTMLTextAreaElement | null): void {
  if (!input || typeof input.focus !== "function") return;
  try {
    input.focus();
  } catch {
    // Some embedded browsers expose focus but reject it outside a user gesture.
  }
}

function scrollToLatest(node: HTMLDivElement | null): void {
  if (!node || typeof node.scrollIntoView !== "function") return;
  try {
    node.scrollIntoView();
  } catch {
    // Keep rendering if the embedded browser does not implement scroll options.
  }
}

function resolveAttachmentUrl(url: string): string {
  if (/^(?:https?:|blob:|data:)/i.test(url)) return url;
  return `${API_ORIGIN}${url.startsWith("/") ? "" : "/"}${url}`;
}

function takeSpeechSegments(input: string, force = false): { segments: string[]; remainder: string } {
  const segments: string[] = [];
  const punctuation = /[，。！？!?；;、\n]/g;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = punctuation.exec(input)) !== null) {
    const candidate = input.slice(consumed, match.index + match[0].length).trim();
    if (candidate) segments.push(candidate);
    consumed = match.index + match[0].length;
  }
  if (force && input.slice(consumed).trim()) {
    segments.push(input.slice(consumed).trim());
    consumed = input.length;
  }
  return { segments, remainder: input.slice(consumed) };
}

export default function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [characterEmotion, setCharacterEmotion] = useState<Emotion>('neutral');
  const [characterGesture, setCharacterGesture] = useState<Gesture>('idle');
  const [characterBubble, setCharacterBubble] = useState("");
  const [characterDisabled, setCharacterDisabled] = useState(false);
  const [status, setStatus] = useState("正在连接");
  const [mobileNav, setMobileNav] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>({ allowed: false, paused: false });
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryEditDraft, setMemoryEditDraft] = useState("");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [adultStatus, setAdultStatus] = useState<AdultStatus>({ confirmed: false });
  const [adultOpen, setAdultOpen] = useState(false);
  const [memoryCandidate, setMemoryCandidate] = useState<MemoryCandidate | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [speechError, setSpeechError] = useState("");
  const [ttsBusyId, setTtsBusyId] = useState<string | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [audioPaused, setAudioPaused] = useState(false);
  const [audioMode, setAudioMode] = useState<"audio" | "browser-fallback">("audio");
  const [ttsError, setTtsError] = useState<{ id: string; message: string } | null>(null);
  const [audioNotice, setAudioNotice] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(() => localStorage.getItem("companion-auto-speak") !== "false");
  const [autoSpeakBlocked, setAutoSpeakBlocked] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [profileDraft, setProfileDraft] = useState<AgentProfile | null>(null);
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipState | null>(null);
  const [agentMemories, setAgentMemories] = useState<AgentMemory[]>([]);
  const [relationshipEvents, setRelationshipEvents] = useState<RelationshipEvent[]>([]);
  const [relationshipRules, setRelationshipRules] = useState<RelationshipRule[]>([]);
  const [ruleDraft, setRuleDraft] = useState({ name: "", match_text: "", event_type: "custom", trigger: "自定义关系规则命中", trust_delta: 0, affection_delta: 0, irritation_delta: 0, needs_distance: false, silence_minutes: 0, priority: 50, enabled: true });
  const [agentMemoryDraft, setAgentMemoryDraft] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [realtimeOpen, setRealtimeOpen] = useState(false);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("idle");
  const [realtimeRecording, setRealtimeRecording] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState("");
  const [realtimeTranscript, setRealtimeTranscript] = useState("");
  const [realtimeAnswer, setRealtimeAnswer] = useState("");
  const latestSpeechStyle = useRef<SpeechStyleSnapshot | null>(null);
  const generationController = useRef<AbortController | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const mediaStream = useRef<MediaStream | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordingStartedAt = useRef<number | null>(null);
  const recordingUrlRef = useRef<string | null>(null);
  const activeAudio = useRef<HTMLAudioElement | null>(null);
  const activeAudioUrl = useRef<string | null>(null);
  const ttsController = useRef<AbortController | null>(null);
  const ttsRequestId = useRef(0);
  const speechQueueGeneration = useRef(0);
  const speechSynthesisQueue = useRef<Array<{ message: UiMessage; text: string; generation: number }>>([]);
  const speechPlaybackQueue = useRef<Array<{ message: UiMessage; text: string; blob?: Blob; browserFallback?: boolean; generation: number }>>([]);
  const speechSynthesisRunning = useRef(false);
  const speechPlaybackRunning = useRef(false);
  const queuedPlaybackDone = useRef<(() => void) | null>(null);
  const generationAssistantId = useRef<string | null>(null);
  const stoppingGeneration = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachmentUrls = useRef<Set<string>>(new Set());
  const realtimeSocket = useRef<WebSocket | null>(null);
  const realtimeStream = useRef<MediaStream | null>(null);
  const realtimeResponseId = useRef<string>("");
  const realtimeShouldStayOpen = useRef(false);
  const realtimeListeningLoop = useRef(false);
  const realtimeVoiceActive = useRef(false);
  const realtimeVoiceDetectedAt = useRef(0);
  const realtimeVoiceSilenceSince = useRef(0);
  const realtimeTurnOpen = useRef(false);
  const realtimeAudioContext = useRef<AudioContext | null>(null);
  const realtimeAnalyser = useRef<AnalyserNode | null>(null);
  const realtimeVadFrame = useRef<number | null>(null);
  const realtimeSpeaking = useRef(false);
  const realtimeSentenceBuffer = useRef("");
  const realtimeFullAnswer = useRef("");
  const realtimeFirstSegmentPending = useRef(true);
  const realtimeCaptureContext = useRef<AudioContext | null>(null);
  const realtimeCaptureSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const realtimeCaptureProcessor = useRef<ScriptProcessorNode | null>(null);
  const realtimeCaptureSink = useRef<GainNode | null>(null);
  const realtimeCaptureSampleRate = useRef(48_000);
  const realtimePlaybackContext = useRef<AudioContext | null>(null);
  const realtimePlaybackCursor = useRef(0);
  const realtimePlaybackSampleRate = useRef(24_000);
  const realtimePlaybackSources = useRef<Set<AudioBufferSourceNode>>(new Set());
  // 角色表现：常驻广播通道 + 音频能量驱动的口型
  const characterChannel = useRef<BroadcastChannel | null>(null);
  const characterMouthRef = useRef(0);
  const mouthTracker = useRef<MouthTracker | null>(null);
  const pcmMouth = useRef<PcmMouth | null>(null);

  useEffect(() => () => {
    mediaRecorder.current?.stop();
    mediaStream.current?.getTracks().forEach((track) => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    attachmentUrls.current.forEach((url) => URL.revokeObjectURL(url));
    attachmentUrls.current.clear();
    activeAudio.current?.pause();
    queuedPlaybackDone.current?.();
    queuedPlaybackDone.current = null;
    if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
    ttsController.current?.abort();
    realtimeStream.current?.getTracks().forEach((track) => track.stop());
    realtimeCaptureProcessor.current?.disconnect();
    realtimeCaptureSource.current?.disconnect();
    realtimeCaptureSink.current?.disconnect();
    if (realtimeCaptureContext.current) void realtimeCaptureContext.current.close().catch(() => undefined);
    realtimePlaybackSources.current.forEach((source) => { try { source.stop(); } catch { /* Already stopped. */ } });
    realtimePlaybackSources.current.clear();
    if (realtimePlaybackContext.current) void realtimePlaybackContext.current.close().catch(() => undefined);
    realtimeSocket.current?.close();
    mouthTracker.current?.stop();
    mouthTracker.current = null;
    pcmMouth.current?.stop();
    pcmMouth.current = null;
    characterChannel.current?.close();
    characterChannel.current = null;
  }, []);

  useEffect(() => {
    localStorage.setItem("companion-auto-speak", String(autoSpeak));
  }, [autoSpeak]);

  async function refreshSessions() {
    const response = await fetch(`${API}/sessions`);
    if (!response.ok) throw new Error("API unavailable");
    setSessions(await response.json());
  }

  async function refreshRelationshipState() {
    const response = await fetch(`${API}/relationship/state`);
    if (!response.ok) return;
    setRelationshipDraft(await response.json());
  }

  useEffect(() => {
    refreshSessions().then(() => setStatus("已连接")).catch(() => setStatus("服务未启动"));
    fetch(`${API}/memory/status`).then((response) => response.json()).then(setMemoryStatus).catch(() => undefined);
    fetch(`${API}/adult/status`).then((response) => response.json()).then(setAdultStatus).catch(() => undefined);
    fetch(`${API}/agent/profile`).then((response) => response.json()).then((value) => { setProfile(value); setProfileDraft(value); }).catch(() => undefined);
    refreshRelationshipState().catch(() => undefined);
  }, []);

  useEffect(() => scrollToLatest(endRef.current), [messages]);

  // 根据关系状态推断人物情绪
  useEffect(() => {
    if (!relationshipDraft || active?.mode !== 'girlfriend') {
      setCharacterEmotion('neutral');
      return;
    }

    const { mood, irritation, trust, affection } = relationshipDraft;

    // 优先根据烦躁度判断负面情绪
    if (irritation >= 30) {
      setCharacterEmotion('angry');
    } else if (irritation >= 18) {
      setCharacterEmotion('cold');
    } else if (mood === '担心' || mood === '焦虑') {
      setCharacterEmotion('worried');
    } else if (mood === '委屈' || mood === '难过') {
      setCharacterEmotion('sad');
    } else if (affection >= 70 && trust >= 60) {
      setCharacterEmotion('happy');
    } else if (affection >= 50 && mood.includes('害羞')) {
      setCharacterEmotion('shy');
    } else if (trust >= 40 && affection >= 40) {
      setCharacterEmotion('happy');
    } else {
      setCharacterEmotion('neutral');
    }
  }, [relationshipDraft, active?.mode]);

  // 根据交互状态推断人物动作
  useEffect(() => {
    if (realtimeOpen) {
      if (realtimeRecording) {
        setCharacterGesture('listening');
      } else if (busy) {
        setCharacterGesture('thinking');
      } else {
        setCharacterGesture('speaking');
      }
    } else if (busy) {
      setCharacterGesture('thinking');
    } else if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      setCharacterGesture('speaking');
      // 2秒后回到待机
      const timer = setTimeout(() => setCharacterGesture('idle'), 2000);
      return () => clearTimeout(timer);
    } else {
      setCharacterGesture('idle');
    }
  }, [busy, realtimeOpen, realtimeRecording, messages]);

  // 常驻通道：口型每秒更新约 30 次，不能每次重建通道
  useEffect(() => {
    characterChannel.current = createCompanionChannel();
    return () => {
      characterChannel.current?.close();
      characterChannel.current = null;
    };
  }, []);

  // 把交互状态广播给独立角色页与桌面角色窗口，保持两边表现一致
  useEffect(() => {
    publishCharacterState({ gesture: characterGesture, speaking: characterGesture === "speaking" });
  }, [characterGesture]);

  function publishCharacterState(patch: SharedCharacterState) {
    characterChannel.current?.postMessage(patch);
  }

  function truncateBubble(text: string): string {
    const cleaned = text.trim();
    return cleaned.length > BUBBLE_MAX_CHARS ? `${cleaned.slice(0, BUBBLE_MAX_CHARS)}…` : cleaned;
  }

  /** 开始用真实音频能量驱动口型，并把台词推给角色窗口的头顶气泡。 */
  function attachElementMouth(audio: HTMLAudioElement, blob: Blob, text: string): void {
    mouthTracker.current?.stop();
    const holder: EnvelopeHolder = { current: null };
    mouthTracker.current = trackElementMouth(audio, holder, (value) => {
      characterMouthRef.current = value;
      publishCharacterState({ mouthOpen: value });
    });
    void computeEnvelope(blob)
      .then((envelope) => { holder.current = envelope; })
      .catch(() => undefined);

    const bubble = truncateBubble(text);
    setCharacterBubble(bubble);
    publishCharacterState({ bubble, speaking: true, gesture: "speaking" });
  }

  /** 播放结束或被打断时收回口型与气泡。 */
  function detachMouth(clearBubble = true): void {
    mouthTracker.current?.stop();
    mouthTracker.current = null;
    pcmMouth.current?.stop();
    pcmMouth.current = null;
    characterMouthRef.current = 0;
    publishCharacterState(clearBubble ? { mouthOpen: 0, bubble: "" } : { mouthOpen: 0 });
    if (clearBubble) setCharacterBubble("");
  }

  async function openSession(item: ChatSession) {
    stopAudio();
    const response = await fetch(`${API}/sessions/${item.id}`);
    if (!response.ok) return;
    const detail = await response.json();
    setActive(item);
    setMessages(detail.messages);
    setPendingAttachments([]);
    setAttachmentError("");
    setMobileNav(false);
  }

  async function newSession(mode: "girlfriend" | "advisor" = "girlfriend"): Promise<ChatSession | null> {
    if (mode === "girlfriend" && !adultStatus.confirmed) {
      setAdultOpen(true);
      return null;
    }
    const response = await fetch(`${API}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
    });
    if (!response.ok) return null;
    const item: ChatSession = await response.json();
    stopAudio();
    setSessions((current) => [item, ...current]);
    setActive(item);
    setMessages([]);
    setPendingAttachments([]);
    setMobileNav(false);
    focusInput(inputRef.current);
    return item;
  }

  async function confirmAdult() {
    const response = await fetch(`${API}/adult/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    if (!response.ok) return;
    setAdultStatus(await response.json());
    setAdultOpen(false);
  }

  async function revokeAdult() {
    const response = await fetch(`${API}/adult/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: false }) });
    if (!response.ok) return;
    setAdultStatus(await response.json());
  }

  async function removeSession(event: MouseEvent, item: ChatSession) {
    event.stopPropagation();
    if (active?.id === item.id) stopAudio();
    await fetch(`${API}/sessions/${item.id}`, { method: "DELETE" });
    setSessions((current) => current.filter((row) => row.id !== item.id));
    if (active?.id === item.id) { setActive(null); setMessages([]); }
    if (active?.id === item.id) setPendingAttachments([]);
  }

  async function openMemory() {
    const [statusResponse, memoryResponse] = await Promise.all([fetch(`${API}/memory/status`), fetch(`${API}/memory`)]);
    if (!statusResponse.ok || !memoryResponse.ok) return;
    setMemoryStatus(await statusResponse.json());
    setMemories(await memoryResponse.json());
    setMemoryOpen(true);
  }

  async function openProfile() {
    const [profileResponse, relationshipResponse, memoriesResponse, eventsResponse, rulesResponse] = await Promise.all([fetch(`${API}/agent/profile`), fetch(`${API}/relationship/state`), fetch(`${API}/agent/memories`), fetch(`${API}/relationship/events`), fetch(`${API}/relationship/rules`)]);
    if (!profileResponse.ok || !relationshipResponse.ok || !memoriesResponse.ok || !eventsResponse.ok || !rulesResponse.ok) return;
    const nextProfile: AgentProfile = await profileResponse.json();
    setProfile(nextProfile);
    setProfileDraft(nextProfile);
    const nextRelationship: RelationshipState = await relationshipResponse.json();
    setRelationshipDraft(nextRelationship);
    setAgentMemories(await memoriesResponse.json());
    setRelationshipEvents(await eventsResponse.json());
    setRelationshipRules(await rulesResponse.json());
    setProfileOpen(true);
  }

  async function addRelationshipRule() {
    if (!ruleDraft.name.trim() || !ruleDraft.match_text.trim() || profileBusy) return;
    setProfileBusy(true);
    try {
      const response = await fetch(`${API}/relationship/rules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ruleDraft, name: ruleDraft.name.trim(), match_text: ruleDraft.match_text.trim(), trigger: ruleDraft.trigger.trim() }) });
      if (response.ok) {
        const created: RelationshipRule = await response.json();
        setRelationshipRules((current) => [...current, created].sort((a, b) => b.priority - a.priority));
        setRuleDraft({ name: "", match_text: "", event_type: "custom", trigger: "自定义关系规则命中", trust_delta: 0, affection_delta: 0, irritation_delta: 0, needs_distance: false, silence_minutes: 0, priority: 50, enabled: true });
      }
    } finally { setProfileBusy(false); }
  }

  async function toggleRelationshipRule(rule: RelationshipRule) {
    const response = await fetch(`${API}/relationship/rules/${rule.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...rule, enabled: !rule.enabled }) });
    if (response.ok) { const saved: RelationshipRule = await response.json(); setRelationshipRules((current) => current.map((item) => item.id === saved.id ? saved : item)); }
  }

  async function deleteRelationshipRule(rule: RelationshipRule) {
    const response = await fetch(`${API}/relationship/rules/${rule.id}`, { method: "DELETE" });
    if (response.ok) setRelationshipRules((current) => current.filter((item) => item.id !== rule.id));
  }

  async function addAgentMemory() {
    const content = agentMemoryDraft.trim();
    if (!content || profileBusy) return;
    setProfileBusy(true);
    try {
      const response = await fetch(`${API}/agent/memories`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "self_fact", content, importance: 3 }) });
      if (response.ok) {
        const created: AgentMemory = await response.json();
        setAgentMemories((current) => [created, ...current]);
        setAgentMemoryDraft("");
      }
    } finally { setProfileBusy(false); }
  }

  async function deleteAgentMemory(memory: AgentMemory) {
    const response = await fetch(`${API}/agent/memories/${memory.id}`, { method: "DELETE" });
    if (response.ok) setAgentMemories((current) => current.filter((item) => item.id !== memory.id));
  }

  async function saveProfile() {
    if (!profileDraft || !relationshipDraft || profileBusy) return;
    setProfileBusy(true);
    try {
      const headers = { "Content-Type": "application/json" };
      const [profileResponse, relationshipResponse] = await Promise.all([
        fetch(`${API}/agent/profile`, { method: "PUT", headers, body: JSON.stringify(profileDraft) }),
        fetch(`${API}/relationship/state`, { method: "PUT", headers, body: JSON.stringify({
          mood: relationshipDraft.mood,
          trust: relationshipDraft.trust,
          affection: relationshipDraft.affection,
          irritation: relationshipDraft.irritation,
          conflict_count: relationshipDraft.conflict_count,
          last_trigger: relationshipDraft.last_trigger,
        }) }),
      ]);
      if (profileResponse.ok && relationshipResponse.ok) {
        const saved: AgentProfile = await profileResponse.json();
        const savedRelationship: RelationshipState = await relationshipResponse.json();
        setProfile(saved);
        setProfileDraft(saved);
        setRelationshipDraft(savedRelationship);
        setProfileOpen(false);
      }
    } finally { setProfileBusy(false); }
  }

  function updateProfile<K extends keyof AgentProfile>(field: K, value: AgentProfile[K]) {
    setProfileDraft((current) => current ? { ...current, [field]: value } : current);
  }

  function updateRelationship<K extends keyof RelationshipState>(field: K, value: RelationshipState[K]) {
    setRelationshipDraft((current) => current ? { ...current, [field]: value } : current);
  }

  async function setMemoryConsent(allowed: boolean) {
    setMemoryBusy(true);
    try {
      const response = await fetch(`${API}/memory/consent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowed }) });
      if (response.ok) setMemoryStatus(await response.json());
    } finally { setMemoryBusy(false); }
  }

  async function setMemoryPaused(paused: boolean) {
    setMemoryBusy(true);
    try {
      const response = await fetch(`${API}/memory/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) });
      if (response.ok) setMemoryStatus(await response.json());
    } finally { setMemoryBusy(false); }
  }

  async function addMemory() {
    const content = memoryDraft.trim();
    if (!content || memoryBusy) return;
    setMemoryBusy(true);
    try {
      const response = await fetch(`${API}/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "user_fact", content }) });
      if (response.ok) { const created: Memory = await response.json(); setMemories((current) => [created, ...current]); setMemoryDraft(""); }
    } finally { setMemoryBusy(false); }
  }

  async function deleteMemory(memory: Memory) {
    if (!window.confirm(`删除这条记忆？\n\n${memory.content}`)) return;
    const response = await fetch(`${API}/memory/${memory.id}`, { method: "DELETE" });
    if (response.ok) setMemories((current) => current.filter((item) => item.id !== memory.id));
  }

  function startMemoryEdit(memory: Memory) {
    setEditingMemoryId(memory.id);
    setMemoryEditDraft(memory.content);
  }

  function cancelMemoryEdit() {
    setEditingMemoryId(null);
    setMemoryEditDraft("");
  }

  async function saveMemoryEdit(memory: Memory) {
    const content = memoryEditDraft.trim();
    if (!content || memoryBusy) return;
    setMemoryBusy(true);
    try {
      const response = await fetch(`${API}/memory/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (response.ok) {
        const saved: Memory = await response.json();
        setMemories((current) => current.map((item) => item.id === saved.id ? saved : item));
        cancelMemoryEdit();
      }
    } finally { setMemoryBusy(false); }
  }

  function retryMessage(messageIndex: number) {
    const previousUser = [...messages.slice(0, messageIndex)].reverse().find((message) => message.role === "user");
    if (!previousUser) return;
    if (busy) return;
    void sendMessageText(previousUser.content, [previousUser.id, messages[messageIndex].id], true, []);
  }

  function regenerateMessage(messageIndex: number) {
    const previousUser = [...messages.slice(0, messageIndex)].reverse().find((message) => message.role === "user");
    if (!previousUser || busy) return;
    void sendMessageText(previousUser.content, [previousUser.id, messages[messageIndex].id], true, []);
  }

  async function confirmMemoryCandidate() {
    if (!memoryCandidate || candidateBusy) return;
    setCandidateBusy(true);
    try {
      const response = await fetch(`${API}/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: memoryCandidate.kind, content: memoryCandidate.content }) });
      if (response.ok) {
        const created: Memory = await response.json();
        setMemories((current) => [created, ...current]);
        setMemoryCandidate(null);
      } else if (response.status === 403) {
        setMemoryOpen(true);
      }
    } finally { setCandidateBusy(false); }
  }

  function setAudioPreview(blob: Blob) {
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    const url = URL.createObjectURL(blob);
    recordingUrlRef.current = url;
    setRecordingUrl(url);
  }

  async function chooseImages() {
    if (attachmentBusy || busy) return;
    imageInputRef.current?.click();
  }

  async function uploadImageFiles(files: FileList | File[], sessionId = active?.id) {
    if (attachmentBusy) return;
    if (!sessionId) {
      const created = await newSession();
      if (!created) return;
      sessionId = created.id;
    }
    const selected = Array.from(files).slice(0, Math.max(0, MAX_ATTACHMENTS - pendingAttachments.length));
    if (selected.length === 0) {
      setAttachmentError("一条消息最多支持 4 张图片。");
      return;
    }
    setAttachmentBusy(true);
    setAttachmentError("");
    try {
      for (const file of selected) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
          setAttachmentError("请选择 JPG、PNG、WEBP 或 GIF 图片。");
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachmentError("单张图片不能超过 10 MB。");
          continue;
        }
        const localUrl = URL.createObjectURL(file);
        const placeholder: PendingAttachment = {
          id: createClientId(),
          kind: "image",
          original_name: file.name,
          mime_type: file.type,
          size: file.size,
          analysis_status: "uploading",
          summary: "",
          created_at: new Date().toISOString(),
          url: localUrl,
          uploading: true,
        };
        attachmentUrls.current.add(localUrl);
        setPendingAttachments((current) => [...current, placeholder]);
        const form = new FormData();
        form.append("file", file);
        try {
          const response = await fetch(`${API}/sessions/${sessionId}/attachments`, { method: "POST", body: form });
          if (!response.ok) {
            let message = "图片上传失败，仍可继续使用文字聊天。";
            try {
              const payload = await response.json() as { detail?: string };
              if (typeof payload.detail === "string") message = payload.detail;
            } catch { /* Keep the stable fallback for non-JSON errors. */ }
            throw new Error(message);
          }
          const saved: MessageAttachment = await response.json();
          setPendingAttachments((current) => current.map((item) => {
            if (item.id !== placeholder.id) return item;
            if (attachmentUrls.current.has(item.url)) {
              URL.revokeObjectURL(item.url);
              attachmentUrls.current.delete(item.url);
            }
            return { ...saved, uploading: false };
          }));
        } catch (error) {
          setPendingAttachments((current) => current.map((item) => item.id === placeholder.id ? { ...item, uploading: false, error: error instanceof Error ? error.message : "图片上传失败。" } : item));
          setAttachmentError(error instanceof Error ? error.message : "图片上传失败。");
        }
      }
    } finally {
      setAttachmentBusy(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  }

  function removePendingAttachment(attachment: PendingAttachment) {
    setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachmentUrls.current.has(attachment.url)) {
      URL.revokeObjectURL(attachment.url);
      attachmentUrls.current.delete(attachment.url);
    }
    if (!attachment.uploading && !attachment.error) {
      void fetch(`${API}/attachments/${attachment.id}`, { method: "DELETE" });
    }
  }

  function closeRealtimeSocket() {
    realtimeShouldStayOpen.current = false;
    realtimeListeningLoop.current = false;
    const socket = realtimeSocket.current;
    realtimeSocket.current = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.end" }));
    }
    socket?.close();
  }

  function stopRealtimeVad() {
    if (realtimeVadFrame.current !== null) {
      cancelAnimationFrame(realtimeVadFrame.current);
      realtimeVadFrame.current = null;
    }
    realtimeAnalyser.current = null;
    if (realtimeAudioContext.current) {
      void realtimeAudioContext.current.close().catch(() => undefined);
      realtimeAudioContext.current = null;
    }
    realtimeVoiceActive.current = false;
    realtimeVoiceDetectedAt.current = 0;
    realtimeVoiceSilenceSince.current = 0;
    realtimeTurnOpen.current = false;
  }

  function cleanupRealtimeAudio() {
    stopRealtimeVad();
    realtimeCaptureProcessor.current?.disconnect();
    realtimeCaptureProcessor.current = null;
    realtimeCaptureSource.current?.disconnect();
    realtimeCaptureSource.current = null;
    realtimeCaptureSink.current?.disconnect();
    realtimeCaptureSink.current = null;
    if (realtimeCaptureContext.current) {
      void realtimeCaptureContext.current.close().catch(() => undefined);
      realtimeCaptureContext.current = null;
    }
    realtimePlaybackSources.current.forEach((source) => { try { source.stop(); } catch { /* Already stopped. */ } });
    realtimePlaybackSources.current.clear();
    if (realtimePlaybackContext.current) {
      void realtimePlaybackContext.current.close().catch(() => undefined);
      realtimePlaybackContext.current = null;
    }
    realtimePlaybackCursor.current = 0;
    realtimeStream.current?.getTracks().forEach((track) => track.stop());
    realtimeStream.current = null;
    setRealtimeRecording(false);
  }

  function interruptRealtimeAnswer() {
    if (!realtimeSpeaking.current && realtimePlaybackSources.current.size === 0) return;
    realtimeSentenceBuffer.current = "";
    realtimePlaybackSources.current.forEach((source) => { try { source.stop(); } catch { /* Already stopped. */ } });
    realtimePlaybackSources.current.clear();
    realtimePlaybackCursor.current = realtimePlaybackContext.current?.currentTime ?? 0;
    ttsRequestId.current += 1;
    ttsController.current?.abort();
    ttsController.current = null;
    if (activeAudio.current) {
      activeAudio.current.pause();
      activeAudio.current.onended = null;
      activeAudio.current.onerror = null;
      activeAudio.current = null;
    }
    if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
    activeAudioUrl.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    const socket = realtimeSocket.current;
    if (socket?.readyState === WebSocket.OPEN && realtimeResponseId.current) {
      socket.send(JSON.stringify({ type: "response.cancel", response_id: realtimeResponseId.current }));
    }
    realtimeResponseId.current = "";
    realtimeSpeaking.current = false;
    detachMouth();
    setRealtimeState("listening");
    setRealtimeStatus("我在听");
  }

  function playRealtimePcm(chunk: ArrayBuffer, sampleRate: number) {
    if (!chunk.byteLength || !sampleRate) return;
    const context = realtimePlaybackContext.current ?? new AudioContext();
    realtimePlaybackContext.current = context;
    void context.resume().catch(() => undefined);
    const samples = new Int16Array(chunk);
    // 实时语音没有可预解码的整段音频，直接按分片能量驱动口型
    if (!pcmMouth.current) {
      pcmMouth.current = createPcmMouth((value) => {
        characterMouthRef.current = value;
        publishCharacterState({ mouthOpen: value });
      });
    }
    pcmMouth.current.pulse(pcmEnergy(samples));
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.012, realtimePlaybackCursor.current);
    source.start(startAt);
    realtimePlaybackCursor.current = startAt + buffer.duration;
    realtimePlaybackSources.current.add(source);
    realtimeSpeaking.current = true;
    setRealtimeState("speaking");
    setRealtimeStatus("正在说");
    source.onended = () => {
      realtimePlaybackSources.current.delete(source);
      if (realtimePlaybackSources.current.size === 0) {
        realtimeSpeaking.current = false;
        if (realtimeShouldStayOpen.current) {
          setRealtimeState("listening");
          setRealtimeStatus("正在听");
        }
      }
    };
  }

  function handleRealtimeEvent(payload: SsePayload) {
    const type = payload.type;
    if (type === "session.ready") {
      setRealtimeState("listening");
      setRealtimeStatus("正在听");
      return;
    }
    if (type === "transcription.started") {
      setRealtimeState("thinking");
      setRealtimeStatus("正在识别");
      return;
    }
    if (type === "transcript.final" && typeof payload.text === "string") {
      setRealtimeTranscript(payload.text);
      setRealtimeState("thinking");
      setRealtimeStatus("正在生成回复");
      return;
    }
    if (type === "response.started") {
      realtimeResponseId.current = typeof payload.response_id === "string" ? payload.response_id : "";
      realtimeSentenceBuffer.current = "";
      realtimeFullAnswer.current = "";
      realtimeFirstSegmentPending.current = true;
      setRealtimeAnswer("");
      setCharacterBubble("");
      publishCharacterState({ bubble: "" });
      setRealtimeState("thinking");
      return;
    }
    if (type === "speech.format") {
      const sampleRate = Number(payload.sample_rate);
      if (Number.isFinite(sampleRate) && sampleRate > 0) realtimePlaybackSampleRate.current = sampleRate;
      return;
    }
    if (type === "speech.style") {
      const emotionVector = Array.isArray(payload.emotion_vector)
        ? payload.emotion_vector.map(Number).filter(Number.isFinite)
        : [];
      latestSpeechStyle.current = {
        name: typeof payload.name === "string" ? payload.name : "",
        instruct: typeof payload.instruct === "string" ? payload.instruct : "",
        speed: Number(payload.speed) || 1,
        emotion_vector: emotionVector.length === 8 ? emotionVector : [],
      };
      return;
    }
    if (type === "speech.error" && typeof payload.message === "string") {
      setRealtimeStatus(payload.message);
      return;
    }
    if (type === "response.text.delta" && typeof payload.text === "string") {
      realtimeFullAnswer.current += payload.text;
      setRealtimeAnswer((current) => current + payload.text);
      const bubble = truncateBubble(realtimeFullAnswer.current);
      setCharacterBubble(bubble);
      publishCharacterState({ bubble, speaking: true, gesture: "speaking" });
      return;
    }
    if (type === "response.text.completed" && typeof payload.text === "string") {
      realtimeFullAnswer.current = payload.text;
      setRealtimeAnswer(payload.text);
      void refreshSessions();
      void refreshRelationshipState();
      return;
    }
    if (type === "response.completed") {
      void refreshSessions();
      return;
    }
    if (type === "response.cancelled") {
      realtimeResponseId.current = "";
      ttsController.current?.abort();
      ttsController.current = null;
      setRealtimeState("listening");
      setRealtimeStatus("你打断了我，我听着");
      return;
    }
    if (type === "session.ended") {
      setRealtimeState("idle");
      return;
    }
    if (type === "error" && typeof payload.message === "string") {
      setRealtimeState("error");
      setRealtimeStatus(payload.message);
      window.setTimeout(() => {
        if (realtimeShouldStayOpen.current && realtimeSocket.current?.readyState === WebSocket.OPEN) {
          setRealtimeState("listening");
          setRealtimeStatus("可以重新开始说话");
        }
      }, 1800);
    }
  }

  async function startRealtimeListening() {
    const socket = realtimeSocket.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || realtimeCaptureProcessor.current) return;
    realtimeListeningLoop.current = true;
    interruptRealtimeAnswer();
    setRealtimeTranscript("");
    setRealtimeAnswer("");
    setRealtimeStatus("正在听");
    setRealtimeState("listening");
    setRealtimeRecording(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      realtimeStream.current = stream;
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      const captureSampleRate = audioContext.sampleRate || 48_000;
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(2048, 1, 1);
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 0;
      source.connect(analyser);
      source.connect(processor);
      processor.connect(silentSink);
      silentSink.connect(audioContext.destination);
      realtimeAudioContext.current = audioContext;
      realtimeAnalyser.current = analyser;
      realtimeCaptureContext.current = audioContext;
      realtimeCaptureSource.current = source;
      realtimeCaptureProcessor.current = processor;
      realtimeCaptureSink.current = silentSink;
      realtimeCaptureSampleRate.current = captureSampleRate;
      const samples = new Uint8Array(analyser.frequencyBinCount);
      const threshold = 0.06;
      const speechStartMs = 180;
      const silenceEndMs = 450;
      const maxTurnMs = 20_000;
      processor.onaudioprocess = (event) => {
        if (!realtimeListeningLoop.current || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const targetLength = Math.max(1, Math.round(input.length * 16_000 / captureSampleRate));
        const pcm = new Int16Array(targetLength);
        for (let index = 0; index < targetLength; index += 1) {
          const sourcePosition = index * captureSampleRate / 16_000;
          const leftIndex = Math.floor(sourcePosition);
          const rightIndex = Math.min(input.length - 1, leftIndex + 1);
          const fraction = sourcePosition - leftIndex;
          const sample = input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction;
          pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        socket.send(pcm.buffer);
      };
      const tick = () => {
        if (!realtimeListeningLoop.current || realtimeCaptureProcessor.current !== processor) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        }
        const level = Math.sqrt(energy / samples.length);
        const now = Date.now();
        if (level > threshold) {
          if (!realtimeTurnOpen.current) {
            realtimeTurnOpen.current = true;
            socket.send(JSON.stringify({ type: "turn.start" }));
          }
          if (!realtimeVoiceActive.current) {
            realtimeVoiceActive.current = true;
            realtimeVoiceDetectedAt.current = now;
          }
          realtimeVoiceSilenceSince.current = 0;
          if (realtimeSpeaking.current) interruptRealtimeAnswer();
        } else if (realtimeVoiceActive.current) {
          if (!realtimeVoiceSilenceSince.current) realtimeVoiceSilenceSince.current = now;
          const voicedLongEnough = now - realtimeVoiceDetectedAt.current >= speechStartMs;
          if (voicedLongEnough && now - realtimeVoiceSilenceSince.current >= silenceEndMs) {
            realtimeVoiceActive.current = false;
            realtimeVoiceSilenceSince.current = 0;
            realtimeTurnOpen.current = false;
            socket.send(JSON.stringify({ type: "turn.end" }));
          }
        }
        if (realtimeVoiceActive.current && now - realtimeVoiceDetectedAt.current >= maxTurnMs) {
          realtimeVoiceActive.current = false;
          realtimeVoiceSilenceSince.current = 0;
          realtimeTurnOpen.current = false;
          socket.send(JSON.stringify({ type: "turn.end" }));
        }
        realtimeVadFrame.current = requestAnimationFrame(tick);
      };
      realtimeVadFrame.current = requestAnimationFrame(tick);
    } catch (error) {
      cleanupRealtimeAudio();
      setRealtimeState("error");
      setRealtimeStatus(error instanceof DOMException && error.name === "NotAllowedError" ? "你拒绝了麦克风权限。" : "无法启动实时录音。");
    }
  }

  async function openRealtime() {
    if (realtimeOpen) return;
    realtimeShouldStayOpen.current = true;
    let session = active;
    if (!active) {
      const created = await newSession();
      if (!created) return;
      session = created;
    }
    if (!session) return;
    setRealtimeOpen(true);
    setRealtimeState("connecting");
    setRealtimeStatus("正在连接");
    setRealtimeTranscript("");
    setRealtimeAnswer("");
    const wsBase = API_ORIGIN.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsBase}/api/v1/realtime/${session.id}`);
    realtimeSocket.current = socket;
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playRealtimePcm(event.data, realtimePlaybackSampleRate.current);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => playRealtimePcm(buffer, realtimePlaybackSampleRate.current));
        return;
      }
      try {
        handleRealtimeEvent(JSON.parse(event.data) as SsePayload);
      } catch {
        setRealtimeStatus("收到无法识别的实时消息。");
      }
    };
    socket.onerror = () => {
      setRealtimeState("error");
      setRealtimeStatus("实时连接失败，文字聊天仍可使用。");
    };
    socket.onclose = () => {
      if (realtimeShouldStayOpen.current) {
        cleanupRealtimeAudio();
        setRealtimeState("idle");
        setRealtimeStatus("实时连接已断开，文字聊天仍可使用。");
      }
    };
    socket.onopen = () => { void startRealtimeListening(); };
  }

  function closeRealtime() {
    stopAudio();
    cleanupRealtimeAudio();
    closeRealtimeSocket();
    setRealtimeOpen(false);
    setRealtimeState("idle");
    setRealtimeStatus("");
    setRealtimeTranscript("");
    setRealtimeAnswer("");
    void refreshSessions();
    void refreshRelationshipState();
  }

  async function transcribeRecording(blob: Blob, durationMs: number) {
    setTranscribing(true);
    setSpeechError("");
    const form = new FormData();
    form.append("file", blob, "recording.webm");
    form.append("language", "zh-CN");
    form.append("duration_ms", String(durationMs));
    try {
      const response = await fetch(`${API}/speech/transcribe`, { method: "POST", body: form });
      if (!response.ok) {
        let message = "语音识别失败，请重试。";
        try {
          const payload = await response.json() as { detail?: string };
          if (typeof payload.detail === "string") message = payload.detail;
        } catch { /* Keep a stable fallback for non-JSON errors. */ }
        throw new Error(message);
      }
      const result = await response.json() as { text?: string };
      if (!result.text?.trim()) throw new Error("没有识别到文字，请重新录音。" );
      setDraft(result.text.trim());
      focusInput(inputRef.current);
    } catch (error) {
      setSpeechError(error instanceof Error ? error.message : "语音识别失败，请重试。");
    } finally {
      setTranscribing(false);
    }
  }

  function stopAudio() {
    ttsRequestId.current += 1;
    speechQueueGeneration.current += 1;
    speechSynthesisQueue.current = [];
    speechPlaybackQueue.current = [];
    queuedPlaybackDone.current?.();
    queuedPlaybackDone.current = null;
    ttsController.current?.abort();
    ttsController.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    activeAudio.current?.pause();
    if (activeAudio.current) {
      activeAudio.current.currentTime = 0;
      activeAudio.current.onended = null;
      activeAudio.current.onerror = null;
    }
    activeAudio.current = null;
    if (activeAudioUrl.current) URL.revokeObjectURL(activeAudioUrl.current);
    activeAudioUrl.current = null;
    setPlayingAudioId(null);
    setAudioPaused(false);
    setAudioMode("audio");
    setTtsBusyId(null);
    detachMouth();
  }

  async function synthesizeQueuedSpeech(item: { message: UiMessage; text: string; generation: number }): Promise<void> {
    if (item.generation !== speechQueueGeneration.current || !item.text.trim()) return;
    const requestId = ttsRequestId.current;
    const controller = new AbortController();
    ttsController.current = controller;
    setTtsBusyId(item.message.id);
    try {
      const response = await fetch(`${API}/speech/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: item.text,
          speed: latestSpeechStyle.current?.speed || 1.0,
          emotion: (latestSpeechStyle.current?.instruct || relationshipDraft?.mood || "").slice(0, 500),
          emotion_vector: latestSpeechStyle.current?.emotion_vector.length === 8
            ? latestSpeechStyle.current.emotion_vector
            : undefined,
          // The API owns the chat tier; omit this override so changing
          // TTS_CHAT_NUM_STEP does not require rebuilding the frontend.
        }),
        signal: controller.signal,
      });
      if (requestId !== ttsRequestId.current || item.generation !== speechQueueGeneration.current) return;
      if (!response.ok) throw new Error("语音合成失败，文字回复仍可继续使用。");
      const blob = await response.blob();
      if (!blob.size) throw new Error("语音合成没有返回音频。");
      const providerMode = response.headers.get("X-Speech-Mode") === "browser-fallback" ? "browser-fallback" : "audio";
      if (providerMode === "browser-fallback") {
        speechPlaybackQueue.current.push({ message: item.message, text: item.text, browserFallback: true, generation: item.generation });
        void processSpeechPlayback();
        return;
      }
      speechPlaybackQueue.current.push({ message: item.message, text: item.text, blob, generation: item.generation });
      void processSpeechPlayback();
    } finally {
      if (ttsController.current === controller) ttsController.current = null;
    }
  }

  async function processSpeechSynthesis(): Promise<void> {
    if (speechSynthesisRunning.current) return;
    speechSynthesisRunning.current = true;
    try {
      while (speechSynthesisQueue.current.length > 0) {
        const item = speechSynthesisQueue.current.shift();
        if (!item || item.generation !== speechQueueGeneration.current) continue;
        try {
          await synthesizeQueuedSpeech(item);
        } catch (error) {
          if (item.generation !== speechQueueGeneration.current || (error instanceof DOMException && error.name === "AbortError")) continue;
          setTtsError({ id: item.message.id, message: error instanceof Error ? error.message : "语音合成失败，文字回复仍可继续使用。" });
          speechSynthesisQueue.current = [];
        }
      }
    } finally {
      speechSynthesisRunning.current = false;
    }
  }

  async function processSpeechPlayback(): Promise<void> {
    if (speechPlaybackRunning.current) return;
    speechPlaybackRunning.current = true;
    try {
      while (speechPlaybackQueue.current.length > 0) {
        const item = speechPlaybackQueue.current.shift();
        if (!item || item.generation !== speechQueueGeneration.current) continue;
        try {
          await playQueuedSpeech(item);
        } catch (error) {
          if (item.generation !== speechQueueGeneration.current || (error instanceof DOMException && error.name === "AbortError")) continue;
          setTtsError({ id: item.message.id, message: error instanceof Error ? error.message : "音频播放失败，文字回复仍可继续使用。" });
          speechPlaybackQueue.current = [];
        }
      }
    } finally {
      speechPlaybackRunning.current = false;
    }
  }

  async function playQueuedSpeech(item: { message: UiMessage; text: string; blob?: Blob; browserFallback?: boolean; generation: number }): Promise<void> {
    if (item.generation !== speechQueueGeneration.current) return;
    if (item.browserFallback) {
      if (!("speechSynthesis" in window)) throw new Error("当前浏览器没有可用的语音引擎，请配置云端 TTS 后重试。");
      const utterance = new SpeechSynthesisUtterance(item.text);
      utterance.lang = "zh-CN";
      utterance.rate = 1;
      setPlayingAudioId(item.message.id);
      setAudioMode("browser-fallback");
      setAudioPaused(false);
      const bubble = truncateBubble(item.text);
      setCharacterBubble(bubble);
      publishCharacterState({ bubble, speaking: true, gesture: "speaking" });
      try {
        await new Promise<void>((resolve, reject) => {
          utterance.onend = () => resolve();
          utterance.onerror = () => reject(new Error("浏览器语音播放失败，文字回复仍可继续使用。"));
          queuedPlaybackDone.current = resolve;
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        });
      } finally {
        queuedPlaybackDone.current = null;
        if (item.generation === speechQueueGeneration.current) {
          setPlayingAudioId(null);
          setAudioPaused(false);
          setTtsBusyId(null);
          detachMouth();
        }
      }
      return;
    }
    if (!item.blob?.size) throw new Error("语音合成没有返回音频。");
    const url = URL.createObjectURL(item.blob);
    const audio = new Audio(url);
    activeAudio.current = audio;
    activeAudioUrl.current = url;
    setPlayingAudioId(item.message.id);
    setAudioMode("audio");
    setAudioPaused(false);
    attachElementMouth(audio, item.blob, item.text);
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("音频播放失败，文字回复仍可继续使用。"));
        queuedPlaybackDone.current = resolve;
        audio.play().then(() => setAutoSpeakBlocked(false)).catch((error) => {
          if (item.generation === speechQueueGeneration.current && error instanceof DOMException && error.name === "NotAllowedError") {
            setAutoSpeakBlocked(true);
            reject(new Error("浏览器拦截了自动播放，请点击播放语音。"));
          } else {
            reject(error);
          }
        });
      });
    } finally {
      queuedPlaybackDone.current = null;
      if (activeAudio.current === audio) {
        activeAudio.current.pause();
        activeAudio.current.onended = null;
        activeAudio.current.onerror = null;
        activeAudio.current = null;
      }
      if (activeAudioUrl.current === url) {
        URL.revokeObjectURL(url);
        activeAudioUrl.current = null;
      }
      if (item.generation === speechQueueGeneration.current) {
        setPlayingAudioId(null);
        setAudioPaused(false);
        setTtsBusyId(null);
        detachMouth();
      }
    }
  }

  function enqueueSpeech(message: UiMessage, text: string, generation: number): void {
    const cleaned = text.trim();
    if (!autoSpeak || !cleaned || generation !== speechQueueGeneration.current) return;
    speechSynthesisQueue.current.push({ message, text: cleaned, generation });
    void processSpeechSynthesis();
  }

  async function playAssistantAudio(message: UiMessage, automatic = false) {
    if (message.role !== "assistant" || message.pending || message.error || !message.content.trim()) return;
    setTtsError(null);
    setAudioNotice("");
    if (playingAudioId === message.id && (activeAudio.current || audioMode === "browser-fallback")) {
      if (audioMode === "browser-fallback") {
        if (audioPaused) {
          window.speechSynthesis.resume();
          setAudioPaused(false);
        } else {
          window.speechSynthesis.pause();
          setAudioPaused(true);
        }
      } else if (activeAudio.current?.paused) {
        await activeAudio.current.play().then(() => setAudioPaused(false)).catch(() => setTtsError({ id: message.id, message: "浏览器阻止了播放，请再次点击播放。" }));
      } else if (activeAudio.current) {
        activeAudio.current.pause();
        setAudioPaused(true);
      }
      return;
    }
    stopAudio();
    const requestId = ttsRequestId.current;
    const controller = new AbortController();
    ttsController.current = controller;
    setTtsBusyId(message.id);
    try {
      const response = await fetch(`${API}/speech/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message.content,
          speed: latestSpeechStyle.current?.speed || 1.0,
          emotion: (latestSpeechStyle.current?.instruct || relationshipDraft?.mood || "").slice(0, 500),
          emotion_vector: latestSpeechStyle.current?.emotion_vector.length === 8
            ? latestSpeechStyle.current.emotion_vector
            : undefined,
          num_step: 12,
        }),
        signal: controller.signal,
      });
      if (requestId !== ttsRequestId.current) return;
      if (!response.ok) {
        let errorMessage = "语音合成失败，文字回复仍可继续使用。";
        try {
          const payload = await response.json() as { detail?: string | Array<{ msg?: string }> };
          if (typeof payload.detail === "string") errorMessage = payload.detail;
          if (Array.isArray(payload.detail)) {
            const details = payload.detail
              .map((item) => typeof item?.msg === "string" ? item.msg : "")
              .filter(Boolean)
              .join("；");
            if (details) errorMessage = `语音请求参数有误：${details}`;
          }
        } catch { /* Keep the stable fallback for non-JSON errors. */ }
        throw new Error(errorMessage);
      }
      const blob = await response.blob();
      if (requestId !== ttsRequestId.current) return;
      if (!blob.size) throw new Error("语音合成没有返回音频。");
      const providerMode = response.headers.get("X-Speech-Mode") === "browser-fallback" ? "browser-fallback" : "audio";
      if (providerMode === "browser-fallback" && "speechSynthesis" in window) {
        if (!window.speechSynthesis.getVoices().length) setAudioNotice("正在使用浏览器语音引擎；如果仍无声音，请安装中文语音包，或配置云端 TTS。");
        const utterance = new SpeechSynthesisUtterance(message.content);
        utterance.lang = "zh-CN";
        utterance.rate = 1;
        utterance.onend = () => stopAudio();
        utterance.onerror = () => setTtsError({ id: message.id, message: "浏览器语音播放失败，文字回复仍可继续使用。" });
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        setPlayingAudioId(message.id);
        setAudioMode("browser-fallback");
        setAudioPaused(false);
        const bubble = truncateBubble(message.content);
        setCharacterBubble(bubble);
        publishCharacterState({ bubble, speaking: true, gesture: "speaking" });
        return;
      }
      if (providerMode === "browser-fallback") {
        throw new Error("当前浏览器没有可用的语音引擎，请配置云端 TTS 后重试。");
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      activeAudio.current = audio;
      activeAudioUrl.current = url;
      setPlayingAudioId(message.id);
      setAudioPaused(false);
      attachElementMouth(audio, blob, message.content);
      audio.onended = () => stopAudio();
      audio.onerror = () => {
        stopAudio();
        setTtsError({ id: message.id, message: "音频播放失败，文字回复仍可继续使用。" });
      };
      try {
        await audio.play();
        setAutoSpeakBlocked(false);
      } catch (error) {
        if (automatic && error instanceof DOMException && error.name === "NotAllowedError") {
          stopAudio();
          setAutoSpeakBlocked(true);
          setTtsError({ id: message.id, message: "浏览器拦截了自动播放，请点击播放语音。" });
          return;
        }
        throw error;
      }
    } catch (error) {
      if (requestId !== ttsRequestId.current || (error instanceof DOMException && error.name === "AbortError")) return;
      stopAudio();
      setTtsError({ id: message.id, message: error instanceof Error ? error.message : "语音合成失败，文字回复仍可继续使用。" });
    } finally {
      if (requestId === ttsRequestId.current) {
        ttsController.current = null;
        setTtsBusyId(null);
      }
    }
  }

  function finishRecording(cancelled = false) {
    const recorder = mediaRecorder.current;
    if (!recorder) return;
    if (cancelled) {
      recordingChunks.current = [];
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      if (recorder.state !== "inactive") recorder.onstop = () => undefined;
      if (recorder.state !== "inactive") recorder.stop();
      setRecording(false);
      setSpeechError("");
      return;
    }
    if (recorder.state !== "inactive") recorder.stop();
  }

  async function startRecording() {
    if (recording || transcribing || busy) return;
    setSpeechError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setSpeechError("当前浏览器不支持录音，请继续使用文字输入。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaStream.current = stream;
      mediaRecorder.current = recorder;
      recordingChunks.current = [];
      recordingStartedAt.current = Date.now();
      recorder.ondataavailable = (event) => { if (event.data.size > 0) recordingChunks.current.push(event.data); };
      recorder.onstop = () => {
        const chunks = recordingChunks.current;
        const durationMs = Math.min(60_000, Date.now() - (recordingStartedAt.current || Date.now()));
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        recordingChunks.current = [];
        mediaStream.current?.getTracks().forEach((track) => track.stop());
        mediaStream.current = null;
        mediaRecorder.current = null;
        setRecording(false);
        if (blob.size === 0) {
          setSpeechError("录音内容为空，请重新录音。");
          return;
        }
        setAudioPreview(blob);
        void transcribeRecording(blob, durationMs);
      };
      recorder.start(250);
      setRecording(true);
      window.setTimeout(() => {
        if (mediaRecorder.current === recorder && recorder.state === "recording") finishRecording();
      }, 60_000);
    } catch (error) {
      mediaStream.current?.getTracks().forEach((track) => track.stop());
      mediaStream.current = null;
      setSpeechError(error instanceof DOMException && error.name === "NotAllowedError" ? "你拒绝了麦克风权限，文字聊天仍可继续。" : "无法启动录音，请检查麦克风权限。");
    }
  }

  async function stopGeneration() {
    if (!active || !busy) return;
    stoppingGeneration.current = true;
    setStatus("正在停止");
    stopAudio();
    void fetch(`${API}/sessions/${active.id}/stop`, { method: "POST" }).catch(() => undefined);
    generationController.current?.abort();
    const assistantId = generationAssistantId.current;
    if (assistantId) {
      setMessages((rows) => rows.map((row) => row.id === assistantId ? {
        ...row,
        content: row.content || "已停止生成。",
        pending: false,
        error: row.content ? undefined : "已停止生成。",
      } : row));
    }
    setBusy(false);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const attachmentIds = pendingAttachments.filter((item) => !item.uploading && !item.error).map((item) => item.id);
    await sendMessageText(draft.trim(), [], false, attachmentIds);
  }

  async function sendMessageText(text: string, replaceIds: string[] = [], regenerate = false, attachmentIds: string[] = []) {
    if ((!text.trim() && attachmentIds.length === 0 && !regenerate) || busy) return;
    stopAudio();
    let current = active;
    if (!current) {
      if (!adultStatus.confirmed) {
        setAdultOpen(true);
        return;
      }
      const response = await fetch(`${API}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "girlfriend" }) });
      if (!response.ok) return;
      current = await response.json();
      setActive(current);
      setSessions((rows) => [current!, ...rows]);
    }
    if (!current) return;
    const sentAttachments = attachmentIds.length
      ? pendingAttachments.filter((item) => attachmentIds.includes(item.id))
      : (replaceIds.length ? messages.find((message) => message.id === replaceIds[0])?.attachments || [] : []);
    const user: UiMessage = { id: createClientId(), role: "user", content: text, created_at: new Date().toISOString(), attachments: sentAttachments };
    const assistant: UiMessage = { id: createClientId(), role: "assistant", content: "", created_at: new Date().toISOString(), pending: true };
    setMessages((rows) => [...rows.filter((row) => !replaceIds.includes(row.id)), user, assistant]);
    setDraft("");
    setPendingAttachments([]);
    setAttachmentError("");
    setBusy(true);
    stoppingGeneration.current = false;
    generationController.current = new AbortController();
    generationAssistantId.current = assistant.id;
    try {
      const response = await fetch(`${API}/sessions/${current.id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, regenerate, attachment_ids: attachmentIds }), signal: generationController.current.signal,
      });
      if (!response.ok) throw new Error("暂时无法发送，请稍后重试。");
      let answer = "";
      let failure = "";
      let speechBuffer = "";
      const speechGeneration = speechQueueGeneration.current;
      const handleEvent = (event: string, payload: SsePayload) => {
        if (event === "token" && typeof payload.text === "string") {
          answer += payload.text;
          speechBuffer += payload.text;
          const segments = takeSpeechSegments(speechBuffer);
          speechBuffer = segments.remainder;
          for (const segment of segments.segments) {
            enqueueSpeech(assistant, segment, speechGeneration);
          }
        }
        if (event === "error" && typeof payload.message === "string") failure = payload.message;
        if (event === "speech_style") {
          const emotionVector = Array.isArray(payload.emotion_vector)
            ? payload.emotion_vector.map(Number).filter(Number.isFinite)
            : [];
          latestSpeechStyle.current = {
            name: typeof payload.name === "string" ? payload.name : "",
            instruct: typeof payload.instruct === "string" ? payload.instruct : "",
            speed: Number(payload.speed) || 1,
            emotion_vector: emotionVector.length === 8 ? emotionVector : [],
          };
        }
        if (event === "memory_candidate" && typeof payload.kind === "string" && typeof payload.content === "string" && typeof payload.source === "string") {
          setMemoryCandidate({ kind: payload.kind, content: payload.content, source: payload.source });
        }
        if (event === "judgement_started") setStatus("正在判断关系状态");
        if (event === "judgement_completed") setStatus("关系判断已完成");
        if (event === "skill_started") setStatus("正在调用核心 Skill");
        if (event === "skill_completed") setStatus(`核心 Skill ${typeof payload.version === "string" ? payload.version : "已完成"}`);
        if (event === "token") setStatus("正在生成回复");
        if (event === "token" || event === "error") {
          setMessages((rows) => rows.map((row) => row.id === assistant.id ? { ...row, content: answer || failure, error: failure || undefined } : row));
        }
      };
      await consumeSseResponse(response, handleEvent);
      if (!answer && !failure) failure = "生成意外结束，请重试。";
      if (failure) {
        stopAudio();
      }
      if (answer && !failure) {
        const finalSegment = takeSpeechSegments(speechBuffer, true);
        for (const segment of finalSegment.segments) {
          enqueueSpeech(assistant, segment, speechGeneration);
        }
      }
      setMessages((rows) => rows.map((row) => row.id === assistant.id ? { ...row, content: answer || failure, pending: false, error: failure || undefined } : row));
      await refreshSessions();
      await refreshRelationshipState();
    } catch (error) {
      const message = stoppingGeneration.current ? "已停止生成。" : (error instanceof Error ? error.message : "网络连接失败。");
      setMessages((rows) => rows.map((row) => row.id === assistant.id ? { ...row, content: message, pending: false, error: message } : row));
    } finally {
      setBusy(false);
      generationController.current = null;
      generationAssistantId.current = null;
      setStatus("已连接");
      focusInput(inputRef.current);
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="brand-row"><div className="brand-mark"><Heart size={17} fill="currentColor" /></div><span>{profile?.display_name || "陪伴智能体"}</span></div>
        <button className="new-chat" onClick={() => newSession()}><MessageSquarePlus size={17} />新建对话</button>
        <div className="sidebar-label">最近对话</div>
        <div className="session-list">
          {sessions.map((item) => <button key={item.id} className={`session-item ${active?.id === item.id ? "selected" : ""}`} onClick={() => openSession(item)}>
            <MessageSquarePlus size={15} /><span>{item.title}</span><span className="session-actions" onClick={(event) => removeSession(event, item)} title="删除对话"><Trash2 size={14} /></span>
          </button>)}
        </div>
        <div className="sidebar-bottom"><div className="connection"><span className={status === "服务未启动" ? "status-dot offline" : "status-dot"} />{status}</div><div className="sidebar-tools"><button className="settings-button" title="角色设置" onClick={() => void openProfile()}><Heart size={16} /></button><button className="settings-button" title="记忆设置" onClick={() => void openMemory()}><Settings2 size={17} /></button></div></div>
      </aside>
      {mobileNav && <button className="scrim" aria-label="关闭菜单" onClick={() => setMobileNav(false)} />}
      <main className="main-panel">
        <header className="topbar"><button className="mobile-menu icon-button" onClick={() => setMobileNav(true)} aria-label="打开菜单"><MessageSquarePlus size={18} /></button>
          {active ? <div className="mode-switch"><button className={active.mode === "girlfriend" ? "mode-active" : ""} onClick={() => newSession("girlfriend")}><Heart size={15} />AI 女友</button><button className={active.mode === "advisor" ? "mode-active" : ""} onClick={() => newSession("advisor")}><UserRound size={15} />关系顾问</button></div> : <div className="topbar-title">AI 陪伴</div>}
          {active?.mode === "girlfriend" && relationshipDraft && <button className="relationship-strip" type="button" onClick={() => void openProfile()} title="查看当前关系状态"><span className="relationship-mood">{relationshipDraft.mood}</span><span>信任 {relationshipDraft.trust}</span><span>亲密 {relationshipDraft.affection}</span><span className={relationshipDraft.irritation >= 18 ? "relationship-irritation warm" : "relationship-irritation"}>烦躁 {relationshipDraft.irritation}</span></button>}
          <button className="realtime-entry" type="button" onClick={() => void openRealtime()} disabled={realtimeOpen || busy} title="实时语音对话"><Phone size={15} />实时语音</button>
          <button className={`auto-speak-toggle ${autoSpeak ? "on" : ""} ${autoSpeakBlocked ? "blocked" : ""}`} type="button" onClick={() => { if (autoSpeakBlocked) { setAutoSpeakBlocked(false); setAutoSpeak(true); return; } setAutoSpeak((current) => !current); }} title={autoSpeakBlocked ? "浏览器拦截了自动播放，点击恢复设置" : autoSpeak ? "关闭自动语音" : "开启自动语音"}><Volume2 size={14} />{autoSpeakBlocked ? "点击恢复语音" : autoSpeak ? "自动语音" : "语音关闭"}</button>
          <button className={`auto-speak-toggle ${characterDisabled ? "" : "on"}`} type="button" onClick={() => setCharacterDisabled((current) => !current)} title={characterDisabled ? "显示 3D 角色" : "隐藏 3D 角色，使用轻量模式"}>{characterDisabled ? "轻量模式" : "角色显示"}</button>
          <div className="privacy-label"><ShieldCheck size={15} />本地开发</div>
        </header>

        <div className="main-body">
          {active?.mode !== "advisor" && !characterDisabled && <section className="character-pane">
            <CharacterStage
              modelUrl={CHARACTER_MODEL_URL}
              mouthSource={characterMouthRef}
              visual={{
                emotion: characterEmotion,
                intensity: inferIntensity(relationshipDraft, characterEmotion),
                gesture: characterGesture,
                mouthOpen: 0,
                lookAt: null,
                bubble: characterBubble,
              }}
            />
            <div className="character-pane-caption">
              <strong>{profile?.display_name || "小满"}</strong>
              <span>{characterGesture === "thinking" ? "思考中" : characterGesture === "speaking" ? "说话中" : characterGesture === "listening" ? "倾听中" : "陪着你"}</span>
            </div>
          </section>}
          <div className="chat-pane">
        {messages.length === 0 ? <section className="welcome">
          <div className="welcome-icon"><Sparkles size={22} /></div>
          <p className="eyebrow">你的 AI 陪伴空间</p>
          <h1>今天想聊些什么？</h1>
          <p className="welcome-copy">可以从今天的心情、一件小事，或者脑海里挥之不去的问题开始。</p>
          <div className="starter-prompts"><button onClick={() => setDraft("今天发生了一件让我有点在意的事")}>今天发生了一件小事</button><button onClick={() => setDraft("我最近的心情有些复杂，想和你聊聊")}>聊聊最近的心情</button><button onClick={() => setDraft("我有个问题，想听听你的想法")}>听听你的想法</button></div>
        </section> : <section className="conversation" aria-live="polite">
          {messages.map((message, messageIndex) => <article key={message.id} className={`message-row ${message.role}`}>
            {message.role === "assistant" && <div className="avatar assistant-avatar"><Heart size={15} fill="currentColor" /></div>}
            <div className={`message-content ${message.error ? "message-error" : ""}`}>
              {!!message.attachments?.length && <div className="message-attachments">{message.attachments.map((attachment) => <a key={attachment.id} className="message-attachment" href={resolveAttachmentUrl(attachment.url)} target="_blank" rel="noreferrer" title={attachment.original_name || "查看图片"}><img src={resolveAttachmentUrl(attachment.url)} alt={attachment.original_name || "用户上传的图片"} />{attachment.analysis_status === "failed" && <span>图片理解失败，仍已发送</span>}</a>)}</div>}
              {message.pending && !message.content && <div className="thinking"><span /><span /><span /></div>}
              {message.content && <div className="message-text">{message.content}</div>}
              {message.error && <div className="error-caption"><span>尚未生成 AI 回复</span><button type="button" onClick={() => retryMessage(messageIndex)}>重试</button></div>}
              {message.role === "assistant" && !message.pending && !message.error && <div className="message-actions"><button type="button" onClick={() => void playAssistantAudio(message)} disabled={ttsBusyId === message.id}><span className="message-action-icon">{ttsBusyId === message.id ? <Volume2 size={12} /> : playingAudioId === message.id && !audioPaused ? <Pause size={12} /> : <Play size={12} />}</span>{ttsBusyId === message.id ? "准备语音" : playingAudioId === message.id && !audioPaused ? "暂停" : audioPaused ? "继续播放" : "播放语音"}</button>{playingAudioId === message.id && <button type="button" onClick={stopAudio} aria-label="停止播放语音" title="停止播放语音"><Square size={12} />停止</button>}{messageIndex === messages.length - 1 && <button type="button" onClick={() => regenerateMessage(messageIndex)} disabled={busy}><RefreshCw size={12} />重新生成</button>}{ttsError?.id === message.id && <span className="tts-error" role="status">{ttsError.message}</span>}{audioNotice && playingAudioId === message.id && <span className="tts-error" role="status">{audioNotice}</span>}</div>}
            </div>
            {message.role === "user" && <div className="avatar user-avatar"><UserRound size={15} /></div>}
          </article>)}
          <div ref={endRef} />
        </section>}
        <div className="composer-wrap">{memoryCandidate && <div className="candidate-card"><div className="candidate-copy"><Sparkles size={15} /><div><strong>要记住这件事吗？</strong><span>{memoryCandidate.content}</span></div></div><div className="candidate-actions"><button className="candidate-dismiss" onClick={() => setMemoryCandidate(null)}>忽略</button><button className="candidate-confirm" onClick={() => void confirmMemoryCandidate()} disabled={candidateBusy}>记住</button></div></div>}{speechError && <div className="speech-notice" role="status"><span>{speechError}</span><button type="button" aria-label="关闭语音提示" title="关闭" onClick={() => setSpeechError("")}><X size={14} /></button></div>}{attachmentError && <div className="speech-notice" role="status"><span>{attachmentError}</span><button type="button" aria-label="关闭图片提示" title="关闭" onClick={() => setAttachmentError("")}><X size={14} /></button></div>}{recordingUrl && <div className="recording-preview"><span>{transcribing ? "正在识别录音..." : "录音已转写，可编辑后发送"}</span><audio controls src={recordingUrl} /></div>}<form className="composer" onSubmit={sendMessage}>
          <input ref={imageInputRef} className="visually-hidden" type="file" accept={ALLOWED_IMAGE_TYPES.join(",")} multiple onChange={(event) => { if (event.target.files?.length) void uploadImageFiles(event.target.files); }} />
          {pendingAttachments.length > 0 && <div className="attachment-previews">{pendingAttachments.map((attachment) => <div className={`attachment-preview ${attachment.error ? "has-error" : ""}`} key={attachment.id}><img src={resolveAttachmentUrl(attachment.url)} alt={attachment.original_name || "待发送图片"} /><div><strong>{attachment.uploading ? "正在上传" : attachment.error ? "上传失败" : "待发送"}</strong><span>{attachment.original_name}</span>{attachment.error && <small>{attachment.error}</small>}</div><button type="button" onClick={() => removePendingAttachment(attachment)} aria-label="移除图片" title="移除图片"><X size={13} /></button></div>)}</div>}
          <textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(event); } }} placeholder="写下你想说的话..." rows={1} maxLength={12000} />
          <div className="composer-footer"><span className="composer-note"><ShieldCheck size={13} />记忆由你控制</span><div className="composer-actions">{!busy && (recording ? <button type="button" className="recording-button" onClick={() => finishRecording()} aria-label="停止录音" title="停止录音"><Square size={15} /></button> : <button type="button" className="mic-button" onClick={() => void startRecording()} disabled={transcribing} aria-label="开始录音" title="开始录音"><Mic size={17} /></button>)}{!recording && <button type="button" className="image-button" onClick={() => void chooseImages()} disabled={busy || transcribing || attachmentBusy || pendingAttachments.length >= MAX_ATTACHMENTS} aria-label="添加图片" title="添加图片"><ImageIcon size={16} /></button>}{recording && <button type="button" className="cancel-recording" onClick={() => finishRecording(true)} aria-label="取消录音" title="取消录音"><X size={15} /></button>}{busy ? <button type="button" className="stop-generation" onClick={() => void stopGeneration()} aria-label="停止生成" title="停止生成"><StopCircle size={17} /></button> : <button type="submit" disabled={(!draft.trim() && !pendingAttachments.some((item) => !item.uploading && !item.error)) || recording || transcribing || attachmentBusy || pendingAttachments.some((item) => item.uploading)} aria-label="发送消息" title="发送"><Send size={17} /></button>}</div></div>
        </form><p className="disclaimer">AI 可能会有疏漏，重要决定请结合现实情况判断。</p></div>
          </div>
        </div>
      </main>
      {realtimeOpen && <div className="realtime-backdrop" role="presentation" onClick={closeRealtime}><section className="realtime-panel" role="dialog" aria-modal="true" aria-labelledby="realtime-title" onClick={(event) => event.stopPropagation()}>
        <div className="realtime-header"><div><p className="eyebrow">实时语音</p><h2 id="realtime-title">和{profile?.display_name || "她"}说说话</h2></div><button className="panel-close" onClick={closeRealtime} aria-label="结束实时语音">×</button></div>
      <div className={`realtime-orb ${realtimeState}`}><Phone size={28} /></div>
      <p className="realtime-status">{realtimeStatus || "准备中"}</p>
        <div className="realtime-captions">
          <div><span>你</span><p>{realtimeTranscript || (realtimeState === "speaking" ? "你说话时我会停下来听" : "直接说话，停顿后我会自动回复")}</p></div>
          <div><span>{profile?.display_name || "她"}</span><p>{realtimeAnswer || (realtimeState === "thinking" ? "正在想..." : "等待回复")}</p></div>
        </div>
        <div className="realtime-controls">
          <button type="button" className={`realtime-start ${realtimeRecording ? "running" : ""}`} onClick={() => void startRealtimeListening()} disabled={realtimeRecording || realtimeState === "connecting"}><Mic size={18} />{realtimeRecording ? "正在通话" : "开始通话"}</button>
          <button type="button" className="realtime-cancel" onClick={() => interruptRealtimeAnswer()}>打断</button>
          <button type="button" className="realtime-end" onClick={closeRealtime}><PhoneOff size={16} />结束</button>
        </div>
        <p className="realtime-note">你说完停顿约半秒，我会自动接话；我说话时你直接开口就能打断。</p>
      </section></div>}
      {profileOpen && profileDraft && relationshipDraft && <div className="profile-backdrop" role="presentation" onClick={() => setProfileOpen(false)}><section className="profile-panel" role="dialog" aria-modal="true" aria-labelledby="profile-title" onClick={(event) => event.stopPropagation()}>
        <div className="memory-panel-header"><div><p className="eyebrow">角色与关系</p><h2 id="profile-title">自定义她</h2></div><button className="panel-close" onClick={() => setProfileOpen(false)} aria-label="关闭">×</button></div>
        <p className="memory-intro">这里决定她是谁、在意什么，以及她会不会对不尊重保持距离。设置会影响之后的每轮对话。</p>
        <div className="relationship-editor">
          <div className="relationship-editor-title"><strong>关系状态</strong><span>可以设置她此刻的基础状态，聊天后仍会根据行为变化。</span></div>
          <label>当前情绪<input value={relationshipDraft.mood} onChange={(event) => updateRelationship("mood", event.target.value)} maxLength={40} placeholder="例如：平静、委屈、吃醋、疏离" /></label>
          <div className="relationship-ranges"><label>信任<span>{relationshipDraft.trust}</span><input type="range" min="0" max="100" value={relationshipDraft.trust} onChange={(event) => updateRelationship("trust", Number(event.target.value))} /></label><label>亲密<span>{relationshipDraft.affection}</span><input type="range" min="0" max="100" value={relationshipDraft.affection} onChange={(event) => updateRelationship("affection", Number(event.target.value))} /></label><label>烦躁<span>{relationshipDraft.irritation}</span><input type="range" min="0" max="100" value={relationshipDraft.irritation} onChange={(event) => updateRelationship("irritation", Number(event.target.value))} /></label></div>
          <div className="relationship-number-row"><label>冲突次数<input type="number" min="0" max="999" value={relationshipDraft.conflict_count} onChange={(event) => updateRelationship("conflict_count", Number(event.target.value))} /></label><label>最近触发原因<input value={relationshipDraft.last_trigger} onChange={(event) => updateRelationship("last_trigger", event.target.value)} maxLength={200} placeholder="例如：刚刚因为失约不开心" /></label></div>
        </div>
        <div className="profile-form">
          <label>名字<input value={profileDraft.display_name} onChange={(event) => updateProfile("display_name", event.target.value)} maxLength={40} /></label>
          <label>性格<textarea value={profileDraft.personality} onChange={(event) => updateProfile("personality", event.target.value)} rows={3} maxLength={1000} /></label>
          <label>背景<textarea value={profileDraft.background} onChange={(event) => updateProfile("background", event.target.value)} rows={3} maxLength={1500} /></label>
          <label>兴趣与日常<textarea value={profileDraft.interests} onChange={(event) => updateProfile("interests", event.target.value)} rows={2} maxLength={800} /></label>
          <label>底线<textarea value={profileDraft.boundaries} onChange={(event) => updateProfile("boundaries", event.target.value)} rows={2} maxLength={1000} /></label>
          <label>说话方式<textarea value={profileDraft.speech_style} onChange={(event) => updateProfile("speech_style", event.target.value)} rows={2} maxLength={800} /></label>
          <div className="autonomy-section"><div className="section-heading"><div><strong>她自己的生活</strong><span>这些内容只用来保持角色的连续性，不会让她无故打断当前话题。</span></div></div><label>当前心情<input value={profileDraft.inner_mood} onChange={(event) => updateProfile("inner_mood", event.target.value)} maxLength={80} placeholder="例如：有点困，但心情还不错" /></label><label>当前关注<textarea value={profileDraft.current_focus} onChange={(event) => updateProfile("current_focus", event.target.value)} rows={2} maxLength={1000} placeholder="例如：最近在琢磨一部电影的结尾" /></label><label>近期想做的事<textarea value={profileDraft.recent_plan} onChange={(event) => updateProfile("recent_plan", event.target.value)} rows={2} maxLength={1000} placeholder="例如：周末想整理房间、去散步" /></label><label>暂时不想聊的话题<textarea value={profileDraft.avoid_topics} onChange={(event) => updateProfile("avoid_topics", event.target.value)} rows={2} maxLength={1000} placeholder="例如：不想展开工作上的争执" /></label></div>
          <div className="range-row"><label>自主程度<span>{profileDraft.autonomy_level}/5</span><input type="range" min="1" max="5" value={profileDraft.autonomy_level} onChange={(event) => updateProfile("autonomy_level", Number(event.target.value))} /></label><label>生气敏感度<span>{profileDraft.anger_sensitivity}/5</span><input type="range" min="1" max="5" value={profileDraft.anger_sensitivity} onChange={(event) => updateProfile("anger_sensitivity", Number(event.target.value))} /></label></div>
          <div className="range-row"><label>主动表达<span>{profileDraft.initiative_level}/5</span><input type="range" min="1" max="5" value={profileDraft.initiative_level} onChange={(event) => updateProfile("initiative_level", Number(event.target.value))} /></label><label>主动表达冷却（分钟）<input type="number" min="5" max="1440" value={profileDraft.initiative_cooldown_minutes} onChange={(event) => updateProfile("initiative_cooldown_minutes", Number(event.target.value))} /></label></div>
          <label>冷静时间（分钟）<input type="number" min="5" max="240" value={profileDraft.silent_duration_minutes} onChange={(event) => updateProfile("silent_duration_minutes", Number(event.target.value))} /></label>
        </div>
        <div className="agent-memory-section"><div className="section-heading"><div><strong>她记得的事</strong><span>这是 AI 自己的记忆，不等同于关于你的长期记忆。</span></div></div><div className="agent-memory-add"><input value={agentMemoryDraft} onChange={(event) => setAgentMemoryDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addAgentMemory(); }} placeholder="添加她最近在意或记得的事" maxLength={300} /><button onClick={() => void addAgentMemory()} disabled={!agentMemoryDraft.trim() || profileBusy}>添加</button></div>{agentMemories.length === 0 ? <div className="small-empty">还没有额外记忆。</div> : <div className="agent-memory-list">{agentMemories.map((memory) => <div className="agent-memory-item" key={memory.id}><span>{memory.content}</span><button onClick={() => void deleteAgentMemory(memory)} aria-label="删除 AI 记忆" title="删除"><Trash2 size={14} /></button></div>)}</div>}</div>
        <div className="relationship-history-section"><div className="section-heading"><div><strong>关系经历</strong><span>冲突会留下记录，道歉或修复后会标记为已修复。</span></div></div>{relationshipEvents.length === 0 ? <div className="small-empty">还没有关系事件。</div> : <div className="relationship-event-list">{relationshipEvents.map((event) => <div className={`relationship-event ${event.resolved ? "resolved" : "unresolved"}`} key={event.id}><div className="relationship-event-top"><strong>{event.trigger}</strong><span>{event.resolved ? "已修复" : "未修复"}</span></div><p>{event.user_message}</p><small>情绪 {event.mood_before} → {event.mood_after} · 信任 {event.trust_delta >= 0 ? "+" : ""}{event.trust_delta} · 烦躁 {event.irritation_delta >= 0 ? "+" : ""}{event.irritation_delta}</small></div>)}</div>}</div>
        <div className="relationship-rules-section"><div className="section-heading"><div><strong>自定义关系规则</strong><span>输入逗号分隔的短语，命中优先级最高的启用规则。规则只在后台影响关系状态。</span></div></div><div className="relationship-rule-form"><input value={ruleDraft.name} onChange={(event) => setRuleDraft((current) => ({ ...current, name: event.target.value }))} placeholder="规则名称" maxLength={80} /><input value={ruleDraft.match_text} onChange={(event) => setRuleDraft((current) => ({ ...current, match_text: event.target.value }))} placeholder="触发短语，例如：放鸽子,失约" maxLength={200} /><input value={ruleDraft.trigger} onChange={(event) => setRuleDraft((current) => ({ ...current, trigger: event.target.value }))} placeholder="后台记录原因" maxLength={200} /><div className="rule-number-grid"><label>信任<input type="number" min="-30" max="30" value={ruleDraft.trust_delta} onChange={(event) => setRuleDraft((current) => ({ ...current, trust_delta: Number(event.target.value) }))} /></label><label>亲密<input type="number" min="-30" max="30" value={ruleDraft.affection_delta} onChange={(event) => setRuleDraft((current) => ({ ...current, affection_delta: Number(event.target.value) }))} /></label><label>烦躁<input type="number" min="-50" max="50" value={ruleDraft.irritation_delta} onChange={(event) => setRuleDraft((current) => ({ ...current, irritation_delta: Number(event.target.value) }))} /></label><label>优先级<input type="number" min="0" max="999" value={ruleDraft.priority} onChange={(event) => setRuleDraft((current) => ({ ...current, priority: Number(event.target.value) }))} /></label></div><label className="rule-distance"><input type="checkbox" checked={ruleDraft.needs_distance} onChange={(event) => setRuleDraft((current) => ({ ...current, needs_distance: event.target.checked, silence_minutes: event.target.checked ? Math.max(5, current.silence_minutes) : 0 }))} />命中后保持距离 <input type="number" min="0" max="1440" value={ruleDraft.silence_minutes} onChange={(event) => setRuleDraft((current) => ({ ...current, silence_minutes: Number(event.target.value) }))} /> 分钟</label><button className="rule-add-button" onClick={() => void addRelationshipRule()} disabled={!ruleDraft.name.trim() || !ruleDraft.match_text.trim() || profileBusy}>添加规则</button></div>{relationshipRules.length === 0 ? <div className="small-empty">还没有自定义规则。</div> : <div className="relationship-rule-list">{relationshipRules.map((rule) => <div className={`relationship-rule ${rule.enabled ? "enabled" : "disabled"}`} key={rule.id}><div className="relationship-rule-copy"><strong>{rule.name}</strong><span>短语：{rule.match_text} · 优先级 {rule.priority}</span><small>信任 {rule.trust_delta >= 0 ? "+" : ""}{rule.trust_delta} · 亲密 {rule.affection_delta >= 0 ? "+" : ""}{rule.affection_delta} · 烦躁 {rule.irritation_delta >= 0 ? "+" : ""}{rule.irritation_delta}{rule.needs_distance ? ` · 冷静 ${rule.silence_minutes || "默认"} 分钟` : ""}</small></div><div className="relationship-rule-actions"><button onClick={() => void toggleRelationshipRule(rule)}>{rule.enabled ? "停用" : "启用"}</button><button onClick={() => void deleteRelationshipRule(rule)} aria-label="删除规则" title="删除"><Trash2 size={14} /></button></div></div>)}</div>}</div>
        <div className="profile-actions"><button className="candidate-dismiss" onClick={() => setProfileOpen(false)}>取消</button><button className="candidate-confirm" onClick={() => void saveProfile()} disabled={profileBusy}>保存角色</button></div>
      </section></div>}
      {memoryOpen && <div className="memory-backdrop" role="presentation" onClick={() => setMemoryOpen(false)}><section className="memory-panel" role="dialog" aria-modal="true" aria-labelledby="memory-title" onClick={(event) => event.stopPropagation()}>
        <div className="memory-panel-header"><div><p className="eyebrow">隐私与连续性</p><h2 id="memory-title">长期记忆</h2></div><button className="panel-close" onClick={() => setMemoryOpen(false)} aria-label="关闭">×</button></div>
        <p className="memory-intro">只保存你明确允许的简短信息，不保存完整聊天。你可以随时暂停或删除。</p>
        <div className="memory-consent"><div><strong>{memoryStatus.allowed ? (memoryStatus.paused ? "记忆已暂停" : "记忆已开启") : "记忆未开启"}</strong><span>{memoryStatus.allowed ? "对话可以使用下方已保存内容" : "未授权时不会读取或写入长期记忆"}</span></div><button className={`memory-toggle ${memoryStatus.allowed && !memoryStatus.paused ? "on" : ""}`} disabled={memoryBusy} onClick={() => void (memoryStatus.allowed ? setMemoryPaused(!memoryStatus.paused) : setMemoryConsent(true))} aria-label={memoryStatus.allowed && !memoryStatus.paused ? "暂停记忆" : "开启记忆"}><span /></button></div>
        {memoryStatus.allowed && <div className="memory-actions"><button disabled={memoryBusy || memoryStatus.paused} onClick={() => void setMemoryPaused(true)}>暂停保存</button><button disabled={memoryBusy || !memoryStatus.paused} onClick={() => void setMemoryPaused(false)}>恢复保存</button><button className="danger-text" disabled={memoryBusy} onClick={() => void setMemoryConsent(false)}>撤回授权</button></div>}
        {memoryStatus.allowed && !memoryStatus.paused && <div className="memory-add"><input value={memoryDraft} onChange={(event) => setMemoryDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addMemory(); }} placeholder="添加一条你希望我记住的事" maxLength={200} /><button onClick={() => void addMemory()} disabled={!memoryDraft.trim() || memoryBusy}>保存</button></div>}
        <div className="memory-list"><div className="memory-list-heading">已保存 {memories.length} 条</div>{memories.length === 0 ? <div className="memory-empty">这里还没有记忆。你可以手动添加一条。</div> : memories.map((memory) => <div className="memory-item" key={memory.id}><div className="memory-item-main"><span className="memory-kind">{memory.kind === "user_fact" ? "关于你" : memory.kind}</span>{editingMemoryId === memory.id ? <textarea value={memoryEditDraft} onChange={(event) => setMemoryEditDraft(event.target.value)} maxLength={200} rows={3} autoFocus /> : <p>{memory.content}</p>}</div><div className="memory-item-actions">{editingMemoryId === memory.id ? <><button onClick={() => void saveMemoryEdit(memory)} disabled={!memoryEditDraft.trim() || memoryBusy}>保存</button><button onClick={cancelMemoryEdit} disabled={memoryBusy}>取消</button></> : <><button onClick={() => startMemoryEdit(memory)} aria-label="编辑记忆" title="编辑">编辑</button><button onClick={() => void deleteMemory(memory)} aria-label="删除记忆" title="删除"><Trash2 size={15} /></button></>}</div></div>)}</div>
        <div className="adult-setting"><div><strong>成年人确认</strong><span>{adultStatus.confirmed ? "已确认年满 18 周岁，可进入 AI 女友模式" : "未确认，AI 女友模式保持锁定"}</span></div>{adultStatus.confirmed ? <button className="danger-text" onClick={() => void revokeAdult()}>撤回</button> : <button onClick={() => setAdultOpen(true)}>确认</button>}</div>
      </section></div>}
      {adultOpen && <div className="adult-backdrop" role="presentation"><section className="adult-dialog" role="dialog" aria-modal="true" aria-labelledby="adult-title">
        <div className="adult-dialog-icon"><ShieldCheck size={22} /></div><h2 id="adult-title">进入 AI 女友模式</h2><p>AI 女友模式仅面向年满 18 周岁的成年人。确认后，你可以随时在设置中撤回。</p><div className="adult-dialog-actions"><button className="adult-cancel" onClick={() => setAdultOpen(false)}>暂不进入</button><button className="adult-confirm" onClick={() => void confirmAdult()}>我已年满 18 周岁</button></div>
      </section></div>}
    </div>
  );
}
