import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Member, SubtitleCue, SubtitleTrack } from "@/types/subtitle";
import { Display } from "./Display";
// CSS를 문자열로 가져와 Shadow DOM에 주입 (외부 사이트와 격리)
import displayCss from "./display.css?inline";

const OVERLAY_HOST_ID = "kaptik-overlay-host";
const PANEL_HOST_ID = "kaptik-panel-host";

/** 마운트 결과 핸들 */
export interface DisplayHandle {
  destroy(): void;
  /** 스트리밍으로 누적된 자막 큐 목록을 업데이트한다. */
  updateCues(cues: SubtitleCue[]): void;
  /** 화자 식별 결과로 멤버 레지스트리를 업데이트한다. */
  updateMembers(members: Record<string, Member>): void;
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
  isLive = false,
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
  // VOD 정상 트랙은 첫 자막 도착 시 삽입 — 생성 중 또는 스트리밍 대기 중에 빈 패널이 노출되는 것을 방지
  let panelInserted = false;

  if (panelContainer) {
    const panel = createShadowMount();
    panel.host.id = PANEL_HOST_ID;
    // 사이드 컬럼의 일반 블록으로 흐르게 둔다 (관련영상 위에 위치)
    panel.host.style.cssText = "display:block;border:0;margin:0;padding:0;";
    panelHost = panel.host;
    panelMount = panel.mount;

    // 라이브이거나 에러 트랙이면 즉시 삽입, VOD 정상 트랙은 updateCues에서 처리
    if (isLive || track.error) {
      panelContainer.prepend(panelHost);
      panelInserted = true;
    }
  }

  // useState setters는 렌더 간 stable이므로 클로저 변수에 할당해도 안전하다.
  let _setCues: ((cues: SubtitleCue[]) => void) | null = null;
  let _setMembers: ((updater: (prev: Record<string, Member>) => Record<string, Member>) => void) | null = null;

  function ConnectedDisplay() {
    const [cues, setCues] = useState<SubtitleCue[]>(track.cues);
    const [members, setMembers] = useState<Record<string, Member>>(track.members);
    _setCues = setCues;
    _setMembers = setMembers as typeof _setMembers;
    return (
      <Display
        video={video}
        track={{ ...track, cues, members }}
        panelMount={panelMount}
        panelDocked={panelDocked}
        isLive={isLive}
      />
    );
  }

  // root는 실제 DOM에 연결된 오버레이 노드에 생성한다.
  // (가운데 자막은 여기에 직접 렌더, 패널만 사이드 컬럼으로 portal)
  let root: Root | null = createRoot(overlay.mount);
  root.render(
    <StrictMode>
      <ConnectedDisplay />
    </StrictMode>,
  );

  return {
    destroy() {
      root?.unmount();
      root = null;
      _setCues = null;
      overlay.host.remove();
      panelHost?.remove();
    },
    updateCues(cues) {
      // VOD: 첫 자막 도착 시 패널을 DOM에 삽입 (그 전까지는 사이드 컬럼에 빈 박스가 노출되지 않음)
      if (!panelInserted && panelHost && panelContainer && cues.length > 0) {
        panelContainer.prepend(panelHost);
        panelInserted = true;
      }
      _setCues?.(cues);
    },
    updateMembers(newEntries) {
      _setMembers?.((prev) => ({ ...prev, ...newEntries }));
    },
  };
}
