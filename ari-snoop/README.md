
# Asterisk ARI + Qwen3 ASR Realtime Integration

This document explains how to install, configure, and run the **two Node.js services**
used to provide **real-time, speaker-separated transcription** for Asterisk 18 calls
using **ARI Snoop + ExternalMedia** and **Qwen3 ASR Flash Realtime**.

---

## Architecture Overview

```
SIP Call
  ↓
Asterisk Dialplan
  ↓
Stasis(bc-ari-snoop)
  ↓
ARI Snoop Manager (Node.js)
  ├─ spy=in  → RTP → ASR Gateway → Qwen ASR → Speaker 1 text
  ├─ spy=out → RTP → ASR Gateway → Qwen ASR → Speaker 2 text
  ↓
Dialplan continues normally (FreePBX logic preserved)
```

---

## Components

### 1) ARI Snoop Manager
- Connects to Asterisk ARI
- Creates `spy=in` and `spy=out` snoop channels
- Creates ExternalMedia RTP streams
- Registers calls with the ASR Gateway

### 2) Qwen ASR Gateway
- Receives RTP (PCM 8kHz)
- Streams audio to `qwen3-asr-flash-realtime`
- Emits live and final transcripts per speaker

---

## Prerequisites

### Asterisk
- Asterisk 18
- ARI enabled (`http.conf`, `ari.conf`)
- Dialplan includes:
  ```
  Stasis(bc-ari-snoop,...)
  ```

### Node.js
- Node.js **v22.13.1**
- npm **v11.2.0**

Verify:
```
node -v
npm -v
```

---

## Installation

## 1) ARI Snoop Manager

### Directory
```
/opt/bc-ari-snoop/
 ├── index.js
 ├── package.json
 └── .env
```

### .env
```
ARI_URL=http://127.0.0.1:8088
ARI_USER=broadconvo
ARI_PASS=StrongPasswordHere
ARI_APP=bc-ari-snoop

ASR_RTP_HOST=10.10.10.50
ASR_RTP_BASE_PORT=30000
ASR_RTP_CODEC=slin
ASR_RTP_DETERMINISTIC_PORTS=true

ASR_GATEWAY_HTTP=http://10.10.10.50:7070
LOG_LEVEL=info
```

### Install & Run
```
cd /opt/bc-ari-snoop
npm install
node index.js
```

Expected output:
```
[READY] Listening on ARI app: bc-ari-snoop
```

---

## 2) Qwen ASR Gateway

### Directory
```
/opt/qwen-asr-gateway/
 ├── index.js
 ├── package.json
 └── .env
```

### .env
```
QWEN3_ASR_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx
QWEN3_ASR_MODEL=qwen3-asr-flash-realtime
QWEN3_ASR_URL=wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
QWEN3_ASR_FORMAT=pcm
QWEN3_ASR_SAMPLE_RATE=8000
QWEN3_ASR_LANG=""

GATEWAY_HTTP_PORT=7070
GATEWAY_BIND_ADDR=0.0.0.0
```

### Install & Run
```
cd /opt/qwen-asr-gateway
npm install
node index.js
```

Expected output:
```
[HTTP] listening on http://0.0.0.0:7070
```

---

## Speaker Mapping

| Stream | Description | UI |
|------|-------------|----|
| spy=in | Audio FROM channel | Speaker 1 |
| spy=out | Audio TO channel | Speaker 2 |

Transcripts are tagged with:
- `callId = LINKEDID`
- `speaker = S1_in / S2_out`
- `uniqueid`

---

## Firewall Requirements

### ASR Gateway
- UDP `30000–38000` (RTP)
- TCP `7070` (HTTP)

### Asterisk
- UDP to ASR Gateway RTP ports
- TCP to ASR Gateway `:7070`

---

## Production Recommendations

- Run both services via **systemd**
- Monitor `/health` endpoint on ASR Gateway
- Use `LINKEDID` for transcript correlation
- Do not mix audio before ASR

---

## Troubleshooting

| Issue | Check |
|-----|------|
| No transcripts | RTP ports open |
| One speaker only | Both snoops created |
| Delayed text | Qwen VAD settings |
| Calls bypass ARI | Dialplan Stasis placement |

---

## License

Internal use – BroadConvo
