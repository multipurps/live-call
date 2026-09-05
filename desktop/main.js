const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const UnityCaptureSender = require('./unity-capture-sender'); // null on non-Windows, see that file

// Same web app as the phone/PWA version - no code duplication. Point this at
// your deployed URL (or a local dev server while working on the web app
// itself). The app detects it's running inside this desktop shell via
// window.electronAPI (see preload.js) and only then shows OBS-related UI.
const APP_URL = process.env.LIVE_CALL_URL || 'https://live-call-eight.vercel.app';

let capSender = null;

function createWindow(){
  const win = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 380,
    title: 'Live Call & Swap',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Renderer sends raw RGBA frames here (see preload.js's sendFrameToObs +
  // app.src.js's OBS capture loop) whenever the person turns on "Send to
  // OBS". Only wired up on Windows - see unity-capture-sender.js's header
  // for why macOS needs a different, signed approach instead.
  if (UnityCaptureSender) {
    ipcMain.on('obs:send-frame', (event, { width, height, buffer }) => {
      if (!capSender) capSender = new UnityCaptureSender(0);
      try {
        capSender.send(width, height, Buffer.from(buffer));
      } catch (e) {
        console.error('[obs bridge] send failed:', e);
      }
    });
  }
});

app.on('window-all-closed', () => {
  if (capSender) { capSender.close(); capSender = null; }
  if (process.platform !== 'darwin') app.quit();
});
