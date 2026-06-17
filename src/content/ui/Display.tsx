import { createPortal } from "react-dom";
import type { SubtitleTrack } from "@/types/subtitle";
import { useActiveIndex, useSettings } from "../hooks";
import { CenterSubtitle } from "./CenterSubtitle";
import { SidePanel } from "./SidePanel";

interface DisplayProps {
  video: HTMLVideoElement;
  track: SubtitleTrack;
  /** 패널 Shadow DOM 마운트 노드 (도킹 불가 시 null → 오버레이로 폴백) */
  panelMount: HTMLElement | null;
  /** 패널을 사이드 컬럼에 도킹하는지 여부 */
  panelDocked: boolean;
  /** 라이브 스트림 여부 */
  isLive?: boolean;
}

/**
 * 자막 UI 루트. (오버레이 Shadow DOM 안에서 렌더됨)
 * 단일 rAF(useActiveIndex)와 단일 설정 구독을 공유한다.
 * - 가운데 자막: 이 컴포넌트가 속한 오버레이에 직접 렌더
 * - 우측 패널: 도킹 모드면 createPortal로 사이드 컬럼(panelMount)에, 아니면 오버레이 안에 렌더
 */
export function Display({ video, track, panelMount, panelDocked, isLive = false }: DisplayProps) {
  const settings = useSettings();
  const activeIndex = useActiveIndex(video, track.cues);

  if (!settings.enabled) return null;

  const showPanel = settings.showPanel;
  // 폴백 모드에서만 패널이 오버레이 안에 들어가므로 가운데 자막을 비켜준다
  const overlayHasPanel = showPanel && !panelDocked;

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

      {/* 도킹 모드: 패널을 사이드 컬럼으로 portal */}
      {panelDocked &&
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
