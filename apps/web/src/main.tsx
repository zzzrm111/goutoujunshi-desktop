import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import CharacterPage from "./character/CharacterPage";
import ChatWindow from "./character/ChatWindow";
import "./styles.css";

type ErrorBoundaryState = { hasError: boolean };

class AppErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  componentDidCatch(error: Error): void {
    console.error("陪伴智能体渲染异常", error);
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, color: "#59645d", background: "#f7f8f7" }}>
          <section style={{ maxWidth: 360, textAlign: "center" }}>
            <h1 style={{ fontSize: 20, margin: "0 0 10px" }}>页面遇到了一点问题</h1>
            <p style={{ fontSize: 13, lineHeight: 1.7, margin: "0 0 18px" }}>可以刷新页面后继续，当前对话数据仍保存在本地。</p>
            <button type="button" onClick={() => window.location.reload()} style={{ border: 0, borderRadius: 6, padding: "9px 14px", color: "#fff", background: "#558a69", cursor: "pointer" }}>刷新页面</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

// 桌面角色窗口通过 ?window=pet 直接进入角色页。
// 桌面端使用资源协议加载静态文件，无法做 SPA 回退，因此这里用查询参数区分入口。
const isPetWindow = new URLSearchParams(window.location.search).get("window") === "pet";
const isChatWindow = new URLSearchParams(window.location.search).get("window") === "chat";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      {isChatWindow ? (
        <ChatWindow />
      ) : isPetWindow ? (
        <CharacterPage />
      ) : (
        <BrowserRouter>
          <Routes>
            <Route path="/character" element={<CharacterPage />} />
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
      )}
    </AppErrorBoundary>
  </React.StrictMode>,
);
