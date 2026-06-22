import type {
  BroadcastMessage,
  RequestMessage,
  ResponseMessage,
} from "@/shared/messaging";
import type { LanguageCode, Member, Platform, SubtitleCue, SubtitleTrack } from "@/types/subtitle";
import { resolveMemberByName } from "@/shared/members";
import {
  fetchSubtitleTrack,
  createJob,
  fetchLiveSubtitles,
} from "@/api/client";
import { getSettings } from "@/shared/settings";
import {
  getLocalStatus,
  startLocalJob,
  updateJobProgress,
  completeLocalJob,
  removeAvailable,
  isLocalJobDone,
  markCuesReady,
  areCuesReady,
  readLiveCues,
  writeLiveCues,
} from "./generationStore";
import { StreamingSession } from "@/api/wsClient";
import { MockStreamingSession } from "@/api/mockStreamingSession";

/** 자막 트랙 메모리 캐시 (서비스 워커 생존 동안 유효) */
const trackCache = new Map<string, SubtitleTrack>();

/** tabId → 현재 스트리밍 세션 + 누적 cue 배열 (devMode면 MockStreamingSession) */
const streamingSessions = new Map<
  number,
  { session: StreamingSession | MockStreamingSession; cues: SubtitleCue[] }
>();

/** tabId → 라이브 스트리밍 세션 상태 */
interface AdPeriod {
  startMs: number;
  endMs: number | null; // null = 아직 재생 중
}

interface LiveSession {
  sessionId: string;
  platform: Platform;
  videoId: string;
  videoUrl?: string;
  captureStartVideoTime: number;
  /** 현재 서버에 요청 중인 번역 언어. */
  language: string;
  /** 언어별 독립 cue 배열. 언어를 바꿔도 이전 언어 내용을 버리지 않아, 돌아오면 이어서 볼 수 있다. */
  cuesByLang: Map<string, SubtitleCue[]>;
  pending: Map<number, { text_ko: string; speaker: string; cached: boolean; startMs: number; language: string }>;
  /** 광고 구간(영상 시각 ms). startMs~endMs 사이 ts를 가진 cue는 렌더링 제외 */
  adPeriods: AdPeriod[];
  /** 마지막으로 확인한 광고 상태. stage 메시지 도착 시 즉시 필터링에도 사용한다. */
  isAdPlaying: boolean;
  /** 마지막으로 알려진 영상 재생 위치(ms) — 광고 구간 계산에 사용 */
  lastKnownVideoMs: number;
  /** content의 현재 재생 위치를 주기적으로 offscreen에 전달하는 타이머 (타임싱크용) */
  timeSyncTimer?: ReturnType<typeof setInterval>;
}
const liveSessions = new Map<number, LiveSession>();

/** jobId → 진행 모니터링 WebSocket */
const jobSockets = new Map<string, WebSocket>();

// ── 오프스크린 문서 관리 ─────────────────────────────────

async function ensureOffscreen(): Promise<void> {
  // chrome.offscreen is Chrome 109+
  const offscreen = (chrome as unknown as Record<string, unknown>).offscreen as {
    createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  } | undefined;
  if (!offscreen) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (existingContexts.length > 0) return;

  await offscreen.createDocument({
    url: chrome.runtime.getURL("src/offscreen/index.html"),
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture tab audio for live stream transcription",
  });
}

async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function closeOffscreen(): Promise<void> {
  const offscreen = (chrome as unknown as Record<string, unknown>).offscreen as {
    closeDocument?(): Promise<void>;
  } | undefined;
  if (!offscreen?.closeDocument) return;
  try {
    await offscreen.closeDocument();
  } catch { /* already closed */ }
  // closeDocument resolve 후에도 문맥이 잠시 남을 수 있어 실제 소멸까지 폴링 확인
  for (let i = 0; i < 20; i++) {
    if (!(await offscreenExists())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * tabCapture stream ID를 획득한다.
 * "active stream" 에러(SW 재시작 후 offscreen 잔여 캡처)는 정리 후 재시도한다.
 */
async function acquireStreamId(tabId: number): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("getMediaStreamId timeout: 콜백이 5초 내에 응답하지 않음"));
        }, 5000);
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 잔여 캡처가 탭을 점유 중 → offscreen 정리 후 재시도
      if (msg.includes("active stream") && attempt < 2) {
        console.warn(`[Kaptik BG Live] active stream 점유 감지 — 정리 후 재시도 (${attempt + 1}/3)`);
        try {
          await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
        } catch { /* offscreen 미존재 시 무시 */ }
        await new Promise((r) => setTimeout(r, 200));
        await closeOffscreen();
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
  throw new Error("getMediaStreamId 재시도 실패: active stream을 해제하지 못함");
}

function cacheKey(platform: string, videoId: string): string {
  return `${platform}:${videoId}`;
}

