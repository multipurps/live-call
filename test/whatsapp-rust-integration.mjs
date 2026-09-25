// Integration harness for the whatsapp-rust wiring in server.mjs.
//
// WHAT THIS DOES AND DOES NOT PROVE
// ---------------------------------
// It exercises the REAL server.mjs code paths that were added for the
// whatsapp-rust backend: the /api/social-call/whatsapp-rust/* proxy routes,
// the QR-rendering route, the provider-selection layer on
// /api/social-call/call, the provider-aware hangup, and the media WebSocket
// <-> Rust-bridge TCP relay (both directions, including the frame framing).
//
// The Rust process itself cannot run in this harness: it is replaced by a
// stand-in that speaks exactly the HTTP + tagged-TCP contract documented in
// server/whatsapp_rust_bridge/src/main.rs and media.rs. That is the same
// boundary server.mjs already uses for tgcalls_bridge, and it is the right
// seam to test here - everything on the Node side of that boundary is real
// code, executed for real. It does NOT prove the Rust crate compiles or that
// WhatsApp rings a phone; see server/whatsapp_rust_bridge/README.md for what
// is and is not verified.
//
// Run:  node test/whatsapp-rust-integration.mjs
// Needs: npm install (ws, qrcode), and a free PORT/WA_RUST_PORT/WA_RUST_MEDIA_PORT.

import http from 'http';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3199);
const WA_RUST_PORT = Number(process.env.WA_RUST_PORT || 5160);
const WA_RUST_MEDIA_PORT = Number(process.env.WA_RUST_MEDIA_PORT || 5161);
const BASE = `http://127.0.0.1:${PORT}`;

// Channel tags - MUST match server.mjs WA_RUST_CH and media.rs CH_*.
const CH = { VIDEO_IN: 0x01, AUDIO_IN: 0x02, AUDIO_OUT: 0x03, H264_OUT: 0x04, TELEMETRY_OUT: 0x05 };

let failures = 0;
let checks = 0;
function check(name, cond, detail = '') {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Stand-in for server/whatsapp_rust_bridge (the Rust process).
// ---------------------------------------------------------------------------
const stub = {
  calls: [],
  hangups: 0,
  mutes: [],
  pairCodes: [],
  contacts: [],
  lookups: [],
  callState: 'idle',
  connected: true,
  mediaSockets: 0,
  mediaFrames: { video: 0, audio: 0, videoBytes: 0, audioBytes: 0 },
  mediaSocket: null,
};

function frame(channel, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(channel, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); } });
  });
}

const stubHttp = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const url = req.url.split('?')[0];
  const key = `${req.method} ${url}`;

  if (key === 'GET /health') return json(res, 200, { ok: true, provider: 'whatsapp-rust' });
  if (key === 'GET /status') {
    return json(res, 200, {
      provider: 'whatsapp-rust',
      status: stub.connected ? 'connected' : 'scan_qr',
      connected: stub.connected,
      user: { jid: '15551234567@s.whatsapp.net', phone: '15551234567', name: 'Test Link' },
      // A real whatsapp-rust QR payload is a comma-joined token string; the
      // shape is all the QR-rendering route cares about.
      qr: '2@abcDEF,tokenTwo,tokenThree',
      pairingCode: null,
      error: null,
      media: { jpegFramesIn: stub.mediaFrames.video },
      call: null,
      callState: stub.callState,
    });
  }
  if (key === 'POST /pair/code') {
    stub.pairCodes.push(body);
    return json(res, 200, { code: 'ABCD1234', expires_at: Math.floor(Date.now() / 1000) + 180 });
  }
  if (key === 'POST /pair/cancel') return json(res, 200, { status: 'cancelled' });
  if (key === 'GET /contacts') return json(res, 200, { contacts: stub.contacts });
  if (key === 'POST /contacts') {
    stub.contacts.push({ phone: body.phone, name: body.name });
    return json(res, 200, { ok: true, phone: body.phone, name: body.name });
  }
  if (key === 'POST /lookup') {
    stub.lookups.push(body);
    return json(res, 200, { exists: true, jid: `${body.phone}@s.whatsapp.net`, phone: body.phone, name: 'Looked Up' });
  }
  if (key === 'GET /call/state') return json(res, 200, { state: stub.callState, callId: 'CALL-STUB', durationSec: 1, video: true });
  if (key === 'POST /call') {
    stub.calls.push(body);
    stub.callState = 'ringing';
    // The real bridge flips to connected when the peer's <accept> arrives;
    // the stand-in does it shortly after so the poller has a transition to see.
    setTimeout(() => { stub.callState = 'connected'; }, 400);
    return json(res, 200, { ok: true, status: 'calling', callId: 'CALL-STUB', video: body.video, source: body.source });
  }
  if (key === 'POST /call/mute') { stub.mutes.push(body); return json(res, 200, { ok: true, muted: body.muted }); }
  if (key === 'POST /hangup') {
    stub.hangups++;
    stub.callState = 'ended';
    return json(res, 200, { ok: true, status: 'ended', peerNotified: true });
  }
  return json(res, 404, { error: `no stub route for ${key}` });
});

