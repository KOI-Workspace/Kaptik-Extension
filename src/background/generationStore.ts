import type { Platform, SubtitleCue, SubtitleStatus } from "@/types/subtitle";

/**
 * 백엔드(Kaptik API) 개발 전까지 자막 생성 흐름을 로컬에서 시뮬레이션하는 저장소.
 * 실제 API가 붙으면 background가 먼저 API를 호출하고, 실패할 때만 이 시뮬레이션으로 폴백한다.
 *
 * 상태 규칙:
 * - 생성 완료된 영상 → available
 * - 생성 진행 중 → generating (경과 시간으로 진행률/ETA 계산)
 * - 그 외 → none
 */

/** 로컬 폴백 기준 소요 시간(ms). 백엔드 pct가 오면 오버라이드됨. */
const DEFAULT_DURATION_MS = 300_000;

const JOBS_KEY = "kaptik:jobs";
const DONE_KEY = "kaptik:available";
const CUES_KEY = "kaptik:cues_ready";
/** videoId 키 → 생성 시 사용된 언어 코드 */
const GEN_LANG_KEY = "kaptik:gen_lang";
/** 월간 한도 초과(quota_exceeded)가 발생한 platform:videoId 목록 */
const MONTHLY_LIMIT_KEY = "kaptik:monthly_limit";
const LIVE_CUES_KEY = "kaptik:live_cues";
const MAX_LIVE_CUES_PER_LANG = 1000;

interface Job {
  platform: Platform;
  videoId: string;
  startedAt: number;
  durationMs: number;
  /** 생성 요청 시 사용된 언어 코드 */
  language?: string;
  /** 백엔드 ws-job 진행 메시지에서 수신한 실제 진행률 (0~1) */
  pct?: number;
  /** 마지막 pct 수신 타임스탬프 (ETA 속도 계산용) */
  pctAt?: number;
  /** 그 이전 pct 값 */
  prevPct?: number;
  /** 그 이전 pct 타임스탬프 */
  prevPctAt?: number;
  /** 백엔드 ws-job 진행 메시지에서 수신한 현재 단계 */
  step?: string;
}

function keyOf(platform: Platform, videoId: string): string {
  return `${platform}:${videoId}`;
}

function liveCueKey(platform: Platform, videoId: string, language: string): string {
  return `${platform}:${videoId}:${language}`;
}

async function readJobs(): Promise<Record<string, Job>> {
  const r = await chrome.storage.local.get(JOBS_KEY);
  return (r[JOBS_KEY] ?? {}) as Record<string, Job>;
}

async function writeJobs(jobs: Record<string, Job>): Promise<void> {
  await chrome.storage.local.set({ [JOBS_KEY]: jobs });
}

async function readDone(): Promise<string[]> {
  const r = await chrome.storage.local.get(DONE_KEY);
  return (r[DONE_KEY] ?? []) as string[];
}

async function readCuesReady(): Promise<string[]> {
  const r = await chrome.storage.local.get(CUES_KEY);
  return (r[CUES_KEY] ?? []) as string[];
}

async function readGenLang(): Promise<Record<string, string>> {
  const r = await chrome.storage.local.get(GEN_LANG_KEY);
  return (r[GEN_LANG_KEY] ?? {}) as Record<string, string>;
}

/**
 * 모든 주요 저장소 데이터를 한 번에 읽는다. (성능 최적화)
 * @returns 배열 순서: [jobs, done, cuesReady, genLang, monthlyLimit]
 */
async function readAll(): Promise<[Record<string, Job>, string[], string[], Record<string, string>, string[]]> {
  const data = await chrome.storage.local.get([JOBS_KEY, DONE_KEY, CUES_KEY, GEN_LANG_KEY, MONTHLY_LIMIT_KEY]);
  return [
    (data[JOBS_KEY] ?? {}) as Record<string, Job>,
    (data[DONE_KEY] ?? []) as string[],
    (data[CUES_KEY] ?? []) as string[],
    (data[GEN_LANG_KEY] ?? {}) as Record<string, string>,
    (data[MONTHLY_LIMIT_KEY] ?? []) as string[],
  ];
}

/**
 * 여러 저장소 값을 한 번에 쓴다. (성능 최적화)
 */
async function writeAll(
  jobs: Record<string, Job>,
  done: string[],
  cues: string[],
  genLang: Record<string, string>,
  monthlyLimit: string[],
): Promise<void> {
  await chrome.storage.local.set({
    [JOBS_KEY]: jobs,
    [DONE_KEY]: done,
    [CUES_KEY]: cues,
    [GEN_LANG_KEY]: genLang,
    [MONTHLY_LIMIT_KEY]: monthlyLimit,
  });
}

