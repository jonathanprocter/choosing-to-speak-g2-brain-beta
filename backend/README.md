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
- `POST /v1/memory/enable`
- `POST /v1/memory/sessions`
- `DELETE /v1/memory`
- `DELETE /v1/memory/sessions/:sessionId`

## Run locally

```bash
cd ~/Desktop/choosing-to-speak-g2-brain-beta/backend
cp .env.example .env
npm start
```

For AI-generated coaching, set `OPENAI_API_KEY` in `.env`. Without it, the service still returns schema-valid deterministic responses so the beta can run end to end.

Session memory is stored in SQLite. Locally it defaults to:

```text
backend/data/choosing-to-speak-memory.sqlite
```

Set `MEMORY_DB_PATH` to override it. The health endpoint reports `ai.memorySync=sqlite_persistent` and includes memory row counts.

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

## Render always-on app

The repo root includes `render.yaml` for an always-on Render web service:

```yaml
type: web
name: choosing-to-speak-brain
runtime: node
plan: starter
rootDir: backend
healthCheckPath: /v1/health
```

Render should run the service with `HOST=0.0.0.0` and `VELVETSPEAK_PUBLIC_BASE_URL=https://speak.procterai.cc`.

The Render service also mounts a persistent disk at `/var/data` and sets:

```text
MEMORY_DB_PATH=/var/data/choosing-to-speak-memory.sqlite
MEMORY_MAX_SESSIONS=500
```

Only files written under `/var/data` survive deploys and restarts, so the SQLite database must stay on that mount.

## Android beta note

The patched Titan/G2 beta copy is configured for the always-on Render beta host:

```text
https://speak.procterai.cc
wss://speak.procterai.cc/v1/transcribe/stream
```

The direct Render host remains available at `https://choosing-to-speak-brain.onrender.com`.

For a local backend tunnel test instead of Render, point the `speak.procterai.cc` ingress rule back to `http://localhost:8788`, then start the backend with the public base URL:

```bash
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=https://speak.procterai.cc \
  npm start
```

The plugin's `g2Mic` path uses `WS /v1/transcribe/stream`, and the backend returns `stream.ready` after the plugin authenticates.

For a plugged-in development run, you can still use ADB reverse and a local public base URL:

```bash
adb -s TITAN20000001860 reverse tcp:8788 tcp:8788
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=http://127.0.0.1:8788 \
  npm start
```
