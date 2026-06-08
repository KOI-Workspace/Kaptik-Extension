import type { LanguageCode } from "@/types/subtitle";

/**
 * UI 표시 언어.
 * 한국어(ko)는 K-pop 원문 언어이므로 시청자 UI 언어 선택지에서는 제외한다.
 */
export type UiLanguage = Exclude<LanguageCode, "ko">;

/** 사용자가 선택할 수 있는 UI/자막 언어 (한국어 제외, 영어가 기본) */
export const UI_LANGUAGE_OPTIONS: UiLanguage[] = ["en", "ja", "zh-CN", "id"];

/** 기본 UI 언어 */
export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

/** 임의의 언어 코드를 UI 지원 언어로 보정한다 (ko 등 미지원은 영어로 폴백). */
export function toUiLanguage(lang: LanguageCode): UiLanguage {
  return (UI_LANGUAGE_OPTIONS as string[]).includes(lang)
    ? (lang as UiLanguage)
    : DEFAULT_UI_LANGUAGE;
}

/** UI 문자열 묶음 */
export interface Messages {
  // 공통/팝업 헤더
  appTagline: string;
  footer: string;
  // 상태 뷰
  checking: string;
  unsupportedTitle: string;
  unsupportedDesc: string;
  noneTitle: string;
  noneDesc: string;
  generateBtn: string;
  noneNote: string;
  generatingTitle: string;
  generatingEta: (seconds: number) => string;
  notifyLabel: string;
  generatingNote: string;
  failedTitle: string;
  retryBtn: string;
  readyTitle: string;
  viewSubtitlesBtn: string;
  // 설정 항목
  langLabel: string;
  speakerLabel: string;
  panelLabel: string;
  lineCountLabel: string;
  lineCountOne: string;
  lineCountTwo: string;
  fontSizeLabel: string;
  bgOpacityLabel: string;
  // aria
  ariaToggleSubtitles: string;
  ariaNotifyReady: string;
  // 결제/등급
  ctaUnlock: string;
  planBasic: string;
  planPro: string;
  upgradeTitle: string;
  upgradeDesc: string;
  upgradeCta: string;
  panelLockTitle: string;
  panelLockDesc: string;
  planTestLabel: string;
  // 패널
  panelTitle: string;
  panelEmpty: string;
  latest: string;
  ariaChangeLang: string;
  ariaClosePanel: string;
  ariaCloseAnnotation: string;
  seekTo: (time: string) => string;
  // 미리보기 샘플 자막
  previewText: string;
}

