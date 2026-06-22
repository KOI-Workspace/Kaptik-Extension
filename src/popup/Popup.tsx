import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  isPaid,
  getEffectivePlan,
  PRICING_URL,
  type KaptikSettings,
} from "@/shared/settings";
import { getMessages, UI_LANGUAGE_OPTIONS, type Messages } from "@/shared/i18n";
import { resolveAdapter } from "@/content/siteAdapters";
import {
  requestStatus,
  startGeneration,
  setLiveLang,
} from "@/shared/messaging";
import {
  LANGUAGE_LABELS,
  type LanguageCode,
  type Platform,
  type SubtitleStatus,
} from "@/types/subtitle";

/** 현재 탭에서 식별된 영상 */
interface Target {
  platform: Platform;
  videoId: string;
  isLive: boolean;
  /** true = 팝업의 Start 버튼으로 오디오 캡처를 시작해야 하는 플랫폼 (Weverse 등) */
  alwaysCapture: boolean;
}

/** 토글 스위치 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" />
    </label>
  );
}

export function Popup() {
  // undefined: 확인 중, null: 지원 안 함, Target: 영상 식별됨
  const [target, setTarget] = useState<Target | null | undefined>(undefined);
  const [settings, setSettings] = useState<KaptikSettings>(DEFAULT_SETTINGS);
  // undefined: 첫 poll 응답 대기 중 (팝업 열릴 때 순간적으로 NoneView가 보이지 않도록)
  const [status, setStatus] = useState<SubtitleStatus | undefined>(undefined);
  // 팝업이 열린 상태에서 generating → available 전환이 감지되면 설정창 대신 완료 안내 뷰를 표시
  const prevStatusStateRef = useRef<SubtitleStatus["state"]>("none");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // alwaysCapture 플랫폼(Weverse)에서 Start 버튼 클릭 시 tabId 전달을 위해 저장
  const tabInfoRef = useRef<{ id: number; url: string; title: string } | null>(null);
  // 2초 폴링 interval ID (cleanup용)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // poll 클로저에서 settings 최신값을 읽기 위한 ref (useEffect는 target 변경 시에만 재실행되므로 직접 참조 시 stale)
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // settings.language가 UI 언어와 자막 생성 언어를 함께 제어
  const t = getMessages(settings.language);

  useEffect(() => {
    let active = true;
    (async () => {
      const s = await getSettings();
      if (active) setSettings(s);

      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const url = tab?.url ?? "";
      const adapter = resolveAdapter(url);
      const videoId = adapter?.getVideoId(url) ?? null;
      if (!adapter || !videoId) {
        if (active) setTarget(null);
        return;
      }
      // content script가 DOM 기반으로 저장한 isLive를 읽는다 (없으면 URL 기반 폴백)
      const storageKey = `kaptik:live:${adapter.platform}:${videoId}`;
      const stored = await chrome.storage.local.get(storageKey);
      const isLive = typeof stored[storageKey] === "boolean"
        ? (stored[storageKey] as boolean)
        : (adapter.isLive?.(url) ?? false);

      // alwaysCapture 플랫폼(Weverse 등): Start 버튼 클릭 시 사용할 탭 정보를 미리 저장
      if (adapter.alwaysCapture && tab?.id) {
        tabInfoRef.current = { id: tab.id, url, title: tab.title ?? "" };
      }

      const target: Target = {
        platform: adapter.platform,
        videoId,
        isLive,
        alwaysCapture: adapter.alwaysCapture ?? false,
      };
      if (active) setTarget(target);
    })();

    return () => { active = false; };
  }, []);

  // target이 확인되면 상태 폴링 시작
  useEffect(() => {
    if (!target) return;

    let active = true;

    const poll = async () => {
      // settingsRef로 현재 language를 읽어 전달 — storage 쓰기 전 race condition 방지
      const s = await requestStatus(
        target.platform,
        target.videoId,
        settingsRef.current.language,
        tabInfoRef.current?.url,
      );
      if (active && s) {
        // 로컬 상태가 아직 "none"이지만 UI가 "generating"인 경우 — job이 백엔드에서
        // 아직 startLocalJob 전이므로 poll이 "none"을 돌려줘 UI를 되돌리지 않도록 한다.
        if (prevStatusStateRef.current === "generating" && s.state === "none") return;
        prevStatusStateRef.current = s.state as SubtitleStatus["state"];
        setStatus(s);
      }
    };

    void poll();
    pollIntervalRef.current = setInterval(() => { void poll(); }, 2000);

    return () => {
      active = false;
      if (pollIntervalRef.current != null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [target]);

  const patch = (next: Partial<KaptikSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
    void updateSettings(next);
  };

  /** 결제/업그레이드 페이지를 새 탭으로 연다. */
  const openPricing = () => {
    void chrome.tabs.create({ url: PRICING_URL });
  };

  const handleGenerate = () => {
    if (!target) return;
    prevStatusStateRef.current = "generating";
    setStatus({ state: "generating", etaSeconds: 0, progress: 0 });
    // 시작 전 고른 언어를 명시 전달 — patch(storage 쓰기) 완료 전 race condition 방지
    void startGeneration(target.platform, target.videoId, false, settings.language).then((eta) => {
      if (eta === null) {
        setStatus({ state: "failed" });
      } else {
        setStatus((prev) =>
          prev?.state === "generating" ? { ...prev, etaSeconds: eta } : prev
        );
      }
    });
  };

  /**
   * alwaysCapture 플랫폼(Weverse 등)의 Start 버튼 핸들러.
   * 팝업 클릭으로 activeTab 권한이 부여된 상태에서 오디오 캡처를 시작한다.
   */
  const handleStartLive = async () => {
    if (!target || !tabInfoRef.current) return;
    const { id: tabId, url: videoUrl, title: videoTitle } = tabInfoRef.current;
    prevStatusStateRef.current = "generating";
    setStatus({ state: "generating", etaSeconds: 0, progress: 0 });
    // content script에서 실제 재생 위치를 받아 앵커로 사용 (실패 시 0 폴백)
    let captureStartVideoTime = 0;
    try {
      const t = await chrome.tabs.sendMessage(tabId, { type: "GET_VIDEO_TIME" });
      if (typeof t === "number" && Number.isFinite(t)) captureStartVideoTime = t;
    } catch {
      /* content script 미응답 → 0 사용 */
    }
    void chrome.runtime.sendMessage({
      type: "START_LIVE_STREAMING",
      platform: target.platform,
      videoId: target.videoId,
      tabId,
      captureStartVideoTime,
      videoTitle,
      videoUrl,
    });
  };

  const handleRetry = () => {
    prevStatusStateRef.current = "none";
    setStatus({ state: "none" });
  };

  /** 현재 영상의 로컬 저장 cue를 삭제한다 (광고 구간 오캡처 데이터 제거). */
  const handleClearCues = () => {
    if (!target) return;
    void chrome.runtime.sendMessage({
      type: "CLEAR_LIVE_CUES",
      platform: target.platform,
      videoId: target.videoId,
    });
  };

  const handleLanguageChange = (newLang: LanguageCode) => {
    if (!target) return;
    patch({ language: newLang });

    // alwaysCapture(위버스 등) 라이브 캡처: 언어 변경 = 캡처를 유지한 채 서버 번역 언어만 전환.
    // 이전 언어 자막은 비우고 새 언어로 다시 쌓인다 (광고 차단 등 나머지 로직은 그대로).
    // VOD처럼 generating으로 되돌리지 않아 설정창(언어 선택)이 유지된다.
    if (target.alwaysCapture && tabInfoRef.current) {
      setLiveLang(tabInfoRef.current.id, newLang);
      return;
    }

    // YouTube VOD: 새 언어로 전환 — 서버에 이미 해당 언어 자막이 있으면 캐시 재사용
    prevStatusStateRef.current = "generating";
    setStatus({ state: "generating", etaSeconds: 0, progress: 0 });
    void startGeneration(target.platform, target.videoId, false, newLang).then((eta) => {
      if (eta === null) {
        setStatus({ state: "failed" });
      } else {
        setStatus((prev) =>
          prev?.state === "generating" ? { ...prev, etaSeconds: eta } : prev
        );
      }
    });
  };

  const handleLogout = () => {
    setAccountMenuOpen(false);
    patch({ loggedIn: false });
  };

  // 로그인 전에는 다른 모든 화면보다 로그인 화면을 우선 표시
  if (!settings.loggedIn) {
    return (
      <div className="popup">
        <LoginView t={t} onLogin={() => patch({ loggedIn: true })} />
      </div>
    );
  }

  const effectivePlan = getEffectivePlan(settings);
  // Basic 플랜은 라이브 스트림만 허용 — VOD는 업그레이드 유도
  const locked = target != null && !target.isLive && effectivePlan === "basic";

  // ── 렌더 ──
  return (
    <div className="popup">
      <header className="popup-header">
        <div className="popup-brand">
          <div className="popup-logo">
            Kapti<span>k</span>
          </div>
          <div className="popup-subtitle">{t.appTagline}</div>
        </div>
        <div className="popup-header-right">
          {(() => {
            return isPaid(effectivePlan) ? (
              // 결제 후: 요금제 칩 + 프로필 아바타 (클릭 시 로그아웃 메뉴)
              <div className="account">
                <span className={"plan-chip plan-" + effectivePlan}>
                  {effectivePlan === "pro" ? t.planPro : t.planBasic}
                </span>
                <button
                  type="button"
                  className="account-avatar"
                  title={settings.profileName}
                  onClick={() => setAccountMenuOpen((v) => !v)}
                >
                  {settings.profileName.trim().charAt(0).toUpperCase()}
                </button>
                {accountMenuOpen && (
                  <div className="account-menu">
                    <button
                      type="button"
                      className="account-menu-item"
                      onClick={handleLogout}
                    >
                      {t.logoutBtn}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              // 미로그인 또는 무료: 결제하러 가기
              <button type="button" className="pro-badge" onClick={openPricing}>
                🔒 {t.ctaUnlock}
              </button>
            );
          })()}
          {target && status?.state === "available" && (
            <Switch
              checked={settings.enabled}
              onChange={(v) => patch({ enabled: v })}
              ariaLabel={t.ariaToggleSubtitles}
            />
          )}
        </div>
      </header>

      {target === undefined && <CheckingView t={t} />}
      {target === null && <UnsupportedView t={t} />}

      {target && locked && (
        <LockedView t={t} onUpgrade={openPricing} />
      )}

      {target && !locked && status === undefined && <CheckingView t={t} />}

      {target && !locked && status?.state === "none" && (
        target.alwaysCapture
          ? <LiveNoneView t={t} settings={settings} patch={patch} onStart={handleStartLive} />
          : <NoneView t={t} settings={settings} patch={patch} onGenerate={handleGenerate} />
      )}

      {target && !locked && status?.state === "generating" && (
        <GeneratingView
          t={t}
          status={status}
          liveCapturing={target.alwaysCapture}
          onClearCues={target.alwaysCapture ? handleClearCues : undefined}
        />
      )}

      {target && !locked && status?.state === "failed" && (
        <FailedView t={t} reason={status.reason} onRetry={handleRetry} />
      )}

      {target && !locked && status?.state === "available" && (
        <AvailableView
          settings={settings}
          patch={patch}
          t={t}
          onUpgrade={openPricing}
          onLanguageChange={handleLanguageChange}
        />
      )}

      {(import.meta.env.DEV || settings.devMode) && <DevSettingsSection settings={settings} patch={patch} />}
    </div>
  );
}

/* ── 상태별 뷰 ── */

export function CheckingView({ t }: { t: Messages }) {
  return <div className="state-block state-checking">{t.checking}</div>;
}

/** 자막 언어 선택 드롭다운 (시작 전/후 공용) */
export function LanguageSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: LanguageCode;
  onChange: (lang: LanguageCode) => void;
  ariaLabel: string;
}) {
  return (
    <select
      className="select"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as LanguageCode)}
    >
      {UI_LANGUAGE_OPTIONS.map((code) => (
        <option key={code} value={code}>
          {LANGUAGE_LABELS[code]}
        </option>
      ))}
    </select>
  );
}

