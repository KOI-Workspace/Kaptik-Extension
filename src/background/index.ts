import type {
  BroadcastMessage,
  RequestMessage,
  ResponseMessage,
} from "@/shared/messaging";
import type { Platform, SubtitleCue, SubtitleTrack } from "@/types/subtitle";
import { resolveMemberByName } from "@/shared/members";
import {
  fetchSubtitleTrack,
  createJob,
} from "@/api/client";
import { getSettings } from "@/shared/settings";
import {
  getLocalStatus,
  startLocalJob,
  updateJobProgress,
  completeLocalJob,
} from "./generationStore";
import { StreamingSession } from "@/api/wsClient";

/** 자막 트랙 메모리 캐시 (서비스 워커 생존 동안 유효) */
const trackCache = new Map<string, SubtitleTrack>();

/** tabId → 현재 스트리밍 세션 + 누적 cue 배열 */
const streamingSessions = new Map<number, { session: StreamingSession; cues: SubtitleCue[] }>();

/** tabId → 라이브 스트리밍 세션 상태 */
interface LiveSession {
  sessionId: string;
  platform: Platform;
  videoId: string;
  captureStartVideoTime: number;
  captureStartWallTime: number;
  cues: SubtitleCue[];
  pending: Map<number, { text_ko: string; speaker: string }>;
  seekSent: boolean;
  seekTimer: ReturnType<typeof setTimeout> | null;
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
    reasons: ["AUDIO_CAPTURE"],
    justification: "Capture tab audio for live stream transcription",
  });
}

async function closeOffscreen(): Promise<void> {
  const offscreen = (chrome as unknown as Record<string, unknown>).offscreen as {
    closeDocument?(): Promise<void>;
  } | undefined;
  if (!offscreen?.closeDocument) return;
  try {
    await offscreen.closeDocument();
  } catch { /* already closed */ }
}

function cacheKey(platform: string, videoId: string): string {
  return `${platform}:${videoId}`;
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
): Promise<ResponseMessage> {
  // 폴백: 로컬 시뮬레이션 (실제 백엔드는 ws-job으로 진행 추적)
  const status = await getLocalStatus(platform, videoId);
  return { type: "STATUS_OK", status };
}

// ── 자막 생성 시작 ────────────────────────────────────────
async function handleStartGeneration(
  platform: Platform,
  videoId: string,
): Promise<ResponseMessage> {
  const settings = await getSettings();
  const { serverUrl, language, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  // YouTube만 지원 (타 플랫폼은 라이브 스트리밍 경로)
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let jobId: string;
  try {
    const result = await createJob({ serverUrl, authToken, url, targetLang: language });
    jobId = result.jobId;
  } catch (e) {
    console.error("[Kaptik BG] Job 생성 실패:", e);
    return { type: "ERR", error: e instanceof Error ? e.message : "Job 생성 실패" };
  }

  // 로컬 상태를 generating으로 전이 — 팝업 폴링이 즉시 반영되도록
  const etaSeconds = await startLocalJob(platform, videoId);

  openJobSocket(jobId, platform, videoId, serverUrl, authToken, devMode);
  return { type: "GENERATION_STARTED", etaSeconds };
}

/** /ws-job/{jobId} WebSocket을 열어 진행 상황을 모니터링한다. */
function openJobSocket(
  jobId: string,
  platform: Platform,
  videoId: string,
  serverUrl: string,
  authToken: string,
  devMode = false,
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

  // devMode: 60초 후 강제 완료 — 긴 영상도 1분치 생성되면 바로 확인 가능
  let devTimer: ReturnType<typeof setTimeout> | undefined;
  if (devMode) {
    devTimer = setTimeout(() => {
      console.info(`[Kaptik BG] devMode 60s 강제 완료 jobId=${jobId}`);
      finish();
    }, 60_000);
  }

  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(e.data) as Record<string, unknown>;
      if (msg.type === "progress") {
        const step = String(msg.step ?? "");
        const pct = Number(msg.pct ?? 0);
        console.info(`[Kaptik BG] Job ${jobId} 진행: step=${step} pct=${pct}`);
        void updateJobProgress(platform, videoId, step, pct);
      } else if (msg.type === "done") {
        console.info(`[Kaptik BG] Job ${jobId} 완료 total_cues=${String(msg.total_cues ?? 0)}`);
        clearTimeout(devTimer);
        finish();
      } else if (msg.type === "error") {
        console.error(`[Kaptik BG] Job ${jobId} 오류:`, String(msg.message ?? ""));
        clearTimeout(devTimer);
        ws.close();
        jobSockets.delete(jobId);
      }
    } catch { /* malformed JSON */ }
  };

  ws.onerror = () => {
    console.error(`[Kaptik BG] Job socket 오류 jobId=${jobId}`);
    clearTimeout(devTimer);
    jobSockets.delete(jobId);
  };

  ws.onclose = () => {
    clearTimeout(devTimer);
    jobSockets.delete(jobId);
  };
}

