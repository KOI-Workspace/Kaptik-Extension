import { useState, type ReactNode } from "react";
import { getMessages, type Messages } from "@/shared/i18n";
import { DEFAULT_SETTINGS, type KaptikSettings } from "@/shared/settings";
import {
  Switch,
  CheckingView,
  LoginView,
  UnsupportedView,
  NoneView,
  GeneratingView,
  FailedView,
  LockedView,
  AvailableView,
} from "@/popup/Popup";

/** 실제 팝업 헤더를 그대로 재현 (Popup.tsx 내부 비공개 JSX라 미리보기용으로 복제) */
function PreviewHeader({
  t,
  plan,
  accountMenuOpen,
  onToggleMenu,
  showSwitch,
  switchOn,
}: {
  t: Messages;
  plan: "free" | "basic" | "pro";
  accountMenuOpen: boolean;
  onToggleMenu: () => void;
  showSwitch: boolean;
  switchOn: boolean;
}) {
  return (
    <header className="popup-header">
      <div className="popup-brand">
        <div className="popup-logo">
          Kapti<span>k</span>
        </div>
        <div className="popup-subtitle">{t.appTagline}</div>
      </div>
      <div className="popup-header-right">
        {plan === "free" ? (
          <button type="button" className="pro-badge">
            🔒 {t.ctaUnlock}
          </button>
        ) : (
          <div className="account">
            <span className={"plan-chip plan-" + plan}>
              {plan === "pro" ? t.planPro : t.planBasic}
            </span>
            <button type="button" className="account-avatar" onClick={onToggleMenu}>
              J
            </button>
            {accountMenuOpen && (
              <div className="account-menu">
                <button type="button" className="account-menu-item">
                  {t.logoutBtn}
                </button>
              </div>
            )}
          </div>
        )}
        {showSwitch && <Switch checked={switchOn} onChange={() => {}} ariaLabel={t.ariaToggleSubtitles} />}
      </div>
    </header>
  );
}

const t = getMessages("en");
const baseSettings: KaptikSettings = { ...DEFAULT_SETTINGS, profileName: "Jiwoo Kim" };

interface RenderCtx {
  settings: KaptikSettings;
  patch: (next: Partial<KaptikSettings>) => void;
  accountMenuOpen: boolean;
  toggleAccountMenu: () => void;
}

interface Scenario {
  id: string;
  label: string;
  group: string;
  render: (ctx: RenderCtx) => ReactNode;
}

const SCENARIOS: Scenario[] = [
  {
    id: "checking",
    label: "확인 중",
    group: "기본",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <CheckingView t={t} />
      </>
    ),
  },
  {
    id: "unsupported",
    label: "미지원 페이지",
    group: "기본",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <UnsupportedView t={t} />
      </>
    ),
  },
  {
    id: "login",
    label: "로그인 화면",
    group: "기본",
    render: () => <LoginView t={t} onLogin={() => {}} />,
  },
  {
    id: "locked",
    label: "잠김 (Basic + VOD)",
    group: "기본",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="basic" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <LockedView t={t} onUpgrade={() => {}} />
      </>
    ),
  },
  {
    id: "account-menu",
    label: "헤더: 로그아웃 메뉴 열림",
    group: "기본",
    render: () => (
      <>
        <PreviewHeader t={t} plan="pro" accountMenuOpen onToggleMenu={() => {}} showSwitch={false} switchOn={false} />
        <NoneView t={t} settings={baseSettings} patch={() => {}} onGenerate={() => {}} />
      </>
    ),
  },
  {
    id: "none",
    label: "자막 없음 (None)",
    group: "생성 흐름",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <NoneView t={t} settings={baseSettings} patch={() => {}} onGenerate={() => {}} />
      </>
    ),
  },
  {
    id: "generating",
    label: "생성 중 (62%)",
    group: "생성 흐름",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <GeneratingView t={t} status={{ state: "generating", etaSeconds: 45, progress: 0.62, step: "stt" }} />
      </>
    ),
  },
  {
    id: "failed-generic",
    label: "생성 실패 (일반)",
    group: "생성 흐름",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <FailedView t={t} onRetry={() => {}} />
      </>
    ),
  },
  {
    id: "failed-not-korean",
    label: "1. 한국어 영상 아님 → Cannot Create",
    group: "영상 판별 3종",
    render: ({ accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="pro" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={false} switchOn={false} />
        <FailedView t={t} reason="not_korean" onRetry={() => {}} />
      </>
    ),
  },
  {
    id: "available-unidentified",
    label: "2. 한국어, 학습 안 된 화자",
    group: "영상 판별 3종",
    render: ({ settings, patch, accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="pro" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={true} switchOn={settings.enabled} />
        <AvailableView
          settings={{ ...settings, devMode: true }}
          patch={patch}
          t={t}
          onUpgrade={() => {}}
          isLive={false}
        />
      </>
    ),
  },
  {
    id: "available-known",
    label: "3. 학습된 K-pop 아이돌 (현재)",
    group: "영상 판별 3종",
    render: ({ settings, patch, accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="pro" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={true} switchOn={settings.enabled} />
        <AvailableView
          settings={{ ...settings, devMode: true }}
          patch={patch}
          t={t}
          onUpgrade={() => {}}
          isLive={true}
        />
      </>
    ),
  },
  {
    id: "available-disabled",
    label: "자막 켜기 유도 (toggle off)",
    group: "자막 준비됨",
    render: ({ settings, patch, accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="pro" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={true} switchOn={false} />
        <AvailableView
          settings={{ ...settings, enabled: false }}
          patch={patch}
          t={t}
          onUpgrade={() => {}}
          isLive={true}
        />
      </>
    ),
  },
  {
    id: "available-free",
    label: "전체 설정 (무료, 업그레이드 배너)",
    group: "자막 준비됨",
    render: ({ settings, patch, accountMenuOpen, toggleAccountMenu }) => (
      <>
        <PreviewHeader t={t} plan="free" accountMenuOpen={accountMenuOpen} onToggleMenu={toggleAccountMenu} showSwitch={true} switchOn={settings.enabled} />
        <AvailableView
          settings={{ ...settings, devMode: false, plan: "free" }}
          patch={patch}
          t={t}
          onUpgrade={() => {}}
          isLive={true}
        />
      </>
    ),
  },
];

const GROUPS = Array.from(new Set(SCENARIOS.map((s) => s.group)));

export function PreviewApp() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [settings, setSettings] = useState<KaptikSettings>(baseSettings);

  const patch = (next: Partial<KaptikSettings>) => setSettings((s) => ({ ...s, ...next }));
  const toggleAccountMenu = () => setAccountMenuOpen((v) => !v);

  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];

  return (
    <div className="preview-layout">
      <nav className="preview-nav">
        <h1>Kaptik Popup Preview</h1>
        <p>확장 설치/빌드 없이 팝업 상태를 바로 확인합니다.</p>
        {GROUPS.map((group) => (
          <div key={group}>
            <div className="preview-nav-group">{group}</div>
            {SCENARIOS.filter((s) => s.group === group).map((s) => (
              <button
                key={s.id}
                type="button"
                className={"preview-nav-btn" + (s.id === scenarioId ? " is-active" : "")}
                onClick={() => setScenarioId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="preview-stage">
        <div className="preview-frame-wrap">
          <div className="preview-frame-label">{scenario.label}</div>
          <div className="preview-frame popup">
            {scenario.render({ settings, patch, accountMenuOpen, toggleAccountMenu })}
          </div>
        </div>
      </main>
    </div>
  );
}
