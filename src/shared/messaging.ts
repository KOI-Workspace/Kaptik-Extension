import type { Member, Platform, SubtitleCue, SubtitleStatus, SubtitleTrack } from "@/types/subtitle";

/** content/popup → background 요청 메시지 */
export type RequestMessage =
  | { type: "GET_SUBTITLES"; platform: Platform; videoId: string }
  | { type: "GET_STATUS"; platform: Platform; videoId: string }
  | { type: "START_GENERATION"; platform: Platform; videoId: string }
  | { type: "START_STREAMING"; youtubeUrl: string; seekSec: number; serverUrl: string; keepCues?: boolean }
  | { type: "STOP_STREAMING" }
  | { type: "START_LIVE_STREAMING"; platform: Platform; videoId: string; captureStartVideoTime: number; videoTitle?: string; videoUrl?: string }
  | { type: "STOP_LIVE_STREAMING" };

/** background → 요청자 응답 메시지 */
export type ResponseMessage =
  | { type: "SUBTITLES_OK"; track: SubtitleTrack }
  | { type: "STATUS_OK"; status: SubtitleStatus }
  | { type: "GENERATION_STARTED"; etaSeconds: number }
  | { type: "STREAMING_STARTED" }
  | { type: "ERR"; error: string };

/** background → content 브로드캐스트 */
export type BroadcastMessage =
  | { type: "SUBTITLES_READY"; platform: Platform; videoId: string }
  | { type: "CUES_ALL_READY"; platform: Platform; videoId: string }
  | { type: "CUE_READY"; cues: SubtitleCue[] }
  | { type: "STREAMING_ERROR"; message: string }
  | { type: "SEEK_AND_SHOW"; seekSec: number }
  | { type: "SPEAKER_IDENTIFIED"; speakerId: string; name: string; member: Member };

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

/** 영상의 자막 제공 상태를 조회한다. */
export async function requestStatus(
  platform: Platform,
  videoId: string,
): Promise<SubtitleStatus | null> {
  const res = await send({ type: "GET_STATUS", platform, videoId });
  return res?.type === "STATUS_OK" ? res.status : null;
}

/** 자막 생성을 시작한다. @returns 예상 소요 시간(초) 또는 null */
export async function startGeneration(
  platform: Platform,
  videoId: string,
): Promise<number | null> {
  const res = await send({ type: "START_GENERATION", platform, videoId });
  return res?.type === "GENERATION_STARTED" ? res.etaSeconds : null;
}
