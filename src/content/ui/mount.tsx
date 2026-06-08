import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SubtitleTrack } from "@/types/subtitle";
import { Display } from "./Display";
// CSS를 문자열로 가져와 Shadow DOM에 주입 (외부 사이트와 격리)
import displayCss from "./display.css?inline";

const OVERLAY_HOST_ID = "kaptik-overlay-host";
const PANEL_HOST_ID = "kaptik-panel-host";

/** 마운트 결과 핸들 — 정리(unmount)에 사용 */
export interface DisplayHandle {
  destroy(): void;
}

/** 격리된 Shadow DOM host를 만들고, 그 안에 렌더용 마운트 노드를 반환한다. */
function createShadowMount(): { host: HTMLDivElement; mount: HTMLDivElement } {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = displayCss;
  shadow.appendChild(style);

  const mount = document.createElement("div");
  shadow.appendChild(mount);

  return { host, mount };
}

/**
 * 자막 UI를 마운트한다.
 * - 가운데 자막 오버레이: 영상 플레이어(overlayContainer) 위에 absolute로 표시
 * - 우측 히스토리 패널: 사이드 컬럼(panelContainer)에 도킹해 관련영상을 아래로 밀어냄
 *   panelContainer가 없으면 패널도 영상 위 오버레이로 폴백한다.
 *
 * 두 위치는 각각 독립 Shadow DOM이지만, 단일 React root에서 createPortal로
 * 렌더하므로 자막 동기화(rAF)와 설정 구독을 하나로 공유한다.
 *
 * @param overlayContainer 플레이어 래퍼 (가운데 자막 기준)
 * @param panelContainer 사이드 컬럼 (없으면 null → 패널 오버레이 폴백)
 * @param video 자막 동기화 기준 video
 * @param track 자막 트랙
 */
export function mountDisplay(
  overlayContainer: HTMLElement,
  panelContainer: HTMLElement | null,
  video: HTMLVideoElement,
  track: SubtitleTrack,
): DisplayHandle {
  // 중복 마운트 방지
  overlayContainer.querySelector(`#${OVERLAY_HOST_ID}`)?.remove();
  panelContainer?.querySelector(`#${PANEL_HOST_ID}`)?.remove();

  // 가운데 자막이 컨테이너 기준으로 절대 배치되도록 보장
  if (getComputedStyle(overlayContainer).position === "static") {
    overlayContainer.style.position = "relative";
  }

  // ── 영상 오버레이 host (가운데 자막) ──
  const overlay = createShadowMount();
  overlay.host.id = OVERLAY_HOST_ID;
  overlay.host.style.cssText =
    "position:absolute;inset:0;pointer-events:none;border:0;margin:0;padding:0;";
  overlayContainer.appendChild(overlay.host);

  // ── 패널 host (도킹 가능 시 사이드 컬럼 맨 위) ──
  const panelDocked = panelContainer != null;
  let panelHost: HTMLDivElement | null = null;
  let panelMount: HTMLDivElement | null = null;
  if (panelContainer) {
    const panel = createShadowMount();
    panel.host.id = PANEL_HOST_ID;
    // 사이드 컬럼의 일반 블록으로 흐르게 둔다 (관련영상 위에 위치)
    panel.host.style.cssText = "display:block;border:0;margin:0;padding:0;";
    panelContainer.prepend(panel.host);
    panelHost = panel.host;
    panelMount = panel.mount;
  }

  // root는 실제 DOM에 연결된 오버레이 노드에 생성한다.
  // (가운데 자막은 여기에 직접 렌더, 패널만 사이드 컬럼으로 portal)
  let root: Root | null = createRoot(overlay.mount);
  root.render(
    <StrictMode>
      <Display
        video={video}
        track={track}
        panelMount={panelMount}
        panelDocked={panelDocked}
      />
    </StrictMode>,
  );

  return {
    destroy() {
      root?.unmount();
      root = null;
      overlay.host.remove();
      panelHost?.remove();
    },
  };
}
