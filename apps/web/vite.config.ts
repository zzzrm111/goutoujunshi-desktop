import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Tauri 的生产包通过本地资源协议加载 index.html，绝对路径 /assets/* 会
  // 指向资源根而不是应用目录，导致主窗口与桌宠都显示空白。使用相对路径。
  base: "./",
  server: { host: "127.0.0.1", port: 5173 },
});