/** 생성 완료 처리: 알림 + 탭 브로드캐스트 */
async function onGenerationComplete(
  platform: Platform,
  videoId: string,
): Promise<void> {
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

  await broadcastReady(platform, videoId);
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
): Promise<ResponseMessage> {
  const settings = await getSettings();
  const { serverUrl, language, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  // 기존 라이브 세션 정리
  const prev = liveSessions.get(tabId);
  if (prev) {
    prev.seekTimer && clearTimeout(prev.seekTimer);
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    liveSessions.delete(tabId);
  }

  const sessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const session: LiveSession = {
    sessionId,
    platform,
    videoId,
    captureStartVideoTime,
    captureStartWallTime: Date.now(),
    cues: [],
    pending: new Map(),
    seekSent: false,
    seekTimer: null,
  };
  liveSessions.set(tabId, session);

  let streamId: string;
  try {
    streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });
  } catch (e) {
    liveSessions.delete(tabId);
    console.error("[Kaptik BG] tabCapture.getMediaStreamId 실패:", e);
    return { type: "ERR", error: e instanceof Error ? e.message : "tabCapture 실패" };
  }

  await ensureOffscreen();

  chrome.runtime.sendMessage({
    type: "CAPTURE_TAB",
    streamId,
    sessionId,
    serverUrl,
    authToken,
    targetLang: language,
    videoTitle,
  }).catch(() => {});

  // 30초 후 아직 seek를 보내지 않았으면 SEEK_AND_SHOW 발송
  session.seekTimer = setTimeout(() => {
    const live = liveSessions.get(tabId);
    if (live && !live.seekSent) {
      live.seekSent = true;
      const msg: BroadcastMessage = { type: "SEEK_AND_SHOW", seekSec: 30 };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      console.info(`[Kaptik BG] SEEK_AND_SHOW tabId=${tabId}`);
    }
  }, 30_000);

  console.info(`[Kaptik BG] 라이브 스트리밍 시작 tabId=${tabId} sessionId=${sessionId}`);
  return { type: "STREAMING_STARTED" };
}

function handleStopLiveStreaming(tabId: number): void {
  const session = liveSessions.get(tabId);
  if (!session) return;
  session.seekTimer && clearTimeout(session.seekTimer);
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  liveSessions.delete(tabId);

  // 다른 라이브 세션이 없으면 오프스크린 닫기
  if (liveSessions.size === 0) {
    void closeOffscreen();
  }
  console.info(`[Kaptik BG] 라이브 스트리밍 중단 tabId=${tabId}`);
}

/** 오프스크린에서 전달된 STT 메시지를 처리해 CUE_READY를 브로드캐스트한다. */
function handleLiveCueMsg(tabId: number, data: Record<string, unknown>): void {
  const session = liveSessions.get(tabId);
  if (!session) return;

  const offset = session.captureStartVideoTime;

  if (data.type === "speaker_identified") {
    const speakerId = String(data.speaker ?? "");
    const name = String(data.name ?? "");
    const member = resolveMemberByName(name);
    if (member) {
      console.info(`[Kaptik BG] 라이브 화자 식별 → tab ${tabId}: ${speakerId} = ${member.name}`);
      const msg: BroadcastMessage = { type: "SPEAKER_IDENTIFIED", speakerId, name, member };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    }
    return;
  }

  if (data.stage === 1) {
    const ts = Number(data.ts);
    session.pending.set(ts, {
      text_ko: String(data.text_ko ?? ""),
      speaker: String(data.speaker ?? ""),
    });
    return;
  }

  if (data.stage === 2 && !data.streaming) {
    const ts = Number(data.ts);
    const p = session.pending.get(ts);
    if (!p) return;
    session.pending.delete(ts);

    const start = ts / 1000 + offset;
    const cue: SubtitleCue = {
      start,
      end: start + 6,
      speakerId: p.speaker || undefined,
      text: { ko: p.text_ko, en: String(data.text_en ?? "") },
      annotations: (data.annotations as SubtitleCue["annotations"]) ?? [],
    };

    session.cues.push(cue);
    session.cues.sort((a, b) => a.start - b.start);

    const msg: BroadcastMessage = { type: "CUE_READY", cues: [...session.cues] };
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});

    // 첫 cue가 도착하고 30초 분량(ts >= 30s)이면 즉시 SEEK_AND_SHOW
    if (!session.seekSent && ts >= 30_000) {
      session.seekSent = true;
      session.seekTimer && clearTimeout(session.seekTimer);
      const seekMsg: BroadcastMessage = { type: "SEEK_AND_SHOW", seekSec: 30 };
      chrome.tabs.sendMessage(tabId, seekMsg).catch(() => {});
      console.info(`[Kaptik BG] 조기 SEEK_AND_SHOW (ts=${ts}ms) tabId=${tabId}`);
    }
  }
}

