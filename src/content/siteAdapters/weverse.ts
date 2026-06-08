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
    // 자막/패널은 '영상 박스' 안에만 머물러야 한다.
    // 컨테이너를 영상보다 넓게 잡으면 패널이 영상 밖(우측 여백·댓글 영역)으로
    // 번져 화면을 가린다. 그래서 video와 크기가 거의 같은(레터박스 없는)
    // 가장 바깥 조상까지만 확장하고, 그보다 커지면 멈춘다.
    const vRect = video.getBoundingClientRect();
    let node: HTMLElement = video.parentElement;
    while (node.parentElement && node.parentElement !== document.body) {
      const pr = node.parentElement.getBoundingClientRect();
      const sameBox =
        vRect.width > 0 &&
        pr.width <= vRect.width * 1.06 &&
        pr.height <= vRect.height * 1.06;
      if (sameBox) {
        node = node.parentElement;
      } else break;
    }
    return node;
  },

  getPanelContainer() {
    const video = this.getVideoElement();
    if (!video) return null;
    const vRect = video.getBoundingClientRect();
    if (vRect.width === 0) return null;

    // 위버스는 클래스명이 빌드마다 해시로 바뀌므로 셀렉터가 불안정하다.
    // 영상을 가리지 않도록, 영상 '오른쪽' 또는 (좁은 화면이면) 영상 '아래'의
    // 컬럼을 위치·크기로 추론해 그 맨 위에 패널을 도킹한다.
    const all = Array.from(
      document.querySelectorAll<HTMLElement>("div, section, aside"),
    ).filter((el) => !el.contains(video)); // 영상을 품은 큰 래퍼는 제외

    // 1순위(넓은 화면): 영상 오른쪽의 세로 컬럼
    const rightCol = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.left >= vRect.right - 80 &&
        r.width >= 260 &&
        r.width <= 720 &&
        r.height >= 320
      );
    });
    if (rightCol.length > 0) {
      rightCol.sort(
        (a, b) =>
          b.getBoundingClientRect().height - a.getBoundingClientRect().height,
      );
      return rightCol[0];
    }

    // 2순위(좁은 화면): 영상 바로 아래의 컬럼 → 영상 아래로 내려가 도킹
    const belowCol = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top >= vRect.bottom - 40 && // 영상 하단 경계 부근부터 시작
        r.width >= 260 &&
        r.height >= 160 &&
        // 가로로 영상과 겹치는(같은 컬럼 흐름의) 요소만
        r.left < vRect.right &&
        r.right > vRect.left
      );
    });
    if (belowCol.length > 0) {
      // 영상에 가장 가까운(top이 가장 작은) 컬럼을 고른다.
      belowCol.sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
      return belowCol[0];
    }

    return null;
  },
};
