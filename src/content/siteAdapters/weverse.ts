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
    if (!video?.parentElement) return null;
    // 세로 영상이 큰 플레이어(좌우 검은 여백 포함) 안에 있으면, 그 큰 컨테이너에
    // 자막을 붙이면 영상 박스 밖으로 빠진다. video를 직접 감싸는 부모에서 시작해
    // video 폭과 비슷한(레터박스 없는) 가장 바깥 조상까지만 올라가, 자막이
    // 영상 박스 안에 정확히 뜨도록 한다.
    const vw = video.getBoundingClientRect().width;
    let node: HTMLElement = video.parentElement;
    while (node.parentElement && node.parentElement !== document.body) {
      const pw = node.parentElement.getBoundingClientRect().width;
      if (vw > 0 && pw <= vw * 1.15) {
        node = node.parentElement;
      } else break;
    }
    return node;
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

    if (candidates.length === 0) return null;

    // 가장 키가 큰(컬럼 전체에 가까운) 후보를 사이드 컬럼으로 본다.
    candidates.sort(
      (a, b) =>
        b.getBoundingClientRect().height - a.getBoundingClientRect().height,
    );
    return candidates[0];
  },
};
