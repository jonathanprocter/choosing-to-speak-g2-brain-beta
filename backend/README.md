# Choosing to Speak Brain Backend

Small backend boundary for the Choosing to Speak beta plugin, with VoiceLock deliberately absent.

It implements the routes the extracted plugin already calls:

- `GET /health`
- `GET /v1/health`
- `POST /v1/live_brain`
- `POST /v1/search`
- `POST /v1/transcribe`
- `WS /v1/transcribe/stream`
- `POST /v1/coach`
- `POST /v1/debrief`
- `POST /v1/coach_review`

## Run locally

```bash
cd ~/Desktop/choosing-to-speak-g2-brain-beta/backend
cp .env.example .env
npm start
```

For AI-generated coaching, set `OPENAI_API_KEY` in `.env`. Without it, the service still returns schema-valid deterministic responses so the beta can run end to end.

## Auth

The plugin sends a bearer token. The server accepts the token in `VELVETSPEAK_BETA_TOKEN`.

The env var names are retained for compatibility with the extracted G2 plugin runtime.

Default local token:

```text
velvet-beta-local
```

## Smoke test

```bash
npm test
```

## Android beta note

The patched Titan/G2 beta copy is configured for a plugged-in development run:

```bash
adb -s TITAN20000001860 reverse tcp:8788 tcp:8788
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=http://127.0.0.1:8788 \
  npm start
```

With that reverse active, `http://127.0.0.1:8788` and `ws://127.0.0.1:8788` inside the Android WebView reach this Mac backend. The plugin's `g2Mic` path uses `WS /v1/transcribe/stream`, and the backend returns `stream.ready` after the plugin authenticates.

For an unplugged G2/phone run, put this service behind a reachable HTTPS/WSS URL and update the plugin runtime plus `app.json` whitelist to that URL.
