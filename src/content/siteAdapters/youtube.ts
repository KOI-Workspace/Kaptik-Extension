import type { SiteAdapter } from "./types";

/**
 * YouTube 어댑터.
 * - 영상 ID: URL 쿼리 ?v= 또는 /shorts/<id> 경로
 * - 컨테이너: #movie_player (전체화면에서도 자막 유지)
 */
export const youtubeAdapter: SiteAdapter = {
  platform: "youtube",

  matches(url) {
    try {
      return /(^|\.)youtube\.com$/.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  getVideoId(url) {
    try {
      const u = new URL(url);
      const v = u.searchParams.get("v");
      if (v) return v;
      // Shorts: /shorts/<id>
      const shorts = u.pathname.match(/\/shorts\/([\w-]+)/);
      if (shorts) return shorts[1];
      return null;
    } catch {
      return null;
    }
  },

  getVideoElement() {
    return (
      (document.querySelector("video.html5-main-video") as HTMLVideoElement | null) ??
      (document.querySelector("#movie_player video") as HTMLVideoElement | null) ??
      (document.querySelector("video") as HTMLVideoElement | null)
    );
  },

  getOverlayContainer() {
    return (
      (document.querySelector("#movie_player") as HTMLElement | null) ??
      (document.querySelector(".html5-video-player") as HTMLElement | null)
    );
  },

  getPanelContainer() {
    // 넓은 화면(2컬럼)에서는 우측 관련영상 컬럼에 도킹하고,
    // 좁은 화면(1컬럼)에서는 우측 컬럼이 영상 아래로 밀려 사라지므로
    // 영상 바로 아래(#below) 영역에 도킹한다.
    const flexy = document.querySelector("ytd-watch-flexy");
    const twoColumns = flexy
      ? flexy.hasAttribute("is-two-columns_")
      : window.innerWidth >= 1016;

    if (twoColumns) {
      const side =
        (document.querySelector("#secondary-inner") as HTMLElement | null) ??
        (document.querySelector("#secondary") as HTMLElement | null);
      if (side) return side;
    }

    // 좁은 화면: 영상 바로 아래(제목/메타데이터 영역 맨 위)에 도킹
    return (
      (document.querySelector("#below") as HTMLElement | null) ??
      (document.querySelector("#primary-inner") as HTMLElement | null)
    );
  },
};
