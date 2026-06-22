import type { SiteAdapter } from "./types";
import { findVideoBox, findDockColumn } from "./heuristics";

/**
 * 위버스 삽입 광고로 볼 수 있는 영상의 최대 길이(초).
 * 이보다 길면 광고가 아니라 본편(라이브 다시보기 등)으로 판단한다.
 * (광고는 보통 15~30초. 짧은 본편 영상을 광고로 오판하지 않도록 40초로 둔다)
 */
const AD_MAX_DURATION_SEC = 40;

/**
 * 영상 속성만으로 광고 영상 여부를 판정하는 순수 로직 (DOM 미접근 → 단위 테스트 가능).
 * - 광고 CDN(doubleclick 등) src면 광고
 * - blob + "짧은" 유한 길이 = 삽입 광고
 *   (진짜 라이브 본편=Infinity, 다시보기 본편=긴 유한값 → 광고 아님)
 * - 그 외 비-blob src는 광고로 간주
 */
export function isLikelyAdVideo(params: {
  src: string;
  duration: number;
}): boolean {
  const { src, duration } = params;
  if (/doubleclick|googlesyndication|gvt1|googlevideo|adservice/i.test(src)) return true;
  if (
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
   * 위버스는 크게 두 종류의 광고가 있다.
   *
   * [A] 짧은 삽입 광고 (blob + 짧은 duration):
   *   별도 video 요소 또는 같은 요소로 짧게 재생 → isLikelyAdVideo 가 감지.
   *
   * [B] HLS 스트림 내장 프리롤 (SSAI):
   *   라이브 다시보기 스트림 맨 앞에 광고 구간이 통째로 붙어 있어
   *   video.duration 이 전체 길이(수천 초)로 잡힘 → isLikelyAdVideo 로 감지 불가.
   *   이 경우 플레이어가 광고 중에 보여 주는 UI 텍스트나 DOM 요소로 감지한다.
   *
   * 판별 핵심(A 유형)은 순수 함수 isLikelyAdVideo 로 분리(테스트 대상).
   * 여기서는 재생·가시성 필터 및 B 유형 감지를 담당한다.
   */
  isAdPlaying() {
    const pageText = document.body?.innerText?.slice(0, 3000) ?? "";

    // 영어 광고 UI 텍스트 (YouTube/범용)
    if (/\b(skip ad|sponsored|advertisement)\b/i.test(pageText)) return true;
    // 한국어 광고 UI 텍스트 — "광고 건너뛰기" 또는 "건너뛰기" 단독
    // innerText 는 보이는 텍스트만 포함하므로 aria-label 전용 seek 버튼과 겹치지 않는다.
    if (/광고\s*건너뛰기/.test(pageText) || /건너뛰기/.test(pageText)) return true;

    // Google IMA SDK 광고 클릭-through 링크:
    // SSAI 프리롤 재생 중 플레이어가 doubleclick 도메인으로 향하는 <a> 태그를 DOM에 추가한다.
    // 광고가 끝나면 제거되므로 존재 자체가 광고 중임을 의미한다.
    if (document.querySelector(
      'a[href*="doubleclick.net"], a[href*="googleadservices.com"], a[href*="googlesyndication.com"]'
    )) {
      return true;
    }

    const videos = Array.from(document.querySelectorAll("video"));
    return videos.some((v) => {
      // !v.paused 제거 — 광고 일시정지 시에도 광고 소스로 인식해야 패널이 안 뜸
      const isCandidate = !v.ended && !v.muted && v.readyState >= 2;
      if (!isCandidate) return false;

      const rect = v.getBoundingClientRect();
      const isVisible = rect.width > 80 && rect.height > 45;
      if (!isVisible) return false;

      return isLikelyAdVideo({ src: v.currentSrc || "", duration: v.duration });
    });
  },
};