const stubTcp = net.createServer((socket) => {
  stub.mediaSockets++;
  stub.mediaSocket = socket;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const channel = buffer[0];
      const len = buffer.readUInt32BE(1);
      if (buffer.length < 5 + len) break;
      const payload = buffer.subarray(5, 5 + len);
      buffer = buffer.subarray(5 + len);
      if (channel === CH.VIDEO_IN) { stub.mediaFrames.video++; stub.mediaFrames.videoBytes += payload.length; }
      if (channel === CH.AUDIO_IN) { stub.mediaFrames.audio++; stub.mediaFrames.audioBytes += payload.length; }
    }
  });
  socket.on('close', () => { if (stub.mediaSocket === socket) stub.mediaSocket = null; });

  // Send the peer's media back out, the way the real bridge does, so the
  // return direction of server.mjs's relay is exercised too.
  setTimeout(() => {
    if (socket.destroyed) return;
    socket.write(frame(CH.AUDIO_OUT, Buffer.from([1, 2, 3, 4])));
    socket.write(frame(CH.H264_OUT, Buffer.from([0, 0, 0, 1, 0x65, 9, 9])));
    socket.write(frame(CH.TELEMETRY_OUT, Buffer.from(JSON.stringify({ type: 'media_stats', stub: true }))));
  }, 150);
});