/** 서버 ts가 0/비정상일 때 화면 표시용 영상 시간을 안전하게 보정한다. */
function normalizeLiveCueStartMs(session: LiveSession, rawTs: number): number {
  if (Number.isFinite(rawTs) && rawTs > 0) return Math.round(rawTs);
  // 1차 폴백: background가 폴링한 실제 영상 위치
  if (session.lastKnownVideoMs > 0) {
    console.warn(`[Kaptik BG Live] 비정상 cue ts=${rawTs} → videoMs=${session.lastKnownVideoMs}로 보정`);
    return Math.round(session.lastKnownVideoMs);
  }
  // 2차 폴백: videoMs도 0인 경우 (라이브 스트림 시작 직후 currentTime=0 상황).
  // 현재 언어의 마지막 cue 이후로 배치해 단조 증가를 보장한다.
  const currentCues = session.cuesByLang.get(session.language) ?? [];
  if (currentCues.length > 0) {
    const lastMs = Math.round(currentCues[currentCues.length - 1].start * 1000) + 3000;
    console.warn(`[Kaptik BG Live] 비정상 cue ts=${rawTs}, videoMs=0 → 직전 cue 기준 ${lastMs}ms로 추정`);
    return lastMs;
  }
  console.warn(`[Kaptik BG Live] 비정상 cue ts=${rawTs}, videoMs=0, 첫 cue → 0으로 처리`);
  return 0;
}

function isWithinAdPeriod(session: LiveSession, startMs: number): boolean {
  return session.adPeriods.some(
    (period) => startMs >= period.startMs && (period.endMs === null || startMs <= period.endMs),
  );
}

async function fetchStoredLiveCuesFromServer(
  platform: Platform,
  videoId: string,
  language: string,
  videoUrl?: string,
): Promise<SubtitleCue[]> {
  if (!videoUrl) return [];
  try {
    const settings = await getSettings();
    const authToken = settings.devMode ? "dev" : settings.authToken;
    const cues = await fetchLiveSubtitles({
      serverUrl: settings.serverUrl,
      authToken,
      videoUrl,
      targetLang: language as LanguageCode,
    });
    if (cues.length > 0) {
      await writeLiveCues(platform, videoId, language, cues);
    }
    return cues;
  } catch (e) {
    console.warn(`[Kaptik BG Live] 서버 저장 자막 조회 실패 (${platform}/${videoId}):`, e);
    return [];
  }
}


// ── 자막 트랙 ─────────────────────────────────────────────
async function handleGetSubtitles(
  platform: Platform,
  videoId: string,
): Promise<ResponseMessage> {
  const key = cacheKey(platform, videoId);
  const cached = trackCache.get(key);
  if (cached) return { type: "SUBTITLES_OK", track: cached };

  const track = await fetchSubtitleTrack(platform, videoId);
  trackCache.set(key, track);
  return { type: "SUBTITLES_OK", track };
}

// ── 상태 조회 ─────────────────────────────────────────────
async function handleGetStatus(
  platform: Platform,
  videoId: string,
  msgLanguage?: string,
  videoUrl?: string,
): Promise<ResponseMessage> {
  // YouTube가 아닌 플랫폼(Weverse 등)은 오디오 캡처 경로를 사용한다.
  // - 활성 세션 + 번역 자막(cue) 1개 이상 도착 → "available" (설정 패널 표시)
  // - 활성 세션 있으나 아직 첫 자막 전 → "generating" (캡처 중, 첫 자막 대기)
  // - 세션 없음 → "none" (Start 버튼 표시 — 새로고침/재진입 후 항상 Start를 다시 눌러야 함)
  if (platform !== "youtube") {
    const session = [...liveSessions.values()].find(
      (s) => s.platform === platform && s.videoId === videoId,
    );
    const settings = await getSettings();
    const language = msgLanguage ?? settings.language;
    if (!session) {
      return { type: "STATUS_OK", status: { state: "none" } };
    }
    // 현재 언어 칠판에 cue가 하나라도 있으면 available (언어를 방금 바꿔서 아직 새 cue가 없더라도
    // 이전에 해당 언어로 쌓인 게 있으면 available로 처리 — 화면에 이미 복원돼 있음)
    const currentLangCues = session.cuesByLang.get(session.language) ?? [];
    if (currentLangCues.length > 0) {
      return { type: "STATUS_OK", status: { state: "available" } };
    }
    const storedCues = await readLiveCues(platform, videoId, language);
    if (storedCues.length > 0) {
      return { type: "STATUS_OK", status: { state: "available" } };
    }
    const serverCues = await fetchStoredLiveCuesFromServer(platform, videoId, language, videoUrl);
    if (serverCues.length > 0) {
      return { type: "STATUS_OK", status: { state: "available" } };
    }
    return { type: "STATUS_OK", status: { state: "generating", etaSeconds: 0, progress: 0 } };
  }
  const settings = await getSettings();
  // 호출자가 language를 직접 전달하면 우선 사용 — storage 쓰기 완료 전 race condition 방지
  const language = msgLanguage ?? settings.language;
  const wasDone = await isLocalJobDone(platform, videoId);
  // 현재 언어를 전달해 다른 언어로 생성된 자막은 "none"으로 처리
  const status = await getLocalStatus(platform, videoId, language);
  // getLocalStatus 내부에서 막 완료/실패 전이됐는데, 전이 핸들러(setTimeout 등)가
  // 같은 타이밍에 먼저 가져가 버려 SUBTITLES_READY를 못 보내는 경쟁을 방지
  if (!wasDone) {
    if (status.state === "available") void onGenerationComplete(platform, videoId);
    else if (status.state === "failed") void broadcastReady(platform, videoId);
  }
  return { type: "STATUS_OK", status };
}

