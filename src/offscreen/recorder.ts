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
}

let activeStream: MediaStream | null = null;
let activeWs: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;

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
      }),
    );

    // 16 kHz mono AudioContext for PCM-16 resampling
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
    // ScriptProcessor requires a destination to fire onaudioprocess
    scriptProcessor.connect(audioCtx.destination);
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
