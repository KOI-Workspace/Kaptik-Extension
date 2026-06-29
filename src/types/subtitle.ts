/** 지원 플랫폼 */
export type Platform = "youtube" | "weverse" | "instagram";

/**
 * 지원 자막 언어 코드 (BCP-47 일부)
 * - ko: 한국어 원문 (생성 소스), 나머지는 번역 대상 언어
 */
export type LanguageCode =
  | "ko" | "en" | "ja" | "zh-CN" | "id"
  | "th" | "zh-TW" | "es" | "vi" | "pt" | "it" | "de" | "ru" | "fr"
  | "hi" | "ar" | "tr" | "tl" | "ms" | "pl" | "cs" | "uk" | "ro"
  | "sv" | "no" | "da" | "fi" | "nl";

/** 사용자에게 보여줄 언어 라벨 */
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  "zh-CN": "简体中文",
  id: "Bahasa Indonesia",
  th: "ภาษาไทย",
  "zh-TW": "繁體中文",
  es: "Español",
  vi: "Tiếng Việt",
  pt: "Português",
  it: "Italiano",
  de: "Deutsch",
  ru: "Русский",
  fr: "Français",
  hi: "हिन्दी",
  ar: "العربية",
  tr: "Türkçe",
  tl: "Filipino",
  ms: "Bahasa Melayu",
  pl: "Polski",
  cs: "Čeština",
  uk: "Українська",
  ro: "Română",
  sv: "Svenska",
  no: "Norsk",
  da: "Dansk",
  fi: "Suomi",
  nl: "Nederlands",
};

/** 자막 번역 대상 언어 목록 (ko 제외) — 드롭다운·availableLanguages의 단일 진실 소스 */
export const SUBTITLE_LANGUAGE_CODES: LanguageCode[] = [
  "en", "ja", "zh-CN", "zh-TW", "id",
  "es", "pt", "fr", "de", "it", "ru", "pl", "cs", "uk", "ro",
  "th", "vi", "tr", "ar", "hi", "ms", "tl",
  "sv", "no", "da", "fi", "nl",
];

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
  /** 이 개념이 무엇인지 (1–2 sentences) */
  what: string;
  /** 발화와 어떻게 이어지는지 (1 sentence) */
  why: string;
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
  /** 화자 이름 식별 가능 여부 — false면 색상으로만 구분하고 이름/이니셜은 비공개 처리 */
  speakerIdentified?: boolean;
  /** 자막 생성 자체가 불가능한 사유 (예: "not_korean") — 있으면 패널에 안내만 표시 */
  error?: string;
}

/**
 * 영상의 자막 제공 상태.
 * - available: 자막 준비됨 → 바로 볼 수 있음
 * - none: 아직 번역 없음 → 생성 필요
 * - generating: 생성 중 (남은 시간/진행률 제공)
 * - failed: 생성 실패 (reason="not_korean"이면 한국어 영상이 아니라 생성 불가)
 * - monthly_limit: 월간 24시간 사용 한도 초과
 * - concurrent_job: 같은 계정에서 이미 번역이 진행 중 (1계정 1번역 제한)
 */
export type SubtitleStatus =
  | { state: "available"; isLive?: boolean; speakerIdentifiable?: boolean }
  | { state: "none" }
  | { state: "generating"; etaSeconds: number; progress: number; step?: string }
  | { state: "failed"; reason?: string }
  | { state: "monthly_limit" }
  | { state: "concurrent_job" };
