import type { Platform } from "@/types/subtitle";

/**
 * 사이트별 영상 플레이어 접근 방식을 추상화한 어댑터.
 * YouTube/Weverse 등 DOM 구조가 달라도 동일 인터페이스로 다룬다.
 */
export interface SiteAdapter {
  platform: Platform;
  /** 현재 URL이 이 어댑터의 대상 사이트인지 */
  matches(url: string): boolean;
  /**
   * URL에서 영상 식별자를 추출한다 (없으면 null).
   * content/popup 양쪽에서 재사용하므로 DOM이 아닌 URL만으로 판단한다.
   */
  getVideoId(url: string): string | null;
  /** 자막 동기화 기준이 되는 video 요소 (없으면 null) */
  getVideoElement(): HTMLVideoElement | null;
  /**
   * 오버레이를 붙일 컨테이너 (보통 플레이어 래퍼).
   * 전체화면에서도 유지되도록 video를 감싸는 요소를 반환한다.
   */
  getOverlayContainer(): HTMLElement | null;
  /**
   * 자막 히스토리 패널을 끼워 넣을 사이드 컬럼 컨테이너.
   * 영상 옆(예: YouTube 관련영상 영역)에 패널을 도킹할 위치를 반환한다.
   * 적절한 위치가 없으면 null — 이 경우 패널은 영상 위 오버레이로 폴백한다.
   */
  getPanelContainer(): HTMLElement | null;
}
