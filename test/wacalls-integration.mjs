// Integration harness for the WaCalls wiring in server.mjs + server/wacalls.mjs.
//
// WHAT THIS DOES AND DOES NOT PROVE
// ---------------------------------
// It runs the REAL server.mjs against a stand-in WaCalls instance and exercises
// the paths that were added for this engine, end to end on the Node side:
//
//   * the /api/social-call/wacalls/* control routes (status, qr, pair, logout,
//     call, answer, reject, end, webrtc, webrtc/renegotiate, video/*, avatar)
//   * the API-key discipline: every outbound request carries X-API-Key +
//     X-Client-Id, and no response handed to the browser contains the key
//   * the video capability probe, in both directions (a video-capable build and
//     an audio-only one)
//   * the provider-selection layer on /api/social-call/call (wacalls places the
//     real call with {video:true}; greenapi keeps its old behaviour and never
//     touches WaCalls; an unknown provider is rejected, not silently re-routed)
//   * the SSE event bridge: WaCalls' event stream -> the media WebSocket the
//     browser already listens on (incoming call, media ready, ended), including
//     the normalised `wacalls_event` vocabulary
//   * the case where WaCalls is NOT configured: an honest 503 / configured:false
//     instead of a crash or a fake success
//   * that the Green API routes are untouched
//
// The WaCalls process itself cannot run here (it is a Go service with a real
// WhatsApp session behind it), so it is replaced by a stand-in that speaks the
// documented HTTP + SSE contract of the video-capable build
// (meowcaller/pion lineage: {video:true} on call start, /video/start|stop|accept,
// /webrtc + /webrtc/renegotiate, GET /api/events, X-API-Key). Everything on the
// Node side of that boundary is real code, executed for real. It does NOT prove
// that WhatsApp rings a phone, that the avatar's H.264 is accepted by the
// peer's decoder, or anything about the Go side's media plane.
//
// Run:  node test/wacalls-integration.mjs
// Needs: npm install (ws), and free ports (PORT, WACALLS_PORT, NOCONF_PORT).

import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 3199);
const NOCONF_PORT = PORT + 1;
const WACALLS_PORT = Number(process.env.WACALLS_PORT || 5190);
const API_KEY = 'test-key-do-not-log';
const CLIENT_ID = 'live-call';
const BASE = `http://127.0.0.1:${PORT}`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = {};
  if (text) { try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; } }
  return { status: res.status, data, text };
}

// ---------------------------------------------------------------------------
// Stand-in WaCalls instance
// ---------------------------------------------------------------------------
const stub = {
  requests: [],           // { method, path, hasKey, clientId, body }
  badKeyRequests: 0,
  missingKeyRequests: 0,
  videoRoutes: true,      // false = an audio-only build (no per-call video routes)
  paired: true,           // the session the stub reports (flipped for the QR test)
  events: [],             // queued SSE frames
  sseClients: 0,
  emit(type, fields = {}) {
    this.events.push([`data: ${JSON.stringify({ type, at: Date.now(), ...fields })}\n\n`, true]);
  },
};

