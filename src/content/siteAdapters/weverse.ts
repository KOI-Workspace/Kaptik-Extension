import type { SiteAdapter } from "./types";
import { findVideoBox, findDockColumn } from "./heuristics";

/**
 * 위버스 삽입 광고로 볼 수 있는 영상의 최대 길이(초).
 * 이보다 길면 광고가 아니라 본편(라이브 다시보기 등)으로 판단한다.
 * (광고는 보통 15~60초. 3분 등 짧은 본편 영상을 광고로 오판하지 않도록 1분으로 둔다)
 */
const AD_MAX_DURATION_SEC = 60;

/**
 * 영상 속성만으로 광고 영상 여부를 판정하는 순수 로직 (DOM 미접근 → 단위 테스트 가능).
 * - 광고 CDN(doubleclick 등) src면 광고
 * - 라이브 페이지의 blob + "짧은" 유한 길이 = 삽입 광고
 *   (진짜 라이브 본편=Infinity, 다시보기 본편=긴 유한값 → 광고 아님)
 * - 그 외 비-blob src는 광고로 간주
 */
export function isLikelyAdVideo(params: {
  isLivePage: boolean;
  src: string;
  duration: number;
}): boolean {
  const { isLivePage, src, duration } = params;
  if (/doubleclick|googlesyndication|gvt1|googlevideo|adservice/i.test(src)) return true;
  if (
    isLivePage &&
    src.startsWith("blob:") &&
    Number.isFinite(duration) &&
    duration > 0 &&
    duration <= AD_MAX_DURATION_SEC
  ) {
    return true;
  }
  if (!src || src.startsWith("blob:")) return false;
  return true;
}

/**
 * Weverse 어댑터.
 * Weverse는 SPA이며 라이브/미디어/모먼트 등 경로 구조가 다양하고,
 * DOM 클래스명이 빌드마다 해시로 바뀐다. 그래서 고정 셀렉터 대신
 * video 요소 기준의 위치·크기 추론(heuristics)으로 견고성을 확보한다.
 */
export const weverseAdapter: SiteAdapter = {
  platform: "weverse",
  // 위버스는 yt-dlp 음성 추출이 불가능해 라이브/VOD 모두 오디오 캡처 경로를 사용한다
  alwaysCapture: true,

  matches(url) {
    try {
      return /(^|\.)weverse\.io$/.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  getVideoId(url) {
    try {
      const pathname = new URL(url).pathname;
      // 예: /bts/live/2-12345, /bts/media/4-67890, /artist/moment/...
      const m = pathname.match(/([0-9]+-[0-9]+)/);
      if (m) return m[1];
      // 마지막 경로 세그먼트라도 식별자로 사용
      const segments = pathname.split("/").filter(Boolean);
      return segments.length ? segments[segments.length - 1] : null;
    } catch {
      return null;
    }
  },

  getVideoElement() {
    return document.querySelector("video") as HTMLVideoElement | null;
  },

  getOverlayContainer() {
    const video = this.getVideoElement();
    return video ? findVideoBox(video) : null;
  },

  getPanelContainer() {
    const video = this.getVideoElement();
    return video ? findDockColumn(video) : null;
  },

  isLive(url: string): boolean {
    try {
      return new URL(url).pathname.includes("/live/");
    } catch {
      return false;
    }
  },

  /**
   * 광고 재생 여부.
   * - 알려진 광고 CDN URL(구글 등)은 바로 감지
   * - 위버스 라이브 본편은 blob: URL + duration=Infinity(라이브 스트림)
   * - 위버스 광고(LG U+ 등 한국 브랜드)는 blob: URL이지만 duration이 짧은 유한값(광고 길이)
   *   → 라이브 페이지에서 blob + "짧은" 유한 duration = 광고로 판정
   * - 라이브 다시보기(/live/ 유지하되 54분 등 긴 유한 duration)는 본편이므로 광고로 보지 않는다
   * 판별 핵심은 순수 함수 isLikelyAdVideo로 분리(테스트 대상). 여기선 재생/가시성만 거른다.
   */
  isAdPlaying() {
    const pageText = document.body?.innerText?.slice(0, 3000) ?? "";
    if (/\b(skip ad|sponsored|advertisement)\b/i.test(pageText) || /광고\s*건너뛰기/.test(pageText)) {
      return true;
    }

    const isLivePage = /\/live\//.test(location.href);
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.some((v) => {
      // !v.paused 제거 — 광고 일시정지 시에도 광고 소스로 인식해야 패널이 안 뜸
      const isCandidate = !v.ended && !v.muted && v.readyState >= 2;
      if (!isCandidate) return false;

      const rect = v.getBoundingClientRect();
      const isVisible = rect.width > 80 && rect.height > 45;
      if (!isVisible) return false;

      return isLikelyAdVideo({ isLivePage, src: v.currentSrc || "", duration: v.duration });
    });
  },
};
