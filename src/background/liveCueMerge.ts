import type { LanguageCode, SubtitleCue } from "@/types/subtitle";

const LONG_TEXT_MERGE_WINDOW_SEC = 8;
const SHORT_TEXT_MERGE_WINDOW_SEC = 1.5;
const SHORT_TEXT_MAX_LENGTH = 8;

function normalizeText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/[.?!。！？]+$/g, "")
    .trim()
    .toLowerCase();
}

function isRelatedText(a: string | undefined, b: string | undefined): boolean {
  const normalizedA = normalizeText(a);
  const normalizedB = normalizeText(b);
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  const [shorter, longer] = normalizedA.length <= normalizedB.length
    ? [normalizedA, normalizedB]
    : [normalizedB, normalizedA];
  // 짧은 쪽이 긴 쪽의 절반 미만이면 같은 발화의 점진적 업데이트가 아닌 다른 발화로 판단
  if (shorter.length < longer.length * 0.5) return false;
  return longer.includes(shorter);
}

function chooseLongerText(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return normalizeText(b).length > normalizeText(a).length ? b : a;
}

function shouldMergeCue(existing: SubtitleCue, next: SubtitleCue, language: string): boolean {
  const timeDiff = Math.abs(existing.start - next.start);
  const koRelated = isRelatedText(existing.text.ko, next.text.ko);
  const translatedRelated = isRelatedText(
    existing.text[language as LanguageCode],
    next.text[language as LanguageCode],
  );
  if (!koRelated && !translatedRelated) return false;

  const longestTextLength = Math.max(
    normalizeText(existing.text.ko).length,
    normalizeText(next.text.ko).length,
    normalizeText(existing.text[language as LanguageCode]).length,
    normalizeText(next.text[language as LanguageCode]).length,
  );
  const windowSec = longestTextLength <= SHORT_TEXT_MAX_LENGTH
    ? SHORT_TEXT_MERGE_WINDOW_SEC
    : LONG_TEXT_MERGE_WINDOW_SEC;
  return timeDiff <= windowSec;
}

function mergeCue(existing: SubtitleCue, next: SubtitleCue, language: string): SubtitleCue {
  const lang = language as LanguageCode;
  return {
    ...existing,
    start: Math.min(existing.start, next.start),
    end: Math.max(existing.end, next.end),
    speakerId: next.speakerId ?? existing.speakerId,
    text: {
      ...existing.text,
      ...next.text,
      ko: chooseLongerText(existing.text.ko, next.text.ko),
      [lang]: chooseLongerText(existing.text[lang], next.text[lang]),
    },
    annotations: next.annotations?.length ? next.annotations : existing.annotations,
  };
}

function normalizeCueEnds(cues: SubtitleCue[]): SubtitleCue[] {
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    if (!next) return cue;
    const nextBoundedEnd = Math.max(cue.start + 1.2, next.start - 0.1);
    return { ...cue, end: Math.min(cue.end, nextBoundedEnd) };
  });
}

/**
 * 라이브 cue를 시간순 목록에 추가한다.
 * 서버가 같은 발화를 부분/반복 업데이트로 보내도 한 줄로 합쳐 패널 중복과 클릭 오차를 줄인다.
 */
export function upsertLiveCue(cues: SubtitleCue[], cue: SubtitleCue, language: string): SubtitleCue[] {
  const nextCues = [...cues];
  const mergeIndex = nextCues.findIndex((existing) => shouldMergeCue(existing, cue, language));

  if (mergeIndex >= 0) {
    nextCues[mergeIndex] = mergeCue(nextCues[mergeIndex], cue, language);
  } else {
    nextCues.push(cue);
  }

  nextCues.sort((a, b) => a.start - b.start);
  return normalizeCueEnds(nextCues);
}

export function compactLiveCues(cues: SubtitleCue[], language: string): SubtitleCue[] {
  return cues
    .slice()
    .sort((a, b) => a.start - b.start)
    .reduce<SubtitleCue[]>((acc, cue) => upsertLiveCue(acc, cue, language), []);
}
