import type { SiteAdapter } from "./siteAdapters";
import { resolveAdapter } from "./siteAdapters";
import type { BroadcastMessage } from "@/shared/messaging";
import { requestStatus } from "@/shared/messaging";
import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  getEffectivePlan,
  type KaptikSettings,
} from "@/shared/settings";
import { mountDisplay, type DisplayHandle } from "./ui/mount";
import { waitFor, watchUrlChanges } from "./utils";
import type { SubtitleCue, SubtitleTrack } from "@/types/subtitle";

/**
 * content script 진입점.
 * 현재 사이트 어댑터를 찾고, "자막 표시 ON + 상태 available" 조건을 만족할 때만
 * 영상 위에 자막 UI(가운데 오버레이 + 우측 패널)를 마운트한다.
 */
async function bootstrap() {
  // 주입 여부 확인용 — 어댑터 매칭 전에 무조건 찍는다
  console.info("[Kaptik] content script 로드됨:", location.href);
  const adapter = resolveAdapter();
  if (!adapter) {
    console.info("[Kaptik] 지원하지 않는 사이트:", location.hostname);
    return;
  }
  console.info(`[Kaptik] ${adapter.platform} 페이지 감지`);
  const controller = new SubtitleController(adapter);
  await controller.start();
}

/** 영상 단위로 자막 UI 생명주기를 관리하는 컨트롤러 */
class SubtitleController {
  private settings: KaptikSettings = DEFAULT_SETTINGS;
  private mounted: {
    videoId: string;
    panelContainer: HTMLElement | null;
    handle: DisplayHandle;
    video: HTMLVideoElement;
    isLive: boolean;
    /** VOD 전용: 스트리밍 완료 전까지 cues를 버퍼링 */
    vodCuesReady: boolean;
    lastVodCues: SubtitleCue[];
  } | null = null;
  private videoCleanup: (() => void) | null = null;
  /** evaluate() 안에서 정의된 startStreaming을 외부(메시지 핸들러)에서도 호출 가능하도록 저장 */
  private startStreamingFn: ((seekSec: number, keepCues?: boolean) => void) | null = null;
  /** 평가 진행 중 플래그 — 긴 await 동안 중복 evaluate가 끼어들어 취소시키는 것을 방지 */
  private evaluating = false;
  /** 30초 화자 식별 대기 타이머 */
  private speakerIdTimer: number | undefined = undefined;
  /** 현재 세션에서 화자 식별이 한 번이라도 성공했는지 */
  private speakerIdentifiedOnce = false;

  constructor(private adapter: SiteAdapter) {}

