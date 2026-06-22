import { describe, expect, it } from "vitest";
import { findActiveCueIndex, findDisplayCueIndex, isNearLiveEdge } from "./hooks";
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

describe("findDisplayCueIndex — 라이브 엣지 최신 cue 폴백", () => {
  it("구간 매칭되면 라이브여도 그대로 사용한다 (되감기·녹화 동기 유지)", () => {
    expect(findDisplayCueIndex(cues, 20, true)).toBe(1);
    expect(findDisplayCueIndex(cues, 36, true)).toBe(2);
  });

  it("라이브 엣지가 아니면 구간 밖에서 폴백하지 않는다 (VOD/되감기 무음 구간)", () => {
    expect(findDisplayCueIndex(cues, 30, false)).toBe(-1);
  });

  it("라이브 엣지: 최신 cue가 영상 위치보다 미래여도 근처면 표시 (파이프라인 지연 보정)", () => {
    // 영상 33초인데 최신 cue.start가 35초(2초 미래) → 구간 매칭 실패하지만 근처라 표시
    expect(findActiveCueIndex(cues, 33)).toBe(-1);
    expect(findDisplayCueIndex(cues, 33, true)).toBe(2);
  });

  it("라이브 엣지: 최신 cue 구간이 막 끝난 직후에도 잠깐 유지 (허용 오차 내)", () => {
    // 영상 40초, 최신 cue end=37 → 구간 매칭 실패하지만 |35-40|=5초라 표시
    expect(findActiveCueIndex(cues, 40)).toBe(-1);
    expect(findDisplayCueIndex(cues, 40, true)).toBe(2);
  });

  it("되감기 후 무음 구간: 최신 cue가 한참 미래면 억지로 띄우지 않는다", () => {
    // 영상 5초(첫 cue 전), 최신 cue.start=35 → |35-5|=30초로 허용 오차 초과 → -1
    expect(findDisplayCueIndex(cues, 5, true)).toBe(-1);
  });

  it("cue가 없으면 -1", () => {
    expect(findDisplayCueIndex([], 10, true)).toBe(-1);
  });
});

describe("isNearLiveEdge — 실시간 끝부분 판정", () => {
  it("seekable 끝과 가까우면 라이브 엣지로 본다", () => {
    expect(isNearLiveEdge(985, 1000)).toBe(true);
  });

  it("seekable 끝에서 많이 뒤로 가 있으면 과거 시점으로 본다", () => {
    expect(isNearLiveEdge(900, 1000)).toBe(false);
  });

  it("seekable 정보가 없으면 되감기 없는 실시간 엣지로 본다", () => {
    expect(isNearLiveEdge(10, null)).toBe(true);
  });
});
