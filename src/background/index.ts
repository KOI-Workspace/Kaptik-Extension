import type {
  BroadcastMessage,
  RequestMessage,
  ResponseMessage,
} from "@/shared/messaging";
import type { Member, Platform, SubtitleCue, SubtitleTrack } from "@/types/subtitle";
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
  removeAvailable,
  isLocalJobDone,
  markCuesReady,
  areCuesReady,
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
interface LiveSession {
  sessionId: string;
  platform: Platform;
  videoId: string;
  captureStartVideoTime: number;
  cues: SubtitleCue[];
  pending: Map<number, { text_ko: string; speaker: string; cached: boolean }>;
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

/** YouTube 플레이어에서 caption trackKind를 읽어온다 (MAIN world 실행) */
async function fetchTrackKind(tabId: number): Promise<string | undefined> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          type YTPlayer = HTMLElement & {
            getPlayerResponse?: () => {
              captions?: {
                playerCaptionsTracklistRenderer?: {
                  captionTracks?: Array<{ kind?: string }>;
                };
              };
            };
          };
          const player = document.getElementById("movie_player") as YTPlayer | null;
          const tracks = player?.getPlayerResponse?.()
            ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          const track = tracks?.[0];
          if (!track) return undefined;
          return track.kind === "asr" ? "ASR" : "standard";
        } catch {
          return undefined;
        }
      },
    });
    return results[0]?.result ?? undefined;
  } catch {
    return undefined;
  }
}

/** 팝업처럼 sender.tab이 없는 경우 활성 YouTube 탭 ID를 조회한다 */
async function resolveYoutubeTabId(senderTabId: number | undefined): Promise<number | undefined> {
  if (senderTabId) return senderTabId;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: "*://*.youtube.com/*" });
  return tabs[0]?.id;
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
): Promise<ResponseMessage> {
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
  senderTabId: number | undefined,
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

  // YouTube만 지원 (타 플랫폼은 라이브 스트리밍 경로)
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // job 생성 전 track_kind 조회 — 서버가 파이프라인(ASR vs 스크립트 번역)을 결정하는 데 사용
  const tabId = await resolveYoutubeTabId(senderTabId);
  const trackKind = tabId ? await fetchTrackKind(tabId) : undefined;
  console.info(`[Kaptik BG] track_kind=${trackKind ?? "없음"} (${videoId})`);

  let jobId: string;
  try {
    const result = await createJob({ serverUrl, authToken, url, targetLang: language, trackKind, force: force || undefined });
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
  const settings = await getSettings();
  const { serverUrl, language, devMode } = settings;
  const authToken = devMode ? "dev" : settings.authToken;

  // 기존 라이브 세션 정리
  const prev = liveSessions.get(tabId);
  if (prev) {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    liveSessions.delete(tabId);
  }

  const sessionId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const session: LiveSession = {
    sessionId,
    platform,
    videoId,
    captureStartVideoTime,
    cues: [],
    pending: new Map(),
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
    console.error("[Kaptik BG Live] tabCapture.getMediaStreamId 실패:", e);
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
    videoUrl,
  }).catch(() => {});

  console.info(`[Kaptik BG Live] 라이브 스트리밍 시작 tabId=${tabId} platform=${platform} sessionId=${sessionId}`);
  return { type: "STREAMING_STARTED" };
}

function handleStopLiveStreaming(tabId: number): void {
  const session = liveSessions.get(tabId);
  if (!session) return;
  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  liveSessions.delete(tabId);

  // 다른 라이브 세션이 없으면 오프스크린 닫기
  if (liveSessions.size === 0) {
    void closeOffscreen();
  }
  console.info(`[Kaptik BG Live] 라이브 스트리밍 중단 tabId=${tabId}`);
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
    });
    console.debug(`[Kaptik BG Live] STT stage1 ts=${ts}ms: "${text_ko}"`);
    return;
  }

  if (data.stage === 2 && !data.streaming) {
    const ts = Number(data.ts);
    const p = session.pending.get(ts);
    if (!p) return;
    session.pending.delete(ts);

    // cached cue는 룸 생성 시점 기준 절대 ts이므로 captureStartVideoTime offset 적용 안 함
    const start = p.cached ? ts / 1000 : ts / 1000 + offset;
    const cue: SubtitleCue = {
      start,
      end: start + 6,
      speakerId: p.speaker || undefined,
      text: { ko: p.text_ko, en: String(data.text_en ?? "") },
      annotations: (data.annotations as SubtitleCue["annotations"]) ?? [],
    };

    session.cues.push(cue);
    session.cues.sort((a, b) => a.start - b.start);

    console.info(`[Kaptik BG Live] CUE #${session.cues.length} → tab ${tabId}: [ko] "${p.text_ko}" / [en] "${String(data.text_en ?? "")}" (ts=${ts}ms, cached=${p.cached})`);

    const msg: BroadcastMessage = { type: "CUE_READY", videoId: session.videoId, cues: [...session.cues] };
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
  trackKind?: string,
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
    cues.push(newCue);
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
        trackKind,
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
        console.error("[Kaptik BG Live] 라이브 스트림 오류:", message.message);
        return false;
      } else if (message.type === "LIVE_WS_CLOSED") {
        console.info(`[Kaptik BG Live] 라이브 WS 종료 code=${message.code}`);
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
            return await handleGetStatus(req.platform, req.videoId, req.language);
          case "START_GENERATION":
            return await handleStartGeneration(sender.tab?.id, req.platform, req.videoId, req.force, req.language);
          case "START_STREAMING": {
            const tabId = sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return await handleStartStreaming(
              tabId,
              req.youtubeUrl,
              req.seekSec,
              req.serverUrl,
              req.keepCues ?? false,
              req.trackKind,
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
            const tabId = sender.tab?.id;
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
          case "GET_TRACK_KIND": {
            const tabId = await resolveYoutubeTabId(sender.tab?.id);
            if (!tabId) return { type: "TRACK_KIND_OK" };
            return { type: "TRACK_KIND_OK", trackKind: await fetchTrackKind(tabId) };
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
