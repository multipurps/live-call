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
