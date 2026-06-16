import type { LanguageCode } from "@/types/subtitle";

/** 결제 등급 — free(미결제) / basic / pro */
export type PlanTier = "free" | "basic" | "pro";

/** JWT payload에서 plan 필드를 추출한다. 유효하지 않으면 "free" 반환. */
export function decodeTokenPlan(token: string): PlanTier {
  try {
    const segment = token.split(".")[1];
    if (!segment) return "free";
    const payload = JSON.parse(atob(segment.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    if (payload.plan === "basic" || payload.plan === "pro") return payload.plan;
  } catch { /* invalid token */ }
  return "free";
}

/** 사용자 자막 설정 */
export interface KaptikSettings {
  /** 자막 표시 on/off (마스터 토글 — '자막 보기'가 켬) */
  enabled: boolean;
  /** 표시할 자막 언어 */
  language: LanguageCode;
  /** 화자 라벨 표시 여부 */
  showSpeaker: boolean;
  /** 자막 글자 크기 배율 (0.8 ~ 1.6) */
  fontScale: number;
  /** 가운데 하단 오버레이에 한 번에 보일 줄 수 (1=한 줄, 2=두 줄) */
  overlayLineCount: 1 | 2;
  /** 가운데 오버레이 배경(검은색) 불투명도 (0 ~ 1) */
  overlayOpacity: number;
  /** 우측 히스토리 패널 표시 여부 */
  showPanel: boolean;
  /** 자막 생성 완료 시 시스템 알림 받기 */
  notifyOnReady: boolean;
  /** 현재 결제 등급 — 백엔드 연동 전 테스트용 플래그 */
  plan: PlanTier;
  /** 결제 계정 표시 이름 (등급 배지 옆 프로필에 사용, 목업) */
  profileName: string;
  /** 스트리밍 백엔드 WebSocket 서버 URL */
  serverUrl: string;
  /** 백엔드 JWT 인증 토큰 — 빈 문자열이면 미로그인 */
  authToken: string;
  /** 개발 모드 — true이면 authToken 대신 "dev" 토큰 전송 */
  devMode: boolean;
  /** 로그인 여부 — false면 팝업에 로그인 화면을 보여준다 */
  loggedIn: boolean;
}

/** 유료 등급(basic/pro) 여부 — 미결제(free)와 결제 후를 구분 */
export function isPaid(plan: PlanTier): boolean {
  return plan !== "free";
}

/** devMode / authToken / plan 순서로 실제 등급을 결정한다 */
export function getEffectivePlan(settings: KaptikSettings): PlanTier {
  if (settings.devMode) return "pro";
  if (settings.authToken) return decodeTokenPlan(settings.authToken);
  return settings.plan;
}

/** chrome.storage.sync 에 저장되는 키 */
export const SETTINGS_KEY = "kaptik:settings";

/** 기본 설정값 */
export const DEFAULT_SETTINGS: KaptikSettings = {
  enabled: true,
  language: "en",
  showSpeaker: true,
  fontScale: 1,
  overlayLineCount: 2,
  overlayOpacity: 0.6,
  showPanel: true,
  notifyOnReady: true,
  plan: "free",
  profileName: "Jiwoo Kim",
  serverUrl: "ws://localhost:8000",
  authToken: "",
  devMode: false,
  loggedIn: true,
};

/** 결제/업그레이드 페이지 URL (백엔드 연동 전 placeholder) */
export const PRICING_URL = "https://kaptik.app/pricing";

/**
 * 저장된 설정을 읽어 기본값과 병합해 반환한다.
 * 즉시 반영을 위해 chrome.storage.local 사용 (sync는 지연/쓰기 제한이 있음).
 * @returns 완전한 형태의 설정 객체
 */
export async function getSettings(): Promise<KaptikSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) };
}

/**
 * 설정 일부를 갱신해 저장한다.
 * @param patch 변경할 설정 항목
 */
export async function updateSettings(
  patch: Partial<KaptikSettings>,
): Promise<KaptikSettings> {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * 설정 변경을 구독한다.
 * @param callback 변경된 설정을 받는 콜백
 * @returns 구독 해제 함수
 */
export function onSettingsChanged(
  callback: (settings: KaptikSettings) => void,
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string,
  ) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      callback({ ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue ?? {}) });
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
