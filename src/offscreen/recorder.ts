/**
 * Offscreen document for live tab audio capture.
 * Receives streamId from the service worker (via tabCapture.getMediaStreamId),
 * resamples audio to 16 kHz PCM-16, and streams it to the Kaptik backend
 * over a WebSocket. Forwards STT/translation messages back to the SW.
 */

interface CaptureTabMsg {
  type: "CAPTURE_TAB";
  streamId: string;
  sessionId: string;
  serverUrl: string;
  authToken: string;
  targetLang: string;
  videoTitle?: string;
  videoUrl?: string;
  /** 캡처 시작 시점의 영상 재생 위치(초) — 서버가 자막 ts 앵커로 사용 */
  captureStartSec?: number;
}

let activeStream: MediaStream | null = null;
let activeWs: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
// 탭 캡처 시 원본 탭이 음소거되므로 Audio 요소로 원음질 복원
let playbackEl: HTMLAudioElement | null = null;

async function startCapture(msg: CaptureTabMsg): Promise<void> {
  stopCapture();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-expect-error — Chrome-specific mandatory constraints
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: msg.streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "LIVE_STREAM_ERROR",
      message: `getUserMedia failed: ${String(err)}`,
    });
    return;
  }

  activeStream = stream;

  // 탭 캡처 시 원본 탭이 음소거됨 → Audio 요소로 원음질 그대로 복원
  playbackEl = new Audio();
  playbackEl.srcObject = stream;
  void playbackEl.play();

  const token = msg.authToken
    ? `?token=${encodeURIComponent(msg.authToken)}`
    : "";
  const wsUrl = `${msg.serverUrl}/ws/${msg.sessionId}${token}`;
  const ws = new WebSocket(wsUrl);
  activeWs = ws;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "init",
        video_type: "live",
        target_lang: msg.targetLang,
        video_title: msg.videoTitle ?? null,
        video_url: msg.videoUrl ?? null,
        capture_start_sec: msg.captureStartSec ?? 0,
      }),
    );

    // 16 kHz mono AudioContext for PCM-16 resampling (STT 전용)
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    // 4 096-sample frames @ 16 kHz ≈ 256 ms per chunk
    scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);

    scriptProcessor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
      }
      ws.send(i16.buffer);
    };

    source.connect(scriptProcessor);
    // onaudioprocess를 트리거하려면 destination 연결 필요.
    // GainNode gain=0으로 묵음 처리해 Audio 요소와 중복 재생 방지
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    scriptProcessor.connect(silentGain);
    silentGain.connect(audioCtx.destination);
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as unknown;
      chrome.runtime.sendMessage({ type: "LIVE_CUE_MSG", data });
    } catch {
      /* malformed JSON — ignore */
    }
  };

  ws.onerror = () => {
    chrome.runtime.sendMessage({
      type: "LIVE_STREAM_ERROR",
      message: "WebSocket error",
    });
  };

  ws.onclose = (ev) => {
    chrome.runtime.sendMessage({
      type: "LIVE_WS_CLOSED",
      code: ev.code,
      reason: ev.reason,
    });
  };
}

function stopCapture(): void {
  playbackEl?.pause();
  playbackEl = null;
  scriptProcessor?.disconnect();
  scriptProcessor = null;
  void audioCtx?.close();
  audioCtx = null;
  activeWs?.close();
  activeWs = null;
  activeStream?.getTracks().forEach((t) => t.stop());
  activeStream = null;
}

chrome.runtime.onMessage.addListener(
  (msg: { type: string } & Partial<CaptureTabMsg>) => {
    if (msg.type === "CAPTURE_TAB") {
      void startCapture(msg as CaptureTabMsg);
    } else if (msg.type === "STOP_CAPTURE") {
      stopCapture();
    }
  },
);
