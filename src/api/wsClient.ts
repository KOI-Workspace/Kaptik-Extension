import type { Member, SubtitleCue } from "@/types/subtitle";
import { resolveMemberByName } from "@/shared/members";

interface PendingStage1 {
  text_ko: string;
  speaker: string;
}

export class StreamingSession {
  private ws: WebSocket | null = null;
  private pending = new Map<number, PendingStage1>();
  private sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  constructor(
    private videoUrl: string,
    private seekSec: number,
    private serverUrl: string,
    private authToken: string,
    private targetLang: string,
    private onCueReady: (cue: SubtitleCue) => void,
    private onError: (msg: string, code?: string) => void,
    private onDone?: (totalCues: number) => void,
    private onSpeakerIdentified?: (speakerId: string, name: string, member: Member) => void,
  ) {}

  connect(): void {
    const token = this.authToken ? `?token=${encodeURIComponent(this.authToken)}` : "";
    const url = `${this.serverUrl}/ws-youtube/${this.sessionId}${token}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.onError(`WebSocket 연결 실패: ${url}`);
      return;
    }

    this.ws.onopen = () => {
      console.info(`[Kaptik WS] 연결됨 → ${this.serverUrl}/ws-youtube/${this.sessionId} (seek=${this.seekSec}s)`);
      this.ws!.send(
        JSON.stringify({
          url: this.videoUrl,
          target_lang: this.targetLang,
          seek_sec: this.seekSec,
          duration_sec: 0,
        }),
      );
      console.info(`[Kaptik WS] 요청 전송: ${this.videoUrl}`);
    };

    this.ws.onmessage = (e: MessageEvent<string>) => {
      try {
        this.handle(JSON.parse(e.data) as Record<string, unknown>);
      } catch {
        // malformed JSON — ignore
      }
    };

    this.ws.onerror = (e) => {
      console.error("[Kaptik WS] 오류:", e);
      this.onError("WebSocket 오류 발생");
    };

    this.ws.onclose = (e) => {
      console.info(`[Kaptik WS] 연결 종료 code=${e.code} clean=${e.wasClean} reason="${e.reason}"`);
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.pending.clear();
  }

  private handle(msg: Record<string, unknown>): void {
    if (msg.type === "ack") {
      console.info(`[Kaptik WS] ack — session=${String(msg.session_id ?? "")}`);
      return;
    }
    if (msg.type === "status") {
      console.info(`[Kaptik WS] status: ${String(msg.message ?? "")}`);
      return;
    }
    if (msg.type === "speaker_identified") {
      const speakerId = String(msg.speaker ?? "");
      const name = String(msg.name ?? "");
      const confidence = Number(msg.confidence ?? 0);
      const member = resolveMemberByName(name);
      if (member) {
        console.info(`[Kaptik WS] 화자 식별: ${speakerId} → ${name} (${member.name}, conf=${confidence.toFixed(2)})`);
        this.onSpeakerIdentified?.(speakerId, name, member);
      } else {
        console.info(`[Kaptik WS] 화자 식별 (미등록 멤버): ${speakerId} → ${name}`);
      }
      return;
    }
    if (msg.type === "done") {
      const totalCues = Number(msg.total_cues ?? 0);
      console.info(`[Kaptik WS] done — total_cues=${totalCues}`);
      this.ws?.close(1000);
      this.ws = null;
      this.onDone?.(totalCues);
      return;
    }
    if (msg.type === "error") {
      console.error(`[Kaptik WS] 서버 오류 code=${String(msg.code ?? "")}:`, String(msg.message ?? "알 수 없는 오류"));
      this.onError(String(msg.message ?? "알 수 없는 오류"), String(msg.code ?? ""));
      return;
    }

    if (msg.stage === 1) {
      const ts = Number(msg.ts);
      this.pending.set(ts, {
        text_ko: String(msg.text_ko ?? ""),
        speaker: String(msg.speaker ?? ""),
      });
      // ts는 백엔드가 seek_sec를 이미 더한 절대 시각(ms) → /1000만 하면 됨
      console.info(`[Kaptik WS] Stage1 t=${(ts / 1000).toFixed(1)}s: "${String(msg.text_ko ?? "")}"`);
      return;
    }

    // Stage2 streaming tokens (msg.streaming === true) → 무시, final만 처리
    if (msg.stage === 2 && !msg.streaming) {
      const ts = Number(msg.ts);
      const p = this.pending.get(ts);
      if (!p) return;
      this.pending.delete(ts);

      // ts = chunk.start_ms + seek_sec * 1000 (백엔드에서 절대값으로 변환)
      // seekSec를 다시 더하면 두 배가 되므로 /1000만 사용
      const start = ts / 1000;
      const rawAnnotations = Array.isArray(msg.annotations) ? msg.annotations : [];
      const translatedText = String(msg.text_en ?? "");
      const cue = {
        start,
        end: start + 6,
        speakerId: p.speaker || undefined,
        text: { ko: p.text_ko, [this.targetLang]: translatedText },
        annotations: rawAnnotations.length > 0 ? rawAnnotations : undefined,
      };
      console.info(`[Kaptik WS] Stage2 t=${start.toFixed(1)}s [${this.targetLang}]: "${translatedText}"`);
      this.onCueReady(cue);
    }
  }
}
