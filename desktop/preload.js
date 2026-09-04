const { contextBridge } = require('electron');

// The loaded web app (same app.js used on mobile/web) checks for
// window.electronAPI.isDesktopApp to know it's running in this shell rather
// than a normal browser, and shows desktop-only UI (like an OBS connection
// control) only when it's present. Kept intentionally tiny and pure-data -
// no functions/streams cross this bridge, only plain values, since the OBS
// bridge itself isn't wired up yet (see obs-server.js).
contextBridge.exposeInMainWorld('electronAPI', {
  isDesktopApp: true,
  // Placeholder: once obs-server.js is a real, tested WHEP server, this
  // becomes the actual local URL OBS should point a WHEP Media Source at,
  // e.g. 'http://localhost:8899/whep/live'. Left null so the web app can
  // tell "running in desktop shell" apart from "OBS bridge is actually
  // ready" and show an honest "coming soon" state instead of a broken button.
  obsWhepUrl: null,
});