// ── 자막 생성 시작 ────────────────────────────────────────
async function handleStartGeneration(
  platform: Platform,
  videoId: string,
  force = false,
  msgLanguage?: string,
): Promise<ResponseMessage> {
  const settings = await getSettings();
  // 메시지에 language가 있으면 우선 사용 — 팝업이 patch()와 동시에 요청을 보낼 때 스토리지 쓰기 완료 전에 백그라운드가 구 언어를 읽는 race condition 방지
  const language = msgLanguage ?? settings.language;
  const { serverUrl, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  if (force) {
    // 강제 재생성: 이전 언어 자막 초기화
    await removeAvailable(platform, videoId);
  } else {
    // 현재 언어 기준으로 상태 확인 — 다른 언어로 생성된 자막은 "none"으로 처리됨
    const currentStatus = await getLocalStatus(platform, videoId, language);
    if (currentStatus.state === "generating") {
      return { type: "GENERATION_STARTED", etaSeconds: currentStatus.etaSeconds ?? 0 };
    }
    if (currentStatus.state === "available") {
      return { type: "GENERATION_STARTED", etaSeconds: 0 };
    }
    // state === "none": 언어 불일치로 인한 재생성 포함 — 이전 상태 초기화
    await removeAvailable(platform, videoId);
  }

  // devMode: 백엔드 없이 기존 mock 자막 데이터로 생성 흐름을 재현 (화면 상태 확인용)
  if (devMode) {
    const etaSeconds = await startLocalJob(platform, videoId, language);
    setTimeout(() => {
      void completeLocalJob(platform, videoId).then((becameDone) => {
        if (becameDone) void onGenerationComplete(platform, videoId);
      });
    }, etaSeconds * 1000);
    return { type: "GENERATION_STARTED", etaSeconds };
  }

  // YouTube만 VOD job 지원 — 다른 플랫폼은 라이브 스트리밍 경로를 사용해야 함
  if (platform !== "youtube") {
    return { type: "ERR", error: `${platform} VOD 자막 생성은 지원하지 않습니다` };
  }
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let jobId: string;
  try {
    const result = await createJob({ serverUrl, authToken, url, targetLang: language, force: force || undefined });
    jobId = result.jobId;
  } catch (e) {
    console.error("[Kaptik BG] Job 생성 실패:", e);
    return { type: "ERR", error: e instanceof Error ? e.message : "Job 생성 실패" };
  }

  // 로컬 상태를 generating으로 전이 — 팝업 폴링이 즉시 반영되도록
  const etaSeconds = await startLocalJob(platform, videoId, language);

  openJobSocket(jobId, platform, videoId, serverUrl, authToken);
  return { type: "GENERATION_STARTED", etaSeconds };
}

/** /ws-job/{jobId} WebSocket을 열어 진행 상황을 모니터링한다. */
function openJobSocket(
  jobId: string,
  platform: Platform,
  videoId: string,
  serverUrl: string,
  authToken: string,
): void {
  const token = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
  const ws = new WebSocket(`${serverUrl}/ws-job/${jobId}${token}`);
  jobSockets.set(jobId, ws);

  const finish = () => {
    if (!jobSockets.has(jobId)) return; // 이미 완료 처리됨
    ws.close();
    jobSockets.delete(jobId);
    void completeLocalJob(platform, videoId);
    void onGenerationComplete(platform, videoId);
  };

  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(e.data) as Record<string, unknown>;
      if (msg.type === "progress") {
        const step = String(msg.step ?? "");
        const pct = Number(msg.pct ?? 0);
        console.info(`[Kaptik BG YT] Job ${jobId} 진행: step=${step} pct=${pct}`);
        void updateJobProgress(platform, videoId, step, pct);
      } else if (msg.type === "done") {
        console.info(`[Kaptik BG YT] Job ${jobId} 완료 total_cues=${String(msg.total_cues ?? 0)}`);
        finish();
      } else if (msg.type === "error") {
        console.error(`[Kaptik BG YT] Job ${jobId} 오류:`, String(msg.message ?? ""));
                ws.close();
        jobSockets.delete(jobId);
      }
    } catch { /* malformed JSON */ }
  };

  ws.onerror = () => {
    console.error(`[Kaptik BG YT] Job socket 오류 jobId=${jobId}`);
        jobSockets.delete(jobId);
  };

  ws.onclose = () => {
        jobSockets.delete(jobId);
  };
}

/** 생성 완료 처리: 탭 브로드캐스트 (알림은 cues 로딩 완료 후 발동) */
async function onGenerationComplete(
  platform: Platform,
  videoId: string,
): Promise<void> {
  await broadcastReady(platform, videoId);
  // 폴백: MV3 SW는 30초 idle 후 종료될 수 있으므로 setTimeout 대신 chrome.alarms 사용.
  // 60초 내 스트리밍이 완료되지 않으면 알람 핸들러가 강제로 완료 처리한다.
  chrome.alarms.create(`cues-ready:${platform}:${videoId}`, { delayInMinutes: 1 });
}