export async function markCuesReady(platform: Platform, videoId: string): Promise<void> {
  const key = keyOf(platform, videoId);
  const list = await readCuesReady();
  if (list.includes(key)) return;
  list.push(key);
  await chrome.storage.local.set({ [CUES_KEY]: list });
}

export async function areCuesReady(platform: Platform, videoId: string): Promise<boolean> {
  const list = await readCuesReady();
  return list.includes(keyOf(platform, videoId));
}

async function readLiveCuesMap(): Promise<Record<string, SubtitleCue[]>> {
  const r = await chrome.storage.local.get(LIVE_CUES_KEY);
  return (r[LIVE_CUES_KEY] ?? {}) as Record<string, SubtitleCue[]>;
}

export async function readLiveCues(
  platform: Platform,
  videoId: string,
  language: string,
): Promise<SubtitleCue[]> {
  const map = await readLiveCuesMap();
  return map[liveCueKey(platform, videoId, language)] ?? [];
}

export async function writeLiveCues(
  platform: Platform,
  videoId: string,
  language: string,
  cues: SubtitleCue[],
): Promise<void> {
  const map = await readLiveCuesMap();
  map[liveCueKey(platform, videoId, language)] = cues
    .slice(-MAX_LIVE_CUES_PER_LANG)
    .sort((a, b) => a.start - b.start);
  await chrome.storage.local.set({ [LIVE_CUES_KEY]: map });
}

/** 부작용 없이 완료 여부만 확인한다 (완료 전이 감지용). */
export async function isLocalJobDone(platform: Platform, videoId: string): Promise<boolean> {
  const done = await readDone();
  return done.includes(keyOf(platform, videoId));
}

async function markDone(key: string): Promise<boolean> {
  // jobs와 done을 한 번에 읽는다 (배치 최적화)
  const [jobs, done] = await Promise.all([readJobs(), readDone()]);
  if (done.includes(key)) return false; // 이미 완료 처리됨
  done.push(key);
  // 완료된 job 제거
  if (jobs[key]) {
    delete jobs[key];
  }
  // 한 번의 storage 쓰기로 모두 처리
  await Promise.all([
    writeJobs(jobs),
    chrome.storage.local.set({ [DONE_KEY]: done }),
  ]);
  return true; // 이번에 새로 완료 전이됨
}

/** 현재 상태를 계산한다 (필요 시 완료 전이 처리). */
export async function getLocalStatus(
  platform: Platform,
  videoId: string,
  currentLanguage?: string,
): Promise<SubtitleStatus> {
  const key = keyOf(platform, videoId);
  // 모든 저장소 데이터를 한 번에 읽는다 (배치 최적화)
  const [jobs, done, cuesReady, genLang, monthlyLimit] = await readAll();

  if (monthlyLimit.includes(key)) {
    return { state: "monthly_limit" };
  }

  if (done.includes(key)) {
    // 생성 시 사용된 언어와 현재 요청 언어가 다르면 아직 해당 언어 자막 없음.
    // gen_lang 항목이 없는 구버전 데이터도 언어 불명으로 간주해 재생성 요구.
    if (currentLanguage) {
      const storedLang = genLang[key];
      if (!storedLang || storedLang !== currentLanguage) {
        return { state: "none" };
      }
    }
    if (cuesReady.includes(key)) return { state: "available" };
    return { state: "generating", progress: 0.99, etaSeconds: 0, step: "cues_loading" };
  }

  const job = jobs[key];
  if (!job) return { state: "none" };

  const elapsed = Date.now() - job.startedAt;
  if (elapsed >= job.durationMs) {
    await markDone(key);
    return { state: "available" };
  }

  // ETA: 백엔드 pct 속도(dpct/dt)로 계산, 데이터 부족하면 로컬 타이머 폴백
  let etaSeconds: number;
  if (
    job.pct !== undefined &&
    job.prevPct !== undefined &&
    job.pctAt !== undefined &&
    job.prevPctAt !== undefined
  ) {
    const dt = (job.pctAt - job.prevPctAt) / 1000;
    const dpct = job.pct - job.prevPct;
    if (dpct > 0 && dt > 0) {
      etaSeconds = Math.ceil((1 - job.pct) / (dpct / dt));
    } else {
      etaSeconds = Math.max(0, Math.ceil((job.durationMs - elapsed) / 1000));
    }
  } else {
    etaSeconds = Math.max(0, Math.ceil((job.durationMs - elapsed) / 1000));
  }

  // 백엔드 pct가 없을 때의 폴백 진행률.
  // 기존 min(0.99, elapsed/duration)은 예상 시간을 넘기면 99%에 '하드 정지'해
  // 멈춘 듯 보였다. 예상 시간(frac=1)까지는 95%까지 선형으로 차오르고, 이후엔
  // 99%를 향해 점근(천천히 접근)시켜 초과되더라도 미세하게나마 계속 전진하게 한다.
  const frac = elapsed / job.durationMs;
  const fallbackProgress =
    frac < 1 ? frac * 0.95 : Math.min(0.99, 0.95 + 0.04 * (1 - Math.exp(-(frac - 1))));

  return {
    state: "generating",
    etaSeconds,
    progress: job.pct ?? fallbackProgress,
    step: job.step,
  };
}

