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
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    if (currentTime < cue.start) return -1;
    if (currentTime >= cue.start && currentTime <= cue.end) return i;
  }
  return -1;
}

/**
 * video의 현재 재생 위치에 해당하는 자막 큐 인덱스를 추적하는 훅.
 * requestAnimationFrame으로 현재 시각을 읽되, 인덱스가 바뀔 때만 리렌더한다.
 * @param video 기준 video 요소
 * @param cues 시간순 정렬된 자막 큐
 * @returns 현재 큐 인덱스 (해당 구간에 자막이 없으면 -1)
 */
export function useActiveIndex(
  video: HTMLVideoElement,
  cues: SubtitleCue[],
): number {
  const [index, setIndex] = useState(-1);

  useEffect(() => {
    let rafId = 0;
    let last = -2;

    const tick = () => {
      const found = findActiveCueIndex(cues, video.currentTime);
      if (found !== last) {
        last = found;
        setIndex(found);
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [video, cues]);

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
