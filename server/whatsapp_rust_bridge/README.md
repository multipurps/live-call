# `whatsapp_rust_bridge` — the real WhatsApp calling backend

A small Rust service that speaks to WhatsApp through the **real
[`oxidezap/whatsapp-rust`](https://github.com/oxidezap/whatsapp-rust) library**
(pinned to rev `f7468ae2920a2b0aedbd0848cf121de56a07f93c`, v0.7.0) and exposes it
to `server.mjs` over localhost HTTP + a tagged TCP media socket.

It exists so Live Call can place a **genuine 1-to-1 WhatsApp video call** whose
outgoing video is the live Lucy 2.5 / Anam avatar output — without touching the
existing Green API integration, which stays as the independent alternative.

```
Lucy 2.5 (Fal/Decart WebRTC) ─┐
                              ├─ activeSocialSource() ── SocialCallMediaAdapter
Anam (@anam-ai/js-sdk) ───────┘        (canvas 480x640@15fps -> JPEG,
                                        ScriptProcessor 16 kHz mono PCM)
                                                     │ ws /api/social-call/media
                                                     ▼
                                              server.mjs  ◄── provider = whatsapp-rust
                                                     │ TCP 127.0.0.1:5061
                                                     ▼
                                       whatsapp_rust_bridge (this crate)
                                         ffmpeg  JPEG -> H.264 Annex-B AUs
                                                     │
                                                     ▼
                          client.voip().call(peer).audio(src,sink)
                                          .video(src,sink).start()
                                                     │
                                                     ▼
                                        a real WhatsApp 1:1 video call
```

## What is actually used from whatsapp-rust

| Concern | Real API used |
| --- | --- |
| Session store | `SqliteStore::new("data/wa_rust_session/whatsapp.db")` |
| Bootstrap | `Bot::builder().with_backend(store).on_event(..).build()` → `bot.spawn()` → `handle.client()` |
| Pairing (preferred) | `client.pair_with_code(PairCodeOptions { phone_number, .. })` — **phone-number link code**, surfaced through `POST /pair/code` |
| Pairing (fallback) | `Event::PairingQrCode { code, timeout }` → `/status` `qr` field, rendered to PNG by `server.mjs` |
| Auth events | `Connected`, `Disconnected`, `PairSuccess`, `PairError`, `PairingCode`, `PairingCodeError`, `LoggedOut` |
| Identity | `client.pn()`, `client.lid()`, `client.push_name()` |
| Contact check | `client.contacts().is_on_whatsapp(&[Jid])` — real registration lookup |
| Calling | `client.voip().call(&peer_jid)` → `.audio(..)`, `.video(..)`, `.start()` |
| Audio out | `AudioSource` impl over an `async_channel` receiver — exactly **960 i16 samples** (60 ms mono @ 16 kHz) per frame |
| Video out | `VideoSource` impl over an `async_channel` receiver — complete **H.264 Annex-B access units** (baseline, ≤1280×720) |
| Inbound media | `AudioSink` / `VideoSink` → relayed back to the browser |
| Lifecycle | `CallHandle::{set_muted, hangup_local, terminate, wait_ended, request_peer_keyframe}`, `CallEvent` stream |

There is **no simulated call, no demo mode and no fake WebRTC** in here. If
whatsapp-rust fails, the failure is passed through verbatim: `/status` reports
the real `error` string, `/call` returns the real `CallError`, and
`server.mjs` relays both to the browser, which renders them on the call screen.

## Wire protocol (identical contract on both ends)

`server.mjs` and `src/media.rs` agree on `[u8 channel][u32 big-endian length][payload]`:

| Ch | Dir | Payload |
| --- | --- | --- |
| `0x01` | server → bridge | one JPEG frame of live avatar video |
| `0x02` | server → bridge | little-endian mono 16 kHz i16 PCM |
| `0x03` | bridge → server | peer PCM (played back in the browser) |
| `0x04` | bridge → server | peer H.264 Annex-B (decoded to `#socialPeerCanvas`) |
| `0x05` | bridge → server | JSON telemetry (`media_stats`, `encoder_error`, …) |

HTTP (`WA_RUST_PORT`, default **5060**):

`GET /health`, `GET /status`, `POST /pair/code`, `POST /pair/cancel`,
`POST /logout`, `GET /contacts`, `POST /contacts`, `POST /lookup`,
`POST /call`, `POST /call/mute`, `GET /call/state`, `POST /hangup`.

## Building and running

```bash
bash server/whatsapp_rust_bridge/build.sh   # also runs from npm postinstall
./target/release/whatsapp_rust_bridge       # or let server.mjs spawn it
```

`build.sh` never hard-fails: it checks for Rust ≥ 1.94 (whatsapp-rust's own
`rust-version`), installs via rustup if needed, and if the build cannot happen
it logs a warning and exits 0 so the rest of Live Call still deploys.
`server.mjs::startWhatsAppRustBridge()` then logs
`whatsapp_rust_bridge binary not found - real whatsapp-rust calling unavailable
(Green API WhatsApp calling unaffected)` instead of crashing, and the
`/api/social-call/whatsapp-rust/*` routes return a real **502** rather than a
fake success.

**Runtime requirement for video:** `ffmpeg` must be on `PATH`. It is what
converts the incoming live JPEG frames into H.264 access units. Audio-only
calls do not need it.

Session material lives **server-side only**, in `data/wa_rust_session/`
(gitignored). The browser never receives identity keys — only state, the linked
number, a QR image, and the pairing code.

## Verification status — read this before believing anything

**Verified here, by running real code** — `node test/whatsapp-rust-integration.mjs`
(35/35 checks) exercises `server.mjs` end to end: the whatsapp-rust proxy
routes, the QR-rendering route, the provider-selection layer on
`/api/social-call/call` (including rejecting an unknown provider and *not*
silently re-routing a provider-less call), the live media relay in **both**
directions with byte-exact framing, `call_state` polling/broadcast, mute,
hangup + media-socket teardown, and proof that the Green API routes are
untouched. In that harness the Rust process is a stand-in speaking this exact
HTTP/TCP contract — which is the same seam `tgcalls_bridge` already uses, and
everything on the Node side of it is real, executed code.

**NOT verified — no Rust toolchain, no `crates.io`, and no `ffmpeg` in this
environment:**

- ❌ this crate has **never been compiled**. `cargo build` has not run.
- ❌ real WhatsApp authentication (pair code or QR) has not been exercised.
- ❌ a real 1-to-1 WhatsApp call has never been placed; ringing, answer,
  relay allocation and hangup against the WhatsApp network are untested.
- ❌ Lucy 2.5 video and Anam video have not been injected into a real
  `VideoSource`.
- ❌ the `ffmpeg` JPEG → H.264 encoder path has not been run.

So: **do not describe video calling as working.** Everything above the Rust
boundary is wired and tested; the Rust boundary itself is written against the
API read directly out of the pinned revision's source, but it is unexecuted.
First real deploy should run, in order: `build.sh` → `GET /status` (expect the
real pairing code) → link a number → `POST /lookup` on a real number →
`POST /call` with `video:false` (audio only, no ffmpeg needed) → then
`video:true` → Lucy → Anam → `POST /hangup`.
