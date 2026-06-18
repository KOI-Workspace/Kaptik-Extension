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
};
