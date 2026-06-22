import type { SiteAdapter } from "./types";
import { findVideoBox, findDockColumn } from "./heuristics";

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
   * - 위버스 광고(LG U+ 등 한국 브랜드)는 blob: URL이지만 duration이 유한값(광고 길이)
   *   → 라이브 페이지에서 blob + 유한 duration = 광고로 판정
   * - VOD/replay 페이지(유한 duration이 정상)는 라이브 페이지가 아니므로 오판하지 않음
   */
  isAdPlaying() {
    const pageText = document.body?.innerText?.slice(0, 3000) ?? "";
    if (/\b(skip ad|sponsored|advertisement)\b/i.test(pageText) || /광고\s*건너뛰기/.test(pageText)) {
      return true;
    }

    const isLivePage = /\/live\//.test(location.href);
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.some((v) => {
      const src = v.currentSrc || "";
      const isPlaying = !v.paused && !v.ended && !v.muted && v.readyState >= 2;
      if (!isPlaying) return false;

      const rect = v.getBoundingClientRect();
      const isVisible = rect.width > 80 && rect.height > 45;
      if (!isVisible) return false;

      if (/doubleclick|googlesyndication|gvt1|googlevideo|adservice/i.test(src)) return true;
      // 라이브 페이지에서 blob URL 영상의 duration이 유한하면 광고
      // (라이브 본편은 duration=Infinity, 광고는 광고 길이만큼의 유한값을 가짐)
      if (isLivePage && src.startsWith("blob:") && Number.isFinite(v.duration)) return true;
      if (!src || src.startsWith("blob:")) return false;
      return true;
    });
  },
};
