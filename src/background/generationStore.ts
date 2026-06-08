import type { Platform, SubtitleStatus } from "@/types/subtitle";

/**
 * 백엔드(Kaptik API) 개발 전까지 자막 생성 흐름을 로컬에서 시뮬레이션하는 저장소.
 * 실제 API가 붙으면 background가 먼저 API를 호출하고, 실패할 때만 이 시뮬레이션으로 폴백한다.
 *
 * 상태 규칙:
 * - 생성 완료된 영상 → available
 * - 생성 진행 중 → generating (경과 시간으로 진행률/ETA 계산)
 * - 그 외 → none
 */

/** 데모용 생성 소요 시간(ms). 실제로는 영상 길이에 비례. */
const DEFAULT_DURATION_MS = 12_000;

const JOBS_KEY = "kaptik:jobs";
const DONE_KEY = "kaptik:available";

interface Job {
  platform: Platform;
  videoId: string;
  startedAt: number;
  durationMs: number;
}

function keyOf(platform: Platform, videoId: string): string {
  return `${platform}:${videoId}`;
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

async function markDone(key: string): Promise<boolean> {
  const done = await readDone();
  if (done.includes(key)) return false; // 이미 완료 처리됨
  done.push(key);
  await chrome.storage.local.set({ [DONE_KEY]: done });
  // 완료된 job 제거
  const jobs = await readJobs();
  if (jobs[key]) {
    delete jobs[key];
    await writeJobs(jobs);
  }
  return true; // 이번에 새로 완료 전이됨
}

/** 현재 상태를 계산한다 (필요 시 완료 전이 처리). */
export async function getLocalStatus(
  platform: Platform,
  videoId: string,
): Promise<SubtitleStatus> {
  const key = keyOf(platform, videoId);
  const done = await readDone();
  if (done.includes(key)) return { state: "available" };

  const jobs = await readJobs();
  const job = jobs[key];
  // 백엔드 미연결 개발 단계: mock 자막은 모든 영상에 항상 존재하므로,
  // 생성 기록이 없어도 바로 볼 수 있도록 available로 간주한다.
  // (실제 백엔드가 붙으면 fetchSubtitleStatus가 우선 적용되어 none/generating을 정확히 반환)
  if (!job) return { state: "available" };

  const elapsed = Date.now() - job.startedAt;
  if (elapsed >= job.durationMs) {
    await markDone(key);
    return { state: "available" };
  }
  return {
    state: "generating",
    etaSeconds: Math.ceil((job.durationMs - elapsed) / 1000),
    progress: Math.min(0.99, elapsed / job.durationMs),
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
  durationMs: number = DEFAULT_DURATION_MS,
): Promise<number> {
  const key = keyOf(platform, videoId);
  const jobs = await readJobs();
  jobs[key] = { platform, videoId, startedAt: Date.now(), durationMs };
  await writeJobs(jobs);
  return Math.ceil(durationMs / 1000);
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