export function LoginView({ t, onLogin }: { t: Messages; onLogin: () => void }) {
  return (
    <div className="login-view">
      <div className="login-logo">
        Kapti<span>k</span>
      </div>
      <div className="login-tagline">{t.appTagline}</div>
      <div className="login-title">{t.loginTitle}</div>
      <div className="login-desc">{t.loginDesc}</div>
      <button type="button" className="btn-primary" onClick={onLogin}>
        {t.loginWithGoogle}
      </button>
    </div>
  );
}

export function UnsupportedView({ t }: { t: Messages }) {
  return (
    <div className="state-block">
      <div className="state-emoji">🎬</div>
      <div className="state-title">{t.unsupportedTitle}</div>
      <div className="state-desc">{t.unsupportedDesc}</div>
    </div>
  );
}

export function NoneView({
  t,
  settings,
  patch,
  onGenerate,
}: {
  t: Messages;
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="state-block">
      <div className="state-title">{t.noneTitle}</div>
      <div className="state-desc">{t.noneDesc}</div>
      {/* 시작 전 언어 선택 — 번역을 돌리기 전에 원하는 언어를 고른다 */}
      <div className="state-lang">
        <span className="row-label">{t.langLabel}</span>
        <LanguageSelect
          value={settings.language}
          onChange={(lang) => patch({ language: lang })}
          ariaLabel={t.ariaChangeLang}
        />
      </div>
      <button type="button" className="btn-primary" onClick={onGenerate}>
        {t.generateBtn}
      </button>
      <div className="state-note">{t.noneNote}</div>
    </div>
  );
}


