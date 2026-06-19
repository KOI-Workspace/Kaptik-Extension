import { createPortal } from "react-dom";
import type { SubtitleTrack } from "@/types/subtitle";
import { useActiveIndex, useSettings } from "../hooks";
import { CenterSubtitle } from "./CenterSubtitle";
import { SidePanel } from "./SidePanel";

/**
 * 패널 표시 모드.
 * - "pending": 도킹할 컬럼을 아직 못 찾음 — 잠시 대기. 오버레이로 깜빡이지 않도록 패널을 그리지 않는다.
 * - "docked":  사이드 컬럼(관련영상/채팅 영역)에 끼워 넣음 (정상 동작)
 * - "overlay": 끝내 컬럼이 없어 영상 위 오버레이로 폴백
 */
export type PanelMode = "pending" | "docked" | "overlay";

interface DisplayProps {
  video: HTMLVideoElement;
  track: SubtitleTrack;
  /** 패널 Shadow DOM 마운트 노드 (도킹 모드에서 portal 대상) */
  panelMount: HTMLElement | null;
  /** 패널 표시 모드 (pending/docked/overlay) */
  panelMode: PanelMode;
  /** 라이브 스트림 여부 */
  isLive?: boolean;
}

/**
 * 자막 UI 루트. (오버레이 Shadow DOM 안에서 렌더됨)
 * 단일 rAF(useActiveIndex)와 단일 설정 구독을 공유한다.
 * - 가운데 자막: 이 컴포넌트가 속한 오버레이에 직접 렌더
 * - 우측 패널: 도킹 모드면 createPortal로 사이드 컬럼(panelMount)에, 아니면 오버레이 안에 렌더
 */
export function Display({ video, track, panelMount, panelMode, isLive = false }: DisplayProps) {
  const settings = useSettings();
  const activeIndex = useActiveIndex(video, track.cues);

  if (!settings.enabled) return null;

  const showPanel = settings.showPanel;
  // 오버레이 폴백일 때만 패널이 영상 위에 들어가므로 가운데 자막을 비켜준다
  const overlayHasPanel = showPanel && panelMode === "overlay";

  return (
    <div
      className={
        `kaptik-root kaptik-root--${track.platform}` +
        (overlayHasPanel ? " has-panel" : "")
      }
    >
      <CenterSubtitle
        track={track}
        activeIndex={activeIndex}
        settings={settings}
      />

      {/* 폴백 모드: 패널을 영상 위 오버레이로 함께 렌더 */}
      {overlayHasPanel && (
        <SidePanel
          video={video}
          track={track}
          activeIndex={activeIndex}
          settings={settings}
          variant="overlay"
          isLive={isLive}
        />
      )}

      {/* 도킹 모드: 패널을 사이드 컬럼으로 portal (pending은 아무것도 안 그림) */}
      {panelMode === "docked" &&
        showPanel &&
        panelMount &&
        createPortal(
          <SidePanel
            video={video}
            track={track}
            activeIndex={activeIndex}
            settings={settings}
            variant="docked"
            isLive={isLive}
          />,
          panelMount,
        )}
    </div>
  );
}
