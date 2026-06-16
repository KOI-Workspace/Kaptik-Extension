import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import getManifest from "./manifest.config";

// Kaptik 확장 프로그램 빌드 설정 (CRXJS + React)
export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest: getManifest(mode) })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // content script HMR 안정성을 위해 포트 고정
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
  build: {
    // 확장 프로그램 디버깅을 위해 소스맵 유지
    sourcemap: true,
  },
}));
