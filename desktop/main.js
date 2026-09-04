const { app, BrowserWindow } = require('electron');
const path = require('path');

// Same web app as the phone/PWA version - no code duplication. Point this at
// your deployed URL (or a local dev server while working on the web app
// itself). The app detects it's running inside this desktop shell via
// window.electronAPI (see preload.js) and only then shows OBS-related UI.
const APP_URL = process.env.LIVE_CALL_URL || 'https://live-call-eight.vercel.app';

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

  // The local OBS bridge server (see obs-server.js) is deliberately NOT
  // started here yet - see that file's header for why. Once it's a real,
  // tested WHEP implementation, start it here and pass its port to the
  // renderer via preload.js instead of the placeholder there now.
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
