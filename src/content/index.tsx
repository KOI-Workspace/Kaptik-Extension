import type { SiteAdapter } from "./siteAdapters";
import { resolveAdapter } from "./siteAdapters";
import type { BroadcastMessage, ResponseMessage } from "@/shared/messaging";
import { requestStatus, isLiveActive } from "@/shared/messaging";
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
    overlayContainer: HTMLElement;
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
  /** 1500ms 주기 evaluate 타이머 ID (컨텍스트 무효화 시 정리용) */
  private evalTimer: number | undefined = undefined;
  /** 확장 컨텍스트 무효화로 폐기됨 — 이후 모든 동작 no-op */
  private disposed = false;
  /** 30초 화자 식별 대기 타이머 */
  private speakerIdTimer: number | undefined = undefined;
  /** 현재 세션에서 화자 식별이 한 번이라도 성공했는지 */
  private speakerIdentifiedOnce = false;
  /** 마운트 전 도착한 라이브 CUE_READY를 임시 보관. 마운트 완료 직후 즉시 적용 */
  private pendingLiveCues: { videoId: string; cues: SubtitleCue[] } | null = null;

  constructor(private adapter: SiteAdapter) {}

  /** 현재 마운트된 영상의 재생 위치(초, 소수 포함). 없으면 페이지의 video 폴백, 그래도 없으면 0.
   * 타임싱크 폴링이 영상 위치를 정확히 추적해야 하므로 floor하지 않는다. */
  getCurrentVideoTime(): number {
    if (this.mounted) return this.mounted.video.currentTime;
    const v = document.querySelector("video");
    return v ? v.currentTime : 0;
  }

  /** 현재 광고 재생 중인지 — 백그라운드 캡처 루프가 0.5초마다 물어 무음 처리 판단에 쓴다. */
  isAdPlaying(): boolean {
    return this.adapter.isAdPlaying?.() ?? false;
  }

  async start() {
    this.settings = await getSettings();

    // 페이지가 새로 로드될 때마다 이전 페이지에서 살아있던 캡처 세션을 정리한다.
    // → "팝업에서 Create Subtitle을 눌러야만 자막 UI가 뜬다"는 UX를 보장.
    //   (이전에 만든 자막/세션이 Start 없이 자동 복구되어 떠버리는 것을 방지)
    //   alwaysCapture(Weverse) 한정이고, 세션이 없으면 background가 무시하므로 안전하다.
    if (this.adapter.alwaysCapture) {
      // background의 handleStopLiveStreaming(동기)이 완전히 끝난 뒤 evaluate()가 시작되도록 await.
      // fire-and-forget이면 IS_LIVE_ACTIVE가 STOP_LIVE_STREAMING보다 먼저 처리되어
      // 새로고침 후 광고 중에 패널이 마운트되는 race condition이 발생한다.
      await chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
    }

    // 설정 변경(자막 ON/OFF, 패널 표시 등) → 재평가
    onSettingsChanged((s) => {
      const prevLanguage = this.settings.language;
      this.settings = s;
      if (prevLanguage !== s.language && this.mounted) {
        if (this.adapter.alwaysCapture) {
          // 라이브 캡처(위버스 등): 언어 변경 시 캡처 세션을 끊으면 안 된다(STOP 금지).
          // 끊으면 광고 차단 타이머까지 멈추고 자동 재시작 트리거가 없어 자막이 영영 사라진다.
          // 화면의 이전 언어 자막만 즉시 비우고, 백그라운드의 언어 전환(set_lang)이 보내주는
          // 새 언어 cue로 다시 채운다.
          this.mounted.handle.updateCues([]);
        } else {
          // YouTube VOD: 기존 자막 제거 후 evaluate → 새 언어 기준으로 재평가.
          // generating이면 대기, 완료되면 SUBTITLES_READY로 재마운트된다.
          this.teardown();
        }
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
        } else if (!this.mounted && message.cues.length > 0) {
          // evaluate() 완료 전 도착 — 마운트 후 즉시 적용할 수 있도록 최신 cue를 보관
          this.pendingLiveCues = { videoId: message.videoId, cues: message.cues };
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
      } else if (message?.type === "LIVE_CAPTURE_STARTED") {
        // 팝업 Start로 캡처 세션이 시작됨 → 1500ms 주기를 기다리지 않고 즉시 마운트 평가
        void this.evaluate();
      } else if (message?.type === "LIVE_CAPTURE_STOPPED") {
        // 캡처 세션 종료 → 자막 UI 즉시 언마운트
        if (this.mounted?.videoId === message.videoId) this.teardown();
      }
    });

    // SPA 내부에서 video만 교체되는 경우 대비 주기 점검
    this.evalTimer = window.setInterval(() => void this.evaluate(), 1500);

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
    if (this.disposed) return;
    // 확장 리로드/업데이트로 컨텍스트가 죽었으면 더 이상 동작하지 않고 정리한다.
    // (죽은 인스턴스가 1500ms 타이머로 chrome API를 호출해 "Extension context invalidated"를 쏟는 것 방지)
    if (!this.extensionAlive()) {
      this.dispose();
      return;
    }
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
      const overlayContainer = this.adapter.getOverlayContainer();

      // 같은 영상, 같은 패널이면 유지 (video 요소가 일시적으로 null이어도 세션 유지)
      // YouTube SPA가 video 요소를 새 인스턴스로 교체한 경우에만 재마운트
      const currentVideo = this.adapter.getVideoElement();
      if (this.mounted?.videoId === videoId) {
        // alwaysCapture 사이트도 플레이어 DOM이 교체되면 기존 Shadow DOM이 화면에서 분리될 수 있다.
        // 같은 DOM이면 유지하고, 컨테이너/비디오가 바뀐 경우만 아래에서 재마운트한다.
        // 단, 세션이 종료됐을 수 있으므로 isLiveActive()를 재확인한다.
        // LIVE_CAPTURE_STOPPED가 mount 전에 도착해 teardown이 no-op이 된 경우,
        // 이 확인이 없으면 패널이 영원히 켜진 채로 남는다.
        if (
          this.adapter.alwaysCapture &&
          this.mounted.overlayContainer === overlayContainer &&
          (this.mounted.video === currentVideo || currentVideo == null)
        ) {
          const active = await isLiveActive();
          if (!active) this.teardown();
          return;
        }
        if (
          this.mounted.panelContainer === panelContainer &&
          this.mounted.overlayContainer === overlayContainer &&
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

      // 우측 패널을 도킹할 사이드 컬럼.
      // 위버스 등 SPA는 이 컬럼(채팅/댓글 영역)이 영상보다 늦게 렌더돼, 마운트 순간에
      // 못 찾으면 패널이 가끔 영상 위 오버레이로 빠졌다. 마운트 직전에 잠깐만(최대 1.5초)
      // 기다려 그 타이밍 문제를 없앤다. 그래도 없으면 기존대로 null → 오버레이 폴백.
      // (마운트 '후'에는 재탐색하지 않는다 — 댓글이 다 로드된 뒤의 거대 본문 컬럼을 잘못 집는 것을 방지)
      const dockColumn =
        (await waitFor(() => this.adapter.getPanelContainer(), 1500)) ?? panelContainer;

      // URL은 /live/ 경로여도 종료된 라이브(다시보기)는 녹화(replay)다. video.duration으로 실제 판정.
      // alwaysCapture 플랫폼(Weverse 등)은 광고 video의 유한 duration에 속지 않도록 URL 판단만 사용.
      const urlIsLive = this.adapter.isLive?.(location.href) ?? false;
      const isLive = this.adapter.alwaysCapture ? urlIsLive : detectLiveFromVideo(video, urlIsLive);
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
        const vodStatus = await requestStatus(this.adapter.platform, videoId, this.settings.language, location.href);
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
          const handle = mountDisplay(container, dockColumn, video, errorTrack, false, () => this.isAdPlaying());
          this.mounted = { videoId, panelContainer: dockColumn, overlayContainer: container, handle, video, isLive: false, vodCuesReady: false, lastVodCues: [] };
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

      // alwaysCapture(Weverse): 팝업 "Create Subtitle"로 캡처 세션이 시작된 경우에만 마운트한다.
      // Start 버튼이 눌리지 않은 상태(active=false)면 저장된 cue 유무와 무관하게 마운트하지 않는다.
      // 새로고침/재진입 시에는 반드시 Create Subtitle을 다시 눌러야 자막 UI가 뜬다.
      if (useCapture && this.adapter.alwaysCapture) {
        const active = await isLiveActive();
        if (!active) {
          this.teardown();
          return;
        }
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
      const handle = mountDisplay(container, dockColumn, video, emptyTrack, isLive, () => this.isAdPlaying(), useCapture);
      this.mounted = { videoId, panelContainer: dockColumn, overlayContainer: container, handle, video, isLive, vodCuesReady: false, lastVodCues: [] };

      if (useCapture) {
        // 마운트 전 도착한 cue가 있으면 즉시 표시 (evaluate 중 CUE_READY 유실 방지)
        const pending = this.pendingLiveCues;
        this.pendingLiveCues = null;
        if (pending?.videoId === videoId && pending.cues.length > 0 && !this.isAdPlaying()) {
          this.mounted.handle.updateCues(pending.cues);
        }

        // 서버/storage에서 이전 세션 cue 복원 (새 세션이라 없을 수 있음)
        chrome.runtime.sendMessage({
          type: "GET_LIVE_CUES",
          platform: this.adapter.platform,
          videoId,
          language: this.settings.language,
          videoUrl: location.href,
        }, (res: ResponseMessage | undefined) => {
          if (
            res?.type === "LIVE_CUES" &&
            res.videoId === videoId &&
            this.mounted?.videoId === videoId &&
            res.cues.length > 0 &&
            !this.isAdPlaying()
          ) {
            this.mounted.handle.updateCues(res.cues);
          }
        });

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
  /** 확장 컨텍스트가 아직 유효한지. 리로드/업데이트 시 content script는 죽은 참조를 들고 남는다. */
  private extensionAlive(): boolean {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  /** 컨텍스트 무효화로 폐기 — 죽은 인스턴스가 타이머/리스너로 에러를 쏟지 않도록 모두 정리한다. */
  private dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.evalTimer !== undefined) clearInterval(this.evalTimer);
    this.evalTimer = undefined;
    clearTimeout(this.speakerIdTimer);
    this.speakerIdTimer = undefined;
    this.videoCleanup?.();
    this.videoCleanup = null;
    this.startStreamingFn = null;
    // 컨텍스트가 죽었으므로 background에 메시지를 보내지 않고 화면 UI만 제거한다.
    this.mounted?.handle.destroy();
    this.mounted = null;
    console.info("[Kaptik] 확장 컨텍스트 무효화 감지 → content script 정리 (탭 새로고침 필요)");
  }

  private teardown() {
    clearTimeout(this.speakerIdTimer);
    this.speakerIdTimer = undefined;
    this.speakerIdentifiedOnce = false;
    this.pendingLiveCues = null;
    this.videoCleanup?.();
    this.videoCleanup = null;
    this.startStreamingFn = null;
    if (this.mounted) {
      // 컨텍스트 무효화 시 sendMessage가 동기적으로 throw하므로 try로 감싼다 (.catch는 동기 throw를 못 잡음)
      try {
        chrome.runtime.sendMessage({ type: "STOP_STREAMING" }).catch(() => {});
        chrome.runtime.sendMessage({ type: "STOP_LIVE_STREAMING" }).catch(() => {});
      } catch {
        /* 확장 리로드로 컨텍스트 무효화 — 무시 */
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

// 백그라운드 캡처 루프가 0.5초마다 광고 여부를 물어본다 (광고 중이면 서버로 무음 전송).
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    if ((message as Record<string, unknown>)?.type !== "GET_AD_STATE") return;
    sendResponse(activeController?.isAdPlaying() ?? false);
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
