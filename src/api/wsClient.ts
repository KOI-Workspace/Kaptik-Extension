import type { Annotation, Member, SubtitleCue } from "@/types/subtitle";
import { resolveMemberByName } from "@/shared/members";

// ===== WebSocket 메시지 타입 정의 =====

/** ACK 메시지: 세션 확인 */
interface WSAckMessage {
  type: "ack";
  session_id?: string;
}

/** Status 메시지: 진행 상태 알림 */
interface WSStatusMessage {
  type: "status";
  message?: string;
}

/** 화자 식별 메시지 */
interface WSSpeakerIdentifiedMessage {
  type: "speaker_identified";
  speaker?: string;
  name?: string;
  confidence?: number;
}

/** 완료 메시지 */
interface WSDoneMessage {
  type: "done";
  total_cues?: number;
}

/** 오류 메시지 */
interface WSErrorMessage {
  type: "error";
  code?: string;
  message?: string;
}

/** Stage1 메시지: 한국어 원문 수신 */
interface WSStage1Message {
  stage: 1;
  ts: number;
  text_ko?: string;
  speaker?: string;
}

/** Stage2 메시지: 번역 완료 */
interface WSStage2Message {
  stage: 2;
  ts: number;
  text_en?: string;
  annotations?: Annotation[];
  streaming?: boolean;
}

/** 모든 가능한 WS 메시지의 유니온 타입 */
type WSMessage = WSAckMessage | WSStatusMessage | WSSpeakerIdentifiedMessage | WSDoneMessage | WSErrorMessage | WSStage1Message | WSStage2Message;

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
        const msg = JSON.parse(e.data);
        this.handle(msg as WSMessage);
      } catch (err) {
        // malformed JSON 감지 시 경고 (개발 중 디버깅용)
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[Kaptik WS] Malformed JSON 수신:`, e.data, err);
        }
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

  private handle(msg: WSMessage): void {
    // 타입별 메시지 처리: stage 메시지(WSStage1/2Message)는 type 필드가 없으므로 먼저 분기
    if (!("type" in msg)) {
      // Stage1: 한국어 원문 수신
      if (msg.stage === 1) {
        const ts = msg.ts;
        this.pending.set(ts, {
          text_ko: msg.text_ko ?? "",
          speaker: msg.speaker ?? "",
        });
        console.info(`[Kaptik WS] Stage1 t=${(ts / 1000).toFixed(1)}s: "${msg.text_ko ?? ""}"`);
      }
      // Stage2: 번역 완료 (streaming=true인 중간 토큰은 무시, final만 처리)
      if (msg.stage === 2 && !msg.streaming) {
        const ts = msg.ts;
        const p = this.pending.get(ts);
        if (!p) return;
        this.pending.delete(ts);
        const start = ts / 1000;
        const rawAnnotations = Array.isArray(msg.annotations) ? msg.annotations : [];
        const translatedText = msg.text_en ?? "";
        const cue: SubtitleCue = {
          start,
          end: start + 6,
          speakerId: p.speaker || undefined,
          text: { ko: p.text_ko, [this.targetLang]: translatedText },
          annotations: rawAnnotations.length > 0 ? rawAnnotations : undefined,
        };
        console.info(`[Kaptik WS] Stage2 t=${start.toFixed(1)}s [${this.targetLang}]: "${translatedText}"`);
        this.onCueReady(cue);
      }
      return;
    }

    if (msg.type === "ack") {
      const ackMsg = msg as WSAckMessage;
      console.info(`[Kaptik WS] ack — session=${ackMsg.session_id ?? ""}`);
      return;
    }

    if (msg.type === "status") {
      const statusMsg = msg as WSStatusMessage;
      console.info(`[Kaptik WS] status: ${statusMsg.message ?? ""}`);
      return;
    }

    if (msg.type === "speaker_identified") {
      const speakerMsg = msg as WSSpeakerIdentifiedMessage;
      const speakerId = speakerMsg.speaker ?? "";
      const name = speakerMsg.name ?? "";
      const confidence = speakerMsg.confidence ?? 0;
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
      const doneMsg = msg as WSDoneMessage;
      const totalCues = doneMsg.total_cues ?? 0;
      console.info(`[Kaptik WS] done — total_cues=${totalCues}`);
      this.ws?.close(1000);
      this.ws = null;
      this.onDone?.(totalCues);
      return;
    }

    if (msg.type === "error") {
      const errorMsg = msg as WSErrorMessage;
      const code = errorMsg.code ?? "";
      const message = errorMsg.message ?? "알 수 없는 오류";
      console.error(`[Kaptik WS] 서버 오류 code=${code}:`, message);
      this.onError(message, code);
      return;
    }

  }
}
