import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LoaderCircle, MessageCircle, Send, X } from "lucide-react";
import { consumeSseResponse, type SsePayload } from "../lib/sse";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1";

type SessionSummary = {
  id: string;
  title: string;
  mode: "girlfriend" | "advisor";
  updated_at: string;
};

type PetMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  pending?: boolean;
  error?: string;
};

type Props = {
  displayName: string;
  onClose: () => void;
};

type TauriWindowBridge = {
  window?: { getCurrentWindow?: () => { startDragging?: () => Promise<void> } };
};

function getStartDragging(): (() => Promise<void>) | undefined {
  const api = (window as unknown as { __TAURI__?: TauriWindowBridge }).__TAURI__;
  const currentWindow = api?.window?.getCurrentWindow?.();
  return currentWindow?.startDragging?.bind(currentWindow);
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { detail?: unknown };
    if (typeof payload.detail === "string" && payload.detail.trim()) return payload.detail;
  } catch {
    // The fallback is clearer than an HTML or empty error body.
  }
  return fallback;
}

export default function PetChatPanel({ displayName, onClose }: Props) {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<PetMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function loadConversation() {
      try {
        const listResponse = await fetch(`${API}/sessions`, { signal: controller.signal });
        if (!listResponse.ok) throw new Error(await readError(listResponse, "无法读取聊天记录。"));
        const sessions = await listResponse.json() as SessionSummary[];
        let session = sessions.find((item) => item.mode === "girlfriend");

        if (!session) {
          const createResponse = await fetch(`${API}/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "girlfriend" }),
            signal: controller.signal,
          });
          if (!createResponse.ok) {
            throw new Error(await readError(createResponse, "无法创建聊天。请先在主窗口完成成年人确认。"));
          }
          session = await createResponse.json() as SessionSummary;
        }

        const detailResponse = await fetch(`${API}/sessions/${session.id}`, { signal: controller.signal });
        if (!detailResponse.ok) throw new Error(await readError(detailResponse, "无法读取聊天内容。"));
        const detail = await detailResponse.json() as { messages?: Array<Omit<PetMessage, "pending" | "error">> };
        if (cancelled) return;
        setSessionId(session.id);
        setMessages((detail.messages || [])
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ ...message, error: undefined, pending: false })));
      } catch (loadError) {
        if (cancelled || (loadError instanceof DOMException && loadError.name === "AbortError")) return;
        setError(loadError instanceof Error ? loadError.message : "聊天暂时不可用。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadConversation();
    return () => {
      cancelled = true;
      controller.abort();
      sendControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [loading]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !sessionId || busy) return;

    const stamp = Date.now();
    const user: PetMessage = {
      id: `pet-user-${stamp}`,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    const assistant: PetMessage = {
      id: `pet-assistant-${stamp}`,
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
      pending: true,
    };
    setMessages((current) => [...current, user, assistant]);
    setDraft("");
    setBusy(true);
    setError("");

    const controller = new AbortController();
    sendControllerRef.current = controller;
    let answer = "";
    let failure = "";

    try {
      const response = await fetch(`${API}/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, regenerate: false, attachment_ids: [] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readError(response, "这次没有发送成功。"));

      const handleEvent = (event: string, payload: SsePayload) => {
        if (event === "token" && typeof payload.text === "string") {
          answer += payload.text;
          setMessages((current) => current.map((message) => message.id === assistant.id
            ? { ...message, content: answer }
            : message));
        }
        if (event === "error" && typeof payload.message === "string") failure = payload.message;
      };

      await consumeSseResponse(response, handleEvent);
      if (!answer && !failure) failure = "这次没有生成回复，再试一次。";
      setMessages((current) => current.map((message) => message.id === assistant.id
        ? { ...message, content: answer || failure, pending: false, error: failure || undefined }
        : message));
    } catch (sendError) {
      if (sendError instanceof DOMException && sendError.name === "AbortError") return;
      const message = sendError instanceof Error ? sendError.message : "网络连接失败。";
      setMessages((current) => current.map((item) => item.id === assistant.id
        ? { ...item, content: message, pending: false, error: message }
        : item));
    } finally {
      sendControllerRef.current = null;
      setBusy(false);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onWindowDragPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const startDragging = getStartDragging();
    if (!startDragging) return;
    event.preventDefault();
    void startDragging().catch(() => undefined);
  }

  return (
    <div
      className="pet-chat-panel standalone"
      role="dialog"
      aria-label={`${displayName}的聊天框`}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <header
        className="pet-chat-header"
        data-tauri-drag-region
        onPointerDown={onWindowDragPointerDown}
      >
        <div className="pet-chat-title" data-tauri-drag-region>
          <MessageCircle aria-hidden="true" />
          <span data-tauri-drag-region>{displayName}</span>
        </div>
        <button
          type="button"
          className="pet-chat-close"
          title={busy ? "正在回复，请稍候" : "关闭聊天框"}
          aria-label="关闭聊天框"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div ref={listRef} className="pet-chat-messages" aria-live="polite">
        {loading && (
          <div className="pet-chat-loading">
            <LoaderCircle aria-hidden="true" />
            <span>正在连接</span>
          </div>
        )}
        {!loading && messages.length === 0 && !error && (
          <div className="pet-chat-empty">在呢。</div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`pet-chat-message ${message.role} ${message.error ? "error" : ""}`}>
            <div>{message.content || (message.pending ? "……" : "")}</div>
          </div>
        ))}
      </div>

      {error && <div className="pet-chat-error">{error}</div>}

      <form className="pet-chat-compose" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          value={draft}
          rows={2}
          maxLength={12000}
          placeholder="说点什么"
          aria-label="消息内容"
          disabled={loading || !sessionId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button type="submit" title="发送消息" aria-label="发送消息" disabled={loading || !sessionId || busy || !draft.trim()}>
          {busy ? <LoaderCircle className="pet-chat-spinner" aria-hidden="true" /> : <Send aria-hidden="true" />}
        </button>
      </form>
    </div>
  );
}
