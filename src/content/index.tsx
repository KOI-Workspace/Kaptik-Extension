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
/** 팝업의 GET_VIDEO_TIME 요청에 응답하기 위한 모듈 스코프 컨트롤러 참조 */
let activeController: SubtitleController | null = null;

/**
 * 실제 라이브 여부를 video.duration으로 판정한다.
 * Weverse는 종료된 라이브(다시보기)도 URL이 `/live/`로 유지되어 URL만으론 구분이 안 된다.
 * duration이 Infinity면 실시간 라이브, 유한하면 녹화(replay)다.
 * 메타데이터 로딩 전(NaN)이면 URL 힌트로 폴백한다.
 */
function detectLiveFromVideo(video: HTMLVideoElement, urlHint: boolean): boolean {
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) return false; // 유한 길이 = 녹화(replay)
  if (d === Infinity) return true; // 무한 = 실시간 라이브
  return urlHint; // 판단 불가 → URL 힌트
}

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
  activeController = controller;
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

  /** 현재 마운트된 영상의 재생 위치(초, 소수 포함). 없으면 페이지의 video 폴백, 그래도 없으면 0.
   * 타임싱크 폴링이 영상 위치를 정확히 추적해야 하므로 floor하지 않는다. */
  getCurrentVideoTime(): number {
    if (this.mounted) return this.mounted.video.currentTime;
    const v = document.querySelector("video");
    return v ? v.currentTime : 0;
  }

  async start() {
    this.settings = await getSettings();

    // 설정 변경(자막 ON/OFF, 패널 표시 등) → 재평가
    onSettingsChanged((s) => {
      const prevLanguage = this.settings.language;
      this.settings = s;
      // 언어 변경 시: 기존 자막 즉시 제거 후 evaluate
      // evaluate 내부에서 requestStatus(language)를 호출하면 새 언어 기준으로 체크하므로
      // generating 상태라면 마운트 안 하고 대기, 완료되면 SUBTITLES_READY로 재마운트된다
      if (prevLanguage !== s.language && this.mounted) {
        this.teardown();
      }
      void this.evaluate();
    });

    // URL 변경(SPA) → 재평가
    watchUrlChanges(() => void this.evaluate());

    // YouTube SPA 네비게이션 시작 즉시 자막 화면을 비운다
    // (pushState → evaluate 사이의 지연 동안 이전 영상 자막이 노출되는 것을 방지)
    window.addEventListener("yt-navigate-start", () => {
      this.mounted?.handle.updateCues([]);
    });

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
          // 생성 완료 → 현재 재생 위치부터 스트리밍 재시작, cue 버퍼 및 화면 즉시 초기화
          // 화면을 비우지 않으면 이전 언어 자막이 새 자막 로딩 완료까지 계속 노출됨
          this.mounted.vodCuesReady = false;
          this.mounted.lastVodCues = [];
          this.mounted.handle.updateCues([]);
          this.startStreamingFn(Math.floor(this.mounted.video.currentTime));
        } else {
          void this.evaluate();
        }
      } else if (message?.type === "CUE_READY") {
        // videoId 불일치 → 이전 영상 세션의 stale 메시지이므로 무시
        if (this.mounted && this.mounted.videoId === message.videoId) {
          if (this.mounted.isLive) {
            this.mounted.handle.updateCues(message.cues);
          } else if (this.mounted.vodCuesReady) {
            // 첫 로딩 완료 후 seek/재생 시 즉시 반영
            this.mounted.handle.updateCues(message.cues);
          } else {
            // 로딩 중에도 즉시 표시 — 백엔드가 매번 전체 정렬 배열을 전송하므로 순서 보장
            this.mounted.lastVodCues = message.cues;
            this.mounted.handle.updateCues(message.cues);
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
        if (this.mounted) {
          // 화자 식별 성공 → 30s 타이머 해제, members 맵 업데이트 (VOD/Live 공통)
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
          console.info(`[Kaptik] 화자 식별 반영: ${message.speakerId} → ${message.member.name}`);
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

  /**
   * 확장 컨텍스트가 살아있는지 확인한다.
   * 개발 중 확장을 재로딩하면 이미 떠 있던 탭의 콘텐츠 스크립트는 컨텍스트가 끊겨
   * chrome.* 호출이 "Extension context invalidated"로 동기 throw한다. 이때 조용히 멈춘다.
   */
  private isContextAlive(): boolean {
    return Boolean(chrome.runtime?.id);
  }

  /** 현재 상태에 맞춰 자막 UI를 표시/숨김 처리한다. */
  private async evaluate() {
    // 컨텍스트가 죽었으면(확장 재로딩 등) 아무 작업도 하지 않는다 — 에러 폭주 방지
    if (!this.isContextAlive()) return;
    // 이미 평가 중이면 끼어들지 않는다 (긴 await가 취소되는 무한 루프 방지)
    if (this.evaluating) return;
    this.evaluating = true;
    const urlAtStart = location.href;
    try {
      // URL 기반으로 영상 ID를 판별한다.
      // YouTube SPA는 pushState로 URL을 먼저 바꾼 뒤 DOM을 업데이트하므로
      // URL이 항상 DOM보다 최신 상태다. DOM을 우선하면 stale 값으로 early-return해
      // 이전 영상 자막이 남는 버그가 생긴다.
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
      if (this.mounted?.videoId === videoId) {
        // alwaysCapture 사이트(Weverse 등): React SPA가 DOM을 자주 교체하므로
        // DOM 참조 비교 없이 videoId만 확인한다 (오디오 캡처는 탭 단위라 영향 없음)
        if (this.adapter.alwaysCapture) return;
        if (
          this.mounted.panelContainer === panelContainer &&
          (this.mounted.video === currentVideo || currentVideo == null)
        ) {
          return;
        }
      }
      // alwaysCapture 사이트: SPA URL 변경으로 videoId가 달라져도
      // 같은 video 요소가 재생 중이면 기존 세션 유지 (teardown 방지)
      if (
        this.adapter.alwaysCapture &&
        this.mounted &&
        currentVideo != null &&
        currentVideo === this.mounted.video
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

      // URL은 /live/ 경로여도 종료된 라이브(다시보기)는 녹화(replay)다. video.duration으로 실제 판정.
      const urlIsLive = this.adapter.isLive?.(location.href) ?? false;
      const isLive = detectLiveFromVideo(video, urlIsLive);
      // alwaysCapture: 위버스처럼 yt-dlp 추출이 불가능한 플랫폼은 라이브/VOD 무관하게 오디오 캡처 경로 사용
      const useCapture = urlIsLive || (this.adapter.alwaysCapture ?? false);

      // 팝업이 DOM 없이도 isLive를 읽을 수 있도록 저장
      void chrome.storage.local.set({
        [`kaptik:live:${this.adapter.platform}:${videoId}`]: isLive,
      });

      // Basic 플랜: 라이브 스트림 및 오디오 캡처 경로 허용, YouTube VOD는 Pro 전용
      if (!useCapture && getEffectivePlan(this.settings) === "basic") {
        this.teardown();
        return;
      }

      // YouTube VOD는 생성이 끝나기 전(none/generating)에는 자막 UI를 띄우지 않는다.
      // 생성이 끝나면(완료/실패) SUBTITLES_READY 브로드캐스트가 evaluate()를 다시 호출한다.
      let speakerIdentified = true;
      if (!useCapture) {
        // this.settings.language는 onSettingsChanged가 즉시 업데이트하므로 항상 최신값
        // language를 직접 전달해 storage 쓰기 완료 전 race condition으로 old 언어가 체크되는 것을 방지
        const vodStatus = await requestStatus(this.adapter.platform, videoId, this.settings.language);
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
          if (!panelContainer) this.watchPanelDock(handle);
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
      // 패널 컬럼을 아직 못 찾았으면 잠시 폴링해 늦게 나타나면 도킹 (오버레이 폴백 방지)
      if (!panelContainer) this.watchPanelDock(handle);

      if (useCapture) {
        // ── 라이브 경로: 탭 오디오 캡처 → 오프스크린 → 백엔드 WS ──
        // 중복 시작 방지 플래그 — 버퍼링 후 playing 이벤트 중복 발생 대응
        let streamingActive = false;
        const startLive = () => {
          if (streamingActive) return;
          streamingActive = true;
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

        if (this.adapter.alwaysCapture) {
          // alwaysCapture 플랫폼(Weverse 등): 팝업 "Start" 버튼이 유일한 캡처 시작 트리거.
          // pause/playing 이벤트로 자동 중단/재시작하지 않는다 — 버퍼링이나 잠깐 멈춤에도
          // 캡처가 끊기지 않도록, 세션은 페이지 이탈 시까지 유지한다.
          this.videoCleanup = () => {};
        } else {
          // YouTube 라이브: 자동 시작 + 일시정지/재생에 따라 캡처 중단/재개
          startLive();

          // 3초 딜레이: 짧은 버퍼링(pause → playing)을 진짜 정지로 오인해 재시작하는 것 방지
          let pauseTimer: number | undefined;
          const onPaused = () => {
            clearTimeout(pauseTimer);
            pauseTimer = window.setTimeout(() => {
              streamingActive = false;
              chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
            }, 3000);
          };
          const onPlaying = () => {
            clearTimeout(pauseTimer);
            startLive();
          };

          video.addEventListener("pause", onPaused);
          video.addEventListener("playing", onPlaying);
          this.videoCleanup = () => {
            video.removeEventListener("pause", onPaused);
            video.removeEventListener("playing", onPlaying);
          };
        }
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
            // this.settings는 onSettingsChanged가 즉시 업데이트하므로 항상 최신 언어
            language: this.settings.language,
          }).catch((err: unknown) => console.error("[Kaptik YT] START_STREAMING 실패:", err));
          console.info(`[Kaptik YT] 스트리밍 요청 (${videoId}, seek=${seekSec}s, keepCues=${keepCues})`);
        };
        this.startStreamingFn = startStreaming;

        // 항상 0초부터 전체 cue를 요청 — video.currentTime 기반 표시는 useActiveIndex가 처리
        startStreaming(0);

        let seekTimer: ReturnType<typeof setTimeout> | undefined;
        // 초기 로딩 완료(vodCuesReady) 전에는 playing/seeked 이벤트를 무시한다.
        // 초기 WS가 완료되기 전에 새 WS 연결이 열리면 이전 연결이 끊겨 cue가 유실됨.
        const onPlaying = () => {
          if (!this.mounted?.vodCuesReady) return;
          clearTimeout(seekTimer);
          startStreaming(Math.floor(video.currentTime), true);
        };
        const onSeeked = () => {
          if (video.paused) return;
          if (!this.mounted?.vodCuesReady) return;
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
      // evaluate 실행 중 URL이 변경됐으면 재실행
      // (pushState가 evaluating lock에 막혀 무시됐을 때: lastUrl이 업데이트됐지만 evaluate는 실행 안 됨)
      if (location.href !== urlAtStart) {
        void this.evaluate();
      }
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
  /**
   * 패널 컬럼이 영상보다 늦게 렌더되는 SPA(위버스 등) 대응.
   * 마운트 시점에 컬럼을 못 찾았을 때 잠시 폴링해 나타나면 도킹하고,
   * 끝내 없으면(좁은 화면 등) 오버레이로 폴백한다.
   */
  private watchPanelDock(handle: DisplayHandle) {
    void waitFor(() => this.adapter.getPanelContainer(), 5000).then((column) => {
      // 그새 teardown/재마운트됐으면 무시 (현재 세션과 동일한 핸들일 때만 적용)
      if (this.mounted?.handle !== handle) return;
      if (column) {
        handle.dockPanel(column);
        this.mounted.panelContainer = column;
      } else {
        handle.fallbackToOverlay();
      }
    });
  }

  private teardown() {
    clearTimeout(this.speakerIdTimer);
    this.speakerIdTimer = undefined;
    this.speakerIdentifiedOnce = false;
    this.videoCleanup?.();
    this.videoCleanup = null;
    this.startStreamingFn = null;
    // 컨텍스트가 살아있을 때만 메시지 전송 — 죽은 컨텍스트에서는 sendMessage가 동기 throw한다
    if (this.mounted && this.isContextAlive()) {
      try {
        chrome.runtime.sendMessage({ type: "STOP_STREAMING" }).catch(() => {});
        chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
      } catch {
        // 컨텍스트 무효화로 인한 동기 throw 무시
      }
    }
    this.mounted?.handle.destroy();
    this.mounted = null;
  }
}

// YouTube 페이지의 PO Token을 page context JS에서 읽어 background에 반환.
// content script는 isolated world이므로 <script> 주입 + postMessage 방식 사용.
// 팝업이 캡처 시작 앵커로 쓸 현재 재생 위치(초)를 요청
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if ((message as Record<string, unknown>)?.type !== "GET_VIDEO_TIME") return;
    sendResponse(activeController?.getCurrentVideoTime() ?? 0);
    return true;
  },
);

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
