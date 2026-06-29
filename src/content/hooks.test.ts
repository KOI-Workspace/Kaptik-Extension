import { describe, expect, it } from "vitest";
import { findActiveCueIndex, findStickyPanelIndex, isNearLiveEdge } from "./hooks";
import type { SubtitleCue } from "@/types/subtitle";

const cues = [
  { start: 10, end: 12, text: { ko: "첫 번째" } },
  { start: 20, end: 22, text: { ko: "두 번째" } },
  { start: 35, end: 37, text: { ko: "세 번째" } },
] satisfies SubtitleCue[];

describe("findActiveCueIndex — 영상 시간 기준 활성 자막", () => {
  it("첫 자막 시작 전이면 활성 자막이 없다", () => {
    expect(findActiveCueIndex(cues, 9.9)).toBe(-1);
  });

  it("자막 시작 시각에 도달하면 해당 자막을 활성으로 본다", () => {
    expect(findActiveCueIndex(cues, 20)).toBe(1);
  });

  it("자막 구간이 끝난 뒤에는 이전 자막을 유지하지 않는다", () => {
    expect(findActiveCueIndex(cues, 30)).toBe(-1);
  });

  it("영상이 과거 시점으로 이동하면 활성 자막도 과거 줄로 돌아간다", () => {
    expect(findActiveCueIndex(cues, 36)).toBe(2);
    expect(findActiveCueIndex(cues, 10)).toBe(0);
  });

  it("자막 구간이 겹치면 더 늦게 시작한 최신 자막을 활성으로 본다", () => {
    const overlappingCues = [
      { start: 100, end: 106, text: { ko: "이전 자막" } },
      { start: 104, end: 110, text: { ko: "현재 자막" } },
    ] satisfies SubtitleCue[];

    expect(findActiveCueIndex(overlappingCues, 105)).toBe(1);
  });

  it("번역되지 않은 먼 미래 구간으로 점프하면 활성 자막이 없다", () => {
    expect(findActiveCueIndex(cues, 322)).toBe(-1);
  });
});

describe("findStickyPanelIndex — 라이브 패널 강조 (침묵 구간 sticky)", () => {
  it("구간 안에 있으면 해당 인덱스를 반환한다", () => {
    expect(findStickyPanelIndex(cues, 20)).toBe(1);
    expect(findStickyPanelIndex(cues, 36)).toBe(2);
  });

  it("침묵 구간(구간 밖)에서도 이미 시작된 마지막 cue를 유지한다", () => {
    // cue[1] end=22, 다음 cue[2] start=35 → 25초는 침묵 구간이지만 cue[1] 유지
    expect(findStickyPanelIndex(cues, 25)).toBe(1);
    // cue[2] end=37 이후에도 마지막 cue[2] 유지
    expect(findStickyPanelIndex(cues, 40)).toBe(2);
  });

  it("첫 cue 시작 전에는 -1을 반환한다 (아직 발화 없음)", () => {
    expect(findStickyPanelIndex(cues, 4)).toBe(-1);
  });

  it("cue가 없으면 -1", () => {
    expect(findStickyPanelIndex([], 10)).toBe(-1);
  });
});

describe("isNearLiveEdge — 실시간 끝부분 판정", () => {
  it("seekable 끝과 가까우면 라이브 엣지로 본다", () => {
    expect(isNearLiveEdge(985, 1000)).toBe(true);
  });

  it("HLS 세그먼트 프리페치로 seekable이 30초 앞이어도 라이브 엣지로 판정한다 (기본 오차 45s)", () => {
    expect(isNearLiveEdge(970, 1000)).toBe(true);  // 30s ahead → 30 ≤ 45
  });

  it("seekable 끝에서 많이 뒤로 가 있으면 과거 시점으로 본다", () => {
    expect(isNearLiveEdge(900, 1000)).toBe(false);  // 100s ahead → 100 > 45
  });

  it("seekable 정보가 없으면 되감기 없는 실시간 엣지로 본다", () => {
    expect(isNearLiveEdge(10, null)).toBe(true);
  });
});
