import http from 'http';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import * as greenApi from './server/greenapi_bridge.mjs';
import { getServiceClient, getAuthedUserId } from './lib/supabaseAdmin.js';
import { getProviderKey } from './lib/keys.js';
import { voiceChanger, startVoiceChangerProcess, VC_CONFIG } from './server/voice_changer.mjs';

// ---------------------------------------------------------------------
// WhatsApp backends. There are exactly TWO and they never touch each other:
//
//   1. GREEN-API  - server/greenapi_bridge.mjs (REST) + the Green API calls
//      SDK in the browser. Per-user credentials from Supabase Vault. This is
//      the original integration and it is UNCHANGED: every /whatsapp/* route
//      below still resolves the caller's own Green API credentials, and
//      /api/social-call/call still defaults to it for platform=whatsapp.
//
//   2. whatsapp-rust - server/whatsapp_rust_bridge, a Rust process built on
//      github.com/oxidezap/whatsapp-rust that places REAL 1:1 WhatsApp calls
//      (signaling + DTLS/SCTP relay + E2E media) and exposes the crate's
//      AudioSource/VideoSource ports, which is how the live Lucy 2.5 / Anam
//      avatar output reaches an actual WhatsApp video call. Green API has no
//      video calling at all (its SDK is audio-only), so this is the only path
//      that can carry video.
//
// Selection is explicit: the frontend sends `provider` on the call request
// and hits the /whatsapp-rust/* routes only when the user chose that engine.
// Nothing here silently switches a Green API user onto whatsapp-rust, and
// whatsapp-rust neither reads nor needs Green API credentials.
// ---------------------------------------------------------------------
export const WHATSAPP_PROVIDERS = ['greenapi', 'whatsapp-rust'];

// Resolves the AUTHENTICATED CALLER's own Green API credentials - every
// user brings their own Green API account (their own WhatsApp number),
// stored encrypted via the same Supabase Vault mechanism already used for
// Anam/fal keys. There is no shared/global WhatsApp connection for the
// whole app; each user's WhatsApp calling is entirely their own.
async function requireGreenApiCreds(req) {
  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) throw new Error('Not signed in');
  const raw = await getProviderKey(supabase, userId, 'greenapi');
  if (!raw) throw new Error('Add your Green API credentials in Profile settings first');
  const creds = greenApi.parseCreds(raw);
  if (!creds) throw new Error('Saved Green API credentials are malformed - re-save as idInstance:apiTokenInstance');
  return creds;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TG_PORT = parseInt(process.env.TG_PORT || '5050', 10);
const TGCALLS_PORT = parseInt(process.env.TGCALLS_PORT || '5051', 10);
// whatsapp-rust bridge: HTTP control plane + a raw TCP socket carrying the
// live avatar media in and the peer's media out.
const WA_RUST_PORT = parseInt(process.env.WA_RUST_PORT || '5060', 10);
const WA_RUST_MEDIA_PORT = parseInt(process.env.WA_RUST_MEDIA_PORT || '5061', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Social call history in-memory + persisted cache
const CALL_HISTORY_FILE = path.join(__dirname, 'data', 'social_call_history.json');
let callHistory = [];
try {
  if (fs.existsSync(CALL_HISTORY_FILE)) {
    callHistory = JSON.parse(fs.readFileSync(CALL_HISTORY_FILE, 'utf8'));
  }
} catch (e) {
  callHistory = [];
}

function saveCallHistory(record) {
  callHistory.unshift(record);
  if (callHistory.length > 100) callHistory.pop();
  try {
    fs.mkdirSync(path.dirname(CALL_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(CALL_HISTORY_FILE, JSON.stringify(callHistory, null, 2));
  } catch (e) {}
}

// Active social call state
let currentActiveCall = null;
let tgCallsStatePoll = null;

// Polls tgcalls_bridge's real call state (idle/ringing/connecting/connected/
// ended/failed - see server/tgcalls_bridge/src/main.rs's CallState enum)
// and forwards changes to the frontend as call_state broadcasts. Without
// this, the only call_state event ever sent was the initial "calling" one
// right after placing the call - the UI had no way to ever learn the call
// actually connected (or failed), so it stayed on "Ringing..." forever
// regardless of what really happened.
function startTgCallsStatePoll() {
  stopTgCallsStatePoll();
  let lastState = null;
  tgCallsStatePoll = setInterval(async () => {
    const r = await proxyToTgCalls('/call/state', 'GET');
    const state = r.data?.state;
    if (!state || state === lastState) return;
    lastState = state;

    if (state === 'connected') {
      if (currentActiveCall) currentActiveCall.status = 'connected';
      broadcastMediaEvent({ type: 'call_state', state: 'connected', call: currentActiveCall });
    } else if (state === 'ringing' || state === 'connecting') {
      broadcastMediaEvent({ type: 'call_state', state, call: currentActiveCall });
    } else if (state === 'failed') {
      broadcastMediaEvent({ type: 'call_state', state: 'failed', error: r.data?.error, call: currentActiveCall });
      stopTgCallsStatePoll();
    } else if (state === 'ended') {
      broadcastMediaEvent({ type: 'call_state', state: 'ended', call: currentActiveCall });
      stopTgCallsStatePoll();
    }
  }, 1000);
}

function stopTgCallsStatePoll() {
  if (tgCallsStatePoll) { clearInterval(tgCallsStatePoll); tgCallsStatePoll = null; }
}

// Keep-alive ping (test-mode only, toggled from the app).
//
// This does NOT run its own internal timer - a setInterval only fires while
// the Node process is already alive, so it can't wake the service back up
// once it's actually spun down, and it silently resets to "off" on every
// restart/redeploy. Instead, the toggle enables/disables a GitHub Actions
// scheduled workflow (.github/workflows/keepalive.yml) that pings this
// service from GitHub's infrastructure every 10 min, independent of
// whatever state this process is in. A disabled workflow simply never
// runs, so "off" means genuinely undisturbed, not just "not pinging for
// now until the next restart resets the flag."
const GITHUB_REPO = 'multipurps/live-call';
const KEEPALIVE_WORKFLOW_ID = 'keepalive.yml';

async function githubApi(path, method = 'GET') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not configured on this service');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'live-call-keepalive',
    },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `GitHub API error ${res.status}`);
  return data;
}

