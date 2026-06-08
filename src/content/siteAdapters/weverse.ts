import type { SiteAdapter } from "./types";

/**
 * Weverse 어댑터.
 * Weverse는 SPA이며 라이브/미디어/모먼트 등 경로 구조가 다양하다.
 * DOM 클래스명이 빌드마다 해시로 바뀔 수 있어, video 요소 기준으로
 * 가장 가까운 플레이어 래퍼를 추론하는 방식으로 견고성을 확보한다.
 */
export const weverseAdapter: SiteAdapter = {
  platform: "weverse",

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
    if (!video) return null;
    // 클래스명에 'Player'/'video' 가 포함된 가장 가까운 조상을 우선 사용
    const labeled = video.closest<HTMLElement>(
      '[class*="Player" i], [class*="video" i], [data-testid*="player" i]',
    );
    return labeled ?? (video.parentElement as HTMLElement | null);
  },

  getPanelContainer() {
    // Weverse는 YouTube 같은 고정 사이드 컬럼이 없어 패널을 도킹하지 않는다.
    // null을 반환하면 패널은 영상 위 오버레이로 폴백된다.
    return null;
  },
};
