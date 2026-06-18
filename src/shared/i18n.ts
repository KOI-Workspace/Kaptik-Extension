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
  cannotCreateTitle: string;
  cannotCreateNotKoreanDesc: string;
  loginTitle: string;
  loginDesc: string;
  loginWithGoogle: string;
  logoutBtn: string;
  readyTitle: string;
  readyDesc: string;
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
  vodLockTitle: string;
  vodLockDesc: string;
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
  // 라이브 스트림
  liveBadge: string;
  liveJustNow: string;
  liveAgoSec: (s: number) => string;
  liveAgoMin: (m: number) => string;
  // alwaysCapture 플랫폼 (Weverse 등) 팝업 시작 버튼
  liveNoneTitle: string;
  liveNoneDesc: string;
  startLiveBtn: string;
  liveCapturingNote: string;
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
    cannotCreateTitle: "Cannot create subtitles",
    cannotCreateNotKoreanDesc: "This video isn't in Korean, so subtitles can't be generated for it.",
    loginTitle: "Sign in to Kaptik",
    loginDesc: "Sign in to sync your subtitle settings and plan.",
    loginWithGoogle: "Continue with Google",
    logoutBtn: "Log out",
    readyTitle: "Subtitles are ready",
    readyDesc: "Tap below to configure and view your subtitles.",
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
    vodLockTitle: "Pro plan required for recorded videos",
    vodLockDesc: "Basic includes live streams only. Upgrade to Pro to generate subtitles for any video.",
    planTestLabel: "Plan (dev test)",
    panelTitle: "Transcript",
    panelEmpty: "Subtitles will start soon",
    latest: "Latest",
    ariaChangeLang: "Change subtitle language",
    ariaClosePanel: "Close panel",
    ariaCloseAnnotation: "Close note",
    seekTo: (t) => `Jump to ${t}`,
    previewText: "Hey everyone, we're finally here!",
    liveBadge: "LIVE",
    liveJustNow: "just now",
    liveAgoSec: (s) => `${s}s ago`,
    liveAgoMin: (m) => `${m}m ago`,
    liveNoneTitle: "Live subtitles ready",
    liveNoneDesc: "Start capturing to see real-time translations.",
    startLiveBtn: "Start live subtitles",
    liveCapturingNote: "Subtitles will appear shortly. You can close this popup.",
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
    cannotCreateTitle: "字幕を作成できません",
    cannotCreateNotKoreanDesc: "この動画は韓国語ではないため、字幕を生成できません。",
    loginTitle: "Kaptikにログイン",
    loginDesc: "字幕設定とプランを同期するにはログインしてください。",
    loginWithGoogle: "Googleで続行",
    logoutBtn: "ログアウト",
    readyTitle: "字幕の準備ができました",
    readyDesc: "下のボタンをタップして字幕を設定・表示してください。",
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
    vodLockTitle: "録画動画はProプランが必要です",
    vodLockDesc: "Basicはライブ配信のみ対応しています。すべての動画に字幕を付けるにはProにアップグレードしてください。",
    planTestLabel: "プラン（テスト）",
    panelTitle: "書き起こし",
    panelEmpty: "まもなく字幕が始まります",
    latest: "最新",
    ariaChangeLang: "字幕の言語を変更",
    ariaClosePanel: "パネルを閉じる",
    ariaCloseAnnotation: "メモを閉じる",
    seekTo: (t) => `${t}へ移動`,
    previewText: "みなさん、やっと来ましたよ！",
    liveBadge: "LIVE",
    liveJustNow: "たった今",
    liveAgoSec: (s) => `${s}秒前`,
    liveAgoMin: (m) => `${m}分前`,
    liveNoneTitle: "ライブ字幕の準備完了",
    liveNoneDesc: "キャプチャを開始してリアルタイム翻訳を見る。",
    startLiveBtn: "ライブ字幕を開始",
    liveCapturingNote: "まもなく字幕が表示されます。このポップアップは閉じて構いません。",
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
    cannotCreateTitle: "无法生成字幕",
    cannotCreateNotKoreanDesc: "该视频不是韩语视频，无法生成字幕。",
    loginTitle: "登录 Kaptik",
    loginDesc: "登录后可同步字幕设置和套餐。",
    loginWithGoogle: "继续使用 Google 登录",
    logoutBtn: "退出登录",
    readyTitle: "字幕已准备好",
    readyDesc: "点击下方按钮来配置和查看字幕。",
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
    vodLockTitle: "录制视频需要 Pro 套餐",
    vodLockDesc: "Basic 仅支持直播。升级到 Pro 即可为任意视频生成字幕。",
    planTestLabel: "套餐（测试）",
    panelTitle: "文字记录",
    panelEmpty: "字幕即将开始",
    latest: "最新",
    ariaChangeLang: "更改字幕语言",
    ariaClosePanel: "关闭面板",
    ariaCloseAnnotation: "关闭注释",
    seekTo: (t) => `跳转到 ${t}`,
    previewText: "大家好，我们终于来了！",
    liveBadge: "LIVE",
    liveJustNow: "刚刚",
    liveAgoSec: (s) => `${s}秒前`,
    liveAgoMin: (m) => `${m}分前`,
    liveNoneTitle: "字幕准备就绪",
    liveNoneDesc: "开始捕获以查看实时翻译。",
    startLiveBtn: "开始实时字幕",
    liveCapturingNote: "字幕即将出现。您可以关闭此弹窗。",
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
    cannotCreateTitle: "Subtitle tidak dapat dibuat",
    cannotCreateNotKoreanDesc: "Video ini bukan berbahasa Korea, jadi subtitle tidak dapat dibuat.",
    loginTitle: "Masuk ke Kaptik",
    loginDesc: "Masuk untuk menyinkronkan pengaturan subtitle dan paket kamu.",
    loginWithGoogle: "Lanjutkan dengan Google",
    logoutBtn: "Keluar",
    readyTitle: "Subtitle sudah siap",
    readyDesc: "Ketuk tombol di bawah untuk mengatur dan melihat subtitle.",
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
    vodLockTitle: "Video rekaman memerlukan paket Pro",
    vodLockDesc: "Basic hanya mencakup siaran langsung. Upgrade ke Pro untuk membuat subtitle di semua video.",
    planTestLabel: "Paket (uji)",
    panelTitle: "Transkrip",
    panelEmpty: "Subtitle akan segera dimulai",
    latest: "Terbaru",
    ariaChangeLang: "Ubah bahasa subtitle",
    ariaClosePanel: "Tutup panel",
    ariaCloseAnnotation: "Tutup catatan",
    seekTo: (t) => `Lompat ke ${t}`,
    previewText: "Hai semua, kita akhirnya di sini!",
    liveBadge: "LIVE",
    liveJustNow: "baru saja",
    liveAgoSec: (s) => `${s}d lalu`,
    liveAgoMin: (m) => `${m}m lalu`,
    liveNoneTitle: "Subtitle live siap",
    liveNoneDesc: "Mulai menangkap untuk melihat terjemahan real-time.",
    startLiveBtn: "Mulai subtitle live",
    liveCapturingNote: "Subtitle akan segera muncul. Anda bisa menutup popup ini.",
  },
};

/** 선택 언어에 해당하는 UI 문자열 묶음을 반환한다 (미지원 언어는 영어). */
export function getMessages(lang: LanguageCode): Messages {
  return MESSAGES[toUiLanguage(lang)];
}
