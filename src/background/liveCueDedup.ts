import type { SubtitleCue } from "@/types/subtitle";

const DUPLICATE_WINDOW_SEC = 0.5;

export interface PendingLiveCue {
  text_ko: string;
  startMs: number;
}

function normalizeCueText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isSameCueText(a: string, b: string): boolean {
  const normalizedA = normalizeCueText(a);
  const normalizedB = normalizeCueText(b);
  return normalizedA.length > 0 && normalizedA === normalizedB;
}

/**
 * 라이브 Stage1 중복 여부를 판정한다.
 * 시간만 가까운 다른 문장은 새 자막으로 인정하고, 같은 문장이 같은 시간대에 다시 온 경우만 중복으로 본다.
 */
export function isDuplicateLiveStage1(params: {
  existingCues: SubtitleCue[];
  pendingCues: PendingLiveCue[];
  startMs: number;
  textKo: string;
}): boolean {
  const startSec = params.startMs / 1000;

  const duplicatedExisting = params.existingCues.some((cue) =>
    Math.abs(cue.start - startSec) < DUPLICATE_WINDOW_SEC &&
    isSameCueText(cue.text.ko ?? "", params.textKo)
  );
  if (duplicatedExisting) return true;

  return params.pendingCues.some((cue) =>
    Math.abs(cue.startMs / 1000 - startSec) < DUPLICATE_WINDOW_SEC &&
    isSameCueText(cue.text_ko, params.textKo)
  );
}