/** 백엔드 step 값을 표시용 레이블로 변환 */
const STEP_LABELS: Record<string, string> = {
  fetch: "Fetching captions…",
  translate: "AI Translating…",
  cues_loading: "Applying subtitles…",
};

export function GeneratingView({
  t,
  status,
  liveCapturing = false,
  onClearCues,
}: {
  t: Messages;
  status: { state: "generating"; etaSeconds: number; progress: number; step?: string };
  liveCapturing?: boolean;
  /** 라이브 캡처 중 "자막 초기화" 버튼 클릭 핸들러. 이전 세션 광고 구간 cue를 제거할 때 사용. */
  onClearCues?: () => void;
}) {
  const stepLabel = status.step ? (STEP_LABELS[status.step] ?? null) : null;

  // 라이브 캡처는 전체 분량을 미리 알 수 없어 정확한 퍼센트 계산이 불가능하다.
  // 이 경우엔 퍼센트 대신 좌우로 흐르는 불확정(indeterminate) 진행바로 폴백한다.
  const indeterminate = liveCapturing;

  // 화면에 보이는 퍼센트(displayPct)를 실제 진행률과 분리해 부드럽게 끌어올린다.
  // 백엔드 진행률은 2초 간격 폴링이라 그대로 그리면 툭툭 튀고, 값이 잠깐 멈추면
  // 숫자도 얼어붙어 "99%에서 멈춘 듯한" 인상을 준다. 그래서 매 50ms ease로 보간하고,
  // 절대 뒤로 가지 않게(단조 증가) 하며, 정체 구간에도 아주 조금씩 전진시킨다.
  const targetPct = Math.min(99, status.progress * 100);
  const targetRef = useRef(targetPct);
  targetRef.current = targetPct;
  const [displayPct, setDisplayPct] = useState(targetPct);

  useEffect(() => {
    if (indeterminate) return;
    const id = setInterval(() => {
      setDisplayPct((prev) => {
        const target = targetRef.current;
        if (prev < target) {
          // 목표보다 낮으면 ease로 빠르게 따라잡는다(최소 0.5%/틱 보장)
          return Math.min(target, prev + Math.max(0.5, (target - prev) * 0.15));
        }
        // 목표에 도달했으면 멈춘 느낌을 없애려 목표보다 살짝 위(+4%, 최대 99%)까지만 미세 전진
        const creepCap = Math.min(99, target + 4);
        if (prev < creepCap) return Math.min(creepCap, prev + 0.04);
        return prev;
      });
    }, 50);
    return () => clearInterval(id);
  }, [indeterminate]);

  return (
    <div className="state-block">
      <div className="state-title">{t.generatingTitle}</div>
      {stepLabel && <div className="state-step">{stepLabel}</div>}
      {indeterminate ? (
        <div className="progress-track progress-indeterminate">
          <div className="progress-fill-indeterminate" />
        </div>
      ) : (
        <div className="progress-wrap">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${displayPct}%` }} />
          </div>
          <div className="progress-pct">{Math.round(displayPct)}%</div>
        </div>
      )}
      <div className="state-note">
        {liveCapturing ? t.liveCapturingNote : t.generatingNote}
      </div>
      {liveCapturing && onClearCues && (
        <button
          type="button"
          className="btn-ghost btn-small"
          onClick={() => {
            if (window.confirm(t.clearCuesConfirm)) onClearCues();
          }}
        >
          {t.clearCuesBtn}
        </button>
      )}
    </div>
  );
}

export function LiveNoneView({
  t,
  settings,
  patch,
  onStart,
}: {
  t: Messages;
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  onStart: () => void;
}) {
  return (
    <div className="state-block">
      <div className="state-title">{t.liveNoneTitle}</div>
      <div className="state-desc">{t.liveNoneDesc}</div>
      {/* 시작 전 언어 선택 — 라이브 캡처를 시작하기 전에 원하는 언어를 고른다 */}
      <div className="state-lang">
        <span className="row-label">{t.langLabel}</span>
        <LanguageSelect
          value={settings.language}
          onChange={(lang) => patch({ language: lang })}
          ariaLabel={t.ariaChangeLang}
        />
      </div>
      <button type="button" className="btn-primary" onClick={onStart}>
        {t.startLiveBtn}
      </button>
    </div>
  );
}

export function FailedView({
  t,
  reason,
  onRetry,
}: {
  t: Messages;
  reason?: string;
  onRetry: () => void;
}) {
  // 한국어 영상이 아님 — 재시도해도 결과가 같으므로 버튼 없이 안내만
  if (reason === "not_korean") {
    return (
      <div className="state-block">
        <div className="state-emoji">🚫</div>
        <div className="state-title">{t.cannotCreateTitle}</div>
        <div className="state-desc">{t.cannotCreateNotKoreanDesc}</div>
      </div>
    );
  }

  return (
    <div className="state-block">
      <div className="state-title">{t.failedTitle}</div>
      <button type="button" className="btn-primary" onClick={onRetry}>
        {t.retryBtn}
      </button>
    </div>
  );
}

export function LockedView({ t, onUpgrade }: { t: Messages; onUpgrade: () => void }) {
  return (
    <div className="state-block">
      <div className="state-emoji">🔒</div>
      <div className="state-title">{t.vodLockTitle}</div>
      <div className="state-desc">{t.vodLockDesc}</div>
      <button type="button" className="upgrade-cta" onClick={onUpgrade}>
        {t.upgradeCta} →
      </button>
    </div>
  );
}

/** 미결제(무료) 사용자에게 보여줄 업그레이드 배너 */
function UpgradeBanner({ t, onUpgrade }: { t: Messages; onUpgrade: () => void }) {
  return (
    <div className="upgrade-banner">
      <div className="upgrade-banner-glow" aria-hidden />
      <div className="upgrade-title">{t.upgradeTitle}</div>
      <div className="upgrade-desc">{t.upgradeDesc}</div>
      <button type="button" className="upgrade-cta" onClick={onUpgrade}>
        {t.upgradeCta} →
      </button>
    </div>
  );
}

export function AvailableView({
  settings,
  patch,
  t,
  onUpgrade,
  onLanguageChange,
}: {
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  t: Messages;
  onUpgrade: () => void;
  onLanguageChange?: (lang: LanguageCode) => void;
}) {
  // 자막이 꺼져 있으면 '자막 보기'로 켜도록 유도
  if (!settings.enabled) {
    return (
      <div className="state-block">
        <div className="state-emoji">💬</div>
        <div className="state-title">{t.readyTitle}</div>
        <button
          type="button"
          className="btn-primary"
          onClick={() => patch({ enabled: true })}
        >
          {t.viewSubtitlesBtn}
        </button>
      </div>
    );
  }

  return (
    <>
      {!isPaid(getEffectivePlan(settings)) && <UpgradeBanner t={t} onUpgrade={onUpgrade} />}

      <div className="card">
        <div className="row">
          <span className="row-label">{t.langLabel}</span>
          <LanguageSelect
            value={settings.language}
            ariaLabel={t.ariaChangeLang}
            onChange={(lang) => {
              if (onLanguageChange) onLanguageChange(lang);
              else patch({ language: lang });
            }}
          />
        </div>

        <div className="row">
          <span className="row-label">{t.speakerLabel}</span>
          <Switch
            checked={settings.showSpeaker}
            onChange={(v) => patch({ showSpeaker: v })}
            ariaLabel={t.speakerLabel}
          />
        </div>

        <div className="row">
          <span className="row-label">{t.panelLabel}</span>
          <Switch
            checked={settings.showPanel}
            onChange={(v) => patch({ showPanel: v })}
            ariaLabel={t.panelLabel}
          />
        </div>

        <div className="row">
          <span className="row-label">{t.lineCountLabel}</span>
          <div className="segment" role="group" aria-label={t.lineCountLabel}>
            <button
              type="button"
              className={
                "segment-btn" + (settings.overlayLineCount === 1 ? " is-on" : "")
              }
              aria-pressed={settings.overlayLineCount === 1}
              onClick={() => patch({ overlayLineCount: 1 })}
            >
              {t.lineCountOne}
            </button>
            <button
              type="button"
              className={
                "segment-btn" + (settings.overlayLineCount === 2 ? " is-on" : "")
              }
              aria-pressed={settings.overlayLineCount === 2}
              onClick={() => patch({ overlayLineCount: 2 })}
            >
              {t.lineCountTwo}
            </button>
          </div>
        </div>

        <div className="row slider-row">
          <div className="slider-head">
            <span className="row-label">{t.fontSizeLabel}</span>
            <span className="slider-value">
              {Math.round(settings.fontScale * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.8}
            max={1.6}
            step={0.05}
            value={settings.fontScale}
            aria-label={t.fontSizeLabel}
            onChange={(e) => patch({ fontScale: Number(e.target.value) })}
          />
        </div>

        <div className="row slider-row">
          <div className="slider-head">
            <span className="row-label">{t.bgOpacityLabel}</span>
            <span className="slider-value">
              {Math.round(settings.overlayOpacity * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.overlayOpacity}
            aria-label={t.bgOpacityLabel}
            onChange={(e) => patch({ overlayOpacity: Number(e.target.value) })}
          />
        </div>

      </div>
    </>
  );
}

function DevSettingsSection({
  settings,
  patch,
}: {
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dev-section">
      <button
        type="button"
        className="dev-section-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Dev {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="card dev-card">
          <div className="row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <span className="row-label row-dev">Server URL (dev)</span>
            <input
              type="text"
              className="select"
              style={{ width: "100%", boxSizing: "border-box" }}
              value={settings.serverUrl}
              placeholder="ws://localhost:8000"
              onChange={(e) => patch({ serverUrl: e.target.value })}
            />
          </div>
          <div className="row">
            <span className="row-label row-dev">Dev Mode (skip auth)</span>
            <Switch
              checked={settings.devMode}
              onChange={(v) => patch({ devMode: v })}
              ariaLabel="Dev Mode"
            />
          </div>
          {!settings.devMode && (
            <div className="row" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
              <span className="row-label row-dev">Auth Token (dev)</span>
              <input
                type="text"
                className="select"
                style={{ width: "100%", boxSizing: "border-box" }}
                value={settings.authToken}
                placeholder="eyJ... (dev-token)"
                onChange={(e) => patch({ authToken: e.target.value })}
              />
            </div>
          )}
          <div className="row">
            <span className="row-label row-dev">Clear subtitle data</span>
            <button
              type="button"
              className="dev-clear-btn"
              onClick={() => {
                void chrome.storage.local.remove([
                  "kaptik:available",
                  "kaptik:jobs",
                  "kaptik:cues_ready",
                  "kaptik:gen_lang",
                  "kaptik:live_cues",
                ]);
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
