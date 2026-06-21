import type {
  Annotation,
  LanguageCode,
  Platform,
  SubtitleCue,
  SubtitleStatus,
  SubtitleTrack,
} from "@/types/subtitle";
import { getMockTrack } from "./mockSubtitles";

/** API 호출 타임아웃(ms) */
const TIMEOUT_MS = 6000;

/** ws(s):// → http(s):// 변환. REST API 호출에 사용. */
export function wsUrlToHttp(url: string): string {
  return url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

/** 백엔드 Job API 응답 타입 */
export interface JobResponse {
  job_id: string;
  user_id: string;
  url: string;
  target_lang: string;
  status: "pending" | "processing" | "done" | "failed";
  step: string | null;
  progress: number;
  total_cues: number;
  error: string | null;
  created_at: number;
  cues?: Array<{
    cue_id: string;
    text_ko: string;
    text_en: string;
    start_ms: number;
    end_ms: number;
    speaker: string;
    annotations: Annotation[];
  }>;
}

interface LiveSubtitlesResponse {
  video_url: string;
  target_lang: string;
  subtitles: Array<{
    text_ko: string;
    text_en: string;
    speaker: string;
    ts: number;
    annotations?: Annotation[];
  }>;
}

/** fetch에 타임아웃과 선택적 Bearer 인증을 적용한 래퍼 */
async function fetchJson<T>(
  url: string,
  opts: { method?: string; body?: unknown; authToken?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.authToken) headers["Authorization"] = `Bearer ${opts.authToken}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      signal: controller.signal,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kaptik API에서 자막 트랙을 가져온다.
 * 백엔드 미연결/오류 시 mock 데이터로 안전하게 대체한다.
 */
export async function fetchSubtitleTrack(
  platform: Platform,
  videoId: string,
): Promise<SubtitleTrack> {
  console.info(`[Kaptik] fetchSubtitleTrack mock fallback (${platform}/${videoId})`);
  return getMockTrack(platform, videoId);
}

/** 서버에 저장된 라이브/캡처 자막을 조회한다. */
export async function fetchLiveSubtitles(opts: {
  serverUrl: string;
  authToken: string;
  videoUrl: string;
  targetLang: LanguageCode;
}): Promise<SubtitleCue[]> {
  const base = wsUrlToHttp(opts.serverUrl);
  const params = new URLSearchParams({
    video_url: opts.videoUrl,
    target_lang: opts.targetLang,
  });
  if (opts.authToken) params.set("token", opts.authToken);
  const res = await fetchJson<LiveSubtitlesResponse>(
    `${base}/live/subtitles?${params.toString()}`,
    { authToken: opts.authToken },
  );

  return res.subtitles
    .map((sub): SubtitleCue => ({
      start: Math.max(0, Number(sub.ts) / 1000),
      end: Math.max(0, Number(sub.ts) / 1000) + 6,
      speakerId: sub.speaker || undefined,
      text: { ko: sub.text_ko, [opts.targetLang]: sub.text_en },
      annotations: sub.annotations ?? [],
    }))
    .sort((a, b) => a.start - b.start)
    .map((cue, i, cues) => {
      const next = cues[i + 1];
      return next ? { ...cue, end: Math.min(cue.end, next.start - 0.1) } : cue;
    });
}

/**
 * 영상의 자막 제공 상태를 조회한다.
 * 백엔드 미연결 시 throw 하여, 호출 측(background)이 로컬 시뮬레이션으로 폴백하도록 한다.
 */
export async function fetchSubtitleStatus(
  platform: Platform,
  videoId: string,
): Promise<SubtitleStatus> {
  // 현재 미사용 — 상태 조회는 generationStore 또는 ws-job으로 처리
  throw new Error(`fetchSubtitleStatus: not implemented (${platform}/${videoId})`);
}

/**
 * POST /jobs — 자막 생성 Job을 생성한다.
 * @returns job_id
 */
export async function createJob(opts: {
  serverUrl: string;
  authToken: string;
  url: string;
  targetLang: string;
  force?: boolean;
}): Promise<{ jobId: string }> {
  const base = wsUrlToHttp(opts.serverUrl);
  const tokenParam = opts.authToken ? `?token=${encodeURIComponent(opts.authToken)}` : "";
  const body: Record<string, unknown> = { url: opts.url, target_lang: opts.targetLang };
  if (opts.force) body.force = true;
  const res = await fetchJson<{ job_id: string }>(
    `${base}/jobs${tokenParam}`,
    { method: "POST", body, authToken: opts.authToken },
  );
  return { jobId: res.job_id };
}

/**
 * GET /jobs/{jobId} — Job 상태 및 결과를 조회한다.
 */
export async function fetchJob(opts: {
  serverUrl: string;
  authToken: string;
  jobId: string;
}): Promise<JobResponse> {
  const base = wsUrlToHttp(opts.serverUrl);
  const tokenParam = opts.authToken ? `?token=${encodeURIComponent(opts.authToken)}` : "";
  return fetchJson<JobResponse>(`${base}/jobs/${opts.jobId}${tokenParam}`, { authToken: opts.authToken });
}