const MESSAGES: Record<UiLanguage, Messages> = {
  en: {
    appTagline: "K-pop Subtitles",
    footer: "Subtitles appear automatically on YouTube · Weverse videos",
    checking: "Checking status…",
    unsupportedTitle: "Not a supported video page",
    unsupportedDesc: "Open a YouTube or Weverse video, then try again.",
    noneTitle: "No translation yet for this video",
    noneDesc:
      "Generate subtitles to see speaker-by-speaker translations and cultural context.",
    generateBtn: "Generate subtitles",
    noneNote: "This can take 1–2 minutes depending on video length.",
    generatingTitle: "Creating subtitles…",
    generatingEta: (s) => `About ${s}s left`,
    notifyLabel: "Notify me when ready",
    generatingNote: "You can close this popup. We'll notify you when it's done.",
    failedTitle: "Subtitle generation failed",
    retryBtn: "Try again",
    readyTitle: "Subtitles are ready",
    viewSubtitlesBtn: "View subtitles",
    langLabel: "Subtitle language",
    speakerLabel: "Speaker Identification",
    panelLabel: "Transcript",
    lineCountLabel: "Subtitle lines",
    lineCountOne: "1 line",
    lineCountTwo: "2 lines",
    fontSizeLabel: "Subtitle size",
    bgOpacityLabel: "Background opacity",
    ariaToggleSubtitles: "Toggle subtitles",
    ariaNotifyReady: "Notify when ready",
    ctaUnlock: "Upgrade",
    planBasic: "Basic",
    planPro: "Pro",
    upgradeTitle: "Unlock everything with Pro",
    upgradeDesc: "Limited-time 50% off — speaker labels, history & cultural notes.",
    upgradeCta: "Upgrade to Pro",
    panelLockTitle: "Subtitle history is a Pro feature",
    panelLockDesc: "Upgrade to follow the full speaker-by-speaker history.",
    planTestLabel: "Plan (dev test)",
    panelTitle: "Transcript",
    panelEmpty: "Subtitles will start soon",
    latest: "Latest",
    ariaChangeLang: "Change subtitle language",
    ariaClosePanel: "Close panel",
    ariaCloseAnnotation: "Close note",
    seekTo: (t) => `Jump to ${t}`,
    previewText: "Hey everyone, we're finally here!",
  },
  ja: {
    appTagline: "K-POP字幕",
    footer: "YouTube・Weverseの動画で自動的に字幕を表示します",
    checking: "状態を確認中…",
    unsupportedTitle: "対応している動画ページではありません",
    unsupportedDesc:
      "YouTubeまたはWeverseの動画を開いてからもう一度押してください。",
    noneTitle: "この動画はまだ翻訳がありません",
    noneDesc: "字幕を生成すると、話者ごとの翻訳や文化的背景まで見られます。",
    generateBtn: "字幕を生成",
    noneNote: "動画の長さによっては1〜2分ほどかかることがあります。",
    generatingTitle: "字幕を作成しています…",
    generatingEta: (s) => `残り約${s}秒`,
    notifyLabel: "完了したら通知する",
    generatingNote:
      "このポップアップを閉じても大丈夫です。完了したら通知します。",
    failedTitle: "字幕の生成に失敗しました",
    retryBtn: "再試行",
    readyTitle: "字幕の準備ができました",
    viewSubtitlesBtn: "字幕を見る",
    langLabel: "字幕の言語",
    speakerLabel: "話者ラベル",
    panelLabel: "書き起こし",
    lineCountLabel: "字幕の行数",
    lineCountOne: "1行",
    lineCountTwo: "2行",
    fontSizeLabel: "字幕サイズ",
    bgOpacityLabel: "背景の透明度",
    ariaToggleSubtitles: "字幕のオン/オフ",
    ariaNotifyReady: "完了時に通知",
    ctaUnlock: "アップグレード",
    planBasic: "Basic",
    planPro: "Pro",
    upgradeTitle: "Proですべての機能を解放",
    upgradeDesc: "期間限定50%オフ — 話者ラベル・履歴・文化メモ。",
    upgradeCta: "Proにアップグレード",
    panelLockTitle: "字幕履歴はPro機能です",
    panelLockDesc: "アップグレードで話者ごとの全履歴を表示できます。",
    planTestLabel: "プラン（テスト）",
    panelTitle: "書き起こし",
    panelEmpty: "まもなく字幕が始まります",
    latest: "最新",
    ariaChangeLang: "字幕の言語を変更",
    ariaClosePanel: "パネルを閉じる",
    ariaCloseAnnotation: "メモを閉じる",
    seekTo: (t) => `${t}へ移動`,
    previewText: "みなさん、やっと来ましたよ！",
  },
  "zh-CN": {
    appTagline: "K-pop字幕",
    footer: "在 YouTube · Weverse 视频上自动显示字幕",
    checking: "正在检查状态…",
    unsupportedTitle: "不是受支持的视频页面",
    unsupportedDesc: "请打开 YouTube 或 Weverse 视频后再试。",
    noneTitle: "该视频暂无翻译",
    noneDesc: "生成字幕后可查看分角色翻译和文化背景。",
    generateBtn: "生成字幕",
    noneNote: "根据视频长度，可能需要 1~2 分钟。",
    generatingTitle: "正在生成字幕…",
    generatingEta: (s) => `大约还剩 ${s} 秒`,
    notifyLabel: "完成后通知我",
    generatingNote: "可以关闭此弹窗。完成后会通知你。",
    failedTitle: "字幕生成失败",
    retryBtn: "重试",
    readyTitle: "字幕已准备好",
    viewSubtitlesBtn: "查看字幕",
    langLabel: "字幕语言",
    speakerLabel: "角色标签",
    panelLabel: "文字记录",
    lineCountLabel: "字幕行数",
    lineCountOne: "1 行",
    lineCountTwo: "2 行",
    fontSizeLabel: "字幕大小",
    bgOpacityLabel: "背景透明度",
    ariaToggleSubtitles: "开关字幕",
    ariaNotifyReady: "完成时通知",
    ctaUnlock: "升级",
    planBasic: "Basic",
    planPro: "Pro",
    upgradeTitle: "升级 Pro 解锁全部功能",
    upgradeDesc: "限时 5 折 — 角色标签、历史记录和文化注释。",
    upgradeCta: "升级到 Pro",
    panelLockTitle: "字幕历史是 Pro 功能",
    panelLockDesc: "升级后可查看完整的分角色历史记录。",
    planTestLabel: "套餐（测试）",
    panelTitle: "文字记录",
    panelEmpty: "字幕即将开始",
    latest: "最新",
    ariaChangeLang: "更改字幕语言",
    ariaClosePanel: "关闭面板",
    ariaCloseAnnotation: "关闭注释",
    seekTo: (t) => `跳转到 ${t}`,
    previewText: "大家好，我们终于来了！",
  },
  id: {
    appTagline: "Subtitle K-pop",
    footer: "Subtitle muncul otomatis di video YouTube · Weverse",
    checking: "Memeriksa status…",
    unsupportedTitle: "Bukan halaman video yang didukung",
    unsupportedDesc: "Buka video YouTube atau Weverse, lalu coba lagi.",
    noneTitle: "Video ini belum punya terjemahan",
    noneDesc:
      "Buat subtitle untuk melihat terjemahan per pembicara dan konteks budaya.",
    generateBtn: "Buat subtitle",
    noneNote: "Bisa memakan waktu 1–2 menit tergantung durasi video.",
    generatingTitle: "Membuat subtitle…",
    generatingEta: (s) => `Sekitar ${s} detik lagi`,
    notifyLabel: "Beri tahu saya saat siap",
    generatingNote:
      "Kamu boleh menutup popup ini. Kami akan memberi tahu saat selesai.",
    failedTitle: "Gagal membuat subtitle",
    retryBtn: "Coba lagi",
    readyTitle: "Subtitle sudah siap",
    viewSubtitlesBtn: "Lihat subtitle",
    langLabel: "Bahasa subtitle",
    speakerLabel: "Label pembicara",
    panelLabel: "Transkrip",
    lineCountLabel: "Baris subtitle",
    lineCountOne: "1 baris",
    lineCountTwo: "2 baris",
    fontSizeLabel: "Ukuran subtitle",
    bgOpacityLabel: "Transparansi latar",
    ariaToggleSubtitles: "Aktifkan/nonaktifkan subtitle",
    ariaNotifyReady: "Beri tahu saat siap",
    ctaUnlock: "Upgrade",
    planBasic: "Basic",
    planPro: "Pro",
    upgradeTitle: "Buka semua fitur dengan Pro",
    upgradeDesc: "Diskon 50% terbatas — label pembicara, riwayat & catatan budaya.",
    upgradeCta: "Upgrade ke Pro",
    panelLockTitle: "Riwayat subtitle adalah fitur Pro",
    panelLockDesc: "Upgrade untuk melihat riwayat lengkap per pembicara.",
    planTestLabel: "Paket (uji)",
    panelTitle: "Transkrip",
    panelEmpty: "Subtitle akan segera dimulai",
    latest: "Terbaru",
    ariaChangeLang: "Ubah bahasa subtitle",
    ariaClosePanel: "Tutup panel",
    ariaCloseAnnotation: "Tutup catatan",
    seekTo: (t) => `Lompat ke ${t}`,
    previewText: "Hai semua, kita akhirnya di sini!",
  },
};

/** 선택 언어에 해당하는 UI 문자열 묶음을 반환한다 (미지원 언어는 영어). */
export function getMessages(lang: LanguageCode): Messages {
  return MESSAGES[toUiLanguage(lang)];
}
