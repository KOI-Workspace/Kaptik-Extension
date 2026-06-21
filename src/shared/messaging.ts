import type { Member, Platform, SubtitleCue, SubtitleStatus, SubtitleTrack } from "@/types/subtitle";

/** content/popup → background 요청 메시지 */
export type RequestMessage =
  | { type: "GET_SUBTITLES"; platform: Platform; videoId: string }
  | { type: "GET_STATUS"; platform: Platform; videoId: string; language?: string }
  | { type: "START_GENERATION"; platform: Platform; videoId: string; force?: boolean; language?: string }
  | { type: "START_STREAMING"; youtubeUrl: string; seekSec: number; serverUrl: string; keepCues?: boolean; language?: string }
  | { type: "STOP_STREAMING" }
  | { type: "START_LIVE_STREAMING"; platform: Platform; videoId: string; captureStartVideoTime: number; videoTitle?: string; videoUrl?: string; tabId?: number }
  | { type: "STOP_LIVE_STREAMING" }
  // content가 "내 탭에 라이브 캡처 세션이 있나?"를 조회한다. (tabId 없으면 sender 탭 기준)
  // alwaysCapture(Weverse) 자막 UI를 Start 이후에만 마운트하기 위한 단일 진실 소스.
  | { type: "IS_LIVE_ACTIVE"; tabId?: number }
  // 라이브 캡처 중 자막 언어를 바꾼다 (offscreen WS에 set_lang 전송 → 이후 자막부터 새 언어).
  | { type: "SET_LIVE_LANG"; tabId: number; language: string };

/** background → 요청자 응답 메시지 */
export type ResponseMessage =
  | { type: "SUBTITLES_OK"; track: SubtitleTrack }
  | { type: "STATUS_OK"; status: SubtitleStatus }
  | { type: "GENERATION_STARTED"; etaSeconds: number }
  | { type: "STREAMING_STARTED" }
  | { type: "LIVE_ACTIVE"; active: boolean }
  | { type: "ERR"; error: string };

/** background → content 브로드캐스트 */
export type BroadcastMessage =
  | { type: "SUBTITLES_READY"; platform: Platform; videoId: string }
  | { type: "CUES_ALL_READY"; platform: Platform; videoId: string }
  | { type: "CUE_READY"; videoId: string; cues: SubtitleCue[] }
  | { type: "STREAMING_ERROR"; message: string }
  | { type: "SPEAKER_IDENTIFIED"; speakerId: string; name: string; member: Member }
  // alwaysCapture 캡처 세션 시작/종료 알림 → content가 자막 UI를 즉시 마운트/언마운트
  | { type: "LIVE_CAPTURE_STARTED"; videoId: string }
  | { type: "LIVE_CAPTURE_STOPPED"; videoId: string };

/** sendMessage 를 Promise로 감싸는 헬퍼 */
function send<R extends ResponseMessage>(
  message: RequestMessage,
): Promise<R | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: R | undefined) => {
      if (chrome.runtime.lastError || !response) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

/**
 * background로 자막 트랙을 요청한다.
 * @returns 성공 시 트랙, 실패 시 null
 */
export async function requestSubtitles(
  platform: Platform,
  videoId: string,
): Promise<SubtitleTrack | null> {
  const res = await send({ type: "GET_SUBTITLES", platform, videoId });
  return res?.type === "SUBTITLES_OK" ? res.track : null;
}

/** 영상의 자막 제공 상태를 조회한다. language를 전달하면 해당 언어 기준으로 체크한다. */
export async function requestStatus(
  platform: Platform,
  videoId: string,
  language?: string,
): Promise<SubtitleStatus | null> {
  const res = await send({ type: "GET_STATUS", platform, videoId, language });
  return res?.type === "STATUS_OK" ? res.status : null;
}

/** 자막 생성을 시작한다. force=true면 기존 자막을 지우고 재생성한다. @returns 예상 소요 시간(초) 또는 null */
export async function startGeneration(
  platform: Platform,
  videoId: string,
  force = false,
  language?: string,
): Promise<number | null> {
  const res = await send({ type: "START_GENERATION", platform, videoId, force, language });
  return res?.type === "GENERATION_STARTED" ? res.etaSeconds : null;
}

/** 라이브 캡처 세션이 활성 상태인지 조회한다. (Weverse 자막 UI 마운트 조건)
 * 팝업은 자기 탭 ID가 없으므로 tabId를 명시한다. content는 생략하면 sender 탭 기준. */
export async function isLiveActive(tabId?: number): Promise<boolean> {
  const res = await send({ type: "IS_LIVE_ACTIVE", tabId });
  return res?.type === "LIVE_ACTIVE" ? res.active : false;
}

/** 라이브 캡처 중 자막 언어를 변경한다 (이후 자막부터 새 언어로 번역). */
export function setLiveLang(tabId: number, language: string): void {
  void chrome.runtime.sendMessage({ type: "SET_LIVE_LANG", tabId, language });
}
