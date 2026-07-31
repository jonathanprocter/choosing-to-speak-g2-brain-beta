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
- `POST /v1/question_cues`
- `POST /v1/memory/enable`
- `POST /v1/memory/sessions`
- `POST /v1/client_context`
- `POST /v1/day_roster`
- `POST /v1/client_candidate`
- `DELETE /v1/memory`
- `DELETE /v1/memory/sessions/:sessionId`
- `DELETE /v1/client_context/:clientId`
- `DELETE /v1/day_roster/:date?lensId=clinical`

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

Client prep and daily roster matching use the same SQLite file. The backend matches roster dates in `America/New_York`, not UTC, so late-evening Eastern appointments do not roll into the next day just because the server is running on UTC.

## Client prep and daily roster

Use `POST /v1/client_context` for durable prep from Notion or the clinical HUD:

```json
{
  "clientId": "client-123",
  "displayName": "Client Name",
  "lensId": "clinical",
  "source": "notion-clinical-hud",
  "summary": "What matters for this client today.",
  "bestQuestions": ["What would make this next step feel doable?"],
  "risks": ["Do not rush into scripts before validating fatigue."],
  "previousSessionNotes": [
    {
      "sessionDate": "2026-07-17",
      "title": "Previous Notion session note",
      "summary": "A concise prior-session theme or clinical prep note.",
      "themes": ["Recurring pattern to listen for"],
      "suggestedQuestions": ["A useful question carried forward from prior work."]
    }
  ]
}
```

Use `POST /v1/day_roster` for the SimplePractice-synced calendar day:

```json
{
  "rosterDate": "2026-07-31",
  "lensId": "clinical",
  "source": "simplepractice-calendar-sync",
  "entries": [
    {
      "eventId": "simplepractice-event-id",
      "clientId": "client-123",
      "clientName": "Client Name",
      "start": "2:00 PM",
      "durationMinutes": 50,
      "summary": "Optional Notion prep can ride along here.",
      "bestQuestions": ["What feels most important to cover today?"],
      "previousSessionNotes": [
        {
          "sessionDate": "2026-07-24",
          "summary": "Prior-session context used to auto-populate the scene.",
          "risks": ["Specific risk or boundary to watch for today."],
          "nextSteps": ["One carry-forward action or thread."]
        }
      ]
    }
  ]
}
```

The plugin bridge calls `POST /v1/client_candidate` to suggest the most likely client for the current Eastern-time appointment window. Dismissed candidates are sent as `dismissedClientIds`, and a manual name can be sent as `manualClientContext`.

For scene setup, send the last 3-5 Notion notes as `previousSessionNotes`, `recentSessionNotes`, or `notionSessionNotes` on either the client prep payload or the matching roster entry. Each note may be plain text or an object with fields such as `sessionDate`, `title`, `summary`, `themes`, `patterns`, `goals`, `risks`, `avoid`, `nextSteps`, `suggestedQuestions`, and `notionUrl`. The backend keeps the five most recent notes, stores them with the client context in SQLite, and uses them for candidate hints, automatic question cues, and counselor-colleague coaching.

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