// ── 스트리밍 세션 관리 ────────────────────────────────────

async function handleStartStreaming(
  tabId: number,
  youtubeUrl: string,
  seekSec: number,
  serverUrl: string,
  keepCues: boolean,
): Promise<ResponseMessage> {
  const settings = await getSettings();
  const { language, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  // onDone → broadcastReady 용으로 videoId 추출
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

  const session = new StreamingSession(
    youtubeUrl,
    seekSec,
    serverUrl,
    authToken,
    language,
    (newCue) => {
      cues.push(newCue);
      cues.sort((a, b) => a.start - b.start);
      for (let i = 0; i < cues.length - 1; i++) {
        cues[i] = { ...cues[i], end: Math.min(cues[i].end, cues[i + 1].start - 0.1) };
      }
      console.info(`[Kaptik BG] CUE #${cues.length} → tab ${tabId}: "${newCue.text.en}" (t=${newCue.start.toFixed(1)}s)`);
      const msg: BroadcastMessage = { type: "CUE_READY", cues: [...cues] };
      chrome.tabs.sendMessage(tabId, msg).catch((e: unknown) => {
        console.warn(`[Kaptik BG] sendMessage 실패 tabId=${tabId}:`, e);
      });
    },
    (err) => {
      console.error(`[Kaptik BG] 스트리밍 오류 tabId=${tabId}:`, err);
      const msg: BroadcastMessage = { type: "STREAMING_ERROR", message: err };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    },
    (totalCues) => {
      console.info(`[Kaptik BG] 스트리밍 완료 tabId=${tabId} totalCues=${totalCues}`);
      void broadcastReady("youtube", videoId);
    },
    (speakerId, name, member) => {
      console.info(`[Kaptik BG] 화자 식별 → tab ${tabId}: ${speakerId} = ${member.name}`);
      const msg: BroadcastMessage = { type: "SPEAKER_IDENTIFIED", speakerId, name, member };
      chrome.tabs.sendMessage(tabId, msg).catch(() => {});
    },
  );

  streamingSessions.set(tabId, { session, cues });
  session.connect();
  console.info(`[Kaptik BG] 스트리밍 시작 tabId=${tabId} seek=${seekSec}s`);
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
  | { type: "LIVE_CUE_MSG"; data: Record<string, unknown> }
  | { type: "LIVE_STREAM_ERROR"; message: string }
  | { type: "LIVE_WS_CLOSED"; code: number; reason: string };

chrome.runtime.onMessage.addListener(
  (message: RequestMessage | OffscreenMessage, sender, sendResponse) => {
    // 오프스크린에서 오는 STT 결과 메시지
    if (
      message.type === "LIVE_CUE_MSG" ||
      message.type === "LIVE_STREAM_ERROR" ||
      message.type === "LIVE_WS_CLOSED"
    ) {
      if (message.type === "LIVE_CUE_MSG") {
        for (const [tabId] of liveSessions) {
          handleLiveCueMsg(tabId, message.data);
        }
      } else if (message.type === "LIVE_STREAM_ERROR") {
        console.error("[Kaptik BG] 라이브 스트림 오류:", message.message);
      } else if (message.type === "LIVE_WS_CLOSED") {
        console.info(`[Kaptik BG] 라이브 WS 종료 code=${message.code}`);
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
            return await handleGetStatus(req.platform, req.videoId);
          case "START_GENERATION":
            return await handleStartGeneration(req.platform, req.videoId);
          case "START_STREAMING": {
            const tabId = sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return await handleStartStreaming(
              tabId,
              req.youtubeUrl,
              req.seekSec,
              req.serverUrl,
              req.keepCues ?? false,
            );
          }
          case "STOP_STREAMING": {
            const tabId = sender.tab?.id;
            if (tabId) {
              streamingSessions.get(tabId)?.session.disconnect();
              streamingSessions.delete(tabId);
              console.info(`[Kaptik BG] 스트리밍 중단 tabId=${tabId}`);
            }
            return { type: "ERR", error: "" };
          }
          case "START_LIVE_STREAMING": {
            const tabId = sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return await handleStartLiveStreaming(
              tabId,
              req.platform,
              req.videoId,
              req.captureStartVideoTime,
              req.videoTitle,
            );
          }
          case "STOP_LIVE_STREAMING": {
            const tabId = sender.tab?.id;
            if (tabId) handleStopLiveStreaming(tabId);
            return { type: "ERR", error: "" };
          }
          default:
            return { type: "ERR", error: "알 수 없는 메시지" };
        }
      } catch (error) {
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
