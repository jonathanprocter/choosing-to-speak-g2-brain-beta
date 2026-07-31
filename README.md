# Choosing to Speak G2 Brain Beta

This repo contains the Choosing to Speak G2 beta package and the companion brain backend used for the Titan2/G2 beta path. Choosing to Speak is the conversation-assistance piece of the Choosing Memento Vivere idea: intentional speech, remembered context, and real-time support without the old VoiceLock beta code.

## Contents

- `backend/` - Node backend for brain, search, coaching, debrief, REST transcription, and G2 WebSocket transcription routes. VoiceLock is deliberately absent.
- `plugin-beta/` - patched Choosing to Speak beta plugin cache package with VoiceLock UI/calls removed and a Cloudflare-backed runtime backend pointer.

## Always-On Beta Host

The current unplugged beta brain host used by the plugin is:

```text
https://choosing-to-speak-brain.onrender.com
wss://choosing-to-speak-brain.onrender.com/v1/transcribe/stream
```

The intended custom domain is also attached in Render:

```text
https://speak.procterai.cc
wss://speak.procterai.cc/v1/transcribe/stream
```

`speak.procterai.cc` is currently a Cloudflare Tunnel DNS record. The local `cloudflared` ingress proxies that hostname to the Render app so HTTPS and WSS work, but Render will keep the custom domain marked unverified until Cloudflare DNS is changed from the tunnel CNAME to `choosing-to-speak-brain.onrender.com`.

An example of a more permanent cloud host behind Cloudflare would be a small Fly.io Machine, DigitalOcean Droplet, Render service, Railway service, AWS Lightsail/EC2 instance, or GCP Compute Engine VM running this Node backend continuously. Cloudflare can sit in front with DNS proxying or with `cloudflared` installed on that host. For this beta, a regular Node host is simpler than rewriting the live WebSocket brain around Cloudflare Workers/Durable Objects.

## Always-On App Host

`render.yaml` defines a Render web service named `choosing-to-speak-brain`:

- runtime: Node
- instance type: `starter`
- root directory: `backend`
- health check: `/v1/health`
- direct URL: `https://choosing-to-speak-brain.onrender.com`
- custom domain: `speak.procterai.cc` after DNS verification
- public base URL: `https://speak.procterai.cc`

The Render service and custom domain have been created. Final DNS cutover is to update Cloudflare DNS for `speak.procterai.cc` from the current Cloudflare Tunnel CNAME to `choosing-to-speak-brain.onrender.com`, then verify the custom domain in Render.

## Unplugged Titan2/G2 Run

```bash
cd backend
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=https://speak.procterai.cc \
  npm start
```

The plugin uses `https://choosing-to-speak-brain.onrender.com` and `wss://choosing-to-speak-brain.onrender.com`, so it does not need `adb reverse` when the phone has internet.

For a plugged-in development run, switch the runtime URL back to `http://127.0.0.1:8788` and run:

```bash
adb -s TITAN20000001860 reverse tcp:8788 tcp:8788
HOST=127.0.0.1 PORT=8788 \
  VELVETSPEAK_BETA_TOKEN=velvet-beta-local \
  VELVETSPEAK_PUBLIC_BASE_URL=http://127.0.0.1:8788 \
  npm start
```

Some internal identifiers still say `velvetspeak` because the extracted Even/G2 plugin currently depends on those package, runtime, storage, and WebSocket contracts.

## Verify

```bash
cd backend
npm test
```
