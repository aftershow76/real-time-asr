/**
 * Qwen ASR Gateway
 * - Receives RTP (PCM 8k)
 * - Streams to qwen3-asr-flash-realtime
 */
require("dotenv").config();
const dgram = require("dgram");
const express = require("express");
const WebSocket = require("ws");

const {
  QWEN3_ASR_API_KEY,
  QWEN3_ASR_MODEL,
  QWEN3_ASR_URL,
  QWEN3_ASR_SAMPLE_RATE,
  GATEWAY_HTTP_PORT
} = process.env;

const calls = new Map();

function rtpPayload(buf) {
  return buf.slice(12); // minimal RTP header
}

class AsrSession {
  constructor(callId, speaker) {
    this.pendingAudio = [];
    this.isOpen = false;
    this.ws = new WebSocket(`${QWEN3_ASR_URL}?model=${QWEN3_ASR_MODEL}`, {
      headers: {
        Authorization: `Bearer ${QWEN3_ASR_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    this.ws.on("open", () => {
      this.isOpen = true;
      this.ws.send(JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "pcm",
          sample_rate: Number(QWEN3_ASR_SAMPLE_RATE),
          turn_detection: { type: "server_vad" }
        }
      }));
      if (this.pendingAudio.length) {
        for (const audio of this.pendingAudio) {
          this.ws.send(audio);
        }
        this.pendingAudio = [];
      }
    });

    this.ws.on("message", m => {
      const msg = JSON.parse(m);
      if (msg.type?.includes("transcription")) {
        console.log(`[${callId}:${speaker}]`, msg.text || msg.transcript);
      }
    });

    this.ws.on("close", () => {
      this.isOpen = false;
    });

    this.ws.on("error", err => {
      console.error(`[${callId}:${speaker}] WebSocket error`, err);
    });
  }

  send(pcm) {
    const payload = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.from(pcm).toString("base64")
    });
    if (this.isOpen && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.pendingAudio.push(payload);
    }
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

function startRtp(callId, speaker, port) {
  const asr = new AsrSession(callId, speaker);
  const sock = dgram.createSocket("udp4");

  sock.on("message", pkt => {
    asr.send(rtpPayload(pkt));
  });

  sock.bind(port);
  return { sock, asr };
}

const app = express();
app.use(express.json());

app.post("/register", (req, res) => {
  const { callId, portIn, portOut } = req.body;

  calls.set(callId, {
    in: startRtp(callId, "S1", portIn),
    out: startRtp(callId, "S2", portOut)
  });

  res.json({ ok: true });
});

app.post("/unregister", (req, res) => {
  const call = calls.get(req.body.callId);
  if (call) {
    call.in.sock.close();
    call.out.sock.close();
    call.in.asr.close();
    call.out.asr.close();
    calls.delete(req.body.callId);
  }
  res.json({ ok: true });
});

app.listen(GATEWAY_HTTP_PORT, () =>
  console.log(`ASR Gateway listening on ${GATEWAY_HTTP_PORT}`)
);
