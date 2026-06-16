import type { Member, SubtitleCue, SubtitleTrack } from "@/types/subtitle";

/**
 * 기본 멤버 레지스트리 (BTS).
 * 색상은 멤버별로 구분되며, Weverse 브랜드 그린(#05F048)은 사용하지 않는다.
 */
export const DEFAULT_MEMBERS: Record<string, Member> = {
  rm: { id: "rm", name: "RM", color: "#7E8AFF" },
  jin: { id: "jin", name: "Jin", color: "#FF74A6" },
  suga: { id: "suga", name: "Suga", color: "#F5A03C" },
  jhope: { id: "jhope", name: "j-hope", color: "#FFD45C" },
  jimin: { id: "jimin", name: "Jimin", color: "#5BC0EB" },
  v: { id: "v", name: "V", color: "#3FB9A8" },
  jungkook: { id: "jungkook", name: "Jungkook", color: "#B488FF" },
};

/**
 * 백엔드가 화자 식별 결과로 돌려주는 이름(한국어/영문) → 멤버 ID 매핑 (BTS).
 * reference_builder --member 플래그에 사용한 이름과 일치해야 한다.
 */
export const KOREAN_NAME_TO_MEMBER_ID: Record<string, string> = {
  // RM
  RM: "rm", rm: "rm", 남준: "rm", 김남준: "rm", 랩몬스터: "rm",
  // Jin
  Jin: "jin", jin: "jin", 진: "jin", 석진: "jin", 김석진: "jin",
  // Suga
  Suga: "suga", suga: "suga", 슈가: "suga", 윤기: "suga", 민윤기: "suga",
  // j-hope
  "j-hope": "jhope", jhope: "jhope", "J-Hope": "jhope", 제이홉: "jhope",
  호석: "jhope", 정호석: "jhope",
  // Jimin
  Jimin: "jimin", jimin: "jimin", 지민: "jimin", 박지민: "jimin",
  // V
  V: "v", v: "v", 뷔: "v", 태형: "v", 김태형: "v",
  // Jungkook
  Jungkook: "jungkook", jungkook: "jungkook", 정국: "jungkook", 전정국: "jungkook",
};

/** 그룹 키 → 멤버 레지스트리 (백엔드 _GROUP_KEYWORDS 키와 일치) */
export const GROUP_MEMBERS: Record<string, Record<string, Member>> = {
  bts: DEFAULT_MEMBERS,
};

/**
 * 백엔드가 내려준 화자 이름(한국어/영문)으로 멤버 데이터를 조회한다.
 * 매칭 실패 시 null.
 */
export function resolveMemberByName(name: string): Member | null {
  const memberId = KOREAN_NAME_TO_MEMBER_ID[name];
  if (!memberId) return null;
  for (const members of Object.values(GROUP_MEMBERS)) {
    if (members[memberId]) return members[memberId];
  }
  return null;
}

/** 알 수 없는 화자를 위한 폴백 컬러 팔레트 */
const FALLBACK_COLORS = [
  "#7E8AFF",
  "#FF74A6",
  "#F5A03C",
  "#5BC0EB",
  "#3FB9A8",
  "#B488FF",
  "#FFD45C",
];

/** 문자열을 안정적인 색상 인덱스로 변환 */
function hashColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

/**
 * 큐의 화자 멤버 정보를 해석한다.
 * track.members 에 없으면 id를 이름으로 쓰는 폴백 멤버를 생성한다.
 */
export function resolveMember(
  track: SubtitleTrack,
  cue: SubtitleCue,
): Member | null {
  if (!cue.speakerId) return null;
  const found = track.members[cue.speakerId];
  const member = found ?? {
    id: cue.speakerId,
    name: cue.speakerId,
    color: hashColor(cue.speakerId),
  };
  // 화자 식별 불가 영상: 색상(아바타 링)으로만 구분하고 이름/이니셜은 비공개
  return track.speakerIdentified === false ? { ...member, name: "" } : member;
}

/** 아바타 이니셜 (이미지 없을 때 사용) */
export function memberInitial(member: Member): string {
  return member.name.trim().charAt(0).toUpperCase();
}
