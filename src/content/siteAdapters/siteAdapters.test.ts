import { describe, it, expect } from "vitest";
import { youtubeAdapter } from "./youtube";
import { weverseAdapter, isLikelyAdVideo } from "./weverse";
import { instagramAdapter } from "./instagram";
import { resolveAdapter } from "./index";

/**
 * 사이트 어댑터의 URL 해석 로직.
 * getVideoId/isLive/matches는 URL만으로 판단하는 순수 로직이라 점검 비용 대비 효과가 크다.
 * (popup도 같은 함수를 재사용하므로 여기가 깨지면 팝업 상태 오표시로 직결됨)
 */

describe("resolveAdapter — URL로 올바른 사이트 선택", () => {
  it("youtube.com → youtube 어댑터", () => {
    expect(resolveAdapter("https://www.youtube.com/watch?v=abc")?.platform).toBe("youtube");
  });
  it("weverse.io → weverse 어댑터", () => {
    expect(resolveAdapter("https://weverse.io/bts/live/2-123")?.platform).toBe("weverse");
  });
  it("instagram.com → instagram 어댑터", () => {
    expect(resolveAdapter("https://www.instagram.com/reels/xyz/")?.platform).toBe("instagram");
  });
  it("지원하지 않는 사이트는 null", () => {
    expect(resolveAdapter("https://example.com/")).toBeNull();
  });
});

describe("YouTube getVideoId", () => {
  it("일반 영상 ?v=", () => {
    expect(youtubeAdapter.getVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("Shorts 경로", () => {
    expect(youtubeAdapter.getVideoId("https://www.youtube.com/shorts/abc123")).toBe("abc123");
  });
  it("라이브 방송 /live/ 경로", () => {
    expect(youtubeAdapter.getVideoId("https://www.youtube.com/live/xyz789")).toBe("xyz789");
  });
  it("영상 ID가 없으면 null", () => {
    expect(youtubeAdapter.getVideoId("https://www.youtube.com/feed/subscriptions")).toBeNull();
  });
});

describe("YouTube isLive (URL 기준)", () => {
  it("/live/ 경로는 라이브", () => {
    expect(youtubeAdapter.isLive!("https://www.youtube.com/live/xyz789")).toBe(true);
  });
  it("일반 watch 경로는 (DOM 없으면) 라이브 아님", () => {
    expect(youtubeAdapter.isLive!("https://www.youtube.com/watch?v=abc")).toBe(false);
  });
});

describe("Weverse getVideoId", () => {
  it("라이브 N-N 식별자", () => {
    expect(weverseAdapter.getVideoId("https://weverse.io/bts/live/2-12345")).toBe("2-12345");
  });
  it("미디어 N-N 식별자", () => {
    expect(weverseAdapter.getVideoId("https://weverse.io/bts/media/4-67890")).toBe("4-67890");
  });
  it("N-N이 없으면 마지막 세그먼트로 폴백", () => {
    expect(weverseAdapter.getVideoId("https://weverse.io/artist/moment")).toBe("moment");
  });
});

describe("Weverse isLive (URL 기준)", () => {
  it("/live/ 경로는 라이브", () => {
    expect(weverseAdapter.isLive!("https://weverse.io/bts/live/2-123")).toBe(true);
  });
  it("/media/ 경로는 라이브 아님", () => {
    expect(weverseAdapter.isLive!("https://weverse.io/bts/media/4-678")).toBe(false);
  });
});

describe("Weverse isLikelyAdVideo — 광고 vs 다시보기 구분", () => {
  it("실시간 라이브 본편(blob + Infinity)은 광고 아님", () => {
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: Infinity })).toBe(false);
  });

  it("라이브 다시보기(blob + 긴 유한 길이 54분)는 광고 아님", () => {
    // 이번 버그: /live/ URL이지만 54:54짜리 다시보기 → 광고로 오판되면 안 됨
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: 3294 })).toBe(false);
  });

  it("라이브 중 짧은 삽입 광고(blob + 30초)는 광고", () => {
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: 30 })).toBe(true);
  });

  it("경계값: 60초까지는 광고, 61초부터는 본편", () => {
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: 60 })).toBe(true);
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: 61 })).toBe(false);
  });

  it("3분짜리 짧은 본편 영상은 광고 아님", () => {
    expect(isLikelyAdVideo({ isLivePage: true, src: "blob:abc", duration: 180 })).toBe(false);
  });

  it("광고 CDN(doubleclick) src는 길이와 무관하게 광고", () => {
    expect(isLikelyAdVideo({ isLivePage: true, src: "https://doubleclick.net/ad", duration: Infinity })).toBe(true);
  });

  it("라이브 페이지가 아니면 짧은 blob도 광고 아님", () => {
    expect(isLikelyAdVideo({ isLivePage: false, src: "blob:abc", duration: 30 })).toBe(false);
  });
});

describe("Instagram getVideoId", () => {
  it("릴스", () => {
    expect(instagramAdapter.getVideoId("https://www.instagram.com/reel/CxYz/")).toBe("CxYz");
  });
  it("게시물", () => {
    expect(instagramAdapter.getVideoId("https://www.instagram.com/p/Abc123/")).toBe("Abc123");
  });
  it("라이브는 live-<username>", () => {
    expect(instagramAdapter.getVideoId("https://www.instagram.com/someuser/live")).toBe("live-someuser");
  });
});
