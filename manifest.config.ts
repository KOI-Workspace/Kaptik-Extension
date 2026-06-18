import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

/**
 * Kaptik 확장 프로그램 매니페스트 (Manifest V3)
 * - content script: YouTube / Weverse 영상 페이지에 자막 오버레이 주입
 * - background: 자막 데이터 요청 중계 (Kaptik API)
 * - action popup: 자막 설정 UI
 */
export default function getManifest(mode: string) {
  const isDev = mode !== "production";
  return defineManifest({
    manifest_version: 3,
    name: "Kaptik – K-pop 라이브 자막",
    version: pkg.version,
    description: pkg.description,
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_title: "Kaptik 자막 설정",
      default_popup: "src/popup/index.html",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png",
      },
    },
    background: {
      service_worker: "src/background/index.ts",
      type: "module",
    },
    content_scripts: [
      {
        matches: [
          "*://*.youtube.com/*",
          "*://*.weverse.io/*",
          "*://*.instagram.com/*",
        ],
        js: ["src/content/index.tsx"],
        run_at: "document_idle",
        all_frames: false,
      },
    ],
    permissions: ["storage", "notifications", "tabs", "cookies", "tabCapture", "activeTab", "offscreen", "alarms", "scripting"],
    host_permissions: [
      "*://*.youtube.com/*",
      "*://*.weverse.io/*",
      "*://*.instagram.com/*",
      "https://kaptik.p-e.kr/*",
      ...(isDev ? ["http://localhost:8000/*"] : []),
    ],
  });
}