/**
 * 로컬 생성 작업을 시작한다.
 * @param durationMs 소요 시간 (실제 API가 eta를 주면 그 값을 사용)
 * @returns 예상 소요 시간(초)
 */
export async function startLocalJob(
  platform: Platform,
  videoId: string,
  language: string,
  durationMs: number = DEFAULT_DURATION_MS,
): Promise<number> {
  const key = keyOf(platform, videoId);
  const [jobs, genLang, mlData] = await Promise.all([
    readJobs(),
    readGenLang(),
    chrome.storage.local.get(MONTHLY_LIMIT_KEY),
  ]);
  jobs[key] = { platform, videoId, startedAt: Date.now(), durationMs, language };
  genLang[key] = language;
  // 서버가 job을 수락했으므로 이 영상의 monthly_limit 플래그를 해제한다
  const monthlyLimit = ((mlData[MONTHLY_LIMIT_KEY] ?? []) as string[]).filter((k) => k !== key);
  await Promise.all([
    writeJobs(jobs),
    chrome.storage.local.set({ [GEN_LANG_KEY]: genLang, [MONTHLY_LIMIT_KEY]: monthlyLimit }),
  ]);
  return Math.ceil(durationMs / 1000);
}

/** 월간 한도 초과(quota_exceeded) 상태를 storage에 기록한다. 이후 poll이 monthly_limit을 반환한다. */
export async function setMonthlyLimit(platform: Platform, videoId: string): Promise<void> {
  const key = keyOf(platform, videoId);
  const r = await chrome.storage.local.get(MONTHLY_LIMIT_KEY);
  const list = (r[MONTHLY_LIMIT_KEY] ?? []) as string[];
  if (!list.includes(key)) {
    list.push(key);
    await chrome.storage.local.set({ [MONTHLY_LIMIT_KEY]: list });
  }
}

/**
 * ws-job 진행 메시지로 수신한 실제 진행률과 단계를 저장한다.
 */
export async function updateJobProgress(
  platform: Platform,
  videoId: string,
  step: string,
  pct: number,
): Promise<void> {
  const key = keyOf(platform, videoId);
  const jobs = await readJobs();
  if (jobs[key]) {
    const prev = jobs[key];
    jobs[key] = {
      ...prev,
      step,
      prevPct: prev.pct,
      prevPctAt: prev.pctAt,
      pct,
      pctAt: Date.now(),
    };
    await writeJobs(jobs);
  }
}

/**
 * 작업을 완료 상태로 전이한다.
 * @returns 이번 호출에서 새로 완료된 경우 true (알림/브로드캐스트 트리거용)
 */
export async function completeLocalJob(
  platform: Platform,
  videoId: string,
): Promise<boolean> {
  return markDone(keyOf(platform, videoId));
}

/** 현재 진행 중인 job이 있으면 true. 라이브 세션 시작 전 concurrent 체크에 사용. */
export async function hasActiveJobs(): Promise<boolean> {
  const jobs = await readJobs();
  return Object.keys(jobs).length > 0;
}

/** 지정된 videoId 외에 다른 진행 중인 job이 있으면 true. VOD 시작 전 concurrent 체크에 사용. */
export async function hasActiveJobForOtherVideo(platform: Platform, videoId: string): Promise<boolean> {
  const jobs = await readJobs();
  const thisKey = keyOf(platform, videoId);
  return Object.keys(jobs).some(k => k !== thisKey);
}

export async function removeAvailable(platform: Platform, videoId: string): Promise<void> {
  const key = keyOf(platform, videoId);
  // 모든 저장소 데이터를 한 번에 읽는다 (배치 최적화)
  const [jobs, done, cues, genLang, monthlyLimit] = await readAll();
  delete jobs[key];
  delete genLang[key];
  // 배치 쓰기로 한 번의 storage 작업으로 처리
  await writeAll(
    jobs,
    done.filter((k) => k !== key),
    cues.filter((k) => k !== key),
    genLang,
    monthlyLimit, // monthly_limit 항목은 그대로 유지
  );
}
