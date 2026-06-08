import { Fragment } from "react";
import type { Annotation } from "@/types/subtitle";

interface AnnotatedTextProps {
  text: string;
  annotations?: Annotation[];
  /** 현재 열려 있는 주석 인덱스 (없으면 null) */
  openIndex: number | null;
  /** 주석 토글 콜백 (주석 인덱스) */
  onToggle: (annotationIndex: number) => void;
}

interface Segment {
  text: string;
  annotationIndex?: number;
}

/**
 * 텍스트에서 각 주석의 term을 찾아 밑줄 강조 구간으로 분할한다.
 * 겹치는 구간은 먼저 등장한 것을 우선한다.
 */
function buildSegments(text: string, annotations: Annotation[]): Segment[] {
  const lower = text.toLowerCase();
  const marks: { start: number; end: number; annotationIndex: number }[] = [];

  annotations.forEach((ann, i) => {
    if (!ann.term) return;
    const idx = lower.indexOf(ann.term.toLowerCase());
    if (idx === -1) return;
    marks.push({ start: idx, end: idx + ann.term.length, annotationIndex: i });
  });

  marks.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue; // 겹침 무시
    if (mark.start > cursor) segments.push({ text: text.slice(cursor, mark.start) });
    segments.push({
      text: text.slice(mark.start, mark.end),
      annotationIndex: mark.annotationIndex,
    });
    cursor = mark.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/**
 * 자막 텍스트를 렌더하며, 문화 맥락 주석이 연결된 구절은 밑줄 + 클릭 가능하게 표시한다.
 * term이 텍스트에서 발견되지 않는 주석은 줄 끝에 ⓘ 배지로 노출한다.
 */
export function AnnotatedText({
  text,
  annotations,
  openIndex,
  onToggle,
}: AnnotatedTextProps) {
  if (!annotations || annotations.length === 0) {
    return <span>{text}</span>;
  }

  const segments = buildSegments(text, annotations);
  const matchedIndices = new Set(
    segments.map((s) => s.annotationIndex).filter((i): i is number => i != null),
  );
  // term이 매칭되지 않은 주석 → 배지로 표시
  const unmatched = annotations
    .map((_, i) => i)
    .filter((i) => !matchedIndices.has(i));

  return (
    <span>
      {segments.map((seg, i) =>
        seg.annotationIndex != null ? (
          <button
            key={i}
            type="button"
            className={
              "kaptik-term" + (openIndex === seg.annotationIndex ? " is-open" : "")
            }
            onClick={(e) => {
              e.stopPropagation(); // 텍스트 행의 seek로 전파 방지
              onToggle(seg.annotationIndex!);
            }}
          >
            {seg.text}
          </button>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
      {unmatched.map((i) => (
        <button
          key={`badge-${i}`}
          type="button"
          className={"kaptik-term-badge" + (openIndex === i ? " is-open" : "")}
          onClick={(e) => {
            e.stopPropagation(); // 텍스트 행의 seek로 전파 방지
            onToggle(i);
          }}
          aria-label={`맥락 보기: ${annotations[i].title}`}
        >
          ⓘ
        </button>
      ))}
    </span>
  );
}
