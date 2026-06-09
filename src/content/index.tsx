import type { SiteAdapter } from "./siteAdapters";
import { resolveAdapter } from "./siteAdapters";
import type { BroadcastMessage } from "@/shared/messaging";
import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  type KaptikSettings,
} from "@/shared/settings";
import { mountDisplay, type DisplayHandle } from "./ui/mount";
import { waitFor, watchUrlChanges } from "./utils";
import type { SubtitleTrack } from "@/types/subtitle";

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
  } | null = null;
  private videoCleanup: (() => void) | null = null;
  /** 평가 진행 중 플래그 — 긴 await 동안 중복 evaluate가 끼어들어 취소시키는 것을 방지 */
  private evaluating = false;

  constructor(private adapter: SiteAdapter) {}

  async start() {
    this.settings = await getSettings();

    // 설정 변경(자막 ON/OFF, 패널 표시 등) → 재평가
    onSettingsChanged((s) => {
      this.settings = s;
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
        void this.evaluate();
      } else if (message?.type === "CUE_READY") {
        this.mounted?.handle.updateCues(message.cues);
      } else if (message?.type === "STREAMING_ERROR") {
        console.error("[Kaptik] 스트리밍 오류:", message.message);
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

      // 같은 영상, 같은 패널, 같은 video 요소면 유지
      // YouTube SPA가 video 요소를 교체하면 stale ref → 재마운트
      if (
        this.mounted?.videoId === videoId &&
        this.mounted.panelContainer === panelContainer &&
        this.mounted.video === this.adapter.getVideoElement()
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

      // 빈 트랙으로 먼저 마운트한 뒤 스트리밍으로 cue를 채운다
      const emptyTrack: SubtitleTrack = {
        platform: this.adapter.platform,
        videoId,
        cues: [],
        availableLanguages: ["ko", "en"],
        members: {},
      };
      const handle = mountDisplay(container, panelContainer, video, emptyTrack);
      this.mounted = { videoId, panelContainer, handle, video };

      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

      const startStreaming = (seekSec: number, keepCues = false) => {
        chrome.runtime.sendMessage({
          type: "START_STREAMING",
          youtubeUrl,
          seekSec,
          serverUrl: this.settings.serverUrl,
          keepCues,
        }).catch((err: unknown) => console.error("[Kaptik] START_STREAMING 실패:", err));
        console.info(`[Kaptik] 스트리밍 요청 (${videoId}, seek=${seekSec}s, keepCues=${keepCues})`);
      };

      startStreaming(Math.floor(video.currentTime));

      let seekTimer: ReturnType<typeof setTimeout> | undefined;

      // 일시정지 → STT 중단
      const onPaused = () => {
        chrome.runtime.sendMessage({ type: "STOP_STREAMING" }).catch(() => {});
        console.info(`[Kaptik] 일시정지 → 스트리밍 중단 (${videoId})`);
      };

      // 재생 재개 → 현재 위치부터 재스트리밍 (기존 cue 유지)
      const onPlaying = () => {
        clearTimeout(seekTimer);
        startStreaming(Math.floor(video.currentTime), true);
      };

      // seek 완료 → 재생 중일 때만 500ms 디바운스 후 재스트리밍
      const onSeeked = () => {
        if (video.paused) return; // 일시정지 중 탐색은 play 이벤트가 처리
        clearTimeout(seekTimer);
        seekTimer = setTimeout(() => startStreaming(Math.floor(video.currentTime), true), 500);
      };

      video.addEventListener("pause", onPaused);
      video.addEventListener("playing", onPlaying);
      video.addEventListener("seeked", onSeeked);
      this.videoCleanup = () => {
        clearTimeout(seekTimer);
        video.removeEventListener("pause", onPaused);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("seeked", onSeeked);
      };

      console.info(`[Kaptik] 자막 마운트 완료 (${this.adapter.platform}/${videoId})`);
    } finally {
      this.evaluating = false;
    }
  }

  /** 표시 중인 자막 UI와 스트리밍 세션을 제거한다. */
  private teardown() {
    this.videoCleanup?.();
    this.videoCleanup = null;
    if (this.mounted) {
      chrome.runtime.sendMessage({ type: "STOP_STREAMING" }).catch(() => {});
    }
    this.mounted?.handle.destroy();
    this.mounted = null;
  }
}

void bootstrap();
