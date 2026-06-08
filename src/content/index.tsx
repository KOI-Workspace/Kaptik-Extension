import type { SiteAdapter } from "./siteAdapters";
import { resolveAdapter } from "./siteAdapters";
import type { BroadcastMessage } from "@/shared/messaging";
import { requestSubtitles } from "@/shared/messaging";
import {
  DEFAULT_SETTINGS,
  getSettings,
  onSettingsChanged,
  type KaptikSettings,
} from "@/shared/settings";
import { mountDisplay, type DisplayHandle } from "./ui/mount";
import { waitFor, watchUrlChanges } from "./utils";

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
  private mounted: { videoId: string; handle: DisplayHandle } | null = null;
  /** 비동기 경쟁 상태 방지 토큰 */
  private token = 0;

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

    // 생성 완료 브로드캐스트 → 재평가
    chrome.runtime.onMessage.addListener((message: BroadcastMessage) => {
      if (
        message?.type === "SUBTITLES_READY" &&
        message.platform === this.adapter.platform
      ) {
        void this.evaluate();
      }
    });

    // SPA 내부에서 video만 교체되는 경우 대비 주기 점검
    setInterval(() => void this.evaluate(), 1500);

    await this.evaluate();
  }

  /** 현재 상태에 맞춰 자막 UI를 표시/숨김 처리한다. */
  private async evaluate() {
    const token = ++this.token;
    const videoId = this.adapter.getVideoId(location.href);

    // 영상 없음 / 자막 OFF → 숨김
    if (!videoId) {
      console.info("[Kaptik] videoId 없음 → 숨김");
      this.teardown();
      return;
    }
    if (!this.settings.enabled) {
      console.info("[Kaptik] 자막 OFF (enabled=false) → 숨김");
      this.teardown();
      return;
    }

    // 개발 단계: mock 자막은 모든 영상에 항상 존재하므로 status 게이팅을 생략하고,
    // "자막 ON이면 무조건 표시"한다. (백엔드 연동 시 status 기반 게이팅을 복원)
    // → service worker 재시작 타이밍에 status가 null로 와서 안 뜨던 문제도 함께 해결.

    // 이미 같은 영상으로 표시 중이면 유지
    if (this.mounted?.videoId === videoId) {
      return;
    }

    // (재)마운트 준비
    this.teardown();
    const video = await waitFor(() => this.adapter.getVideoElement());
    if (token !== this.token) return;
    if (!video) {
      console.info("[Kaptik] video 요소 못 찾음");
      return;
    }

    const container = this.adapter.getOverlayContainer();
    if (!container) {
      console.info("[Kaptik] overlay container 못 찾음");
      return;
    }
    // 사이드 컬럼(관련영상 영역)이 있으면 패널을 거기에 도킹, 없으면 오버레이 폴백
    const panelContainer = this.adapter.getPanelContainer();
    console.info("[Kaptik] panelContainer 있음?", !!panelContainer);

    const track = await requestSubtitles(this.adapter.platform, videoId);
    if (token !== this.token) return;
    if (!track || track.cues.length === 0) {
      console.info(`[Kaptik] 자막 비어 있음 (${this.adapter.platform}/${videoId})`);
      return;
    }

    const handle = mountDisplay(container, panelContainer, video, track);
    this.mounted = { videoId, handle };
    console.info(
      `[Kaptik] 자막 표시 (${this.adapter.platform}/${videoId}, ${track.cues.length}줄)`,
    );
  }

  /** 표시 중인 자막 UI를 제거한다. */
  private teardown() {
    this.mounted?.handle.destroy();
    this.mounted = null;
  }
}

void bootstrap();