// Start Telegram Bridge Python process
let tgProcess = null;
function startTelegramBridge() {
  const scriptPath = path.join(__dirname, 'server', 'telegram_bridge.py');
  if (!fs.existsSync(scriptPath)) return;
  
  console.log('[Server] Launching Telegram Bridge daemon...');
  tgProcess = spawn('python3', [scriptPath], {
    env: { ...process.env, TG_PORT: String(TG_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tgProcess.stdout.on('data', (d) => console.log(`[TgBridge] ${d.toString().trim()}`));
  tgProcess.stderr.on('data', (d) => console.error(`[TgBridge] ${d.toString().trim()}`));

  tgProcess.on('exit', (code) => {
    console.warn(`[TgBridge] Exited with code ${code}, restarting in 5s...`);
    setTimeout(startTelegramBridge, 5000);
  });
}

// Start the madeline_bridge PHP process - real Telegram P2P calling.
// REPLACES the previous Rust/ferogram tgcalls_bridge, which compiled and
// ran but never confirmed an actual ring in real testing. MadelineProto
// has a documented, mature requestCall()/VoIP API (see
// server/madeline_bridge/bridge.php for details on what was verified).
// UNVERIFIED as of this commit - could not test PHP/composer/amphp at all
// locally; expect iteration against Render's real build/runtime logs,
// same as the Rust bridge needed.
let tgCallsProcess = null;
function startTgCallsBridge() {
  const bridgeDir = path.join(__dirname, 'server', 'madeline_bridge');
  const scriptPath = path.join(bridgeDir, 'bridge.php');
  const vendorPath = path.join(bridgeDir, 'vendor', 'autoload.php');
  // Static, self-contained PHP binary downloaded by build.sh (no apt/root
  // needed - Render's build container is non-root with a read-only apt,
  // confirmed from a real build log) - not a global `php` on PATH.
  const phpBinPath = path.join(bridgeDir, 'php-bin', 'bin', 'php');
  if (!fs.existsSync(phpBinPath) || !fs.existsSync(scriptPath) || !fs.existsSync(vendorPath)) {
    console.warn('[Server] madeline_bridge not found or its build did not complete - real Telegram calling unavailable, PyTgCalls-only.');
    return;
  }

  console.log('[Server] Launching madeline_bridge (real Telegram P2P calling via MadelineProto) daemon...');
  tgCallsProcess = spawn(phpBinPath, [scriptPath], {
    env: { ...process.env, TGCALLS_PORT: String(TGCALLS_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tgCallsProcess.stdout.on('data', (d) => console.log(`[TgCallsBridge] ${d.toString().trim()}`));
  tgCallsProcess.stderr.on('data', (d) => console.error(`[TgCallsBridge] ${d.toString().trim()}`));

  tgCallsProcess.on('exit', (code) => {
    // URGENT SAFETY FIX: this used to restart on a flat 5s timer. When
    // MadelineProto's start() auto-triggers its own interactive CLI QR
    // login on every boot (see bridge.php's TODO on this), a crash-loop
    // here means repeatedly hitting Telegram's real login endpoint every
    // ~5 seconds - confirmed live: this actually happened and produced a
    // real, escalating FLOOD_WAIT rate-limit response from Telegram's
    // servers. A tight restart loop against a real external API is
    // active harm, not just wasted resources - exponential backoff with a
    // hard cap, and a full stop after repeated failures, is mandatory
    // here, not optional hardening.
    tgCallsRestartCount = (tgCallsRestartCount || 0) + 1;
    if (tgCallsRestartCount > 5) {
      console.error(`[TgCallsBridge] Exited with code ${code} for the ${tgCallsRestartCount}th time - giving up auto-restart to avoid hammering Telegram's API. Fix the underlying issue and redeploy.`);
      return;
    }
    const backoffMs = Math.min(30000 * tgCallsRestartCount, 300000); // 30s, 60s, ... capped at 5min
    console.warn(`[TgCallsBridge] Exited with code ${code}, restarting in ${backoffMs / 1000}s (attempt ${tgCallsRestartCount}/5)...`);
    setTimeout(startTgCallsBridge, backoffMs);
  });
}
let tgCallsRestartCount = 0;

// Helper to proxy HTTP requests to Telegram bridge
async function proxyToTg(endpoint, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${TG_PORT}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 502, data: { error: `Telegram bridge unavailable: ${err.message}` } };
  }
}

// Helper to proxy HTTP requests to the tgcalls_bridge (real P2P calling)
async function proxyToTgCalls(endpoint, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${TGCALLS_PORT}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 502, data: { error: `Real-calling bridge unavailable: ${err.message}` } };
  }
}

// ---------------------------------------------------------------
// tgcalls_bridge media pipes: the outgoing video/audio frames the
// frontend already sends over the media WebSocket (channel 0x01 = JPEG
// video frame, 0x02 = PCM mic audio - see wss.on('connection') below)
// were previously just received and dropped; nothing ever consumed
// them. For a real Telegram P2P call, tgcalls_bridge's set_media() reads
// outgoing audio/video from two named pipes (see
// server/tgcalls_bridge/src/main.rs's run_call) since P2PCall has no
// live external-frame push API, only file/pipe-backed ingestion via
// ffmpeg. These functions create those pipes and keep write streams
// open into them for the duration of an active Telegram call.
// ---------------------------------------------------------------
const TGCALLS_AUDIO_PIPE = '/tmp/tgcalls_audio.pcm';
const TGCALLS_VIDEO_PIPE = '/tmp/tgcalls_video.mjpeg';
let tgCallsAudioStream = null;
let tgCallsVideoStream = null;

function makeFreshFifo(fifoPath) {
  try { fs.unlinkSync(fifoPath); } catch (e) { /* didn't exist - fine */ }
  execFileSync('mkfifo', [fifoPath]);
}

function openTgCallsPipes() {
  // A FIFO's open() blocks until the other end is also opened - that's
  // expected and harmless here: Node's fs streams don't block the event
  // loop while waiting, they just fire 'open' once tgcalls_bridge's
  // ffmpeg reader attaches (which happens inside set_media(), itself
  // only called after the call actually connects). Frames arriving over
  // the WS before that just get buffered in the stream's internal
  // buffer, which is fine for the short ringing/connecting window.
  try {
    makeFreshFifo(TGCALLS_AUDIO_PIPE);
    makeFreshFifo(TGCALLS_VIDEO_PIPE);
  } catch (e) {
    console.error('[TgCallsPipes] Failed to create FIFOs (mkfifo unavailable?):', e.message);
    return;
  }

  tgCallsAudioStream = fs.createWriteStream(TGCALLS_AUDIO_PIPE);
  tgCallsVideoStream = fs.createWriteStream(TGCALLS_VIDEO_PIPE);
  tgCallsAudioStream.on('error', (e) => console.warn('[TgCallsPipes] audio pipe error:', e.message));
  tgCallsVideoStream.on('error', (e) => console.warn('[TgCallsPipes] video pipe error:', e.message));
  tgCallsAudioStream.on('open', () => console.log('[TgCallsPipes] audio pipe reader attached'));
  tgCallsVideoStream.on('open', () => console.log('[TgCallsPipes] video pipe reader attached'));
  console.log('[TgCallsPipes] Opened audio/video pipes for tgcalls_bridge');
}

function closeTgCallsPipes() {
  if (tgCallsAudioStream) { tgCallsAudioStream.destroy(); tgCallsAudioStream = null; }
  if (tgCallsVideoStream) { tgCallsVideoStream.destroy(); tgCallsVideoStream = null; }
  try { fs.unlinkSync(TGCALLS_AUDIO_PIPE); } catch (e) {}
  try { fs.unlinkSync(TGCALLS_VIDEO_PIPE); } catch (e) {}
}

// ---------------------------------------------------------------
// whatsapp-rust bridge (server/whatsapp_rust_bridge) - a SEPARATE WhatsApp
// backend that places real 1:1 WhatsApp calls via the whatsapp-rust crate.
//
// Process management mirrors startTgCallsBridge(), including its restart
// policy: this process talks to WhatsApp's real servers, so a crash loop is
// a rate-limit risk, not just noise - exponential backoff with a hard cap.
// ---------------------------------------------------------------
const WA_RUST_BIN = path.join(
  __dirname, 'server', 'whatsapp_rust_bridge', 'target', 'release', 'whatsapp_rust_bridge',
);
const WA_RUST_DATA_DIR = path.join(__dirname, 'data', 'wa_rust_session');

let waRustProcess = null;
let waRustRestartCount = 0;

function startWhatsAppRustBridge() {
  if (!fs.existsSync(WA_RUST_BIN)) {
    // Honest degradation, not a fake: without the compiled binary the
    // /whatsapp-rust/* routes answer with a real "bridge unavailable" error
    // and the app keeps using Green API exactly as before.
    console.warn('[Server] whatsapp_rust_bridge binary not found - real whatsapp-rust calling unavailable (Green API WhatsApp calling unaffected). Run server/whatsapp_rust_bridge/build.sh.');
    return;
  }

  console.log('[Server] Launching whatsapp_rust_bridge (real 1:1 WhatsApp calling via whatsapp-rust) daemon...');
  try {
    fs.mkdirSync(WA_RUST_DATA_DIR, { recursive: true });
  } catch (e) {}

  waRustProcess = spawn(WA_RUST_BIN, [], {
    env: {
      ...process.env,
      WA_RUST_PORT: String(WA_RUST_PORT),
      WA_RUST_MEDIA_PORT: String(WA_RUST_MEDIA_PORT),
      WA_RUST_DATA_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  waRustProcess.stdout.on('data', (d) => console.log(`[WaRust] ${d.toString().trim()}`));
  waRustProcess.stderr.on('data', (d) => console.error(`[WaRust] ${d.toString().trim()}`));

  waRustProcess.on('exit', (code) => {
    waRustProcess = null;
    waRustRestartCount += 1;
    if (waRustRestartCount > 5) {
      console.error(`[WaRust] Exited with code ${code} for the ${waRustRestartCount}th time - giving up auto-restart to avoid hammering WhatsApp's servers. Fix the underlying issue and redeploy.`);
      return;
    }
    const backoffMs = Math.min(30000 * waRustRestartCount, 300000);
    console.warn(`[WaRust] Exited with code ${code}, restarting in ${backoffMs / 1000}s (attempt ${waRustRestartCount}/5)...`);
    setTimeout(startWhatsAppRustBridge, backoffMs);
  });
}

// Helper to proxy HTTP requests to the whatsapp-rust bridge.
async function proxyToWaRust(endpoint, method = 'GET', body = null) {
  const url = `http://127.0.0.1:${WA_RUST_PORT}${endpoint}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (err) {
    return {
      status: 502,
      data: { error: `whatsapp-rust bridge unavailable: ${err.message}. Is server/whatsapp_rust_bridge built?` },
    };
  }
}

// ---------------------------------------------------------------
// whatsapp-rust media socket.
//
// The browser already sends the live avatar output to /api/social-call/media
// as tagged frames (0x01 = 480x640 JPEG @ ~15fps, 0x02 = 16kHz mono s16le
// PCM) - see SocialCallMediaAdapter in app.src.js. For a whatsapp-rust call
// those same bytes are relayed here, framed as [u8 channel][u32 BE length]
// [payload], and the bridge turns them into whatsapp-rust's VideoSource
// (H.264 Annex-B via ffmpeg) and AudioSource (960-sample i16 frames).
//
// The return direction uses the same socket with channels 0x03 (peer PCM),
// 0x04 (peer H.264 access unit) and 0x05 (UTF-8 JSON telemetry), which are
// forwarded straight back out to the browser over the existing media
// WebSocket - no new transport, no new UI surface.
// ---------------------------------------------------------------
const WA_RUST_CH = {
  VIDEO_IN: 0x01,
  AUDIO_IN: 0x02,
  AUDIO_OUT: 0x03,
  H264_OUT: 0x04,
  TELEMETRY_OUT: 0x05,
  RVC_AUDIO_OUT: 0x06,
};

let waRustMediaSocket = null;
let waRustMediaBuffer = Buffer.alloc(0);

function waRustFrame(channel, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(channel, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function openWaRustMediaSocket() {
  if (waRustMediaSocket && !waRustMediaSocket.destroyed) return;
  waRustMediaBuffer = Buffer.alloc(0);

  const socket = net.createConnection({ host: '127.0.0.1', port: WA_RUST_MEDIA_PORT });
  waRustMediaSocket = socket;
  socket.on('connect', () => console.log('[WaRustMedia] media socket connected to bridge'));
  socket.on('error', (e) => {
    // Not fatal to the call: the bridge just won't be receiving avatar media
    // until a reconnect. Say so rather than pretending media is flowing.
    console.warn('[WaRustMedia] media socket error:', e.message);
  });
  socket.on('close', () => {
    if (waRustMediaSocket === socket) waRustMediaSocket = null;
  });

  socket.on('data', (chunk) => {
    waRustMediaBuffer = Buffer.concat([waRustMediaBuffer, chunk]);
    // One or more complete [channel][u32 BE len][payload] frames.
    while (waRustMediaBuffer.length >= 5) {
      const channel = waRustMediaBuffer[0];
      const len = waRustMediaBuffer.readUInt32BE(1);
      if (waRustMediaBuffer.length < 5 + len) break;
      const payload = waRustMediaBuffer.subarray(5, 5 + len);
      waRustMediaBuffer = waRustMediaBuffer.subarray(5 + len);

      if (channel === WA_RUST_CH.TELEMETRY_OUT) {
        try {
          broadcastMediaEvent(JSON.parse(payload.toString('utf8')));
        } catch (e) { /* malformed telemetry is not worth killing a call over */ }
      } else {
        // Peer audio / peer H.264: forward the tagged frame verbatim so the
        // browser can play the audio and (with WebCodecs) decode the video.
        broadcastMediaBinary(waRustFrame(channel, payload));
      }
    }
  });
}

function closeWaRustMediaSocket() {
  if (waRustMediaSocket) {
    try { waRustMediaSocket.destroy(); } catch (e) {}
    waRustMediaSocket = null;
  }
  waRustMediaBuffer = Buffer.alloc(0);
}

function waRustMediaSend(channel, payload) {
  if (waRustMediaSocket && !waRustMediaSocket.destroyed && waRustMediaSocket.writable) {
    waRustMediaSocket.write(waRustFrame(channel, payload));
  }
}

// ---------------------------------------------------------------
// Polls the whatsapp-rust bridge's real call state and forwards changes to
// the frontend as the same call_state broadcasts the tgcalls path uses, so
// the existing Active Call UI (status label, ringback, end-on-failure) needs
// no provider-specific handling.
// ---------------------------------------------------------------
let waRustStatePoll = null;

function startWaRustStatePoll() {
  stopWaRustStatePoll();
  let lastState = null;
  waRustStatePoll = setInterval(async () => {
    const r = await proxyToWaRust('/call/state', 'GET');
    const state = r.data?.state;
    if (!state || state === lastState) return;
    lastState = state;

    if (state === 'connected') {
      if (currentActiveCall) currentActiveCall.status = 'connected';
      broadcastMediaEvent({ type: 'call_state', state: 'connected', call: currentActiveCall });
    } else if (state === 'ringing' || state === 'connecting') {
      broadcastMediaEvent({ type: 'call_state', state, call: currentActiveCall });
    } else if (state === 'failed') {
      // The bridge's own reason (relay rejected the allocate, media setup
      // failed, ffmpeg missing, WhatsApp rejected the offer, ...).
      broadcastMediaEvent({ type: 'call_state', state: 'failed', error: r.data?.error, call: currentActiveCall });
      stopWaRustStatePoll();
    } else if (state === 'ended') {
      broadcastMediaEvent({ type: 'call_state', state: 'ended', call: currentActiveCall });
      stopWaRustStatePoll();
    }
  }, 1000);
}

function stopWaRustStatePoll() {
  if (waRustStatePoll) { clearInterval(waRustStatePoll); waRustStatePoll = null; }
}

// Parse request body
function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        resolve({ raw });
      }
    });
  });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // CORS & Preview headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // -------------------------------------------------------------
  // Social Call API endpoints
  // -------------------------------------------------------------
  if (pathname.startsWith('/api/social-call/')) {
    const subpath = pathname.replace('/api/social-call/', '');

    // Overall status of connected accounts
    if (subpath === 'status' && req.method === 'GET') {
      let waStatus;
      try {
        const creds = await requireGreenApiCreds(req);
        waStatus = await greenApi.getStatus(creds);
      } catch (e) {
        waStatus = { connected: false, error: e.message };
      }
      const tgStatus = await proxyToTg('/tg/status', 'GET');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        whatsapp: waStatus,
        telegram: tgStatus.data,
      }));
    }

    // Call history
    if ((subpath === 'history' || subpath === 'recent') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ history: callHistory }));
    }

    // WhatsApp endpoints - every one of these acts on the AUTHENTICATED
    // CALLER's own Green API credentials, never a shared/global instance.
    if (subpath === 'whatsapp/qr' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const creds = await requireGreenApiCreds(req);
        const qrData = await greenApi.getQrCode(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(qrData));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Hands the frontend what it needs to init the Green API calls SDK
    // directly (client-side WebRTC) - see app.src.js. Returns THIS
    // caller's own credentials, resolved the same way as every other
    // whatsapp/* route. The api token is necessarily exposed to the
    // browser here; that's inherent to how Green API's calling SDK is
    // designed to be used, not something avoidable while using their
    // library as documented.
    if (subpath === 'whatsapp/call-config' && req.method === 'GET') {
      try {
        const creds = await requireGreenApiCreds(req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(creds));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (subpath === 'whatsapp/contacts' && req.method === 'GET') {
      try {
        const creds = await requireGreenApiCreds(req);
        const contacts = await greenApi.getContacts(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ contacts }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message, contacts: [] }));
      }
    }

    if (subpath === 'whatsapp/disconnect' && req.method === 'POST') {
      try {
        const creds = await requireGreenApiCreds(req);
        const result = await greenApi.disconnect(creds);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ---------------------------------------------------------------
    // whatsapp-rust backend (SEPARATE from Green API above).
    //
    // No Green API credentials are read anywhere in this block, and no
    // whatsapp-rust session material is returned to the browser: the Rust
    // bridge keeps the WhatsApp identity keys and session in its own local
    // SQLite store and only ever reports connection state, the linked
    // number, a QR payload and a pairing code - the same two artifacts
    // Green API's own /qr route already hands the browser.
    // ---------------------------------------------------------------
    // The Rust bridge reports the raw QR *payload* string (that is what
    // whatsapp-rust's Event::PairingQrCode carries). The browser needs an
    // image, so render it here with the `qrcode` dependency this project
    // already ships - no new dependency, and no third-party QR service.
    if (subpath === 'whatsapp-rust/qr' && (req.method === 'GET' || req.method === 'POST')) {
      try {
        const r = await proxyToWaRust('/status', 'GET');
        if (r.status !== 200) {
          res.writeHead(r.status === 502 ? 503 : r.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(r.data));
        }
        if (r.data?.connected) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ alreadyAuthorized: true }));
        }
        if (!r.data?.qr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: r.data?.error || 'No pairing QR available yet - the bridge is still connecting.' }));
        }
        const dataUrl = await QRCode.toDataURL(r.data.qr, { margin: 2, width: 260 });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ qr: r.data.qr, dataUrl }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    if (subpath.startsWith('whatsapp-rust/')) {
      const waRustPath = subpath.replace('whatsapp-rust/', '');
      let endpoint = null;
      let method = req.method;
      let body = null;

      switch (waRustPath) {
        case 'status': endpoint = '/status'; method = 'GET'; break;
        case 'pair-code': endpoint = '/pair/code'; method = 'POST'; break;
        case 'pair-cancel': endpoint = '/pair/cancel'; method = 'POST'; break;
        case 'logout': endpoint = '/logout'; method = 'POST'; break;
        case 'contacts': endpoint = '/contacts'; break; // GET list / POST add
        case 'lookup': endpoint = '/lookup'; method = 'POST'; break;
        case 'call-state': endpoint = '/call/state'; method = 'GET'; break;
        case 'mute': endpoint = '/call/mute'; method = 'POST'; break;
        case 'hangup': endpoint = '/hangup'; method = 'POST'; break;
        default: endpoint = null;
      }

      if (!endpoint) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `Unknown whatsapp-rust route: ${waRustPath}` }));
      }

      if (method === 'POST') body = await parseBody(req);
      const r = await proxyToWaRust(endpoint, method, body);
      res.writeHead(r.status === 502 ? 503 : r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }

    // ---------------------------------------------------------------
    // Real Telegram P2P calling auth (tgcalls_bridge) - a SEPARATE session
    // from the regular Telegram connection above. That connection (via
    // telegram_bridge.py/Pyrogram) is used for status/contacts and can't
    // place a real ringing call; this one (via ferogram/tgcalls) is used
    // only for actually placing/receiving calls. Two different MTProto
    // client implementations, so unfortunately two separate sign-ins.
    // ---------------------------------------------------------------
    if (subpath === 'telegram/p2p/status' && req.method === 'GET') {
      const r = await proxyToTgCalls('/status', 'GET');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/send_code' && req.method === 'POST') {
      const body = await parseBody(req);
      const r = await proxyToTgCalls('/send_code', 'POST', body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/sign_in' && req.method === 'POST') {
      const body = await parseBody(req);
      const r = await proxyToTgCalls('/sign_in', 'POST', body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/disconnect' && req.method === 'POST') {
      const r = await proxyToTgCalls('/disconnect', 'POST');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }
    if (subpath === 'telegram/p2p/call_state' && req.method === 'GET') {
      const r = await proxyToTgCalls('/call/state', 'GET');
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r.data));
    }


    // Telegram endpoints
    if (subpath === 'telegram/status' && req.method === 'GET') {
      const tgRes = await proxyToTg('/tg/status', 'GET');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if ((subpath === 'telegram/send_code' || subpath === 'telegram/send-code') && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/send_code', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if ((subpath === 'telegram/sign_in' || subpath === 'telegram/sign-in' || subpath === 'telegram/verify-code') && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/sign_in', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/contacts' && req.method === 'GET') {
      const tgRes = await proxyToTg('/tg/contacts', 'GET');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/resolve' && req.method === 'POST') {
      const body = await parseBody(req);
      const tgRes = await proxyToTg('/tg/resolve', 'POST', body);
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    if (subpath === 'telegram/disconnect' && req.method === 'POST') {
      const tgRes = await proxyToTg('/tg/disconnect', 'POST');
      res.writeHead(tgRes.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(tgRes.data));
    }

    // Unified call placing endpoint
    if (subpath === 'call' && req.method === 'POST') {
      const body = await parseBody(req);
      const { platform, target, name, avatarUrl, provider, video, source } = body;
      if (!platform || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing platform or target' }));
      }

      // WhatsApp engine selection. `provider` is honoured ONLY for WhatsApp
      // and defaults to 'greenapi', so an existing caller that sends no
      // provider keeps the exact behaviour it had before this existed.
      // Anything unrecognised is rejected rather than silently re-routed:
      // dialling through a backend the user did not choose is the one thing
      // this selection layer must never do.
      let waProvider = null;
      if (platform === 'whatsapp') {
        waProvider = provider || 'greenapi';
        if (!WHATSAPP_PROVIDERS.includes(waProvider)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: `Unknown WhatsApp provider "${waProvider}" - expected one of ${WHATSAPP_PROVIDERS.join(', ')}` }));
        }
      }

      currentActiveCall = {
        id: 'call_' + Date.now(),
        platform,
        provider: waProvider,
        target,
        name: name || target,
        avatarUrl,
        startedAt: Date.now(),
        status: 'calling',
      };

      try {
        if (platform === 'whatsapp' && waProvider === 'whatsapp-rust') {
          // REAL WhatsApp call, placed server-side by the whatsapp-rust
          // bridge (offer + relay + E2E media), with the live avatar feed
          // injected as the call's VideoSource/AudioSource.
          //
          // Open the media socket BEFORE placing the call so avatar frames
          // are already flowing by the time the call's media plane attaches.
          openWaRustMediaSocket();
          const r = await proxyToWaRust('/call', 'POST', {
            target,
            name: name || target,
            // video defaults on: this backend exists to make real WhatsApp
            // video calls. `video:false` is a deliberate audio-only call.
            video: video !== false,
            source: source || 'lucy',
          });
          if (r.status !== 200 || r.data?.error) {
            // Surface the bridge's real reason - an unauthenticated session,
            // a missing ffmpeg for video, a rejected offer. Never report a
            // call that did not actually go out as started.
            throw new Error(r.data?.error || `whatsapp-rust call failed (HTTP ${r.status})`);
          }
          currentActiveCall.callId = r.data?.callId || null;
          startWaRustStatePoll();
        } else if (platform === 'whatsapp') {
          // No server-side call placement with Green API - the frontend
          // dials directly via the Green API calls SDK (client-side
          // WebRTC). This endpoint just records call state/history for
          // WhatsApp now; it does not itself cause any ringing.
        } else if (platform === 'telegram') {
          // Real P2P ringing via tgcalls_bridge, not PyTgCalls (which can't
          // ring a private contact - see server/telegram_bridge.py's
          // handle_call comments). Requires the account to have signed in
          // separately via the /p2p/* endpoints below - a different session
          // than the regular Telegram connection used for status/contacts.
          const numericTarget = Number(target);
          if (!Number.isFinite(numericTarget)) {
            throw new Error('Real calling needs a numeric Telegram user id as target');
          }
          // Open the media pipes BEFORE placing the call so they're ready
          // the moment tgcalls_bridge's set_media() looks for a reader -
          // opening is non-blocking on this side (see openTgCallsPipes).
          openTgCallsPipes();
          await proxyToTgCalls('/call', 'POST', { target: numericTarget });
          startTgCallsStatePoll();
        }

        broadcastMediaEvent({ type: 'call_state', state: 'calling', call: currentActiveCall });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'call_started', call: currentActiveCall }));
      } catch (err) {
        currentActiveCall = null;
        closeTgCallsPipes();
        stopTgCallsStatePoll();
        closeWaRustMediaSocket();
        stopWaRustStatePoll();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // -------------------------------------------------------------
    // Realtime RVC voice conversion (w-okada/voice-changer).
    // Lucy 2.5 supplies the avatar video only - this converts the live
    // audio that goes out with it. See server/voice_changer.mjs and
    // server/voicechanger/README.md.
    // -------------------------------------------------------------
    if (subpath === 'voice/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(voiceChanger.status()));
    }

    if (subpath === 'voice/models' && req.method === 'GET') {
      try {
        const models = await voiceChanger.listModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models, selectedSlot: VC_CONFIG.modelSlot }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [], selectedSlot: VC_CONFIG.modelSlot, error: e.message }));
      }
    }

    if (subpath === 'voice/select' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        await voiceChanger.selectModel(Number(body.slot));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(voiceChanger.status()));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...voiceChanger.status(), error: e.message }));
      }
    }

    if (subpath === 'voice/settings' && req.method === 'POST') {
      const body = await parseBody(req);
      // Only the handful of knobs that make sense per-deployment; anything
      // else is set through voice-changer's own UI or env vars.
      const allowed = ['tran', 'indexRatio', 'protect', 'f0Detector', 'silentThreshold'];
      const applied = [];
      const errors = [];
      for (const key of allowed) {
        if (body[key] === undefined || body[key] === null || body[key] === '') continue;
        try {
          await voiceChanger.updateSetting(key, body[key]);
          if (key === 'tran') VC_CONFIG.tran = Number(body[key]);
          if (key === 'indexRatio') VC_CONFIG.indexRatio = Number(body[key]);
          if (key === 'protect') VC_CONFIG.protect = Number(body[key]);
          if (key === 'f0Detector') VC_CONFIG.f0Detector = String(body[key]);
          applied.push(key);
        } catch (e) {
          errors.push(`${key}: ${e.message}`);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ...voiceChanger.status(),
        applied,
        error: errors.length ? errors.join('; ') : null,
      }));
    }

    if (subpath === 'voice/start' && req.method === 'POST') {
      const body = await parseBody(req);
      const status = await startVoiceConversion({ platform: body.platform, modelSlot: body.modelSlot });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(status));
    }

    if (subpath === 'voice/stop' && req.method === 'POST') {
      const status = stopVoiceConversion();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(status));
    }

    if (subpath === 'voice/load-model' && req.method === 'POST') {
      // Loads an RVC checkpoint that already exists on this host into a
      // voice-changer model slot (upload -> concat -> load_model).
      const body = await parseBody(req);
      try {
        const result = await voiceChanger.loadModel({
          slot: Number(body.slot ?? 0),
          pthPath: body.pthPath,
          indexPath: body.indexPath,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ...result, status: voiceChanger.status() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // Hangup endpoint
    if (subpath === 'hangup' && req.method === 'POST') {
      if (currentActiveCall) {
        const durationSec = Math.round((Date.now() - currentActiveCall.startedAt) / 1000);
        saveCallHistory({
          ...currentActiveCall,
          duration: `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`,
          endedAt: Date.now(),
        });

        if (currentActiveCall.platform === 'whatsapp' && currentActiveCall.provider === 'whatsapp-rust') {
          // Real hangup: the bridge sends WhatsApp's <terminate> to the peer
          // and aborts its own media task, then we drop the media socket so
          // no avatar frames keep being encoded for a dead call.
          await proxyToWaRust('/hangup', 'POST').catch(() => {});
          closeWaRustMediaSocket();
          stopWaRustStatePoll();
        } else if (currentActiveCall.platform === 'whatsapp') {
          // No server-side hangup call for Green API - the frontend calls
          // gaClient.hangUp() directly (client-side), same as placing the
          // call itself.
        } else if (currentActiveCall.platform === 'telegram') {
          await proxyToTgCalls('/hangup', 'POST').catch(() => {});
          closeTgCallsPipes();
          stopTgCallsStatePoll();
        }

        broadcastMediaEvent({ type: 'call_state', state: 'ended' });
        currentActiveCall = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ended' }));
    }
  }

  // -------------------------------------------------------------
  // Keep-alive ping toggle (test-mode only) - see the comment above the
  // GITHUB_REPO constant for why this drives a GitHub Actions workflow
  // instead of an internal timer.
  // -------------------------------------------------------------
  if (pathname === '/api/keepalive/status' && req.method === 'GET') {
    try {
      const wf = await githubApi(`/actions/workflows/${KEEPALIVE_WORKFLOW_ID}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled: wf.state === 'active' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/keepalive/toggle' && req.method === 'POST') {
    const body = await parseBody(req);
    const enabled = !!body.enabled;
    try {
      await githubApi(`/actions/workflows/${KEEPALIVE_WORKFLOW_ID}/${enabled ? 'enable' : 'disable'}`, 'PUT');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ enabled }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  if (pathname === '/api/keepalive/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  }

  // -------------------------------------------------------------
  // Route to existing /api/*.js handlers
  // -------------------------------------------------------------
  if (pathname.startsWith('/api/')) {
    const routeName = pathname.replace('/api/', '').split('?')[0];
    const handlerFile = path.join(__dirname, 'api', `${routeName}.js`);

    if (fs.existsSync(handlerFile)) {
      try {
        const mod = await import(handlerFile);
        const handler = mod.default || mod;

        // Mock req/res for Vercel-style handlers
        req.query = Object.fromEntries(parsedUrl.searchParams);
        req.body = await parseBody(req);

        let resSent = false;
        const mockRes = {
          status(code) {
            res.statusCode = code;
            return this;
          },
          setHeader(k, v) {
            res.setHeader(k, v);
            return this;
          },
          json(obj) {
            if (resSent) return;
            resSent = true;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(obj));
          },
          send(data) {
            if (resSent) return;
            resSent = true;
            res.end(data);
          },
        };

        return await handler(req, mockRes);
      } catch (err) {
        console.error(`[API Error] ${pathname}:`, err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // -------------------------------------------------------------
  // Serve Static Files
  // -------------------------------------------------------------
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let filePath = path.join(__dirname, reqPath);

  // If path doesn't exist, try index.html (SPA fallback)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// -------------------------------------------------------------
// Realtime RVC voice conversion for Lucy 2.5 calls
// -------------------------------------------------------------
// Lucy 2.5 (decart/lucy-2-5/realtime) is a video-to-video model: it supplies
// the live avatar and no voice. The audio that goes out with that avatar is
// the live audio already paired with the avatar pipeline - the mic track the
// frontend streams up here as channel 0x02 (see SocialCallMediaAdapter in
// app.src.js). When a conversion session is running, that stream is piped
// through w-okada/voice-changer + an RVC model instead of going straight to
// the call, chunk after chunk, for the whole call - no files, no sentences,
// no TTS.
//
// Where the converted audio goes depends only on how each platform carries
// its outgoing media:
//   * Telegram - the call's outgoing audio is server-side: it is written to
//     the same /tmp/tgcalls_audio.pcm FIFO tgcalls_bridge reads from, so the
//     converted voice is the audio track that travels with the Lucy video.
//   * WhatsApp - the call is browser-side WebRTC (Green API calls SDK), so
//     the converted PCM is sent back to the browser as channel 0x06 (see
//     WA_RUST_CH.RVC_AUDIO_OUT) and the frontend makes it the outgoing
//     audio track there. Also applies to the Green API-engine WhatsApp
//     path specifically - the whatsapp-rust engine places calls server-side
//     and does not yet route through this conversion path (its own audio
//     goes straight into AUDIO_IN unconverted).
// Incoming (caller) audio is untouched by all of this.
//
// If the converter is down or misconfigured the original audio is forwarded
// unchanged and the status says so - a call must never go silent, and the UI
// must never claim a voice is being converted when it isn't.
function vcSamplesFrom(payload) {
  // Channel 0x02 carries raw little-endian int16. The payload is a
  // subarray (offset by the 1-byte channel tag) so it is frequently
  // unaligned for a typed-array view - read it sample by sample instead.
  const n = Math.floor(payload.length / 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = payload.readInt16LE(i * 2);
  return out;
}

function vcSamplesToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

// Where outgoing call audio went BEFORE voice conversion existed (kept
// verbatim - this is the fallback path and the non-converted path).
function writeRawCallAudio(payload) {
  if (currentActiveCall?.platform === 'telegram' && tgCallsAudioStream && !tgCallsAudioStream.destroyed) {
    tgCallsAudioStream.write(payload);
  }
}

function broadcastConvertedAudio(samples) {
  if (!samples || !samples.length) return;
  const payload = vcSamplesToBuffer(samples);
  // 0x06 = this call's own outgoing audio after RVC conversion. Uses the
  // same [channel][4-byte BE length][payload] framing as the whatsapp-rust
  // channels (0x03/0x04) below, rather than a bespoke one-byte-tag format,
  // so the browser has exactly one binary frame parser for this socket.
  const tagged = Buffer.alloc(5 + payload.byteLength);
  tagged[0] = WA_RUST_CH.RVC_AUDIO_OUT;
  tagged.writeUInt32BE(payload.byteLength, 1);
  payload.copy(tagged, 5);
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(tagged); } catch (e) {}
    }
  }
}

function handleConvertedAudio(samples) {
  const platform = voiceChanger.session?.platform || currentActiveCall?.platform;
  if (platform === 'telegram') {
    writeRawCallAudio(vcSamplesToBuffer(samples));
    return;
  }
  // WhatsApp: the call's WebRTC audio lives in the browser, so hand the
  // converted audio back for the outgoing track (see app.src.js).
  broadcastConvertedAudio(samples);
}

function broadcastVoiceStatus() {
  broadcastMediaEvent({ type: 'vc_status', ...voiceChanger.status() });
}

async function startVoiceConversion({ platform, modelSlot } = {}) {
  try {
    if (modelSlot !== undefined && modelSlot !== null && Number(modelSlot) !== VC_CONFIG.modelSlot) {
      VC_CONFIG.modelSlot = Number(modelSlot);
      await voiceChanger.selectModel(VC_CONFIG.modelSlot);
    }
    await voiceChanger.startSession({
      platform: platform || currentActiveCall?.platform || null,
      onConverted: handleConvertedAudio,
    });
  } catch (e) {
    // Never let a converter problem break the call: keep the session (it
    // falls back to pass-through) and report the reason.
    voiceChanger.lastError = e.message;
    voiceChanger.mode = 'bypass';
    console.warn('[VoiceChanger] start failed, falling back to pass-through:', e.message);
  }
  broadcastVoiceStatus();
  return voiceChanger.status();
}

function stopVoiceConversion() {
  voiceChanger.stopSession();
  broadcastVoiceStatus();
  return voiceChanger.status();
}

// -------------------------------------------------------------
// WebSocket Server for Lucy 2.5 Outgoing Video / Mic Media Bridge
// -------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/api/social-call/media' });
const mediaClients = new Set();

function broadcastMediaEvent(msg) {
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// Binary counterpart: the whatsapp-rust bridge's return media (peer PCM audio
// on channel 0x03, peer H.264 access units on 0x04) is forwarded to the
// browser as the same tagged binary frames the browser already sends upward,
// so one framing rule covers both directions of the same socket.
function broadcastMediaBinary(buffer) {
  for (const ws of mediaClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buffer);
    }
  }
}

// Forward WhatsApp call events to connected WebSocket clients
// No persistent WhatsApp connection/event emitter to listen to anymore -
// greenapi_bridge.mjs is stateless, per-user, and per-request (see above).
// The frontend's existing wa_status/wa_qr polling already re-fetches
// status on its own timer, which is how the WhatsApp connect screen
// learns about changes now.

wss.on('connection', (ws) => {
  mediaClients.add(ws);
  console.log('[MediaWS] Client connected. Total:', mediaClients.size);

  // Send current active call state if any
  if (currentActiveCall) {
    ws.send(JSON.stringify({ type: 'call_state', state: currentActiveCall.status, call: currentActiveCall }));
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary frame from Lucy 2.5 canvas / video stream or mic PCM
      // First byte can be channel identifier: 0x01 = Lucy video frame, 0x02 = Mic audio
      const channel = data[0];
      const payload = data.subarray(1);

      if (channel === 0x01) {
        // Lucy 2.5 / Avatar outgoing video frame (JPEG blob, ~15fps - see
        // SocialCallMediaAdapter.startStreaming in app.src.js). Previously
        // received and silently dropped here for every call, WhatsApp and
        // Telegram alike - nothing ever consumed these bytes. For a real
        // Telegram P2P call, tgcalls_bridge's set_media() reads outgoing
        // video from TGCALLS_VIDEO_PIPE as a concatenated-JPEG (MJPEG)
        // stream, decoded by ffmpeg on that side.
        if (currentActiveCall?.platform === 'telegram' && tgCallsVideoStream && !tgCallsVideoStream.destroyed) {
          tgCallsVideoStream.write(payload);
        }
        // For a whatsapp-rust call the same live avatar frame becomes the
        // call's VideoSource: the bridge pipes it through ffmpeg into H.264
        // Annex-B access units, because whatsapp-rust transports only
        // pre-encoded video and never touches pixels. Identical bytes and
        // tag, so Lucy 2.5 and Anam both feed it with no provider-specific
        // branch on the avatar side.
        if (currentActiveCall?.provider === 'whatsapp-rust') {
          waRustMediaSend(WA_RUST_CH.VIDEO_IN, payload);
        }
      } else if (channel === 0x02) {
        // Microphone PCM audio chunk - the live audio paired with the Lucy
        // 2.5 avatar pipeline (raw s16le, 16kHz mono - see
        // tgcalls_bridge's AudioDescription: sample_rate 16000, 1 channel).
        if (voiceChanger.session) {
          // Real-time RVC conversion is running: it takes it from here and
          // calls back through handleConvertedAudio() for each converted
          // chunk (bypassing untouched if the converter is unhealthy).
          voiceChanger.push(vcSamplesFrom(payload));
        } else {
          writeRawCallAudio(payload);
        }
        // whatsapp-rust's AudioSource wants 60ms / 960-sample MONO i16 frames,
        // which the bridge assembles out of this stream (the frontend's
        // ScriptProcessor emits 2048-sample chunks, so this cannot be
        // forwarded frame-for-frame).
        if (currentActiveCall?.provider === 'whatsapp-rust') {
          waRustMediaSend(WA_RUST_CH.AUDIO_IN, payload);
        }
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'call_ready') {
          if (currentActiveCall) {
            currentActiveCall.status = 'connected';
            broadcastMediaEvent({ type: 'call_state', state: 'connected', call: currentActiveCall });
          }
        } else if (msg.type === 'vc_start') {
          // Starts real-time conversion of the outgoing Lucy audio for this
          // call. Only ever sent for the Lucy 2.5 source - the app never
          // asks for it on the Anam avatar path.
          startVoiceConversion({ platform: msg.platform, modelSlot: msg.modelSlot });
        } else if (msg.type === 'vc_stop') {
          stopVoiceConversion();
        } else if (msg.type === 'vc_status') {
          ws.send(JSON.stringify({ type: 'vc_status', ...voiceChanger.status() }));
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    mediaClients.delete(ws);
    // Nothing left to convert if the last browser is gone and no call is up.
    // Deliberately delayed: a socket that is merely reconnecting mid-call
    // must not lose the conversion it is using.
    setTimeout(() => {
      if (mediaClients.size === 0 && !currentActiveCall && voiceChanger.session) {
        console.log('[MediaWS] last client gone with no active call - stopping voice conversion');
        voiceChanger.stopSession();
      }
    }, 2000);
  });
});

// Start services
server.listen(PORT, HOST, () => {
  console.log(`Live Call server running at http://${HOST}:${PORT}`);
  startTelegramBridge();
  startTgCallsBridge();
  // No global WhatsApp init needed for GREEN-API anymore - greenapi_bridge.mjs
  // is stateless and per-user (see requireGreenApiCreds above). The
  // whatsapp-rust bridge IS a long-lived process, because a WhatsApp session
  // is a persistent linked device, not a per-request REST call.
  startWhatsAppRustBridge();
  // Opt-in (VOICE_CHANGER_AUTOSTART=1) - see server/voicechanger/setup.sh.
  startVoiceChangerProcess();
});
