import type { Platform, SubtitleCue, SubtitleTrack } from "@/types/subtitle";
import { DEFAULT_MEMBERS } from "@/shared/members";

/**
 * 백엔드(Kaptik API) 개발 전까지 사용하는 임시 자막 데이터.
 * 실제 API 연동이 붙으면 client.ts 의 fallback 으로만 동작한다.
 */
export const MOCK_CUES: SubtitleCue[] = [
  {
    start: 0,
    end: 3.5,
    speakerId: "rm",
    text: {
      ko: "여러분, 드디어 우리 모였어요!",
      en: "Hey everyone, we're finally here!",
      ja: "みなさん、やっと来ましたよ！",
      "zh-CN": "大家好，我们终于来了！",
      id: "Hai semua, kita akhirnya di sini!",
    },
  },
  {
    start: 3.5,
    end: 7.0,
    speakerId: "jin",
    text: {
      ko: "지난 라이브 이후로 진짜 오랜만이죠?",
      en: "It's been so long since our last live, right?",
      ja: "最後のライブからずいぶん経ちましたよね？",
      "zh-CN": "好久没有直播了，对吧？",
      id: "Sudah lama banget sejak live terakhir kita, kan?",
    },
  },
  {
    start: 7.0,
    end: 10.5,
    speakerId: "v",
    text: {
      ko: "딱 이맘때면 생각나요. 그 40km 행군.",
      en: "Around this time of year, I always think of the 40-kilometer march.",
      ja: "毎年この時期になると、あの40kmの行軍を思い出します。",
      "zh-CN": "每年这个时候，我都会想起那次40公里行军。",
      id: "Setiap tahun di sekitar waktu ini, aku selalu teringat march 40 kilometer itu.",
    },
    annotations: [
      {
        term: "40-kilometer march",
        title: "40km March",
        description:
          "혹독한 1월 기초군사훈련 행군. V의 ‘이맘때’ 한마디가 군 시절 기억을 곧장 소환했어요.",
      },
    ],
  },
  {
    start: 10.5,
    end: 13.5,
    speakerId: "jin",
    text: {
      ko: "아하하, ‘이맘때’래.",
      en: 'Ahaha, "around this time of year"?',
      ja: "あはは、「この時期」だって。",
      "zh-CN": "哈哈，“这个时候”？",
      id: 'Ahaha, "sekitar waktu ini"?',
    },
  },
  {
    start: 13.5,
    end: 17.0,
    speakerId: "suga",
    text: {
      ko: "아, 앨범 빨리 나왔으면 좋겠는데 아직도 멀게 느껴지네.",
      en: "Ah, I wish the album would come out sooner, but it still feels so far away.",
      ja: "ああ、アルバム早く出てほしいのに、まだ遠く感じるなあ。",
      "zh-CN": "啊，真希望专辑能早点出来，但还是觉得好遥远。",
      id: "Ah, semoga albumnya cepat keluar, tapi rasanya masih jauh.",
    },
  },
  {
    start: 17.0,
    end: 19.0,
    speakerId: "rm",
    text: {
      ko: "여전하시네요, 형.",
      en: "Still sharp, hyung.",
      ja: "相変わらずですね、ヒョン。",
      "zh-CN": "还是这么犀利，哥。",
      id: "Masih tajam, hyung.",
    },
    annotations: [
      {
        term: "hyung",
        title: "Hyung (형)",
        description:
          "남성이 손위 남성을 부르는 호칭. 멤버 사이의 친근함과 위계가 동시에 담겨 있어요.",
      },
    ],
  },
  {
    start: 19.0,
    end: 21.5,
    speakerId: "jungkook",
    text: {
      ko: "방금 그거 진짜 웃겼어요.",
      en: "That was actually funny.",
      ja: "今のほんとに面白かった。",
      "zh-CN": "刚才那个真的好笑。",
      id: "Tadi itu beneran lucu.",
    },
  },
  {
    start: 21.5,
    end: 24.5,
    speakerId: "rm",
    text: {
      ko: "형, 아직 안 죽었네요.",
      en: "You've still got it, hyung.",
      ja: "ヒョン、まだまだ健在ですね。",
      "zh-CN": "哥，宝刀未老啊。",
      id: "Hyung masih jago.",
    },
  },
  {
    start: 24.5,
    end: 29.0,
    speakerId: "jhope",
    text: {
      ko: "오늘 큰 발표 하나 있으니까, 끝까지 함께해 주세요!",
      en: "We have a big announcement today, so please stay with us till the end!",
      ja: "今日は大きなお知らせがあるので、最後まで一緒にいてくださいね！",
      "zh-CN": "今天有个重大公告，请大家陪我们到最后！",
      id: "Hari ini ada pengumuman besar, jadi temani kami sampai akhir ya!",
    },
  },
];

/**
 * 임시 자막 트랙을 생성한다.
 * @param platform 플랫폼
 * @param videoId 영상 ID
 */
export function getMockTrack(platform: Platform, videoId: string): SubtitleTrack {
  return {
    platform,
    videoId,
    cues: MOCK_CUES,
    availableLanguages: ["ko", "en", "ja", "zh-CN", "id"],
    members: DEFAULT_MEMBERS,
    isLive: false,
  };
}
