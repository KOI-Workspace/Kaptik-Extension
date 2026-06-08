import type { SiteAdapter } from "./types";
import { findVideoBox, findDockColumn } from "./heuristics";

/**
 * Instagram 어댑터 (뼈대).
 * 인스타는 클래스명이 난독화되므로 Weverse처럼 video 기준 위치·크기 추론을 쓴다.
 * 라이브가 상시 있는 게 아니라, 우선 릴스·게시물 영상에서도 동작하도록 만들어 두고
 * (가장 크게 보이는 video를 자막 대상으로 삼음) 라이브 전용 댓글 컬럼 셀렉터는
 * 실제 라이브 DOM을 확보한 뒤 heuristics 또는 여기서 정밀화한다.
 */
export const instagramAdapter: SiteAdapter = {
  platform: "instagram",

  matches(url) {
    try {
      return /(^|\.)instagram\.com$/.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  getVideoId(url) {
    try {
      const path = new URL(url).pathname;
      // 릴스/게시물/IGTV: /reel(s)/<id>, /p/<id>, /tv/<id>
      const m = path.match(/\/(?:reels?|p|tv)\/([^/]+)/);
      if (m) return m[1];
      // 스토리: /stories/<user>/<id>
      const story = path.match(/\/stories\/[^/]+\/([^/]+)/);
      if (story) return story[1];
      // 라이브: /<username>/live (식별자로 username 사용)
      const live = path.match(/\/([^/]+)\/live\/?$/);
      if (live) return `live-${live[1]}`;
      // 폴백: 마지막 경로 세그먼트
      const segs = path.split("/").filter(Boolean);
      return segs.length ? segs[segs.length - 1] : null;
    } catch {
      return null;
    }
  },

  getVideoElement() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (videos.length === 0) return null;
    // 피드엔 작은 영상이 여럿 떠 있을 수 있으므로 화면에서 가장 크게 보이는 것을 대상으로 한다.
    return videos
      .map((v) => {
        const r = v.getBoundingClientRect();
        return { v, area: r.width * r.height };
      })
      .sort((a, b) => b.area - a.area)[0].v as HTMLVideoElement;
  },

  getOverlayContainer() {
    const video = this.getVideoElement();
    return video ? findVideoBox(video) : null;
  },

  getPanelContainer() {
    const video = this.getVideoElement();
    return video ? findDockColumn(video) : null;
  },
};
