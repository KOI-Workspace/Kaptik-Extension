import type {
  BroadcastMessage,
  RequestMessage,
  ResponseMessage,
} from "@/shared/messaging";
import type { Platform, SubtitleCue, SubtitleStatus, SubtitleTrack } from "@/types/subtitle";
import {
  fetchSubtitleStatus,
  fetchSubtitleTrack,
  requestGeneration,
} from "@/api/client";
import { getSettings } from "@/shared/settings";
import {
  completeLocalJob,
  getLocalStatus,
  startLocalJob,
} from "./generationStore";
import { StreamingSession } from "@/api/wsClient";

/** 자막 트랙 메모리 캐시 (서비스 워커 생존 동안 유효) */
const trackCache = new Map<string, SubtitleTrack>();

/** tabId → 현재 스트리밍 세션 + 누적 cue 배열 */
const streamingSessions = new Map<number, { session: StreamingSession; cues: SubtitleCue[] }>();

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
  let status: SubtitleStatus;
  try {
    // 1순위: 실제 백엔드
    status = await fetchSubtitleStatus(platform, videoId);
  } catch {
    // 폴백: 로컬 시뮬레이션
    status = await getLocalStatus(platform, videoId);
  }
  return { type: "STATUS_OK", status };
}

// ── 자막 생성 시작 ────────────────────────────────────────
async function handleStartGeneration(
  platform: Platform,
  videoId: string,
): Promise<ResponseMessage> {
  let etaSeconds: number;
  try {
    // 실제 백엔드가 있으면 eta를 받아옴
    const result = await requestGeneration(platform, videoId);
    etaSeconds = result.etaSeconds;
    await startLocalJob(platform, videoId, etaSeconds * 1000);
  } catch {
    // 폴백: 로컬 작업 시작 (기본 소요 시간)
    etaSeconds = await startLocalJob(platform, videoId);
  }

  // 완료 시점에 알림/브로드캐스트 (서비스 워커는 작업 직후 살아있으므로 setTimeout으로 충분)
  setTimeout(() => {
    void onGenerationComplete(platform, videoId);
  }, etaSeconds * 1000 + 200);

  return { type: "GENERATION_STARTED", etaSeconds };
}

/** 생성 완료 처리: 상태 전이 + 알림 + 탭 브로드캐스트 */
async function onGenerationComplete(
  platform: Platform,
  videoId: string,
): Promise<void> {
  const newlyDone = await completeLocalJob(platform, videoId);
  if (!newlyDone) return; // 이미 처리됨 (중복 방지)

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

// ── 스트리밍 세션 관리 ────────────────────────────────────

function handleStartStreaming(
  tabId: number,
  youtubeUrl: string,
  seekSec: number,
  serverUrl: string,
  keepCues: boolean,
): ResponseMessage {
  const prev = streamingSessions.get(tabId);
  prev?.session.disconnect();

  const cues: SubtitleCue[] = keepCues ? (prev?.cues ?? []) : [];

  const session = new StreamingSession(
    youtubeUrl,
    seekSec,
    serverUrl,
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
});

// ── 메시지 라우팅 ─────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (message: RequestMessage, sender, sendResponse) => {
    const route = async (): Promise<ResponseMessage> => {
      try {
        switch (message.type) {
          case "GET_SUBTITLES":
            return await handleGetSubtitles(message.platform, message.videoId);
          case "GET_STATUS":
            return await handleGetStatus(message.platform, message.videoId);
          case "START_GENERATION":
            return await handleStartGeneration(message.platform, message.videoId);
          case "START_STREAMING": {
            const tabId = sender.tab?.id;
            if (!tabId) return { type: "ERR", error: "tabId 없음" };
            return handleStartStreaming(
              tabId,
              message.youtubeUrl,
              message.seekSec,
              message.serverUrl,
              message.keepCues ?? false,
            );
          }
          case "STOP_STREAMING": {
            const tabId = sender.tab?.id;
            if (tabId) {
              streamingSessions.get(tabId)?.session.disconnect();
              streamingSessions.delete(tabId);
              console.info(`[Kaptik BG] 스트리밍 중단 tabId=${tabId}`);
            }
            return { type: "ERR", error: "" }; // 응답 불필요, 빈 응답
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
  if (streamingSessions.size > 0) {
    console.debug(`[Kaptik BG] keepalive (활성 세션 ${streamingSessions.size}개)`);
  }
}, 20_000);

// 클릭 시 알림 닫기
chrome.notifications?.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
});
