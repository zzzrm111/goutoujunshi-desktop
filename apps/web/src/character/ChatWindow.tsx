import { useEffect, useState } from "react";
import PetChatPanel from "./PetChatPanel";
import "./character-page.css";

const API = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8001/api/v1";

type TauriBridge = {
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

function getTauriBridge(): TauriBridge | null {
  return (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__ || null;
}

export default function ChatWindow() {
  const [displayName, setDisplayName] = useState("小满");

  useEffect(() => {
    document.documentElement.classList.add("chat-transparent");
    return () => document.documentElement.classList.remove("chat-transparent");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/agent/profile`)
      .then((response) => response.ok ? response.json() : null)
      .then((profile: { display_name?: unknown } | null) => {
        if (!cancelled && typeof profile?.display_name === "string" && profile.display_name.trim()) {
          setDisplayName(profile.display_name);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  function closeWindow() {
    const bridge = getTauriBridge();
    if (bridge?.invoke) {
      void bridge.invoke("hide_pet_chat").catch(() => undefined);
      return;
    }
    window.close();
  }

  return (
    <main className="chat-window-page">
      <PetChatPanel displayName={displayName} onClose={closeWindow} />
    </main>
  );
}
