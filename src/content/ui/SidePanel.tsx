import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LanguageCode, SubtitleTrack } from "@/types/subtitle";
import type { KaptikSettings } from "@/shared/settings";
import { PRICING_URL, isPaid, getEffectivePlan } from "@/shared/settings";
import { getMessages } from "@/shared/i18n";
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
  /** true면 라이브 스트림 — 지연 배지와 상대 시간 라벨을 표시한다 */
  isLive?: boolean;
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
  isLive = false,
}: SidePanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [open, setOpen] = useState<OpenAnnotation | null>(null);

  // 선택 언어에 맞춘 UI 텍스트
  const t = getMessages(settings.language);

  // 라이브: 맨 아래를 보고 있으면 새 cue 도착 시 자동 스크롤
  useEffect(() => {
    if (!isLive) return;
    if (atBottom && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [activeIndex, atBottom, isLive]);

  // VOD: activeIndex가 바뀔 때마다 활성 cue가 패널 내 보이는 영역 안에 있도록 스크롤.
  // useLayoutEffect: paint 전에 실행되므로 잘못된 스크롤 위치가 화면에 보이지 않는다.
  useLayoutEffect(() => {
    if (isLive || !activeRowRef.current || !listRef.current) return;
    const list = listRef.current;
    const row = activeRowRef.current;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // 이미 완전히 보이면 스크롤하지 않음
    if (rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom) return;
    // 행이 범위 밖이면 중앙으로 이동
    const rowRelTop = rowRect.top - listRect.top + list.scrollTop;
    list.scrollTop = rowRelTop - (list.clientHeight - row.clientHeight) / 2;
  }, [activeIndex, isLive]);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (!isLive) {
      // VOD: 활성 cue가 보이면 버튼 숨김, 스크롤로 벗어나면 버튼 표시
      const row = activeRowRef.current;
      if (!row) { setAtBottom(true); return; }
      const listRect = el.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      setAtBottom(rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom);
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 48);
  };

  const scrollToLatest = () => {
    if (isLive) {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      setAtBottom(true);
    } else if (activeRowRef.current && listRef.current) {
      // VOD: 현재 활성 cue를 패널 중앙으로
      const list = listRef.current;
      const row = activeRowRef.current;
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const rowRelTop = rowRect.top - listRect.top + list.scrollTop;
      list.scrollTop = rowRelTop - (list.clientHeight - row.clientHeight) / 2;
    }
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

  // 라이브/VOD 모두 받은 자막은 영상 위치(타임스탬프) 기준으로 전체 표시한다.
  // 라이브도 DVR로 되감을 수 있으므로, 되감아도 자막 목록이 줄지 않고 현재 위치만 하이라이트한다.
  const history = track.cues;

  return (
    <aside className={`kaptik-panel kaptik-panel--${variant}`}>
      <header className="kaptik-panel-head">
        <div className="kaptik-panel-title">
          <span className="kaptik-panel-dot" />
          {t.panelTitle}
          {isLive && (
            <span className="kaptik-live-badge">{t.liveBadge}</span>
          )}
        </div>
      </header>

      <div className="kaptik-panel-body" ref={listRef} onScroll={handleScroll}>
        {track.error ? (
          <div className="kaptik-lock">
            <div className="kaptik-lock-icon">🚫</div>
            <div className="kaptik-lock-title">{t.cannotCreateTitle}</div>
            <div className="kaptik-lock-desc">{t.cannotCreateNotKoreanDesc}</div>
          </div>
        ) : !isPaid(getEffectivePlan(settings)) ? (
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
                key={cueIndex}
                ref={isActive ? activeRowRef : null}
                className={"kaptik-row" + (isActive ? " is-active" : "")}
              >
                {settings.showSpeaker && member && <Avatar member={member} size={34} />}
                <div className="kaptik-row-main">
                  <div className="kaptik-row-head">
                    {settings.showSpeaker && member?.name && (
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

      {isPaid(getEffectivePlan(settings)) && !atBottom && (
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
