/** 지원 플랫폼 */
export type Platform = "youtube" | "weverse" | "instagram";

/**
 * 지원 자막 언어 코드 (BCP-47 일부)
 * - ko: 한국어 원문, en: 영어, ja: 일본어, zh-CN: 중국어 간체, id: 인도네시아어
 */
export type LanguageCode = "ko" | "en" | "ja" | "zh-CN" | "id";

/** 사용자에게 보여줄 언어 라벨 */
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
  id: "Bahasa Indonesia",
};

/** 화자(멤버) 정보 */
export interface Member {
  /** 멤버 식별자 (예: 'rm', 'suga') */
  id: string;
  /** 표시 이름 */
  name: string;
  /** 시그니처 컬러 (이름 라벨/아바타 링에 사용) */
  color: string;
  /** 프로필 이미지 URL (없으면 이니셜 아바타로 대체) */
  avatarUrl?: string;
}

/** 문화적 맥락 주석 (대사 내 특정 구절에 연결) */
export interface Annotation {
  /** 자막 텍스트에서 밑줄로 강조할 구절 (표시 언어 기준 매칭). 비우면 줄 끝 ⓘ 배지로 표시 */
  term?: string;
  /** 주석 제목 */
  title: string;
  /** 주석 본문 설명 */
  description: string;
}

/** 단일 자막 큐 (한 줄의 발화) */
export interface SubtitleCue {
  /** 시작 시각(초) */
  start: number;
  /** 종료 시각(초) */
  end: number;
  /** 화자 멤버 id (track.members 참조) */
  speakerId?: string;
  /** 언어별 자막 텍스트. 일부 언어만 존재할 수 있음 */
  text: Partial<Record<LanguageCode, string>>;
  /** 문화적 맥락 주석 목록 */
  annotations?: Annotation[];
}

/** 한 영상에 대한 전체 자막 트랙 */
export interface SubtitleTrack {
  platform: Platform;
  /** 플랫폼 내 영상 식별자 */
  videoId: string;
  /** 시간순 정렬된 자막 큐 목록 */
  cues: SubtitleCue[];
  /** 이 트랙에서 제공 가능한 언어 목록 */
  availableLanguages: LanguageCode[];
  /** 화자 멤버 레지스트리 (id → Member) */
  members: Record<string, Member>;
  /** 라이브 영상 여부 */
  isLive?: boolean;
}

/**
 * 영상의 자막 제공 상태.
 * - available: 자막 준비됨 → 바로 볼 수 있음
 * - none: 아직 번역 없음 → 생성 필요
 * - generating: 생성 중 (남은 시간/진행률 제공)
 * - failed: 생성 실패
 */
export type SubtitleStatus =
  | { state: "available"; isLive?: boolean }
  | { state: "none" }
  | { state: "generating"; etaSeconds: number; progress: number }
  | { state: "failed"; reason?: string };
