import { type CSSProperties } from "react";
import type { LanguageCode, SubtitleTrack } from "@/types/subtitle";
import type { KaptikSettings } from "@/shared/settings";
import { resolveMember } from "@/shared/members";
import { Avatar } from "./Avatar";

interface CenterSubtitleProps {
  track: SubtitleTrack;
  activeIndex: number;
  settings: KaptikSettings;
}

/** 선택 언어 → 영어 → 첫 언어 순으로 텍스트를 고른다. 빈 문자열("")은 값 없음으로 취급해 다음 언어로 폴백한다. */
function pickText(
  text: Partial<Record<LanguageCode, string>>,
  language: LanguageCode,
): string | null {
  return text[language] || text.en || Object.values(text)[0] || null;
}

/**
 * 영상 가운데 하단 자막 오버레이.
 * 검은 반투명 배경 박스 하나에 최근 발화를 표시한다.
 * 보이는 줄 수(1줄/2줄)는 팝업 설정(overlayLineCount)으로 정한다.
 */
export function CenterSubtitle({
  track,
  activeIndex,
  settings,
}: CenterSubtitleProps) {
  if (activeIndex < 0) return null;

  // 한 줄 또는 두 줄만 표시 (그 외 값은 한 줄로 보정)
  const lineCount = settings.overlayLineCount === 2 ? 2 : 1;
  const startIdx = Math.max(0, activeIndex - lineCount + 1);
  const recent = track.cues.slice(startIdx, activeIndex + 1);

  const style = {
    "--font-scale": settings.fontScale,
    "--overlay-opacity": settings.overlayOpacity,
  } as CSSProperties;

  return (
    <div className="kaptik-center" style={style}>
      <div className="kaptik-center-box">
        {recent.map((cue, i) => {
          const member = resolveMember(track, cue);
          const text = pickText(cue.text, settings.language);
          if (!text) return null;
          const isActive = startIdx + i === activeIndex;
          return (
            <div
              key={i}
              className={"kaptik-center-line" + (isActive ? " is-active" : "")}
            >
              {settings.showSpeaker && member && (
                <Avatar member={member} size={26 * settings.fontScale} />
              )}
              <div className="kaptik-center-body">
                {settings.showSpeaker && member?.name && (
                  <span
                    className="kaptik-center-name"
                    style={{ color: member.color }}
                  >
                    {member.name}
                  </span>
                )}
                <span className="kaptik-center-text">{text}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
