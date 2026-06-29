import { useEffect, useState, useRef } from "react";
import type { SubtitleCue } from "@/types/subtitle";
import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  type KaptikSettings,
} from "@/shared/settings";

/**
 * 현재 자막 설정을 구독하는 훅.
 * 팝업에서 설정을 바꾸면 오버레이/패널에 즉시 반영된다.
 */
export function useSettings(): KaptikSettings {
  const [settings, setSettings] = useState<KaptikSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (active) setSettings(s);
    });
    const unsubscribe = onSettingsChanged(setSettings);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return settings;
}

/**
 * 현재 영상 시간에 맞는 자막 큐 인덱스를 찾는다.
 * 현재 시간이 자막 구간 밖이면 이전 자막을 유지하지 않고 비운다.
 */
export function findActiveCueIndex(cues: SubtitleCue[], currentTime: number): number {
  for (let i = cues.length - 1; i >= 0; i--) {
    const cue = cues[i];
    if (currentTime >= cue.start && currentTime <= cue.end) return i;
  }
  return -1;
}

/** seekable.end() 기준 라이브 엣지 판정 오차(초). HLS 플레이어가 세그먼트를 ~30초 미리 당겨 seekable에 반영하므로 그보다 여유를 둔다. */
const LIVE_EDGE_SEEKABLE_TOLERANCE_SEC = 45;

/**
 * 현재 재생 위치가 라이브 엣지(실시간 끝부분)에 가까운지 확인한다.
 * seekable 정보가 없으면 되감기 가능 구간이 없는 실시간으로 보고 엣지로 처리한다.
 */
export function isNearLiveEdge(
  currentTime: number,
  seekableEnd: number | null,
  toleranceSec = LIVE_EDGE_SEEKABLE_TOLERANCE_SEC,
): boolean {
  if (seekableEnd == null || !Number.isFinite(seekableEnd)) return true;
  return seekableEnd - currentTime <= toleranceSec;
}

function getSeekableEnd(video: HTMLVideoElement): number | null {
  const ranges = video.seekable;
  if (!ranges || ranges.length === 0) return null;
  return ranges.end(ranges.length - 1);
}

/**
 * video의 현재 재생 위치에 해당하는 자막 큐 인덱스를 추적하는 훅.
 * requestAnimationFrame으로 현재 시각을 읽되, 인덱스가 바뀔 때만 리렌더한다.
 * @param video 기준 video 요소
 * @param cues 시간순 정렬된 자막 큐
 * @param isLive 라이브 여부 (라이브면 엣지에서 최신 cue 폴백 적용)
 * @returns 현재 큐 인덱스 (해당 구간에 자막이 없으면 -1)
 */
export function useActiveIndex(
  video: HTMLVideoElement,
  cues: SubtitleCue[],
  isLive = false,
): number {
  const [index, setIndex] = useState(-1);
  const fallbackRef = useRef({ cue: undefined as SubtitleCue | undefined, startTime: 0 });

  useEffect(() => {
    let rafId = 0;
    let last = -2;

    const tick = () => {
      const liveEdge = isLive && isNearLiveEdge(video.currentTime, getSeekableEnd(video), LIVE_EDGE_SEEKABLE_TOLERANCE_SEC);
      let found = findActiveCueIndex(cues, video.currentTime);

      // 라이브 엣지에서 활성 자막이 없을 때, 최신 번역(마지막 cue)을 띄운다.
      if (found === -1 && liveEdge && cues.length > 0) {
        const lastIdx = cues.length - 1;
        const lastCue = cues[lastIdx];

        // 타임스탬프 5초 여유: 서버 타임스탬프가 영상 위치보다 약간 앞서더라도 띄움
        if (video.currentTime >= lastCue.start - 5) {
          // 새 자막이 도착했으면 화면에 표시된 시간(startTime)을 현재 시각으로 초기화
          if (fallbackRef.current.cue !== lastCue) {
            fallbackRef.current.cue = lastCue;
            fallbackRef.current.startTime = video.currentTime;
          }

          const elapsed = video.currentTime - fallbackRef.current.startTime;
          // elapsed >= 0: 사용자가 과거 침묵 구간으로 되감기(seek) 한 것이 아닐 때
          // elapsed <= 4: 표시한 시점부터 4초까지만 유지
          if (elapsed >= 0 && elapsed <= 4) {
            found = lastIdx;
          }
        }
      }

      if (found !== last) {
        last = found;
        setIndex(found);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [video, cues, isLive]);

  return index;
}

/**
 * 패널 강조용 인덱스를 고른다.
 * 라이브 모드에서는 침묵 구간에도 마지막으로 시작된 cue를 유지해 강조가 끊기지 않는다.
 * VOD 모드에서는 구간을 벗어나면 -1로 비운다 (정확한 타임스탬프 클릭 UX 유지).
 */
export function findStickyPanelIndex(cues: SubtitleCue[], currentTime: number): number {
  const active = findActiveCueIndex(cues, currentTime);
  if (active !== -1) return active;
  for (let i = cues.length - 1; i >= 0; i--) {
    // 5초 여유: 최신 자막 타임스탬프가 영상보다 약간 미래라도 강조 (라이브 엣지 즉각 반응)
    if (cues[i].start - 5 <= currentTime) return i;
  }
  return -1;
}

/** 패널 강조용: VOD는 정확한 구간 매칭, 라이브는 침묵 구간에서 마지막 cue 유지. */
export function useCurrentCueIndex(
  video: HTMLVideoElement,
  cues: SubtitleCue[],
  isLive = false,
): number {
  const [index, setIndex] = useState(-1);

  useEffect(() => {
    let rafId = 0;
    let last = -2;

    const tick = () => {
      const found = isLive
        ? findStickyPanelIndex(cues, video.currentTime)
        : findActiveCueIndex(cues, video.currentTime);
      if (found !== last) {
        last = found;
        setIndex(found);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [video, cues, isLive]);

  return index;
}

/** 광고 재생 여부를 짧은 주기로 확인해 오버레이 표시를 제어한다. */
export function useAdState(getIsAdPlaying?: () => boolean): boolean {
  const [isAd, setIsAd] = useState(false);

  useEffect(() => {
    if (!getIsAdPlaying) {
      setIsAd(false);
      return;
    }

    let active = true;
    const read = () => {
      let next = false;
      try {
        next = getIsAdPlaying();
      } catch {
        next = false;
      }
      if (active) setIsAd(next);
    };

    read();
    const timer = window.setInterval(read, 250);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [getIsAdPlaying]);

  return isAd;
}
