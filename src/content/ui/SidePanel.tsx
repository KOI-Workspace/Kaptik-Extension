import { useEffect, useRef, useState } from "react";
import { LANGUAGE_LABELS } from "@/types/subtitle";
import type { LanguageCode, SubtitleTrack } from "@/types/subtitle";
import type { KaptikSettings } from "@/shared/settings";
import { updateSettings, PRICING_URL, isPaid } from "@/shared/settings";
import { getMessages, UI_LANGUAGE_OPTIONS } from "@/shared/i18n";
import { resolveMember } from "@/shared/members";
import { Avatar } from "./Avatar";
import { AnnotatedText } from "./AnnotatedText";

interface SidePanelProps {
  video: HTMLVideoElement;
  track: SubtitleTrack;
  activeIndex: number;
  settings: KaptikSettings;
  /** docked: 사이드 컬럼에 끼워진 일반 블록 / overlay: 영상 위에 떠 있는 형태 */
  variant: "docked" | "overlay";
}

/** 현재 열린 주석 위치 */
interface OpenAnnotation {
  cueIndex: number;
  annIndex: number;
}

function pickText(
  text: Partial<Record<LanguageCode, string>>,
  language: LanguageCode,
): string | null {
  return text[language] ?? text.en ?? Object.values(text)[0] ?? null;
}

/** 초 → m:ss 형식 */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * 영상 오른쪽 히스토리 패널.
 * 지나간 발화를 채팅형 타임라인으로 보여주고, 타임스탬프 클릭 시 해당 위치로 이동한다.
 * 문화 맥락 주석은 밑줄 구절을 눌러 카드 형태로 펼친다.
 */
export function SidePanel({
  video,
  track,
  activeIndex,
  settings,
  variant,
}: SidePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [open, setOpen] = useState<OpenAnnotation | null>(null);

  // 선택 언어에 맞춘 UI 텍스트
  const t = getMessages(settings.language);

  // 새 발화가 추가될 때, 사용자가 맨 아래를 보고 있으면 자동 스크롤
  useEffect(() => {
    if (atBottom && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [activeIndex, atBottom]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 48);
  };

  const scrollToLatest = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const seekTo = (start: number) => {
    video.currentTime = start;
  };

  const toggleAnnotation = (cueIndex: number, annIndex: number) => {
    setOpen((prev) =>
      prev && prev.cueIndex === cueIndex && prev.annIndex === annIndex
        ? null
        : { cueIndex, annIndex },
    );
  };

  // 지나간 발화만 히스토리로 노출
  const history = activeIndex >= 0 ? track.cues.slice(0, activeIndex + 1) : [];

  // 트랙이 제공하는 언어 중 UI 지원 언어(한국어 제외)만 선택지로 노출
  const available = track.availableLanguages.filter((c) =>
    (UI_LANGUAGE_OPTIONS as string[]).includes(c),
  );
  const languageOptions: LanguageCode[] =
    available.length > 0 ? available : UI_LANGUAGE_OPTIONS;

  return (
    <aside className={`kaptik-panel kaptik-panel--${variant}`}>
      <header className="kaptik-panel-head">
        <div className="kaptik-panel-title">
          <span className="kaptik-panel-dot" />
          {t.panelTitle}
        </div>
        <div className="kaptik-panel-actions">
          <select
            className="kaptik-lang-select"
            value={settings.language}
            aria-label={t.ariaChangeLang}
            onChange={(e) =>
              void updateSettings({ language: e.target.value as LanguageCode })
            }
          >
            {languageOptions.map((code) => (
              <option key={code} value={code}>
                {LANGUAGE_LABELS[code]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kaptik-panel-close"
            aria-label={t.ariaClosePanel}
            onClick={() => void updateSettings({ showPanel: false })}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="kaptik-panel-body" ref={listRef} onScroll={handleScroll}>
        {!isPaid(settings.plan) ? (
          <div className="kaptik-lock">
            <div className="kaptik-lock-icon">🔒</div>
            <div className="kaptik-lock-title">{t.panelLockTitle}</div>
            <div className="kaptik-lock-desc">{t.panelLockDesc}</div>
            <button
              type="button"
              className="kaptik-lock-cta"
              onClick={() => window.open(PRICING_URL, "_blank", "noopener")}
            >
              {t.upgradeCta} →
            </button>
          </div>
        ) : history.length === 0 ? (
          <div className="kaptik-panel-empty">{t.panelEmpty}</div>
        ) : (
          history.map((cue, cueIndex) => {
            const member = resolveMember(track, cue);
            const text = pickText(cue.text, settings.language);
            if (!text) return null;
            const isActive = cueIndex === activeIndex;
            const openAnnIndex =
              open && open.cueIndex === cueIndex ? open.annIndex : null;

            return (
              <div
                key={cue.start}
                className={"kaptik-row" + (isActive ? " is-active" : "")}
              >
                {member && <Avatar member={member} size={34} />}
                <div className="kaptik-row-main">
                  <div className="kaptik-row-head">
                    {member && (
                      <span
                        className="kaptik-row-name"
                        style={{ color: member.color }}
                      >
                        {member.name}
                      </span>
                    )}
                    <button
                      type="button"
                      className="kaptik-row-time"
                      onClick={() => seekTo(cue.start)}
                      aria-label={t.seekTo(formatTime(cue.start))}
                    >
                      {formatTime(cue.start)}
                    </button>
                  </div>
                  <div
                    className="kaptik-row-text"
                    role="button"
                    tabIndex={0}
                    title={t.seekTo(formatTime(cue.start))}
                    onClick={() => seekTo(cue.start)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        seekTo(cue.start);
                      }
                    }}
                  >
                    <AnnotatedText
                      text={text}
                      annotations={cue.annotations}
                      openIndex={openAnnIndex}
                      onToggle={(annIndex) => toggleAnnotation(cueIndex, annIndex)}
                    />
                  </div>

                  {/* 주석 카드는 모두 렌더하고 높이로 펼침/접힘을 부드럽게 처리 */}
                  {cue.annotations?.map((ann, annIndex) => {
                    const isOpen = openAnnIndex === annIndex;
                    return (
                      <div
                        key={annIndex}
                        className={
                          "kaptik-annotation-wrap" + (isOpen ? " is-open" : "")
                        }
                      >
                        <div className="kaptik-annotation">
                          <div className="kaptik-annotation-head">
                            <span className="kaptik-annotation-title">
                              {ann.title}
                            </span>
                            <button
                              type="button"
                              className="kaptik-annotation-close"
                              aria-label={t.ariaCloseAnnotation}
                              onClick={() => setOpen(null)}
                            >
                              ✕
                            </button>
                          </div>
                          <p className="kaptik-annotation-desc">
                            {ann.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {isPaid(settings.plan) && !atBottom && (
        <button
          type="button"
          className="kaptik-latest"
          onClick={scrollToLatest}
        >
          ↑ {t.latest}
        </button>
      )}
    </aside>
  );
}
