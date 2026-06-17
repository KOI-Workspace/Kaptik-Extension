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
  const [generatedWhileOpen, setGeneratedWhileOpen] = useState(false);
  const prevStatusStateRef = useRef<SubtitleStatus["state"]>("none");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  // 2초 폴링 interval ID (cleanup용)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const target: Target = { platform: adapter.platform, videoId, isLive };
      if (active) setTarget(target);
    })();

    return () => { active = false; };
  }, []);

  // target이 확인되면 상태 폴링 시작
  useEffect(() => {
    if (!target) return;

    let active = true;

    const poll = async () => {
      const s = await requestStatus(target.platform, target.videoId);
      if (active && s) {
        if (prevStatusStateRef.current === "generating" && s.state === "available") {
          setGeneratedWhileOpen(true);
        }
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
    setGeneratedWhileOpen(false);
    prevStatusStateRef.current = "generating";
    setStatus({ state: "generating", etaSeconds: 0, progress: 0 });
    void startGeneration(target.platform, target.videoId).then((eta) => {
      if (eta === null) {
        setStatus({ state: "failed" });
      } else {
        setStatus((prev) =>
          prev?.state === "generating" ? { ...prev, etaSeconds: eta } : prev
        );
      }
    });
  };

  const handleRetry = () => {
    setGeneratedWhileOpen(false);
    prevStatusStateRef.current = "none";
    setStatus({ state: "none" });
  };

  const handleLanguageChange = (newLang: LanguageCode) => {
    if (!target) return;
    patch({ language: newLang });
    setGeneratedWhileOpen(false);
    prevStatusStateRef.current = "generating";
    setStatus({ state: "generating", etaSeconds: 0, progress: 0 });
    void startGeneration(target.platform, target.videoId, true).then((eta) => {
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
          {target && status?.state === "available" && !generatedWhileOpen && (
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
        <NoneView t={t} onGenerate={handleGenerate} />
      )}

      {target && !locked && status?.state === "generating" && (
        <GeneratingView t={t} status={status} />
      )}

      {target && !locked && status?.state === "failed" && (
        <FailedView t={t} reason={status.reason} onRetry={handleRetry} />
      )}

      {target && !locked && status?.state === "available" && generatedWhileOpen && (
        <SubtitleReadyView t={t} onConfigure={() => setGeneratedWhileOpen(false)} />
      )}

      {target && !locked && status?.state === "available" && !generatedWhileOpen && (
        <AvailableView
          settings={settings}
          patch={patch}
          t={t}
          onUpgrade={openPricing}
          isLive={target.isLive}
          onLanguageChange={handleLanguageChange}
        />
      )}

      {import.meta.env.DEV && <DevSettingsSection settings={settings} patch={patch} />}
    </div>
  );
}

/* ── 상태별 뷰 ── */

export function CheckingView({ t }: { t: Messages }) {
  return <div className="state-block state-checking">{t.checking}</div>;
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

export function NoneView({ t, onGenerate }: { t: Messages; onGenerate: () => void }) {
  return (
    <div className="state-block">
      <div className="state-title">{t.noneTitle}</div>
      <div className="state-desc">{t.noneDesc}</div>
      <button type="button" className="btn-primary" onClick={onGenerate}>
        {t.generateBtn}
      </button>
      <div className="state-note">{t.noneNote}</div>
    </div>
  );
}

function SubtitleReadyView({
  t,
  onConfigure,
}: {
  t: Messages;
  onConfigure: () => void;
}) {
  return (
    <div className="state-block">
      <div className="state-emoji">✅</div>
      <div className="state-title">{t.readyTitle}</div>
      <div className="state-desc">{t.readyDesc}</div>
      <button type="button" className="btn-primary" onClick={onConfigure}>
        {t.viewSubtitlesBtn}
      </button>
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
}: {
  t: Messages;
  status: { state: "generating"; etaSeconds: number; progress: number; step?: string };
}) {
  const stepLabel = status.step ? (STEP_LABELS[status.step] ?? null) : null;

  return (
    <div className="state-block">
      <div className="spinner" />
      <div className="state-title">{t.generatingTitle}</div>
      {stepLabel && <div className="state-step">{stepLabel}</div>}
      <div className="state-note">{t.generatingNote}</div>
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
  isLive,
  onLanguageChange,
}: {
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  t: Messages;
  onUpgrade: () => void;
  isLive: boolean;
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
          <select
            className="select"
            value={settings.language}
            aria-label={t.ariaChangeLang}
            onChange={(e) => {
              const lang = e.target.value as LanguageCode;
              if (onLanguageChange) onLanguageChange(lang);
              else patch({ language: lang });
            }}
          >
            {UI_LANGUAGE_OPTIONS.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_LABELS[code]}
              </option>
            ))}
          </select>
        </div>

        {isLive && (
          <div className="row">
            <span className="row-label">{t.speakerLabel}</span>
            <Switch
              checked={settings.showSpeaker}
              onChange={(v) => patch({ showSpeaker: v })}
              ariaLabel={t.speakerLabel}
            />
          </div>
        )}

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
        </div>
      )}
    </div>
  );
}
