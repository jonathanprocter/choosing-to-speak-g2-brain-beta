# Conversate + clinical-hud Mining Report (2026-07-31)

Sources, both cloned and inspected:

- `https://github.com/jonathanprocter/conversate-apk-handoff-2026-07-31` — APK/native evidence handoff for the built-in Even Realities **Conversate** feature (Titan 2, Even app 2.2.6, pulled 2026-07-31). Not Conversate Plus.
- `https://github.com/jonathanprocter/clinical-hud` — the completed Clinical HUD multi-agent system (mission complete 2026-07-29), including the verbatim 2.5D `ContextAwareSpatialHUD.jsx` and a working Even G2 on-lens bridge.

## 1. How Conversate actually works (from `libapp.so` strings, proto, and DB)

Conversate is a **built-in OS feature of the Even host app**, not an Even Hub plugin. Its pipeline:

1. **Explicit start comes from the glasses dashboard.** The `os_conversate.svg` dashboard asset plus OS-side strings (`os_conversate_close_in`, `os_conversate_sec`, `os_conversate_saved`) show that plain Conversate is launched and closed from the glasses dashboard tile, with on-lens countdown/"saved" feedback. There is no phone-touch dependency anywhere in its start path.
2. **Audio capture** goes through `AudioManager.start(microphone)` with automatic **Bluetooth fallback** to the glasses mic (`AudioManager.start failed with microphone, retrying with bluetooth`, `... returned false during BLE fallback`), plus a native `even::speech_enhance_module` (ONNX-based speech enhancement) before ASR.
3. **Transcription** is streamed over a dedicated WebSocket: `AsrWebsocketManager` (`package:flutter_ezw_asr`) → `/v2/g/jarvis/conversate/ws`, with Tencent Cloud speech behind it (`TencentCloudSpeechTranslateAudioEvent`). Events follow `transcribe_event.proto`:
   - lifecycle: `sessionStarted`, `sessionStopped`, `canceled`, `error`
   - VAD: `speechStartDetected`, `speechEndDetected`
   - results: `recognizing` (partial) / `recognized` (final), `TranscribeResult { text, is_final, session_id, offset_ticks, duration_ticks }`
4. **Resilience patterns worth copying:** `asr network resumed, trigger ws reconnect`; `resumeConverse failed(state mismatch), force restart audio`; `startAudioListen return by transcribe running` (idempotent start guard); `AudioManager.start(microphone) timed out after 3 seconds` (bounded waits).
5. **Persistence** is a small SQLite DB (`conversate.db`): `conversation_messages (converse_id, message_id, speaker_id, speaker_name, content, timestamp, is_user, translated_content, src_lang, target_lang)` + `conversation_read_states`, indexed on `(converse_id, timestamp)`. Server-side session CRUD lives at `/v2/g/jarvis/conversate/{list,detail,messages,update,finish,remove}` and background profiles at `/v2/g/jarvis/conversate/background/*`.

**What choosing-to-speak should adopt from this:**

- The explicit-start philosophy matches what we shipped in 0.1.40: hardware-event start, on-lens feedback, no phone touch in the loop.
- Our WS protocol already mirrors the essentials (`stream.hello`/`stream.ready` ≈ `sessionStarted`, `transcript.partial`/`transcript.final` ≈ `recognizing`/`recognized` with `is_final`). Missing pieces worth adding later: explicit `speechStart/EndDetected`-style VAD events on the stream (the plugin bundles Silero VAD already), an idempotent start guard, and auto-reconnect on network resume.
- The `conversation_messages` schema is a good target shape if we ever import Conversate history into the brain's SQLite memory store (`converse_id` → `sessionId`, `is_user` → speaker kind).

## 2. What clinical-hud gives us

### 2.1 The official Even SDK on-lens pattern (`hud/src/g2/main.js`)

A complete, working `@evenrealities/even_hub_sdk` usage — the same SDK whose symbols (`waitForEvenAppBridge`, `CreateStartUpPageContainer`, `TextContainerProperty`, `TextContainerUpgrade`) are compiled into the choosing-to-speak plugin bundle:

```js
const bridge = await waitForEvenAppBridge();
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
  containerTotalNum: 1,
  textObject: [new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 288,
    borderWidth: 0, borderColor: 15, paddingLength: 8,
    containerID: 1, containerName: 'main',
    content: initialText,
    isEventCapture: 1,          // <- this is what makes the container receive tap events
  })],
}));
// afterwards, updates are cheap:
await bridge.textContainerUpgrade(new TextContainerUpgrade({
  containerID: 1, containerName: 'main', contentOffset: 0, contentLength: 0, content,
}));
```

`isEventCapture: 1` is the load-bearing flag: it is what routes glasses touchbar events into the WebView (`textEvent`/`sysEvent` messages → the `evenHubEvent` path our 0.1.40 explicit-start bridge listens on).

### 2.2 The 2.5D triplane design and its wire contract

The verbatim `ContextAwareSpatialHUD.jsx` renders three perceptual planes from three event types:

| Plane | Event | Payload | Behavior |
| --- | --- | --- | --- |
| NEAR (foreground alert) | `NEAR_ALERT` | `{alertText, timestamp}` | floating alert, auto-dismiss 5 s (8 s on-lens) |
| MID (intervention cue) | `MID_CUE` | `{cueText, modality}` | cue text; panel expands only on `conversationalState === "pause"` |
| FAR (ambient dashboard) | `FAR_AMBIENT` | `{clientRatio, therapistRatio, phase, conversationalState}` | peripheral talk-ratio dashboard |

The G2 text rendering law (`hud/src/g2/format.js`): one 576×288 container, ≤900 chars, NEAR alert takes priority over MID cue, FAR data compressed to one status line.

### 2.3 What is already merged into choosing-to-speak

The backend already computes clinical-hud-inspired deterministic dynamics per digest (`buildConversationDynamics` in `backend/src/server.mjs`): `clientRatio`, `therapistRatio`, `interruptionsByTherapist`, `conversationalState`, and cue selection already keys off them (`source: 'dynamics'`, pause-triggered question cues, high-therapist-talk-share alerts). Health reports `dynamics: clinical_hud_inspired_metrics`. **The metrics/agent side of the merge is done.**

### 2.4 What is NOT merged yet — the actual 2.5D rendering

The choosing-to-speak plugin still renders a flat cue card. The remaining merge work is glasses-side presentation, and `reference/g2-spatial-hud/` in this repo now contains the adapted starting point:

- `format.mjs` — the clinical-hud triplane text law adapted to choosing-to-speak's own payloads (`/v1/coach` results and stream transcripts) instead of the middleware frames.
- `README.md` — how the pieces map, and the two integration options (page-level SDK container vs. rebuilding the bundle's HUD screen).

## 3. Recommended order of work

1. **Verify 0.1.40 on hardware**: glasses tap → debug badge counts hub events → live session starts (explicit start path). This also verifies the `isEventCapture` event routing that everything else depends on.
2. **Run the live end-to-end transcription test** — the WSS path is confirmed working (see README WebSocket Readiness Protocol).
3. **Triplane rendering**: apply `reference/g2-spatial-hud/format.mjs` to the on-lens card so NEAR (coach nudge) > MID (sayThis/question cue) > FAR (ratios + state) layering matches the clinical-hud design.
4. **Later**: VAD lifecycle events on the WS stream, reconnect-on-network-resume, and optional Conversate history import into the memory store.
