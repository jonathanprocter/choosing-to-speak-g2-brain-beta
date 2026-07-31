# VelvetSpeak G2 Brain Beta

This repo contains the local VelvetSpeak G2 beta package and the companion brain backend used for the plugged-in Titan2/G2 development path.

## Contents

- `backend/` - Node backend for VelvetSpeak brain, search, coaching, debrief, REST transcription, and G2 WebSocket transcription routes. VoiceLock is deliberately absent.
- `plugin-beta/` - patched VelvetSpeak beta plugin cache package with VoiceLock UI/calls removed and a local runtime backend pointer.

## Connected Titan2/G2 Run

```bash
cd backend
adb -s TITAN20000001860 reverse tcp:8788 tcp:8788
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=http://127.0.0.1:8788 \
  npm start
```

The plugin uses `http://127.0.0.1:8788` and `ws://127.0.0.1:8788`. With ADB reverse active, those Android WebView loopback requests reach the Mac backend.

For an unplugged phone/glasses run, deploy the backend behind HTTPS/WSS and update the plugin runtime plus `app.json` whitelist.

## Verify

```bash
cd backend
npm test
```

