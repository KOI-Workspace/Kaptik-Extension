import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "@/types/subtitle";
import { isDuplicateLiveStage1 } from "./liveCueDedup";

const existingCue = {
  start: 0.36,
  end: 6.36,
  text: { ko: "밤이면 저도 똑똑똑." },
} satisfies SubtitleCue;

describe("isDuplicateLiveStage1", () => {
  it("시간이 가까워도 텍스트가 다르면 중복이 아니다", () => {
    expect(isDuplicateLiveStage1({
      existingCues: [existingCue],
      pendingCues: [],
      startMs: 172,
      textKo: "새로운 문장입니다.",
    })).toBe(false);
  });

  it("시간이 가깝고 텍스트도 같으면 중복이다", () => {
    expect(isDuplicateLiveStage1({
      existingCues: [existingCue],
      pendingCues: [],
      startMs: 172,
      textKo: "밤이면 저도 똑똑똑.",
    })).toBe(true);
  });

  it("아직 Stage2가 오지 않은 pending cue와도 중복을 잡는다", () => {
    expect(isDuplicateLiveStage1({
      existingCues: [],
      pendingCues: [{ startMs: 200, text_ko: "같은 문장" }],
      startMs: 250,
      textKo: "같은 문장",
    })).toBe(true);
  });
});
