import { describe, expect, it } from "vitest";
import type { SubtitleCue } from "@/types/subtitle";
import { compactLiveCues, upsertLiveCue } from "./liveCueMerge";

function cue(start: number, ko: string, en: string): SubtitleCue {
  return {
    start,
    end: start + 6,
    text: { ko, en },
  };
}

describe("upsertLiveCue", () => {
  it("같은 긴 발화가 몇 초 차이로 반복되면 한 줄로 합친다", () => {
    const result = upsertLiveCue(
      [cue(96, "어제 보고 싶다고 해서", "I said I wanted to see you yesterday.")],
      cue(100, "어제 보고 싶다고 해서", "Uh, I said I wanted to see you yesterday."),
      "en",
    );

    expect(result).toHaveLength(1);
    expect(result[0].start).toBe(96);
    expect(result[0].text.en).toBe("Uh, I said I wanted to see you yesterday.");
  });

  it("짧은 감탄사는 멀리 떨어져 있으면 별도 발화로 둔다", () => {
    const result = upsertLiveCue(
      [cue(94, "어?", "Huh?")],
      cue(100, "어?", "Huh?"),
      "en",
    );

    expect(result).toHaveLength(2);
  });

  it("다른 문장은 시간이 가까워도 합치지 않는다", () => {
    const result = upsertLiveCue(
      [cue(100, "첫 문장", "First sentence.")],
      cue(101, "둘째 문장", "Second sentence."),
      "en",
    );

    expect(result).toHaveLength(2);
  });
});

describe("compactLiveCues", () => {
  it("저장된 cue 목록의 기존 중복도 정리한다", () => {
    const result = compactLiveCues([
      cue(96, "어제 보고 싶다고 해서", "I said I wanted to see you yesterday."),
      cue(97, "어제 보고 싶다고 해서", "I said I wanted to see you yesterday."),
      cue(100, "어제 보고 싶다고 해서", "Uh, I said I wanted to see you yesterday."),
    ], "en");

    expect(result).toHaveLength(1);
  });
});