/** cues 로딩 완료 시 Chrome 알림 발동 */
async function notifySubtitlesReady(platform: Platform, videoId: string): Promise<void> {
  const settings = await getSettings();
  if (settings.notifyOnReady) {
    chrome.notifications.create(`kaptik:${platform}:${videoId}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "Kaptik 자막 준비 완료",
      message: "번역 자막이 생성됐어요. 영상에서 자막을 켜보세요!",
      priority: 2,
    });
  }
}

/** 열려 있는 YouTube/Weverse 탭에 생성 완료를 알린다. */
async function broadcastReady(platform: Platform, videoId: string): Promise<void> {
  const message: BroadcastMessage = { type: "SUBTITLES_READY", platform, videoId };
  const tabs = await chrome.tabs.query({
    url: [
      "*://*.youtube.com/*",
      "*://*.weverse.io/*",
      "*://*.instagram.com/*",
    ],
  });
  for (const tab of tabs) {
    if (tab.id != null) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        /* content script 미주입 탭은 무시 */
      });
    }
  }
}

// ── 라이브 스트리밍 ──────────────────────────────────────

async function handleStartLiveStreaming(
  tabId: number,
  platform: Platform,
  videoId: string,
  captureStartVideoTime: number,
  videoTitle?: string,
  videoUrl?: string,
): Promise<ResponseMessage> {
  console.info(`[Kaptik BG Live] handleStartLiveStreaming 진입 tabId=${tabId} platform=${platform} videoId=${videoId}`);

  const settings = await getSettings();
  const { serverUrl, language, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  // 같은 영상의 세션이 이미 활성화 중이면 재시작하지 않는다
  // (버퍼링 후 playing 이벤트가 중복 발생해도 세션이 끊기지 않도록)
  const prev = liveSessions.get(tabId);
  if (prev && prev.videoId === videoId) {
    console.info(`[Kaptik BG Live] 이미 활성 세션 있음 (dedup) tabId=${tabId} videoId=${videoId}`);
    // 이미 캡처 중이어도 content가 (재주입 등으로) 아직 마운트 안 했을 수 있으므로 알림
    chrome.tabs.sendMessage(tabId, { type: "LIVE_CAPTURE_STARTED", videoId } satisfies BroadcastMessage).catch(() => {});
    return { type: "STREAMING_STARTED" };
  }
  // 다른 영상의 기존 세션 정리
  if (prev) {
    if (prev.timeSyncTimer) clearInterval(prev.timeSyncTimer);
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    liveSessions.delete(tabId);
  }

  const sessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const session: LiveSession = {
    sessionId,
    platform,
    videoId,
    videoUrl,
    captureStartVideoTime,
    language,
    cuesByLang: new Map(),
    pending: new Map(),
    adPeriods: [],
    isAdPlaying: false,
    lastKnownVideoMs: captureStartVideoTime * 1000,
  };
  liveSessions.set(tabId, session);

  // SW 재시작 후 offscreen 잔여 스트림이 탭을 점유할 수 있으므로
  // 캡처를 새로 시작하기 전에 기존 offscreen 문서를 확실히 정리한다.
  // (liveSessions는 SW 재시작 시 비지만 offscreen 문서/스트림은 살아있을 수 있음)
  if (await offscreenExists()) {
    console.info("[Kaptik BG Live] 기존 offscreen 발견 — 정리 후 새 캡처 시작");
    try {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } catch { /* 무시 */ }
    await new Promise((r) => setTimeout(r, 200));
    await closeOffscreen();
  }

  let streamId: string;
  try {
    console.info(`[Kaptik BG Live] getMediaStreamId 호출 중 tabId=${tabId}`);
    streamId = await acquireStreamId(tabId);
    console.info(`[Kaptik BG Live] getMediaStreamId 성공 streamId=${streamId.slice(0, 20)}...`);
  } catch (e) {
    liveSessions.delete(tabId);
    console.error("[Kaptik BG Live] tabCapture.getMediaStreamId 실패:", e);
    return { type: "ERR", error: e instanceof Error ? e.message : "tabCapture 실패" };
  }

  await ensureOffscreen();

  // 캡처 시작 전 광고 상태 확인 → 프리롤 광고가 재생 중이면 처음부터 무음 처리
  let initialMuted = false;
  try {
    const adState = await chrome.tabs.sendMessage(tabId, { type: "GET_AD_STATE" });
    if (typeof adState === "boolean" && adState) {
      initialMuted = true;
      session.isAdPlaying = true;
      session.adPeriods.push({ startMs: 0, endMs: null });
      console.info(`[Kaptik BG Live] 캡처 시작 시 광고 감지 → 초기 무음 모드`);
    }
  } catch { /* content script 미응답 무시 */ }

  chrome.runtime.sendMessage({
    type: "CAPTURE_TAB",
    streamId,
    sessionId,
    serverUrl,
    authToken,
    targetLang: language,
    videoTitle,
    videoUrl,
    captureStartSec: captureStartVideoTime,
    initialMuted,
  }).catch(() => {});

  // content의 현재 재생 위치(초)를 0.5초마다 받아 offscreen에 전달 → 서버가 자막을 영상 위치에 정확히 꽂음.
  // 점프(seek)해도 다음 폴링에서 즉시 반영되므로 라이브 되감기/VOD 앞뒤 점프 모두 정렬됨.
  // null 대신 false로 초기화 — null일 때 첫 폴링에서 false가 오면 "광고 종료"가 오발되는 버그 방지
  let lastAdState: boolean = initialMuted ? true : false;
  session.timeSyncTimer = setInterval(() => {
    chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_TIME" })
      .then((t: unknown) => {
        if (typeof t === "number" && Number.isFinite(t)) {
          session.lastKnownVideoMs = Math.round(t * 1000);
          chrome.runtime.sendMessage({ type: "UPDATE_VIDEO_TIME", videoMs: session.lastKnownVideoMs }).catch(() => {});
        }
      })
      .catch(() => { /* content script 미응답 무시 */ });

    // 광고 상태를 같은 주기로 확인하고 광고 구간(adPeriods)을 기록.
    // 감지 지연(최대 500ms)과 STT 파이프라인 지연을 감안해 구간 전후에 여유를 둔다.
    chrome.tabs.sendMessage(tabId, { type: "GET_AD_STATE" })
      .then((isAd: unknown) => {
        if (typeof isAd !== "boolean") return;
        session.isAdPlaying = isAd;
        if (isAd !== lastAdState) {
          lastAdState = isAd;
          if (isAd) {
            // 광고 시작: 감지 지연 2초를 소급 적용
            const startMs = Math.max(0, session.lastKnownVideoMs - 2000);
            session.adPeriods.push({ startMs, endMs: null });
            console.info(`[Kaptik BG Live] 광고 감지 → 무음 처리 (tab ${tabId}, startMs=${startMs})`);
          } else {
            // 광고 종료: STT 파이프라인 지연(최대 5초)을 감안해 endMs에 버퍼 추가
            const last = session.adPeriods[session.adPeriods.length - 1];
            if (last && last.endMs === null) {
              last.endMs = session.lastKnownVideoMs + 5000;
            }
            console.info(`[Kaptik BG Live] 광고 종료 → 캡처 재개 (tab ${tabId}, endMs=${session.adPeriods[session.adPeriods.length - 1]?.endMs})`);
          }
        }
        chrome.runtime.sendMessage({ type: "SET_CAPTURE_MUTED", muted: isAd }).catch(() => {});
      })
      .catch(() => { /* content script 미응답 무시 */ });
  }, 500);

  console.info(`[Kaptik BG Live] 라이브 스트리밍 시작 tabId=${tabId} platform=${platform} sessionId=${sessionId}`);
  // content가 자막 UI를 즉시 마운트하도록 알림 (1500ms 주기 evaluate를 기다리지 않음)
  chrome.tabs.sendMessage(tabId, { type: "LIVE_CAPTURE_STARTED", videoId } satisfies BroadcastMessage).catch(() => {});
  return { type: "STREAMING_STARTED" };
}

function handleStopLiveStreaming(tabId: number): void {
  const session = liveSessions.get(tabId);
  if (!session) return;
  if (session.timeSyncTimer) clearInterval(session.timeSyncTimer);
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  // content가 자막 UI를 즉시 언마운트하도록 알림
  chrome.tabs.sendMessage(tabId, { type: "LIVE_CAPTURE_STOPPED", videoId: session.videoId } satisfies BroadcastMessage).catch(() => {});
  liveSessions.delete(tabId);

  // 다른 라이브 세션이 없으면 오프스크린 닫기
  if (liveSessions.size === 0) {
    void closeOffscreen();
  }
  console.info(`[Kaptik BG Live] 라이브 스트리밍 중단 tabId=${tabId}`);
}

/**
 * 라이브 캡처 중 번역 언어를 전환한다 (방식 A: 캡처는 유지, 서버 번역 언어만 교체).
 * 언어가 바뀌면 "아예 새로운 자막"으로 취급해 이전 언어 cue를 모두 버리고 화면을 비운다.
 * 광고 구간(adPeriods)·타임싱크 등 나머지 상태는 그대로 유지되므로 광고 차단도 끊김 없이 동작한다.
 */
function handleSetLiveLang(tabId: number, language: string): void {
  const session = liveSessions.get(tabId);
  if (session) {
    if (session.language === language) return; // 동일 언어면 무시
    session.language = language;
    // 언어 변경 전 요청의 stage2가 뒤늦게 도착하면 언어가 섞여 보일 수 있어 대기 중인 조각은 버린다.
    session.pending.clear();
    // 해당 언어 칠판으로 전환. 이전에 쌓인 cue가 있으면 즉시 화면에 복원.
    const existingCues = session.cuesByLang.get(language) ?? [];
    const msg: BroadcastMessage = { type: "CUE_READY", videoId: session.videoId, cues: existingCues };
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    if (existingCues.length === 0) {
      void readLiveCues(session.platform, session.videoId, language).then((storedCues) => {
        if (session.language !== language) return;
        if (storedCues.length > 0) return storedCues;
        return fetchStoredLiveCuesFromServer(session.platform, session.videoId, language, session.videoUrl);
      }).then((cues) => {
        if (!cues || cues.length === 0 || session.language !== language) return;
        session.cuesByLang.set(language, cues);
        const storedMsg: BroadcastMessage = { type: "CUE_READY", videoId: session.videoId, cues };
        chrome.tabs.sendMessage(tabId, storedMsg).catch(() => {});
      });
    }
    console.info(`[Kaptik BG Live] 라이브 언어 전환 → ${language} (tab ${tabId}, 기존 cue ${existingCues.length}개 복원)`);
  }
  // offscreen이 활성 WS로 set_lang을 보내도록 전달 (이후 자막부터 새 언어로 번역됨)
  chrome.runtime.sendMessage({ type: "SET_LANG", sessionId: session?.sessionId, language }).catch(() => {});
}

/** 오프스크린에서 전달된 STT 메시지를 처리해 CUE_READY를 브로드캐스트한다. */
function handleLiveCueMsg(tabId: number, data: Record<string, unknown>): void {
  const session = liveSessions.get(tabId);
  if (!session) return;

  if (data.type === "speaker_identified") {
    const speakerId = String(data.speaker ?? "");
    const name = String(data.name ?? "");
    const member = resolveMemberByName(name);
    if (member) {
      console.info(`[Kaptik BG Live] 라이브 화자 식별 → tab ${tabId}: ${speakerId} = ${member.name}`);
      const msg: BroadcastMessage = { type: "SPEAKER_IDENTIFIED", speakerId, name, member };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
    return;
  }

  if (data.stage === 1) {
    const ts = Number(data.ts);
    const text_ko = String(data.text_ko ?? "");
    session.pending.set(ts, {
      text_ko,
      speaker: String(data.speaker ?? ""),
      cached: Boolean(data.cached),
      startMs: normalizeLiveCueStartMs(session, ts),
      language: session.language,
    });
    console.debug(`[Kaptik BG Live] STT stage1 ts=${ts}ms: "${text_ko}"`);
    return;
  }

  if (data.stage === 2 && !data.streaming) {
    const ts = Number(data.ts);
    const p = session.pending.get(ts);
    if (!p) return;
    session.pending.delete(ts);
    const startMs = p.startMs > 0 ? p.startMs : normalizeLiveCueStartMs(session, ts);

    // 광고 구간 ts 필터: 감지 전/파이프라인 지연으로 서버에 전송된 광고 음성을 렌더링에서 제외
    const isAdCue = session.isAdPlaying || isWithinAdPeriod(session, startMs);
    if (isAdCue) {
      console.info(`[Kaptik BG Live] 광고 구간 CUE 필터 (ts=${startMs}ms, rawTs=${ts}ms): "${p.text_ko}"`);
      return;
    }

    // 서버 ts가 0으로 고정되는 경우가 있어 stage1 시점에 저장한 영상 시간으로 보정한다.
    const start = startMs / 1000;
    // 번역 텍스트는 현재 세션 언어 키에 저장한다. en으로 하드코딩하면 일본어(ja)·인도네시아어(id) 등이
    // UI의 pickText(text, language)에서 매칭되지 않아 엉뚱한 폴백으로 표시된다.
    const cueLanguage = p.language;
    const translated = String(data.translation ?? "");
    // 번역이 빈 문자열이면 key를 포함하지 않는다.
    // "" 를 넣으면 pickText(text, "en")에서 nullish(??) 연산자가 ""를 유효값으로 보고 한국어 폴백을 막는다.
    const textMap: SubtitleCue["text"] = { ko: p.text_ko };
    if (translated) textMap[cueLanguage as LanguageCode] = translated;
    const cue: SubtitleCue = {
      start,
      end: start + 6,
      speakerId: p.speaker || undefined,
      text: textMap,
      annotations: (data.annotations as SubtitleCue["annotations"]) ?? [],
    };

    // 현재 언어 칠판에 upsert. 서버 cached cue 재전송 시 같은 시각 cue가 중복되지 않게 한다.
    const langCues = session.cuesByLang.get(cueLanguage) ?? [];
    const existingIdx = langCues.findIndex((existing) => Math.abs(existing.start - cue.start) < 0.05);
    if (existingIdx >= 0) {
      langCues[existingIdx] = cue;
    } else {
      langCues.push(cue);
    }
    langCues.sort((a, b) => a.start - b.start);
    session.cuesByLang.set(cueLanguage, langCues);
    void writeLiveCues(session.platform, session.videoId, cueLanguage, langCues);

    console.info(`[Kaptik BG Live] CUE #${langCues.length} → tab ${tabId}: [ko] "${p.text_ko}" / [${cueLanguage}] "${translated}" (ts=${startMs}ms, rawTs=${ts}ms, cached=${p.cached})`);

    if (cueLanguage !== session.language) return;
    const msg: BroadcastMessage = { type: "CUE_READY", videoId: session.videoId, cues: [...langCues] };
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

// ── 스트리밍 세션 관리 ────────────────────────────────────

async function handleStartStreaming(
  tabId: number,
  youtubeUrl: string,
  seekSec: number,
  serverUrl: string,
  keepCues: boolean,
  msgLanguage?: string,
): Promise<ResponseMessage> {
  const settings = await getSettings();
  // 메시지에 language가 있으면 우선 사용 — storage 쓰기 완료 전 race condition 방지
  const language = msgLanguage ?? settings.language;
  const { devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  let videoId: string;
  try {
    videoId = new URL(youtubeUrl).searchParams.get("v") ?? youtubeUrl;
  } catch {
    videoId = youtubeUrl;
  }

  const prev = streamingSessions.get(tabId);
  prev?.session.disconnect();

  const cues: SubtitleCue[] = keepCues
    ? (prev?.cues ?? []).filter((c) => c.start < seekSec)
    : [];

  const onCueReady = (newCue: SubtitleCue) => {
    const existingIdx = cues.findIndex((c) => c.start === newCue.start);
    if (existingIdx !== -1) {
      cues[existingIdx] = newCue;
    } else {
      cues.push(newCue);
    }
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
      cues[i] = { ...cues[i], end: Math.min(cues[i].end, cues[i + 1].start - 0.1) };
    }
    console.info(`[Kaptik BG YT] CUE #${cues.length} → tab ${tabId}: "${newCue.text.en}" (t=${newCue.start.toFixed(1)}s)`);
    const msg: BroadcastMessage = { type: "CUE_READY", videoId, cues: [...cues] };
    chrome.tabs.sendMessage(tabId, msg).catch((e: unknown) => {
      console.warn(`[Kaptik BG YT] sendMessage 실패 tabId=${tabId}:`, e);
    });
  };

  const onSpeakerIdentified = (speakerId: string, name: string, member: Member) => {
    console.info(`[Kaptik BG YT] 화자 식별 → tab ${tabId}: ${speakerId} = ${member.name}`);
    const msg: BroadcastMessage = { type: "SPEAKER_IDENTIFIED", speakerId, name, member };
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  };

  // devMode: 백엔드 없이 기존 mock 대화로 스트리밍을 재현 (화면 상태 확인용)
  const session: StreamingSession | MockStreamingSession = devMode
    ? new MockStreamingSession(seekSec, onCueReady, onSpeakerIdentified)
    : new StreamingSession(
        youtubeUrl,
        seekSec,
        serverUrl,
        authToken,
        language,
        onCueReady,
        (err, code) => {
          console.error(`[Kaptik BG YT] 스트리밍 오류 tabId=${tabId}:`, err);
          const msg: BroadcastMessage = { type: "STREAMING_ERROR", message: err };
          chrome.tabs.sendMessage(tabId, msg).catch(() => {});
          if (code === "not_found") {
            // cues가 이미 로드된 경우(재생/탐색 후 재연결 시도)에는 available 상태를 보존한다
            void areCuesReady("youtube", videoId).then((loaded) => {
              if (!loaded) void removeAvailable("youtube", videoId);
            });
          }
        },
        (totalCues) => {
          console.info(`[Kaptik BG YT] 스트리밍 완료 tabId=${tabId} totalCues=${totalCues}`);
          streamingSessions.delete(tabId);
          void markCuesReady("youtube", videoId);
          const doneMsg: BroadcastMessage = { type: "CUES_ALL_READY", platform: "youtube", videoId };
          chrome.tabs.sendMessage(tabId, doneMsg).catch(() => {});
          void notifySubtitlesReady("youtube", videoId);
        },
        onSpeakerIdentified,
      );

  streamingSessions.set(tabId, { session, cues });
  session.connect();
  console.info(`[Kaptik BG YT] 스트리밍 시작 tabId=${tabId} seek=${seekSec}s${devMode ? " (mock)" : ""}`);
  return { type: "STREAMING_STARTED" };
}

// 탭이 닫히면 세션 정리
chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = streamingSessions.get(tabId);
  if (entry) {
    entry.session.disconnect();
    streamingSessions.delete(tabId);
  }
  if (liveSessions.has(tabId)) {
    handleStopLiveStreaming(tabId);
  }
});

// ── 메시지 라우팅 ─────────────────────────────────────────

/** 오프스크린 → 백그라운드 내부 메시지 */
type OffscreenMessage =
  | { type: "LIVE_CUE_MSG"; sessionId: string; data: Record<string, unknown> }
  | { type: "LIVE_STREAM_ERROR"; sessionId?: string; message: string }
  | { type: "LIVE_WS_CLOSED"; sessionId?: string; code: number; reason: string };

chrome.runtime.onMessage.addListener(
  (message: RequestMessage | OffscreenMessage, sender, sendResponse) => {
    // 오프스크린에서 오는 STT 결과 메시지
    if (
      message.type === "LIVE_CUE_MSG" ||
      message.type === "LIVE_STREAM_ERROR" ||
      message.type === "LIVE_WS_CLOSED"
    ) {
      if (message.type === "LIVE_CUE_MSG") {
        const matched = [...liveSessions.entries()].find(
          ([, session]) => session.sessionId === message.sessionId,
        );
        if (matched) {
          handleLiveCueMsg(matched[0], message.data);
        } else {
          console.info(`[Kaptik BG Live] 세션 불일치 cue 무시 sessionId=${message.sessionId}`);
        }
      } else if (message.type === "LIVE_STREAM_ERROR") {
        console.error(`[Kaptik BG Live] 라이브 스트림 오류 sessionId=${message.sessionId ?? "unknown"}:`, message.message);
        return false;
      } else if (message.type === "LIVE_WS_CLOSED") {
        console.info(`[Kaptik BG Live] 라이브 WS 종료 sessionId=${message.sessionId ?? "unknown"} code=${message.code}`);
      }
      sendResponse(null);
      return false;
    }

    const route = async (): Promise<ResponseMessage> => {
      try {
        const req = message as RequestMessage;
        switch (req.type) {
          case "GET_SUBTITLES":
            return await handleGetSubtitles(req.platform, req.videoId);
          case "GET_STATUS":
            return await handleGetStatus(req.platform, req.videoId, req.language, req.videoUrl);
          case "START_GENERATION":
            return await handleStartGeneration(req.platform, req.videoId, req.force, req.language);
          case "START_STREAMING": {
            const tabId = sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return await handleStartStreaming(
              tabId,
              req.youtubeUrl,
              req.seekSec,
              req.serverUrl,
              req.keepCues ?? false,
              req.language,
            );
          }
          case "STOP_STREAMING": {
            const tabId = sender.tab?.id;
            if (tabId) {
              streamingSessions.get(tabId)?.session.disconnect();
              streamingSessions.delete(tabId);
              console.info(`[Kaptik BG YT] 스트리밍 중단 tabId=${tabId}`);
            }
            return { type: "ERR", error: "" };
          }
          case "START_LIVE_STREAMING": {
            // req.tabId: 팝업에서 보낸 경우 sender.tab이 없으므로 메시지에 명시
            const tabId = req.tabId ?? sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return await handleStartLiveStreaming(
              tabId,
              req.platform,
              req.videoId,
              req.captureStartVideoTime,
              req.videoTitle,
              req.videoUrl,
            );
          }
          case "STOP_LIVE_STREAMING": {
            const tabId = sender.tab?.id;
            if (tabId) handleStopLiveStreaming(tabId);
            return { type: "ERR", error: "" };
          }
          case "GET_LIVE_CUES": {
            const tabId = sender.tab?.id;
            const session = tabId != null ? liveSessions.get(tabId) : undefined;
            if (!session) {
              if (!req.platform || !req.videoId || !req.language) {
                return { type: "LIVE_CUES", videoId: "", cues: [] };
              }
              const localCues = await readLiveCues(req.platform, req.videoId, req.language);
              if (localCues.length > 0) {
                return { type: "LIVE_CUES", videoId: req.videoId, cues: localCues };
              }
              return {
                type: "LIVE_CUES",
                videoId: req.videoId,
                cues: await fetchStoredLiveCuesFromServer(
                  req.platform,
                  req.videoId,
                  req.language,
                  req.videoUrl,
                ),
              };
            }
            if (req.platform && req.videoId && req.language) {
              const langCues = session.cuesByLang.get(session.language) ?? [];
              if (langCues.length === 0) {
                const serverCues = await fetchStoredLiveCuesFromServer(
                  req.platform,
                  req.videoId,
                  req.language,
                  req.videoUrl,
                );
                if (serverCues.length > 0) {
                  session.cuesByLang.set(req.language, serverCues);
                  return { type: "LIVE_CUES", videoId: session.videoId, cues: serverCues };
                }
              }
            }
            return {
              type: "LIVE_CUES",
              videoId: session.videoId,
              cues: [...(session.cuesByLang.get(session.language) ?? [])],
            };
          }
          case "IS_LIVE_ACTIVE": {
            // 팝업은 sender.tab이 없으므로 메시지의 tabId를 우선 사용
            const tabId = req.tabId ?? sender.tab?.id;
            return { type: "LIVE_ACTIVE", active: tabId != null && liveSessions.has(tabId) };
          }
          case "SET_LIVE_LANG": {
            handleSetLiveLang(req.tabId, req.language);
            return { type: "ERR", error: "" };
          }
          default:
            return { type: "ERR", error: "알 수 없는 메시지" };
        }
      } catch (error) {
        console.error("[Kaptik BG] 예기치 않은 오류:", error);
        return {
          type: "ERR",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };
    route().then(sendResponse);
    return true; // 비동기 응답 채널 유지
  },
);

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[Kaptik] 설치/업데이트: ${details.reason}`);
});

// cues-ready 알람: 스트리밍이 자연 완료되지 않은 경우 강제 전환 후 재브로드캐스트
chrome.alarms.onAlarm.addListener((alarm) => {
  const match = alarm.name.match(/^cues-ready:([^:]+):(.+)$/);
  if (!match) return;
  const [, platform, videoId] = match;
  void (async () => {
    const alreadyReady = await areCuesReady(platform as Platform, videoId);
    if (alreadyReady) return; // 스트리밍이 정상 완료됨 → 처리 불필요
    // 스트리밍 미완료 → 강제로 ready 처리 후 SUBTITLES_READY 재브로드캐스트
    // content script가 이를 받아 startStreamingFn을 재호출해 cues를 로드한다.
    await markCuesReady(platform as Platform, videoId);
    await broadcastReady(platform as Platform, videoId);
  })();
});

// 스트리밍 세션이 활성 중일 때 서비스 워커가 sleep되지 않도록 20초마다 ping
// (MV3 SW는 30초 idle 후 종료되어 WS 연결이 끊김)
setInterval(() => {
  const total = streamingSessions.size + liveSessions.size;
  if (total > 0) {
    console.debug(`[Kaptik BG] keepalive (VOD ${streamingSessions.size}개, 라이브 ${liveSessions.size}개)`);
  }
}, 20_000);

// 클릭 시 알림 닫기
chrome.notifications?.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
});