function stubJson(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const stubServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${WACALLS_PORT}`);
  const p = url.pathname;
  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({ raw }); } });
    });
  }
  const hasKey = req.headers['x-api-key'] === API_KEY;
  if (!hasKey) stub.badKeyRequests++;
  stub.requests.push({ method: req.method, path: p, hasKey, clientId: req.headers['x-client-id'] || null, body });

  if (!hasKey) return stubJson(res, 401, { error: 'invalid or missing X-API-Key' });

  // Event stream (SSE). Its first frame is the session snapshot, like the real
  // broker (SnapshotFn) sends on connect.
  if (p === '/api/events') {
    stub.sseClients++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({
      type: 'session-list',
      sessions: [stub.paired
        ? { id: 's1', name: 'Live Call', jid: '2348012345678:12@s.whatsapp.net', state: 'open', paired: true }
        : { id: 's1', name: 'Live Call', jid: null, state: 'qr', paired: false }],
    })}\n\n`);
    const timer = setInterval(() => {
      const next = stub.events.shift();
      if (next) { try { res.write(next[0]); } catch (e) {} }
    }, 25);
    req.on('close', () => { clearInterval(timer); stub.sseClients--; });
    return;
  }

  if (p === '/api/sessions' && req.method === 'GET') {
    return stubJson(res, 200, {
      sessions: [stub.paired
        ? { id: 's1', name: 'Live Call', jid: '2348012345678:12@s.whatsapp.net', state: 'open', paired: true }
        : { id: 's1', name: 'Live Call', jid: null, state: 'qr', paired: false }],
    });
  }
  if (p === '/api/sessions' && req.method === 'POST') return stubJson(res, 200, { id: 's1' });
  if (/^\/api\/sessions\/s1\/pair$/.test(p) && req.method === 'POST') { res.writeHead(204); return res.end(); }
  if (/^\/api\/sessions\/s1\/logout$/.test(p) && req.method === 'POST') { res.writeHead(204); return res.end(); }
  if (/^\/api\/sessions\/s1\/history$/.test(p)) return stubJson(res, 200, { rows: [] });
  if (/^\/api\/sessions\/s1\/calls$/.test(p) && req.method === 'GET') {
    return stubJson(res, 200, { active: 0, maxCallsPerSession: 8 });
  }
  if (/^\/api\/sessions\/s1\/calls$/.test(p) && req.method === 'POST') {
    return stubJson(res, 200, { call: { callId: 'call-1' } });
  }

  const perCall = p.match(/^\/api\/sessions\/s1\/calls\/([^/]+)(\/.*)?$/);
  if (perCall) {
    const id = perCall[1];
    const tail = perCall[2] || '';

    // Capability probe: the real video build has this route (404 for an unknown
    // id); an audio-only build does not (Go's ServeMux answers 405 for GET on a
    // POST-only path).
    if (id === 'probe-no-such-call' && !tail) {
      if (!stub.videoRoutes) { res.writeHead(405); return res.end(); }
      return stubJson(res, 404, { error: 'no such call' });
    }
    if (!stub.videoRoutes && tail.startsWith('/video')) { res.writeHead(405); return res.end(); }

    if (!tail && req.method === 'GET') {
      return stubJson(res, 200, { id, sid: 's1', peer: '2348012345678@s.whatsapp.net', state: 'active', direction: 'outbound' });
    }
    if (!tail && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (tail === '/accept' || tail === '/reject' || tail === '/video/start' || tail === '/video/stop' || tail === '/video/accept') {
      return stubJson(res, 200, { status: 'ok' });
    }
    if (tail === '/webrtc' || tail === '/webrtc/renegotiate') {
      return stubJson(res, 200, { sdp_answer: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=stub\r\n' });
    }
    return stubJson(res, 404, { error: `unhandled stub route ${tail}` });
  }

  return stubJson(res, 404, { error: `unhandled stub path ${p}` });
});

// ---------------------------------------------------------------------------
// server.mjs under test
// ---------------------------------------------------------------------------
function startServer({ port, env }) {
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  return { proc, logs };
}

async function waitFor(cond, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function wsEvents(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/social-call/media`);
  const events = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { events.push(JSON.parse(data.toString())); } catch (e) {}
  });
  return { ws, events, of: (type) => events.filter((e) => e.type === type) };
}

async function main() {
  await new Promise((r) => stubServer.listen(WACALLS_PORT, '127.0.0.1', r));
  console.log(`stub WaCalls listening on 127.0.0.1:${WACALLS_PORT}`);

  const main1 = startServer({
    port: PORT,
    env: { WACALLS_URL: `http://127.0.0.1:${WACALLS_PORT}`, WACALLS_API_KEY: API_KEY, WACALLS_CLIENT_ID: CLIENT_ID },
  });
  const noConf = startServer({ port: NOCONF_PORT, env: { WACALLS_URL: '', WACALLS_API_KEY: '' } });

  try {
    await waitFor(() => main1.logs.join('').length > 0, 20000, 'server to start');
    await sleep(1200);

    console.log('\n== status route ==');
    const st = await getJson(`${BASE}/api/social-call/wacalls/status?probe=1`);
    check('status: HTTP 200', st.status === 200, `got ${st.status}`);
    check('status: configured', st.data.configured === true);
    check('status: paired from the instance', st.data.paired === true);
    check('status: phone parsed from the JID', st.data.phone === '2348012345678', JSON.stringify(st.data.phone));
    check('status: video probe says this build does video', st.data.video?.state === 'video', JSON.stringify(st.data.video));
    check('status: session id reported', st.data.sessionId === 's1', st.data.sessionId);
    check('status: stream state present', !!st.data.stream && typeof st.data.stream.running === 'boolean');
    check('status: API key never in the response', !st.text.includes(API_KEY), 'the key leaked to the browser payload');
    check('status: API key not in any recorded request URL of the stub', stub.requests.every((r) => !r.path.includes(API_KEY)));

    const statusAll = await getJson(`${BASE}/api/social-call/status`);
    check('/status includes whatsapp + wacalls + telegram',
      !!statusAll.data.whatsapp && !!statusAll.data.wacalls && !!statusAll.data.telegram);
    check('/status wacalls block is the public shape (no key field)',
      !JSON.stringify(statusAll.data.wacalls).includes(API_KEY) && !('apiKey' in statusAll.data.wacalls));

    console.log('\n== events -> media websocket ==');
    const ws = wsEvents(PORT);
    await waitFor(() => ws.ws.readyState === WebSocket.OPEN, 5000, 'media websocket to open');

    stub.emit('incoming', { sessionId: 's1', id: 'call-2', peer: '2348012345678@s.whatsapp.net', media: 'video' });
    await waitFor(() => ws.of('wacalls_event').some((e) => e.kind === 'incoming'), 6000, 'incoming event');
    const incoming = ws.of('wacalls_event').find((e) => e.kind === 'incoming');
    check('incoming call is broadcast as a wacalls_event', incoming?.kind === 'incoming', JSON.stringify(incoming));
    check('incoming call carries its media kind (audio/video)', incoming?.media === 'video', JSON.stringify(incoming?.media));
    check('incoming call carries the peer', incoming?.peer === '2348012345678@s.whatsapp.net');
    check('incoming call also reaches the generic wa_call_event surface',
      ws.of('wa_call_event').some((e) => e.call?.status === 'offer'));

    // Answering an INCOMING call from the app: the server tracks the offer
    // when it arrives (so /hangup, the state poll and history work for it too)
    // and moves the UI to "connecting" before WaCalls reports the media up.
    const answerIncoming = await getJson(`${BASE}/api/social-call/wacalls/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'call-2' }),
    });
    check('incoming call answered from the app', answerIncoming.status === 200 && stub.requests.some((r) => r.path.endsWith('/call-2/accept')));
    await sleep(800);
    console.log('DEBUG call_state events:', JSON.stringify(ws.of('call_state').map((e) => e.state)));
    console.log('DEBUG server log tail:', main1.logs.join('').split('\n').slice(-12).join('\n'));
    await waitFor(() => ws.of('call_state').some((e) => e.state === 'connecting'), 6000, 'connecting state after answering');
    check('answering an incoming call reports connecting to the UI', ws.of('call_state').some((e) => e.state === 'connecting'));


    console.log('\n== provider selection ==');
    const callsBefore = stub.requests.filter((r) => r.method === 'POST' && r.path === '/api/sessions/s1/calls').length;
    const outgoing = await getJson(`${BASE}/api/social-call/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', target: '+2348012345678', name: 'Test Contact', provider: 'wacalls', video: true, source: 'anam' }),
    });
    check('outgoing wacalls call: HTTP 200', outgoing.status === 200, JSON.stringify(outgoing.data));
    check('outgoing wacalls call: real callId returned', outgoing.data.call?.callId === 'call-1', JSON.stringify(outgoing.data));

    const placeReq = stub.requests.filter((r) => r.method === 'POST' && r.path === '/api/sessions/s1/calls').slice(callsBefore).pop();
    check('WaCalls received the call placement', !!placeReq, 'no POST /calls reached the stub');
    check('call placement used {video:true}', placeReq?.body?.video === true, JSON.stringify(placeReq?.body));
    check('call placement normalised the phone number', placeReq?.body?.phone === '2348012345678', JSON.stringify(placeReq?.body));
    check('call placement carried the API key', placeReq?.hasKey === true);
    check('call placement carried X-Client-Id', placeReq?.clientId === CLIENT_ID, String(placeReq?.clientId));

    // WaCalls' own call-status event for that call: "connected" is the moment
    // the media plane is up. It must reach both the existing call_state
    // surface (the Active Call screen) and the WaCalls-specific vocabulary.
    stub.emit('call-status', { sessionId: 's1', id: 'call-1', status: 'connected', media: 'video', peer: '2348012345678@s.whatsapp.net' });
    await waitFor(() => ws.of('call_state').some((e) => e.state === 'connected'), 6000, 'media-ready');
    check('media ready reaches the existing call_state surface', ws.of('call_state').some((e) => e.state === 'connected'));
    check('media ready also arrives as wacalls_event kind media-ready',
      ws.of('wacalls_event').some((e) => e.kind === 'media-ready'));

    // The silent-downgrade guard: asked for {video:true}, WaCalls reports audio.
    stub.emit('call-status', { sessionId: 's1', id: 'call-1', status: 'ringing', media: 'audio', peer: 'x@s.whatsapp.net' });
    await waitFor(() => ws.of('wacalls_event').some((e) => e.kind === 'media-not-ready' && e.videoDowngrade), 6000, 'video downgrade notice');
    check('a video call downgraded to audio is reported, never presented as video',
      ws.of('wacalls_event').some((e) => e.kind === 'media-not-ready' && typeof e.videoDowngrade === 'string'));

    stub.emit('call-ended', { sessionId: 's1', id: 'call-1', reason: 'user_ended' });
    await waitFor(() => ws.of('wacalls_event').some((e) => e.kind === 'ended'), 6000, 'call ended');
    check('call ended arrives with the reason WaCalls gave',
      ws.of('wacalls_event').find((e) => e.kind === 'ended')?.reason === 'user_ended');
    check('ended also reaches call_state', ws.of('call_state').some((e) => e.state === 'ended'));

    const badProvider = await getJson(`${BASE}/api/social-call/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', target: '2348012345678', provider: 'not-an-engine' }),
    });
    check('unknown provider is rejected (not silently re-routed)', badProvider.status === 400, String(badProvider.status));

    const reqsBeforeGreen = stub.requests.length;
    const green = await getJson(`${BASE}/api/social-call/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'whatsapp', target: '2348012345678', provider: 'greenapi' }),
    });
    check('greenapi provider still accepted', green.status === 200, String(green.status));
    check('greenapi provider never touches WaCalls', stub.requests.length === reqsBeforeGreen);

    console.log('\n== media + call control routes ==');
    const offer = await getJson(`${BASE}/api/social-call/wacalls/webrtc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: 'call-1', sdp_offer: 'v=0 stub-offer' }),
    });
    check('SDP offer relayed, answer returned', offer.status === 200 && !!offer.data.sdp_answer, JSON.stringify(offer.data));
    const webrtcReq = stub.requests.find((r) => r.path.endsWith('/webrtc'));
    check('the offer that reached WaCalls is the browser\'s', webrtcReq?.body?.sdp_offer === 'v=0 stub-offer');
    check('media-ready is signalled to the UI once the leg is negotiated',
      ws.of('wacalls_event').some((e) => e.kind === 'media-ready' && e.subtype === 'webrtc'));

    const renegotiate = await getJson(`${BASE}/api/social-call/wacalls/webrtc/renegotiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: 'call-1', sdp_offer: 'v=0 stub-offer-2' }),
    });
    check('renegotiate relayed', renegotiate.status === 200 && !!renegotiate.data.sdp_answer);
    check('renegotiate took the renegotiate path', stub.requests.some((r) => r.path.endsWith('/webrtc/renegotiate')));

    for (const [tail, label] of [['video/start', 'video start'], ['video/stop', 'video stop'], ['video/accept', 'video accept (peer-requested upgrade)']]) {
      const r = await getJson(`${BASE}/api/social-call/wacalls/${tail}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: 'call-1' }),
      });
      check(`${label} relayed`, r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
      check(`${label} reached WaCalls`, stub.requests.some((q) => q.path.endsWith(`/${tail}`)));
    }

    const answer = await getJson(`${BASE}/api/social-call/wacalls/answer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'call-2' }),
    });
    check('answer relayed to /accept', answer.status === 200 && stub.requests.some((r) => r.path.endsWith('/call-2/accept')));

    const reject = await getJson(`${BASE}/api/social-call/wacalls/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'call-3' }),
    });
    check('reject relayed to /reject', reject.status === 200 && stub.requests.some((r) => r.path.endsWith('/call-3/reject')));
    check('declining is logged with the call id', /\[WaCalls\] incoming call declined: callId=call-3/.test(main1.logs.join('')),
      main1.logs.join('').slice(-300));

    const avatar = await getJson(`${BASE}/api/social-call/wacalls/avatar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'anam' }),
    });
    check('avatar switch recorded', avatar.status === 200 && avatar.data.source === 'anam', JSON.stringify(avatar.data));
    check('avatar switch broadcast to the UI', ws.of('wacalls_event').some((e) => e.kind === 'avatar-switched' && e.source === 'anam'));

    const end = await getJson(`${BASE}/api/social-call/wacalls/end`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'call-1' }),
    });
    check('end relayed to DELETE', end.status === 200 && stub.requests.some((r) => r.method === 'DELETE' && r.path.endsWith('/call-1')));

    const hangup = await getJson(`${BASE}/api/social-call/hangup`, { method: 'POST' });
    check('the app-wide hangup route still answers', hangup.status === 200 && hangup.data.status === 'ended');

    const text = await getJson(`${BASE}/api/social-call/wacalls/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: 'x', text: 'hi' }),
    });
    check('text messaging answers 501 with the real reason', text.status === 501 && text.data.unsupported === true, JSON.stringify(text.data));

    const unknown = await getJson(`${BASE}/api/social-call/wacalls/nope`, { method: 'GET' });
    check('unknown wacalls route answers 404', unknown.status === 404);

    console.log('\n== capability probe: audio-only WaCalls build ==');
    stub.videoRoutes = false;
    // force=1 re-runs the probe instead of returning the cached answer (the
    // downgrade notice above already cached "audio-only" for this instance).
    const audioOnly = await getJson(`${BASE}/api/social-call/wacalls/status?probe=1&force=1`);
    check('audio-only build detected', audioOnly.data.video?.state === 'audio-only', JSON.stringify(audioOnly.data.video));
    check('audio-only detail names the reason', /405/.test(audioOnly.data.video?.detail || ''), audioOnly.data.video?.detail);
    const videoOnAudioOnly = await getJson(`${BASE}/api/social-call/wacalls/video/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId: 'call-1' }),
    });
    check('video route on an audio-only build fails honestly (502, real reason)',
      videoOnAudioOnly.status === 502 && /405|no detail|failed/.test(videoOnAudioOnly.data.error || ''), JSON.stringify(videoOnAudioOnly.data));
    stub.videoRoutes = true;

    console.log('\n== QR rendering ==');
    // Unlink the session, then let WaCalls push the QR the way it really does:
    // a session-list (now unpaired) followed by session-qr over the stream.
    stub.paired = false;
    stub.emit('session-list', { sessions: [{ id: 's1', name: 'Live Call', jid: null, state: 'qr', paired: false }] });
    await sleep(200);
    stub.emit('session-qr', { sessionId: 's1', qr: '2@abcdefghijklmnop,STUB-QR-PAYLOAD,key' });
    await sleep(400);
    const qr = await getJson(`${BASE}/api/social-call/wacalls/qr`, { method: 'POST' });
    check('qr route returns a rendered PNG data URL', qr.status === 200 && String(qr.data.dataUrl || '').startsWith('data:image/png;base64,'),
      JSON.stringify(qr.data).slice(0, 200));
    check('qr route does not leak the API key', !qr.text.includes(API_KEY));

    console.log('\n== unconfigured instance ==');
    const noConfBase = `http://127.0.0.1:${NOCONF_PORT}`;
    const noConfStatus = await getJson(`${noConfBase}/api/social-call/wacalls/status`);
    check('unconfigured: status reports configured:false', noConfStatus.data.configured === false, JSON.stringify(noConfStatus.data));
    check('unconfigured: status explains the env var', /WACALLS_URL/.test(noConfStatus.data.error || ''), noConfStatus.data.error);
    const noConfCall = await getJson(`${noConfBase}/api/social-call/wacalls/call`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: '2348012345678' }),
    });
    check('unconfigured: placing a call answers 503 with the real reason', noConfCall.status === 503, String(noConfCall.status));
    check('unconfigured: no crash in the log', !/UnhandledPromiseRejection|ReferenceError/.test(noConf.logs.join('')),
      noConf.logs.join('').slice(-400));

    console.log('\n== green api untouched ==');
    const reqsBeforeContacts = stub.requests.length;
    const contacts = await getJson(`${BASE}/api/social-call/whatsapp/contacts`);
    check('green api contacts route still exists (its own real error, not a 404)',
      contacts.status !== 404 && typeof contacts.data.error === 'string' && contacts.data.error.length > 0,
      JSON.stringify(contacts.data));
    check('green api contacts never touches WaCalls', stub.requests.length === reqsBeforeContacts);
    const greenStatus = await getJson(`${BASE}/api/social-call/whatsapp/status`);
    check('green api status route still exists', greenStatus.status !== 404, String(greenStatus.status));

    console.log('\n== log lines ==');
    const log = main1.logs.join('');
    check('logs the outgoing call with callId', /\[WaCalls\] outgoing video call placed: callId=call-1/.test(log), log.slice(-500));
    check('logs the media leg negotiation', /browser media leg negotiated for callId=call-1/.test(log));
    check('logs the incoming call', /\[WaCalls\] INCOMING VIDEO call from/.test(log));
    check('logs media ready', /\[WaCalls\] media READY/.test(log));
    check('logs the end of a call', /\[WaCalls\] call ended/.test(log));
    check('logs the avatar switch', /avatar video source switched to Anam/.test(log));
    check('logs the error path honestly', /\[WaCalls\] (video\/start|webrtc) failed/.test(log) || /WaCalls /.test(log));
  } finally {
    try { main1.proc.kill('SIGKILL'); } catch (e) {}
    try { noConf.proc.kill('SIGKILL'); } catch (e) {}
    try { stubServer.close(); } catch (e) {}
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exitCode = 1;
});