// ---------------------------------------------------------------------------
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  await new Promise((r) => stubHttp.listen(WA_RUST_PORT, '127.0.0.1', r));
  await new Promise((r) => stubTcp.listen(WA_RUST_MEDIA_PORT, '127.0.0.1', r));
  console.log(`stub whatsapp-rust bridge: http 127.0.0.1:${WA_RUST_PORT}, media 127.0.0.1:${WA_RUST_MEDIA_PORT}`);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      WA_RUST_PORT: String(WA_RUST_PORT),
      WA_RUST_MEDIA_PORT: String(WA_RUST_MEDIA_PORT),
      TG_PORT: '5150',
      TGCALLS_PORT: '5151',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(d.toString()));
  server.stderr.on('data', (d) => serverLog.push(d.toString()));

  // Wait for the HTTP server to accept connections.
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/keepalive/ping`); break; } catch (e) { await wait(250); }
  }

  console.log('\n1. whatsapp-rust routes proxy to the bridge');
  let r = await get(`${BASE}/api/social-call/whatsapp-rust/status`);
  check('GET /whatsapp-rust/status proxies through', r.status === 200 && r.data.provider === 'whatsapp-rust', JSON.stringify(r.data).slice(0, 160));
  check('status reports the linked number', r.data.user?.phone === '15551234567');

  r = await post(`${BASE}/api/social-call/whatsapp-rust/pair-code`, { phone: '15551234567' });
  check('POST /whatsapp-rust/pair-code returns a code', r.data.code === 'ABCD1234', JSON.stringify(r.data));
  check('pair-code forwarded the phone number', stub.pairCodes.at(-1)?.phone === '15551234567');

  // While linked there is no QR to show - the route must say so rather than
  // invent one.
  r = await get(`${BASE}/api/social-call/whatsapp-rust/qr`);
  check('GET /whatsapp-rust/qr says alreadyAuthorized while linked', r.data.alreadyAuthorized === true, JSON.stringify(r.data));
  // Unlinked: the bridge's raw QR payload must be rendered into an image.
  stub.connected = false;
  r = await get(`${BASE}/api/social-call/whatsapp-rust/qr`);
  check('GET /whatsapp-rust/qr renders the bridge QR payload as a PNG data URL',
    typeof r.data.dataUrl === 'string' && r.data.dataUrl.startsWith('data:image/png;base64,'), String(r.data.dataUrl).slice(0, 40));
  check('the raw QR payload is passed through too', typeof r.data.qr === 'string' && r.data.qr.startsWith('2@'));
  stub.connected = true;

  r = await post(`${BASE}/api/social-call/whatsapp-rust/contacts`, { phone: '15550001111', name: 'Ada' });
  check('POST /whatsapp-rust/contacts adds a number', r.data.ok === true);
  r = await get(`${BASE}/api/social-call/whatsapp-rust/contacts`);
  check('GET /whatsapp-rust/contacts lists it back', Array.isArray(r.data.contacts) && r.data.contacts.some((c) => c.phone === '15550001111'));

  r = await post(`${BASE}/api/social-call/whatsapp-rust/lookup`, { phone: '15550002222' });
  check('POST /whatsapp-rust/lookup resolves a number', r.data.exists === true && r.data.name === 'Looked Up');

  r = await get(`${BASE}/api/social-call/whatsapp-rust/bogus`);
  check('unknown whatsapp-rust subroute 404s', r.status === 404, JSON.stringify(r.data));

  console.log('\n2. provider selection on /api/social-call/call');
  const before = stub.calls.length;
  r = await post(`${BASE}/api/social-call/call`, { platform: 'whatsapp', target: '15550003333', name: 'No Provider' });
  check('omitted provider defaults to greenapi (bridge NOT called)', r.status === 200 && stub.calls.length === before, JSON.stringify(r.data));
  await post(`${BASE}/api/social-call/hangup`, {});

  r = await post(`${BASE}/api/social-call/call`, { platform: 'whatsapp', target: '15550003333', provider: 'telegram-ish' });
  check('unknown provider is rejected, not silently re-routed', r.status === 400 && /Unknown WhatsApp provider/.test(r.data.error || ''), JSON.stringify(r.data));

  console.log('\n3. real whatsapp-rust call + live avatar media relay');
  // Open the media WebSocket first, exactly like SocialCallMediaAdapter does.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/social-call/media`);
  ws.binaryType = 'arraybuffer';
  const wsBinary = [];
  const wsJson = [];
  await new Promise((resolve) => ws.on('open', resolve));
  ws.on('message', (data, isBinary) => {
    if (isBinary) wsBinary.push(Buffer.from(data));
    else { try { wsJson.push(JSON.parse(data.toString())); } catch (e) {} }
  });

  r = await post(`${BASE}/api/social-call/call`, {
    platform: 'whatsapp', target: '15550004444', name: 'Rust Contact', provider: 'whatsapp-rust', video: true, source: 'anam',
  });
  check('POST /call with provider=whatsapp-rust is accepted', r.status === 200 && r.data.status === 'call_started', JSON.stringify(r.data));
  check('bridge received the call with video + source', stub.calls.at(-1)?.video === true && stub.calls.at(-1)?.source === 'anam', JSON.stringify(stub.calls.at(-1)));
  check('bridge received the target number', stub.calls.at(-1)?.target === '15550004444');

  await wait(400);
  check('server opened the media socket to the bridge', stub.mediaSockets >= 1 && !!stub.mediaSocket);

  // Send what SocialCallMediaAdapter sends: 0x01 JPEG frames, 0x02 PCM.
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]);
  const fakePcm = Buffer.alloc(4096, 3);
  for (let i = 0; i < 5; i++) {
    ws.send(Buffer.concat([Buffer.from([CH.VIDEO_IN]), fakeJpeg]));
    ws.send(Buffer.concat([Buffer.from([CH.AUDIO_IN]), fakePcm]));
    await wait(30);
  }
  await wait(400);
  check('live avatar JPEG frames reached the bridge (0x01)', stub.mediaFrames.video === 5, `got ${stub.mediaFrames.video}`);
  check('live avatar PCM frames reached the bridge (0x02)', stub.mediaFrames.audio === 5, `got ${stub.mediaFrames.audio}`);
  check('frame payloads were not truncated', stub.mediaFrames.videoBytes === 5 * fakeJpeg.length && stub.mediaFrames.audioBytes === 5 * fakePcm.length,
    `${stub.mediaFrames.videoBytes}/${stub.mediaFrames.audioBytes}`);

  const peerAudio = wsBinary.filter((b) => b[0] === CH.AUDIO_OUT);
  const peerVideo = wsBinary.filter((b) => b[0] === CH.H264_OUT);
  check('peer audio came back over the media WebSocket (0x03)', peerAudio.length >= 1);
  check('peer H.264 came back over the media WebSocket (0x04)', peerVideo.length >= 1);
  check('bridge telemetry arrived as JSON over the same WebSocket', wsJson.some((m) => m.type === 'media_stats' && m.stub === true), JSON.stringify(wsJson.slice(0, 3)));

  // The state poller should have broadcast the stub's ringing -> connected.
  await wait(1500);
  const states = wsJson.filter((m) => m.type === 'call_state').map((m) => m.state);
  check('call_state polling broadcast the real bridge state', states.includes('connected'), `states=${JSON.stringify(states)}`);

  r = await get(`${BASE}/api/social-call/whatsapp-rust/call-state`);
  check('GET /whatsapp-rust/call-state proxies through', r.data.state === 'connected', JSON.stringify(r.data));

  r = await post(`${BASE}/api/social-call/whatsapp-rust/mute`, { muted: true });
  check('mute reaches the bridge', r.data.muted === true && stub.mutes.at(-1)?.muted === true);

  console.log('\n4. hangup');
  const socketsBefore = stub.mediaSockets;
  r = await post(`${BASE}/api/social-call/hangup`, {});
  check('POST /hangup returns ended', r.data.status === 'ended', JSON.stringify(r.data));
  await wait(300);
  check('hangup reached the bridge', stub.hangups === 1);
  check('media socket was closed after hangup', stub.mediaSocket === null);
  check('call is recorded in history', (await get(`${BASE}/api/social-call/history`)).data.history?.length >= 1);
  ws.close();
  void socketsBefore;

  console.log('\n5. GREEN-API path untouched');
  r = await get(`${BASE}/api/social-call/whatsapp/contacts`);
  check('Green API contacts route still resolves Green API credentials (not the rust bridge)',
    // The proof this is still the Green API path: the error comes out of
    // requireGreenApiCreds()/getServiceClient(), i.e. the per-user Green API
    // credential lookup - nothing in the whatsapp-rust bridge is involved.
    r.status === 500 && /Green API credentials|Not signed in|SUPABASE_SERVICE_ROLE_KEY/i.test(r.data.error || ''), JSON.stringify(r.data));
  const rustCallsBefore = stub.calls.length;
  await post(`${BASE}/api/social-call/call`, { platform: 'whatsapp', target: '15550005555', name: 'Green' });
  check('a provider-less WhatsApp call still never touches the rust bridge', stub.calls.length === rustCallsBefore);
  await post(`${BASE}/api/social-call/hangup`, {});
  r = await get(`${BASE}/api/social-call/whatsapp/call-config`);
  check('Green API call-config route is still present', typeof r.data.error === 'string' && /Green API credentials|Not signed in|SUPABASE_SERVICE_ROLE_KEY/i.test(r.data.error), JSON.stringify(r.data));
  r = await post(`${BASE}/api/social-call/whatsapp/disconnect`, {});
  check('Green API disconnect route is still present', typeof r.data.error === 'string');

  check('server logged that the rust binary is absent (honest degradation, no fake)',
    serverLog.join('').includes('whatsapp_rust_bridge binary not found'));

  server.kill('SIGTERM');
  stubHttp.close();
  stubTcp.close();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log('\n--- server log tail ---');
    console.log(serverLog.join('').split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
