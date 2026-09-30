# live-call
Real-time AI video call

## Editing this app
The files actually served (`app.js`, `boot.js`, `index.html`, `styles.css`,
`admin.html`) are generated, minified output - comments and readable
formatting are stripped so the app doesn't ship a readable narration of its
own architecture/provider choices to anyone who loads the URL or views
source. **Edit the `.src.` files instead** (`app.src.js`, `boot.src.js`,
`index.src.html`, `styles.src.css`, `admin.src.html`), then run:

```
npm install   # first time only
npm run minify
```

...to regenerate the served files before committing. Committing only a
`.src.` change without rebuilding will leave the live site running the old
code.

## WhatsApp video calls (WaCalls engine)

WhatsApp calling has two selectable engines in Profile → WhatsApp:

* **Green API** — the existing integration, audio-only, untouched. Still the
  default and still builds. Calls are placed client-side by its calls SDK.
* **WaCalls** — an external WaCalls instance that carries **real 1:1 WhatsApp
  audio and video calls**, including *incoming* ones. The outgoing video is the
  live avatar selected in the call screen (**Anam** or **Lucy 2.5**), so the
  same AI pipeline (LLM + STT + TTS + avatar) drives a real WhatsApp video call.

WaCalls is reached over HTTP/SSE as a remote service (nothing is built or
spawned locally) with `X-API-Key` held server-side, and the Rust WhatsApp
bridge that used to do this is gone.

```bash
export WACALLS_URL="http://192.168.1.50:8080"   # video-capable WaCalls build
export WACALLS_API_KEY="the-key-set-on-that-instance"
npm start
```

Then Profile → WhatsApp → **WaCalls** → Start pairing, and scan the QR.

Configuration (instance flags, env vars, which files/routes handle incoming
calls, outgoing calls, avatar switching, the data-channel media path and how to
run the integration test): **[server/wacalls.md](server/wacalls.md)**.

---

## Realtime voice conversion (Lucy 2.5 calls)

Lucy 2.5 (`decart/lucy-2-5/realtime`) is a video-to-video model: it supplies
the live avatar and **no voice**. The audio that goes out with that avatar is
the live audio paired with the avatar pipeline, and that is what gets
converted — continuously, in real time, with RVC through
[w-okada/voice-changer](https://github.com/w-okada/voice-changer):

```
Lucy 2.5 live video (unchanged)  ────────────────────────────► outgoing video

live audio paired with the avatar pipeline
        │  browser → /api/social-call/media (channel 0x02)
        ▼
w-okada/voice-changer · RVC      (server/voice_changer.mjs)
        │  16 kHz mono, chunk in → chunk out, no files, no sentences,
        │  no waiting for a pause, no TTS/LLM
        ▼
converted voice
        ├─ Telegram  → /tmp/tgcalls_audio.pcm   (the audio track that travels
        │                                        with the Lucy video)
        └─ WhatsApp  → back to the browser (channel 0x04) → the outgoing
                       WebRTC audio track of the call
```

* Lucy 2.5 **only** — the control is hidden for the Anam avatar source, which
  already brings its own synthesised voice.
* Nothing about Lucy's existing live video behaviour changes, and the Live
  Swap screen is untouched.
* Incoming caller audio is never touched.
* If the converter is down, misconfigured, or has no model, the original
  voice is forwarded unchanged and the UI says `RVC OFF` rather than claiming
  a conversion that isn't happening.

Setup, model loading, tuning and the full list of environment variables:
**[server/voicechanger/README.md](server/voicechanger/README.md)**.

```bash
npm run voice-changer:setup   # install VCClient (once, on the call backend)
npm run voice-changer:start   # or VOICE_CHANGER_AUTOSTART=1 on the backend
```
