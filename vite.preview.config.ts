import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

/**
 * 팝업 UI 상태들을 확장 설치 없이 브라우저에서 바로 확인하기 위한 별도 dev 서버 설정.
 * 메인 vite.config.ts(CRXJS)와 완전히 분리돼 있어 dist를 건드리지 않는다.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  root: "src/popup-preview",
  server: {
    port: 5175,
    strictPort: true,
  },
});
