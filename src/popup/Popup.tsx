import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  type KaptikSettings,
} from "@/shared/settings";
import { getMessages, UI_LANGUAGE_OPTIONS, type Messages } from "@/shared/i18n";
import { requestStatus, startGeneration } from "@/shared/messaging";
import { resolveAdapter } from "@/content/siteAdapters";
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
}

/** 토글 스위치 */
function Switch({
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
  const [status, setStatus] = useState<SubtitleStatus | null>(null);
  const [settings, setSettings] = useState<KaptikSettings>(DEFAULT_SETTINGS);
  const pollRef = useRef<number | undefined>(undefined);

  // 선택 언어에 맞춰 UI 전체 텍스트를 현지화
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
      const target: Target = { platform: adapter.platform, videoId };
      if (active) setTarget(target);

      const st = await requestStatus(target.platform, target.videoId);
      if (active) setStatus(st);
    })();

    return () => {
      active = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const patch = (next: Partial<KaptikSettings>) => {
    setSettings((prev) => ({ ...prev, ...next }));
    void updateSettings(next);
  };

  /** 생성 진행 중 1초마다 상태 폴링 */
  const startPolling = (t: Target) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const st = await requestStatus(t.platform, t.videoId);
      setStatus(st);
      if (st?.state === "available" || st?.state === "failed") {
        if (pollRef.current) clearInterval(pollRef.current);
      }
    }, 1000);
  };

  const onGenerate = async () => {
    if (!target) return;
    const eta = await startGeneration(target.platform, target.videoId);
    setStatus({ state: "generating", etaSeconds: eta ?? 12, progress: 0 });
    startPolling(target);
  };

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
        {target && status?.state === "available" && (
          <Switch
            checked={settings.enabled}
            onChange={(v) => patch({ enabled: v })}
            ariaLabel={t.ariaToggleSubtitles}
          />
        )}
      </header>

      {target === undefined && <CheckingView t={t} />}
      {target === null && <UnsupportedView t={t} />}
      {target && status === null && <CheckingView t={t} />}

      {target && status?.state === "available" && (
        <AvailableView settings={settings} patch={patch} t={t} />
      )}
      {target && status?.state === "none" && (
        <NoneView onGenerate={onGenerate} t={t} />
      )}
      {target && status?.state === "generating" && (
        <GeneratingView
          status={status}
          notify={settings.notifyOnReady}
          onToggleNotify={(v) => patch({ notifyOnReady: v })}
          t={t}
        />
      )}
      {target && status?.state === "failed" && (
        <FailedView onRetry={onGenerate} t={t} />
      )}

      <footer className="popup-footer">{t.footer}</footer>
    </div>
  );
}

/* ── 상태별 뷰 ── */

function CheckingView({ t }: { t: Messages }) {
  return <div className="state-block state-checking">{t.checking}</div>;
}

function UnsupportedView({ t }: { t: Messages }) {
  return (
    <div className="state-block">
      <div className="state-emoji">🎬</div>
      <div className="state-title">{t.unsupportedTitle}</div>
      <div className="state-desc">{t.unsupportedDesc}</div>
    </div>
  );
}

function NoneView({ onGenerate, t }: { onGenerate: () => void; t: Messages }) {
  return (
    <div className="state-block">
      <div className="state-emoji">✨</div>
      <div className="state-title">{t.noneTitle}</div>
      <div className="state-desc">{t.noneDesc}</div>
      <button type="button" className="btn-primary" onClick={onGenerate}>
        {t.generateBtn}
      </button>
      <div className="state-note">{t.noneNote}</div>
    </div>
  );
}

function GeneratingView({
  status,
  notify,
  onToggleNotify,
  t,
}: {
  status: Extract<SubtitleStatus, { state: "generating" }>;
  notify: boolean;
  onToggleNotify: (v: boolean) => void;
  t: Messages;
}) {
  const pct = Math.round(status.progress * 100);
  return (
    <div className="state-block">
      <div className="state-title">{t.generatingTitle}</div>
      <div className="progress">
        <div className="progress-bar" style={{ width: `${Math.max(6, pct)}%` }} />
      </div>
      <div className="progress-meta">
        <span>{pct}%</span>
        <span>{t.generatingEta(status.etaSeconds)}</span>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <div className="row">
          <span className="row-label">{t.notifyLabel}</span>
          <Switch
            checked={notify}
            onChange={onToggleNotify}
            ariaLabel={t.ariaNotifyReady}
          />
        </div>
      </div>
      <div className="state-note">{t.generatingNote}</div>
    </div>
  );
}

function FailedView({ onRetry, t }: { onRetry: () => void; t: Messages }) {
  return (
    <div className="state-block">
      <div className="state-emoji">⚠️</div>
      <div className="state-title">{t.failedTitle}</div>
      <button type="button" className="btn-primary" onClick={onRetry}>
        {t.retryBtn}
      </button>
    </div>
  );
}

function AvailableView({
  settings,
  patch,
  t,
}: {
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  t: Messages;
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
      <div className="preview" aria-hidden>
        {settings.showSpeaker && <div className="preview-speaker">RM</div>}
        <div
          className="preview-text"
          style={{ fontSize: `${15 * settings.fontScale}px` }}
        >
          {t.previewText}
        </div>
      </div>

      <div className="card">
        <div className="row">
          <span className="row-label">{t.langLabel}</span>
          <select
            className="select"
            value={settings.language}
            aria-label={t.ariaChangeLang}
            onChange={(e) => patch({ language: e.target.value as LanguageCode })}
          >
            {UI_LANGUAGE_OPTIONS.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_LABELS[code]}
              </option>
            ))}
          </select>
        </div>

        <div className="row">
          <span className="row-label">{t.panelLabel}</span>
          <Switch
            checked={settings.showPanel}
            onChange={(v) => patch({ showPanel: v })}
            ariaLabel={t.panelLabel}
          />
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
      </div>
    </>
  );
}
