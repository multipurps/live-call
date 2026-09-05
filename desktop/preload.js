const { contextBridge, ipcRenderer } = require('electron');

// The loaded web app (same app.src.js used on mobile/web) checks
// window.electronAPI.isDesktopApp to know it's running in this shell, and
// window.electronAPI.obsCaptureAvailable to know whether it can actually
// offer a "Send to OBS" control right now (Windows only for now - see
// unity-capture-sender.js for why macOS needs a different, signed approach).
contextBridge.exposeInMainWorld('electronAPI', {
  isDesktopApp: true,
  obsCaptureAvailable: process.platform === 'win32',
  // width/height/buffer: buffer is a raw RGBA8 Uint8Array/ArrayBuffer, no
  // padding, row-major (width*4 bytes per row). Fire-and-forget - matches
  // the underlying protocol, which is a shared-memory "latest frame wins"
  // handoff, not a queue.
  sendFrameToObs: (width, height, buffer) => {
    ipcRenderer.send('obs:send-frame', { width, height, buffer });
  },
});

