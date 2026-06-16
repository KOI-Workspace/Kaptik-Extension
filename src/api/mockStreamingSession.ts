import type { Member, SubtitleCue } from "@/types/subtitle";
import { MOCK_CUES } from "./mockSubtitles";
import { DEFAULT_MEMBERS } from "@/shared/members";

/**
 * 백엔드 없이 기존 mock 대화로 스트리밍을 재현한다 (devMode 전용).
 * StreamingSession과 동일한 connect()/disconnect() 인터페이스라 드롭인으로 교체된다.
 *
 * 시간차를 두고 보내지 않고 connect() 시점에 전부 즉시 전달한다 — YouTube의
 * playing 이벤트가 재생 중 예상보다 자주 재발생해 스트리밍이 재시작되는데,
 * setTimeout으로 지연 전달하면 끝까지 도달하기 전에 매번 취소돼 자막이 거의
 * 안 보이는 문제가 있었다. 즉시 전달은 재시작이 몇 번 일어나도 항상 안전하다.
 */
export class MockStreamingSession {
  constructor(
    private seekSec: number,
    private onCueReady: (cue: SubtitleCue) => void,
    private onSpeakerIdentified?: (speakerId: string, name: string, member: Member) => void,
  ) {}

  connect(): void {
    const announced = new Set<string>();
    for (const mock of MOCK_CUES) {
      if (mock.speakerId && !announced.has(mock.speakerId)) {
        announced.add(mock.speakerId);
        const member = DEFAULT_MEMBERS[mock.speakerId];
        if (member) this.onSpeakerIdentified?.(mock.speakerId, member.name, member);
      }
      this.onCueReady({
        ...mock,
        start: this.seekSec + mock.start,
        end: this.seekSec + mock.end,
      });
    }
  }

  disconnect(): void {
    // 즉시 전달 방식이라 정리할 타이머가 없음
  }
}
