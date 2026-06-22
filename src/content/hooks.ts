import { useEffect, useState } from "react";
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

/** 라이브 엣지 판정 허용 오차(초). 오디오 파이프라인 지연(~13초)을 커버한다. */
const LIVE_EDGE_TOLERANCE_SEC = 20;

/**
 * 현재 재생 위치가 라이브 엣지(실시간 끝부분)에 가까운지 확인한다.
 * seekable 정보가 없으면 되감기 가능 구간이 없는 실시간으로 보고 엣지로 처리한다.
 */
export function isNearLiveEdge(
  currentTime: number,
  seekableEnd: number | null,
  toleranceSec = LIVE_EDGE_TOLERANCE_SEC,
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
 * 화면에 표시할 자막 큐 인덱스를 고른다.
 * - 구간 매칭되면 그대로 사용 (되감기·녹화 영상 = 구간 동기가 정확해야 함)
 * - 라이브 엣지에서 구간 매칭이 빠졌는데 최신 cue가 현재 위치 근처면 그 cue를 표시.
 *   라이브 엣지에서는 오디오 처리 지연으로 cue.start가 영상 위치보다 앞뒤로 살짝
 *   어긋나 구간 매칭에서 누락되기 때문 (살짝 늦더라도 최신 자막을 띄워준다).
 *   되감기 후 무음 구간처럼 최신 cue가 한참 미래면 억지로 띄우지 않는다.
 */
export function findDisplayCueIndex(
  cues: SubtitleCue[],
  currentTime: number,
  isLiveEdge: boolean,
): number {
  const active = findActiveCueIndex(cues, currentTime);
  if (active !== -1 || !isLiveEdge || cues.length === 0) return active;

  const last = cues[cues.length - 1];
  return Math.abs(last.start - currentTime) <= LIVE_EDGE_TOLERANCE_SEC
    ? cues.length - 1
    : -1;
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

  useEffect(() => {
    let rafId = 0;
    let last = -2;

    const tick = () => {
      const liveEdge = isLive && isNearLiveEdge(video.currentTime, getSeekableEnd(video));
      const found = findDisplayCueIndex(cues, video.currentTime, liveEdge);
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
