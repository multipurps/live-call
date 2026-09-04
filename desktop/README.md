# Live Call & Swap — Desktop

Electron shell around the same web app used on mobile/PWA. Reuses 100% of the
existing `index.html`/`app.js`/`styles.css` by loading the deployed URL — no
separate copy of the app to maintain.

## Current state (be honest with yourself before shipping this)

- **Works now:** the shell itself. `npm install && npm start` opens the real
  app in a desktop window, and the app detects it's running in this shell
  (`window.electronAPI.isDesktopApp`).
- **Not built yet:** the actual OBS bridge. `obs-server.js` is a stub with
  a header explaining why — the obvious-looking library (`@eyevinn/whip-endpoint`)
  turned out to require a separate SFU media server running alongside it, not
  something that fits a single-user desktop app. The real path is a
  hand-built WHEP server on `werift` (pure-JS WebRTC for Node, no external
  media server needed) — see the comment in that file for the shape of it.
  This needs to be built and tested against a real OBS instance before it's
  trusted; it was not possible to verify end-to-end in the environment this
  was written in (no GUI, no OBS installed).

## Running it

```
cd desktop
npm install
npm start
```

Set `LIVE_CALL_URL` to point at a different deployment (e.g. `localhost:3000`
while developing the web app itself) instead of the default production URL.

## Packaging

`npm run dist` (electron-builder) is configured in package.json but has not
been run/verified — do that on the target OS before distributing anything.
