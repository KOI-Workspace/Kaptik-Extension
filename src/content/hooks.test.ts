import { describe, expect, it } from "vitest";
import { findActiveCueIndex } from "./hooks";
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

  it("번역되지 않은 먼 미래 구간으로 점프하면 활성 자막이 없다", () => {
    expect(findActiveCueIndex(cues, 322)).toBe(-1);
  });
});
