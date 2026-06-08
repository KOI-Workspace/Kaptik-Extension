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
    const video = this.getVideoElement();
    if (!video) return null;
    const vRect = video.getBoundingClientRect();
    if (vRect.width === 0) {
      console.info("[Kaptik] (weverse) video 크기 0 — 패널 도킹 보류");
      return null;
    }

    // Weverse는 클래스명이 빌드마다 해시로 바뀌므로 텍스트/클래스 셀렉터가 불안정하다.
    // 대신 '영상 오른쪽에 위치한 세로 컬럼'을 위치/크기 기준으로 추론한다.
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("div, section, aside"),
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= vRect.right - 80 && // 영상 오른쪽 경계 부근부터 시작
        r.width >= 260 &&
        r.width <= 720 && // 사이드 컬럼 너비대 (페이지 전체 래퍼 제외)
        r.height >= 350 // 충분히 긴 컬럼
      );
    });

    console.info(
      `[Kaptik] (weverse) iframe ${document.querySelectorAll("iframe").length}개, ` +
        `우측 컬럼 후보 ${candidates.length}개 (video.right=${Math.round(vRect.right)})`,
    );

    if (candidates.length === 0) return null;

    // 가장 키가 큰(컬럼 전체에 가까운) 후보를 사이드 컬럼으로 본다.
    candidates.sort(
      (a, b) =>
        b.getBoundingClientRect().height - a.getBoundingClientRect().height,
    );
    const column = candidates[0];
    const r = column.getBoundingClientRect();
    console.info(
      `[Kaptik] (weverse) 패널 도킹 컬럼 선택: <${column.tagName.toLowerCase()}> ` +
        `class="${(typeof column.className === "string" ? column.className : "").slice(0, 40)}" ` +
        `${Math.round(r.width)}x${Math.round(r.height)}`,
    );
    return column;
  },
};
