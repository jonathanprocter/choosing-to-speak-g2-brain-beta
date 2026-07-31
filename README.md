# Choosing to Speak G2 Brain Beta

This repo contains the Choosing to Speak G2 beta package and the companion brain backend used for the Titan2/G2 beta path. Choosing to Speak is the conversation-assistance piece of the Choosing Memento Vivere idea: intentional speech, remembered context, and real-time support without the old VoiceLock beta code.

## Contents

- `backend/` - Node backend for brain, search, coaching, debrief, REST transcription, and G2 WebSocket transcription routes. VoiceLock is deliberately absent.
- `plugin-beta/` - patched Choosing to Speak beta plugin cache package with VoiceLock UI/calls removed and a Cloudflare-backed runtime backend pointer.

## Always-On Beta Host

The current unplugged beta brain host used by the plugin is:

```text
https://speak.procterai.cc
wss://speak.procterai.cc/v1/transcribe/stream
```

Render also exposes the direct service host:

```text
https://choosing-to-speak-brain.onrender.com
wss://choosing-to-speak-brain.onrender.com/v1/transcribe/stream
```

An example of a more permanent cloud host behind Cloudflare would be a small Fly.io Machine, DigitalOcean Droplet, Render service, Railway service, AWS Lightsail/EC2 instance, or GCP Compute Engine VM running this Node backend continuously. Cloudflare can sit in front with DNS proxying or with `cloudflared` installed on that host. For this beta, a regular Node host is simpler than rewriting the live WebSocket brain around Cloudflare Workers/Durable Objects.

## Always-On App Host

`render.yaml` defines a Render web service named `choosing-to-speak-brain`:

- runtime: Node
- instance type: `starter`
- root directory: `backend`
- health check: `/v1/health`
- direct URL: `https://choosing-to-speak-brain.onrender.com`
- custom domain: `speak.procterai.cc`
- public base URL: `https://speak.procterai.cc`

The Render service and custom domain have been created and verified.

## Unplugged Titan2/G2 Run

```bash
cd backend
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=https://speak.procterai.cc \
  npm start
```

The plugin uses `https://speak.procterai.cc` and `wss://speak.procterai.cc`, so it does not need `adb reverse` when the phone has internet.

For a plugged-in development run, switch the runtime URL back to `http://127.0.0.1:8788` and run:

```bash
adb -s TITAN20000001860 reverse tcp:8788 tcp:8788
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=http://127.0.0.1:8788 \
  npm start
```

Some internal identifiers still say `velvetspeak` because the extracted Even/G2 plugin currently depends on those package, runtime, storage, and WebSocket contracts.

## WebSocket Readiness Protocol

`wss://speak.procterai.cc/v1/transcribe/stream` (subprotocol `velvetspeak-stt.v1`) is auth-gated, so a probe that connects and waits silently will time out even when the stream is healthy. The correct readiness sequence is:

1. Connect; the server immediately sends `{"type":"stream.hello","authRequired":true,...}`.
2. Send `{"type":"Authenticate","token":"<beta token>"}`.
3. The server replies `{"type":"stream.ready"}`; binary PCM16 mono 16 kHz frames may then be streamed.

A plain HTTPS `GET /v1/transcribe/stream` returns `426 Upgrade Required` with the same instructions, so any HTTP monitor can discover the handshake contract.

## Glasses Explicit Start

The Even-hosted phone WebView does not deliver phone touch events, so `plugin-beta/dist/index.html` adds a glasses-side explicit start path:

- Every Even app message is mirrored to a `ctsEvenAppMessage` window event so page-level code can observe glasses/ring events even after the app bundle installs its own `_listenEvenAppMessage` delegate.
- A glasses or ring click (`sysEvent.eventType` 0) or double click (3) arms a 1.4 s fallback: if the app's own SDK handler has not started a live session by then, the bridge clicks the visible Start Live button.
- `window.ChoosingToSpeakStart.start()` triggers the same explicit start manually and `window.ChoosingToSpeakStart.status()` reports hub-event counters for verification.
- While `__VELVETSPEAK_DEBUG_HUD_RENDER__` is on, a small badge appears after the first hub event showing `hub <count> | clk <clicks>/<doubleClicks> | <source>` — the glasses-side equivalent of the JS touch counter used to prove phone touch was broken.

## Verify

```bash
cd backend
npm test
```