  async start() {
    this.settings = await getSettings();

    // 설정 변경(자막 ON/OFF, 패널 표시 등) → 재평가
    onSettingsChanged((s) => {
      const prevLanguage = this.settings.language;
      this.settings = s;
      // 언어 변경 시: 기존 자막 즉시 제거하고 SUBTITLES_READY 브로드캐스트로 재마운트
      if (prevLanguage !== s.language && this.mounted) {
        this.teardown();
        return;
      }
      void this.evaluate();
    });

    // URL 변경(SPA) → 재평가
    watchUrlChanges(() => void this.evaluate());

    // background 브로드캐스트 처리
    chrome.runtime.onMessage.addListener((message: BroadcastMessage) => {
      if (
        message?.type === "SUBTITLES_READY" &&
        message.platform === this.adapter.platform
      ) {
        if (
          this.mounted &&
          this.startStreamingFn &&
          this.mounted.videoId === message.videoId
        ) {
          // 생성 완료 → 현재 재생 위치부터 스트리밍 재시작, cue 버퍼 초기화
          this.mounted.vodCuesReady = false;
          this.mounted.lastVodCues = [];
          this.startStreamingFn(Math.floor(this.mounted.video.currentTime));
        } else {
          void this.evaluate();
        }
      } else if (message?.type === "CUE_READY") {
        if (this.mounted) {
          if (this.mounted.isLive) {
            this.mounted.handle.updateCues(message.cues);
          } else if (this.mounted.vodCuesReady) {
            // 첫 로딩 완료 후 seek/재생 시 즉시 반영
            this.mounted.handle.updateCues(message.cues);
          } else {
            // 최초 로딩 중: 버퍼에만 저장 (백엔드가 매번 전체 배열을 전송)
            this.mounted.lastVodCues = message.cues;
          }
        }
      } else if (message?.type === "CUES_ALL_READY") {
        if (
          this.mounted &&
          !this.mounted.isLive &&
          this.mounted.videoId === message.videoId
        ) {
          this.mounted.vodCuesReady = true;
          this.mounted.handle.updateCues(this.mounted.lastVodCues);
        }
      } else if (message?.type === "SPEAKER_IDENTIFIED") {
        if (this.mounted?.isLive) {
          // 화자 식별 성공 → 30s 타이머 해제, members 맵 업데이트
          clearTimeout(this.speakerIdTimer);
          this.speakerIdTimer = undefined;
          this.speakerIdentifiedOnce = true;
          // SPEAKER_N → 멤버, 한국어 이름 → 멤버, 영문 id/이름 → 멤버 모두 등록
          // (백엔드가 해결 후 한국어 이름으로 speaker 필드를 바꾸므로 둘 다 필요)
          this.mounted.handle.updateMembers({
            [message.speakerId]: message.member,
            [message.name]: message.member,
            [message.member.id]: message.member,
            [message.member.name]: message.member,
          });
          console.info(`[Kaptik Live] 화자 식별 반영: ${message.speakerId} → ${message.member.name}`);
        }
      } else if (message?.type === "STREAMING_ERROR") {
        console.error("[Kaptik YT] 스트리밍 오류:", message.message);
        if (this.mounted && !this.mounted.isLive) {
          this.mounted.handle.updateCues([]);
          this.mounted.lastVodCues = [];
          this.mounted.vodCuesReady = false;
        }
      }
    });

    // SPA 내부에서 video만 교체되는 경우 대비 주기 점검
    setInterval(() => void this.evaluate(), 1500);

    // 화면 폭 변경(반응형) → 패널 도킹 위치(우측 ↔ 영상 아래) 재평가
    let resizeTimer: number | undefined;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void this.evaluate(), 250);
    });

    await this.evaluate();
  }

  /** 현재 상태에 맞춰 자막 UI를 표시/숨김 처리한다. */
  private async evaluate() {
    // 이미 평가 중이면 끼어들지 않는다 (긴 await가 취소되는 무한 루프 방지)
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const videoId = this.adapter.getVideoId(location.href);

      // 영상 없음 / 자막 OFF → 숨김
      if (!videoId || !this.settings.enabled) {
        this.teardown();
        return;
      }

      // 사이드 컬럼(관련영상 영역) 또는 영상 아래 — 화면 폭에 따라 달라진다(반응형)
      const panelContainer = this.adapter.getPanelContainer();

      // 같은 영상, 같은 패널이면 유지 (video 요소가 일시적으로 null이어도 세션 유지)
      // YouTube SPA가 video 요소를 새 인스턴스로 교체한 경우에만 재마운트
      const currentVideo = this.adapter.getVideoElement();
      if (
        this.mounted?.videoId === videoId &&
        this.mounted.panelContainer === panelContainer &&
        (this.mounted.video === currentVideo || currentVideo == null)
      ) {
        return;
      }

      // (재)마운트 준비
      this.teardown();
      const video = await waitFor(() => this.adapter.getVideoElement());
      // 평가 도중 영상/설정이 바뀌었으면 중단
      if (
        !video ||
        videoId !== this.adapter.getVideoId(location.href) ||
        !this.settings.enabled
      ) {
        return;
      }

      const container = this.adapter.getOverlayContainer();
      if (!container) {
        console.info("[Kaptik] overlay container 못 찾음");
        return;
      }

      const isLive = this.adapter.isLive?.(location.href) ?? false;

      // 팝업이 DOM 없이도 isLive를 읽을 수 있도록 저장
      void chrome.storage.local.set({
        [`kaptik:live:${this.adapter.platform}:${videoId}`]: isLive,
      });

      // Basic 플랜: 라이브 스트림만 허용
      if (!isLive && getEffectivePlan(this.settings) === "basic") {
        this.teardown();
        return;
      }

      // VOD는 생성이 끝나기 전(none/generating)에는 자막 UI를 띄우지 않는다.
      // 생성이 끝나면(완료/실패) SUBTITLES_READY 브로드캐스트가 evaluate()를 다시 호출한다.
      let speakerIdentified = true;
      if (!isLive) {
        const vodStatus = await requestStatus(this.adapter.platform, videoId);
        if (vodStatus?.state === "failed") {
          // 생성 자체가 불가능한 영상(예: 한국어 아님) → 패널에 안내만, 가운데 자막은 없음
          const errorTrack: SubtitleTrack = {
            platform: this.adapter.platform,
            videoId,
            cues: [],
            availableLanguages: ["ko", "en", "ja", "zh-CN", "id"],
            members: {},
            error: vodStatus.reason,
          };
          const handle = mountDisplay(container, panelContainer, video, errorTrack, false);
          this.mounted = { videoId, panelContainer, handle, video, isLive: false, vodCuesReady: false, lastVodCues: [] };
          console.info(`[Kaptik] 자막 생성 불가 (${videoId}): ${vodStatus.reason ?? "unknown"}`);
          return;
        }
        // cues_loading: job은 완료됐지만 스트리밍 미시작 — available과 동일하게 처리해 스트리밍을 바로 시작한다.
        // 스트리밍이 완료되면 markCuesReady가 호출돼 available로 전환된다.
        const isCuesLoading = vodStatus?.state === "generating" && vodStatus.step === "cues_loading";
        if (vodStatus?.state !== "available" && !isCuesLoading) {
          this.teardown();
          return;
        }
        speakerIdentified = vodStatus?.state === "available" ? (vodStatus.speakerIdentifiable ?? true) : true;
      }

      // 빈 트랙으로 먼저 마운트한 뒤 스트리밍으로 cue를 채운다
      const emptyTrack: SubtitleTrack = {
        platform: this.adapter.platform,
        videoId,
        cues: [],
        availableLanguages: ["ko", "en", "ja", "zh-CN", "id"],
        members: {},
        speakerIdentified,
      };
      const handle = mountDisplay(container, panelContainer, video, emptyTrack, isLive);
      this.mounted = { videoId, panelContainer, handle, video, isLive, vodCuesReady: false, lastVodCues: [] };

      if (isLive) {
        // ── 라이브 경로: 탭 오디오 캡처 → 오프스크린 → 백엔드 WS ──
        const startLive = () => {
          this.resetSpeakerIdTimer();
          chrome.runtime.sendMessage({
            type: "START_LIVE_STREAMING",
            platform: this.adapter.platform,
            videoId,
            captureStartVideoTime: Math.floor(video.currentTime),
            videoTitle: document.title,
            videoUrl: location.href,
          }).catch((err: unknown) =>
            console.error("[Kaptik Live] START_LIVE_STREAMING 실패:", err),
          );
          console.info(`[Kaptik Live] 라이브 스트리밍 시작 (${videoId})`);
        };
        this.startStreamingFn = () => { /* 라이브는 재시작 없음 */ };

        startLive();

        // 일시정지/재생에 따라 캡처 중단/재개
        const onPaused = () => {
          chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
        };
        const onPlaying = () => { startLive(); };

        video.addEventListener("pause", onPaused);
        video.addEventListener("playing", onPlaying);
        this.videoCleanup = () => {
          video.removeEventListener("pause", onPaused);
          video.removeEventListener("playing", onPlaying);
        };
      } else {
        // ── VOD 경로: YouTube WS 스트리밍 ──
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

        const startStreaming = (seekSec: number, keepCues = false) => {
          this.resetSpeakerIdTimer();
          chrome.runtime.sendMessage({
            type: "START_STREAMING",
            youtubeUrl,
            seekSec,
            serverUrl: this.settings.serverUrl,
            keepCues,
          }).catch((err: unknown) => console.error("[Kaptik YT] START_STREAMING 실패:", err));
          console.info(`[Kaptik YT] 스트리밍 요청 (${videoId}, seek=${seekSec}s, keepCues=${keepCues})`);
        };
        this.startStreamingFn = startStreaming;

        // 위에서 이미 available 확인했으므로 바로 시작
        startStreaming(Math.floor(video.currentTime));

        let seekTimer: ReturnType<typeof setTimeout> | undefined;
        // VOD는 cue가 DB에 사전 계산돼 있으므로 일시정지 중에도 WS 유지.
        // YouTube 초기화 시 rapid pause→playing 이벤트가 발생해 세션이 끊기는 것을 방지.
        // 재생 재개 시 onPlaying에서 새 seek 위치로 startStreaming을 호출하므로 WS가 갱신된다.
        const onPlaying = () => {
          clearTimeout(seekTimer);
          startStreaming(Math.floor(video.currentTime), true);
        };
        const onSeeked = () => {
          if (video.paused) return;
          clearTimeout(seekTimer);
          seekTimer = setTimeout(
            () => startStreaming(Math.floor(video.currentTime), true),
            500,
          );
        };

        video.addEventListener("playing", onPlaying);
        video.addEventListener("seeked", onSeeked);
        this.videoCleanup = () => {
          clearTimeout(seekTimer);
          video.removeEventListener("playing", onPlaying);
          video.removeEventListener("seeked", onSeeked);
        };
      }

      console.info(`[Kaptik] 자막 마운트 완료 (${this.adapter.platform}/${videoId}, isLive=${isLive})`);
    } finally {
      this.evaluating = false;
    }
  }

  /** 화자 식별 30초 타이머를 리셋한다. 30초 내 식별 없으면 콘솔 경고. */
  private resetSpeakerIdTimer() {
    clearTimeout(this.speakerIdTimer);
    this.speakerIdentifiedOnce = false;
    this.speakerIdTimer = window.setTimeout(() => {
      if (!this.speakerIdentifiedOnce) {
        console.info("[Kaptik Live] 30초 내 화자 식별 없음 — 화자 표시 비활성화");
      }
    }, 30_000);
  }

  /** 표시 중인 자막 UI와 스트리밍 세션을 제거한다. */
  private teardown() {
    clearTimeout(this.speakerIdTimer);
    this.speakerIdTimer = undefined;
    this.speakerIdentifiedOnce = false;
    this.videoCleanup?.();
    this.videoCleanup = null;
    this.startStreamingFn = null;
    if (this.mounted) {
      chrome.runtime.sendMessage({ type: "STOP_STREAMING" }).catch(() => {});
      chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
    }
    this.mounted?.handle.destroy();
    this.mounted = null;
  }
}

// YouTube 페이지의 PO Token을 page context JS에서 읽어 background에 반환.
// content script는 isolated world이므로 <script> 주입 + postMessage 방식 사용.
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if ((message as Record<string, unknown>)?.type !== "GET_PO_TOKEN") return;

    const RESPONSE_TYPE = "KAPTIK_PO_TOKEN_RESULT";
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as Record<string, unknown>;
      if (data?.type !== RESPONSE_TYPE) return;
      window.removeEventListener("message", handler);
      sendResponse(data.token ?? undefined);
    };
    window.addEventListener("message", handler);
    setTimeout(() => {
      window.removeEventListener("message", handler);
      sendResponse(undefined);
    }, 1000);

    const script = document.createElement("script");
    script.textContent = `(function(){
      try{
        const d=window.ytcfg&&window.ytcfg.data_||{};
        const token=d.VISITOR_DATA||d.visitorData||undefined;
        window.postMessage({type:"${RESPONSE_TYPE}",token},"*");
      }catch(e){window.postMessage({type:"${RESPONSE_TYPE}",token:undefined},"*");}
    })();`;
    (document.head ?? document.documentElement).appendChild(script);
    script.remove();
    return true; // 비동기 sendResponse
  },
);

void bootstrap();
