import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFileSync } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import * as greenApi from './server/greenapi_bridge.mjs';
import { getServiceClient, getAuthedUserId } from './lib/supabaseAdmin.js';
import { getProviderKey } from './lib/keys.js';

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
      const { platform, target, name, avatarUrl } = body;
      if (!platform || !target) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing platform or target' }));
      }

      currentActiveCall = {
        id: 'call_' + Date.now(),
        platform,
        target,
        name: name || target,
        avatarUrl,
        startedAt: Date.now(),
        status: 'calling',
      };

      try {
        if (platform === 'whatsapp') {
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
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

        if (currentActiveCall.platform === 'whatsapp') {
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
      } else if (channel === 0x02) {
        // Microphone PCM audio chunk (expected raw s16le, 48kHz stereo -
        // matching tgcalls_bridge's audio_raw-style MediaDescription).
        if (currentActiveCall?.platform === 'telegram' && tgCallsAudioStream && !tgCallsAudioStream.destroyed) {
          tgCallsAudioStream.write(payload);
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
        }
      } catch (e) {}
    }
  });

  ws.on('close', () => {
    mediaClients.delete(ws);
  });
});

// Start services
server.listen(PORT, HOST, () => {
  console.log(`Live Call server running at http://${HOST}:${PORT}`);
  startTelegramBridge();
  startTgCallsBridge();
  // No global WhatsApp init needed anymore - greenapi_bridge.mjs is
  // stateless and per-user (see requireGreenApiCreds above).
});
