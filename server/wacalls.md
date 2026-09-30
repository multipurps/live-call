# WhatsApp calls through WaCalls (audio + video)

This app drives an **external WaCalls instance** for WhatsApp calling — voice
and **video** — including real **incoming** calls, with the live avatar (Anam or
Lucy 2.5) as the outgoing video. It replaces the previous Rust bridge: nothing
Rust is built, installed or spawned any more.

Green API is untouched. It is still a selectable engine for audio-only calls
(`README.md`, `server/greenapi_bridge.mjs`) and still builds; WaCalls is simply
the engine that can carry video.

---

## 1. Run a video-capable WaCalls instance

WaCalls is a Go service with a React client. For **video** you need the build
whose call engine is `meowcaller`/HyperMeow and whose bridge carries the H.264
data channel — [fabriciosprj/WaCalls-Video](https://github.com/fabriciosprj/WaCalls-Video)
(the lineage this integration was written against, upstream README section
"Videochamada"). The older audio-only build exposes neither `POST .../video/*`
nor `GET .../calls/{id}`, and silently keeps calls audio-only.

```bash
git clone https://github.com/fabriciosprj/WaCalls-Video wacalls-go
cd wacalls-go
go mod download
cd client && npm install && npm run build && cd ..

# API key is REQUIRED for this app (the browser must never reach WaCalls):
export WACALLS_API_KEY="$(head -c 32 /dev/urandom | base64)"
go run ./cmd/server -addr :8080          # add -debug for verbose logs
```

Server flags (`cmd/server/main.go`):

| Flag | Default | Notes |
|---|---|---|
| `-addr` | `:8080` | HTTP listen address. Use `0.0.0.0:8080` behind a proxy/tunnel. |
| `-db` | `wacalls.db` | SQLite session store — holds WhatsApp credentials. Never commit it. |
| `-static` | `client/dist` | Serves the WaCalls web client; optional for API-only use. |
| `-debug` | `false` | Verbose logging, including call/bridge internals. |
| `-max-calls-per-session` | `8` | This app needs **1** active call at a time. |
| `-video-dump` | `false` | Dumps video RTP/RTCP (only for debugging packetisation). |

`WACALLS_API_KEY` in the instance's environment turns on the `X-API-Key` check on
every request. Leave it set: without it the WaCalls API is open to anyone who can
reach it.

**Reachability matters.** The control plane goes through this app's server, but
the **media plane is browser ↔ WaCalls** (WebRTC data channels; only the SDP is
relayed). So `WACALLS_URL` must be reachable *from the browser*, not just from
the server — a `localhost`/containers-only hostname will negotiate SDP and then
carry no media. WaCalls answers with host ICE candidates only (no STUN/TURN), so
the WaCalls host must be directly reachable on its WebRTC ports (UDP by default)
from the browser's network.

---

## 2. Point this app at it

Environment variables (all read by `server/wacalls.mjs`):

| Variable | Required | Meaning |
|---|---|---|
| `WACALLS_URL` | yes | Base URL of the instance, e.g. `https://wacalls.example.com` or `http://192.168.1.50:8080`. Unset ⇒ the WaCalls engine reports `configured:false` and every route answers honestly instead of pretending. |
| `WACALLS_API_KEY` | yes in practice | Sent as `X-API-Key` on every outbound request. **Only ever exists on the server**: it is added in `server/wacalls.mjs`, and the browser receives `apiKeySet`-style booleans, never the key. |
| `WACALLS_SESSION` | no | Session id to drive. Unset ⇒ the first paired session is used, or a new one is created and pairing starts automatically. |
| `WACALLS_CLIENT_ID` | no | `X-Client-Id` (default `live-call`). WaCalls allows one active call per client id; this is what claims/owns the call. |
| `WACALLS_TIMEOUT_MS` | no | HTTP timeout, default `15000`. |

```bash
export WACALLS_URL="http://192.168.1.50:8080"
export WACALLS_API_KEY="the-key-you-set-on-the-instance"
npm start
```

Then in the app: **Profile → WhatsApp → WaCalls → Start pairing**, scan the QR
(the QR arrives over WaCalls' event stream and is rendered by this app's server),
and pick the engine. `GET /api/social-call/wacalls/status` reports
`configured`, `paired`, the linked number and whether the instance is a
video-capable build (`video.state` = `video` | `audio-only` | `unknown`).

Pairing and status are verified live: the capability check calls
`GET .../calls/probe-no-such-call` once (cached, `?probe=1` to refresh,
`?probe=1&force=1` to re-run) because the video build answers **404** there and
the audio-only build answers **405**. After each call is placed, WaCalls' own
`call-status` media kind is compared with the `{video:true}` that was asked for —
a silent downgrade is surfaced in the UI instead of being presented as video.

---

## 3. What handles what

| Concern | Where |
|---|---|
| WaCalls client (config, sessions, pairing, call control, SDP relay, SSE loop, event normalisation) | `server/wacalls.mjs` |
| Control routes + SDP relay + event bridge (`/api/events` → media WebSocket) | `server.mjs` (`/api/social-call/wacalls/*`) |
| **Incoming** video call: `wacalls_event` kind `incoming` → banner → `POST .../wacalls/answer` → `POST .../video/start` → media leg | `app.src.js` (`handleWaCallsEvent`, `showIncomingWaCallsCall`, `answerIncomingWaCallsCall`) |
| **Outgoing** video call: `POST /api/social-call/call` with `provider:'wacalls'` (`{video:true}` on WaCalls) → media leg | `app.src.js` (`placeSocialCall`), `server.mjs` (`subpath === 'call'`) |
| **Avatar video source switching** (`Anam` \| `Lucy 2.5`), mid-call | `app.src.js` (`setSocialCallAvatarSource`, `WaCallsMediaLeg.setAvatarSource`, `#socialSourceSelect`) + `POST /api/social-call/wacalls/avatar` (logged/recorded server-side) |
| Browser media plane: `pcm` (16 kHz mono s16le, both ways) + `vp8` (H.264 access units, both ways) data channels | `app.src.js` (`WaCallsMediaLeg`) |
| Peer audio/video playout | `app.src.js` (`PeerMediaPlayout`) |
| Engine selection UI (Green API / WaCalls) | `index.src.html` (`waEngineGreenBtn`, `waEngineWaCallsBtn`, `waSessionBox`), `app.src.js` (`renderWaEngineUi`, `fetchWaCallsStatus`) |
| Integration test against a stubbed WaCalls instance | `test/wacalls-integration.mjs` |

Route surface (all under `/api/social-call/`):

```
GET|POST wacalls/qr                 pairing QR (raw payload -> PNG data URL)
POST     wacalls/pair               start/restart pairing
POST     wacalls/logout             unlink the session
GET      wacalls/status             [?probe=1][&force=1] connection + video capability
POST     wacalls/call               {target, name, video}  -> places a real call
POST     wacalls/answer|reject|end  {callId}
POST     wacalls/webrtc             {callId, sdp_offer} -> {sdp_answer}
POST     wacalls/webrtc/renegotiate {callId, sdp_offer} -> {sdp_answer} (mid-call video upgrade)
POST     wacalls/video/start|stop|accept {callId}
POST     wacalls/avatar             {source: 'anam'|'lucy'} (recorded + logged)
POST     wacalls/messages           always 501 (see below)
```

Events (WaCalls SSE → normalised in `server/wacalls.mjs` → media WebSocket as
`wacalls_event`, plus `call_state`/`wa_call_event` for the existing UI):
`session`, `incoming` (with `media` = `audio`|`video`), `accepted`, `rejected`,
`ended`, `media-ready`, `media-not-ready`, `video-request`, `error`.

---

## 4. Media path, in one paragraph

The browser builds the SDP offer, posts it to **this app's** server, and the
server relays it to WaCalls with the API key; the answer comes back the same
way. The media itself then flows directly between the browser and WaCalls over
two WebRTC data channels on that connection:

* **`pcm`** — raw 16 kHz mono s16le, both directions. Out: the microphone, or
  the RVC-converted voice when voice conversion is on (the converted audio comes
  back from this app's server as channel `0x06`, exactly as on the Green API
  path). In: the peer's voice → `PeerMediaPlayout`.
* **`vp8`** — the label is historical; the payload is **H.264 Annex-B** with a
  5-byte header (`flags` bit0 = keyframe, bits1–2 = rotation, then a uint32 BE
  timestamp in ms). Out: the live avatar, encoded in the browser with WebCodecs
  (`avc1.42E01F`, 480×640, 15 fps, keyframe every 2 s and on every 1-byte `0x01`
  control frame from the server — that is the peer's PLI/FIR asking for a fresh
  keyframe). In: the peer's camera → WebCodecs `VideoDecoder` → the call screen.

Switching the avatar source only changes which element the encoder draws from;
the next keyframe carries the new source, so Anam ⇄ Lucy 2.5 can be flipped
during a call.

The peer's decoded picture is drawn on the small `#socialPeerCanvas` overlay, as
it already was before this change — the call screen's own layout is untouched.
The avatar is what this app sends; the caller's video is shown in that corner
view, and an audio-only call (or a browser without WebCodecs) shows exactly what
it did before.

---

## 5. Logging

Every one of these is logged with the `[WaCalls]` tag, on the server or in the
browser console:

* outgoing call placed (with `callId`, target and the avatar used), incoming
  call received (with media kind and peer), call answered/rejected/ended,
* media leg opened/negotiated/closed (with frame counters), media ready /
  not-ready, the peer asking for a video upgrade,
* avatar video source switched (both client-side and server-side, recorded on
  the active call record),
* every WaCalls call-setup or media-streaming error, with the real reason from
  WaCalls (HTTP status + body), never a generic failure.

---

## 6. Text messages

Not wired, on purpose: neither WaCalls build exposes a send-text endpoint (its
API is sessions, pairing, calls and history), and this app has no WhatsApp
send-text path. `POST /api/social-call/wacalls/messages` answers **501** with
that reason rather than faking success. Sending text through WaCalls would need
a messaging endpoint on the WaCalls side (whatsmeow `SendMessage`) — and, if it
should double as the AI's reply channel, a webhook/SSE event for incoming text
in the same event stream this app already consumes.

---

## 7. Testing

```bash
npm test          # same as: node test/wacalls-integration.mjs
```

This runs the real `server.mjs` against a stub WaCalls instance that speaks the
documented HTTP + SSE contract: control routes, API-key discipline (every
outbound request carries the key; no response leaks it), the video capability
probe in both directions, provider selection (`wacalls` places with
`{video:true}`, `greenapi` is never re-routed), the SSE event bridge, the
unconfigured case, and that the Green API routes still exist. It does **not**
prove anything about the Go side or that a real phone rings — that needs a real
instance and a real WhatsApp account.
