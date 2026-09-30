// wacalls.mjs
//
// WaCalls client for the WhatsApp call path of Live Call.
//
// WaCalls (https://github.com/multipurps/WaCalls) is an external Go service
// that pairs a real WhatsApp account and carries REAL 1:1 WhatsApp calls -
// voice and VIDEO - on top of its own VoIP/SRTP stack. This module is the one
// place that knows how to talk to it:
//
//   * control plane  - plain HTTP JSON, authenticated with X-API-Key,
//                      base URL from WACALLS_URL (see CONFIG below). This is
//                      the ONLY place the API key exists: the browser never
//                      receives it (publicStatus() is the shape the frontend
//                      gets, and it is built field by field, never spread).
//   * event stream   - GET /api/events (SSE). Subscribed once, reconnected
//                      with backoff, and normalised into the event vocabulary
//                      the app already understands (see NORMALISED EVENTS).
//   * media plane    - NOT proxied here, on purpose. WaCalls carries call
//                      media over WebRTC data channels between the browser and
//                      the Go server: "pcm" (16 kHz mono s16le, both
//                      directions) and "vp8" (encoded H.264 access units,
//                      both directions, 5-byte header - see
//                      client/src/lib/video-frame.ts in WaCalls). server.mjs
//                      proxies only the SDP offer/answer, so the API key stays
//                      server-side while the media path is browser <-> WaCalls.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------
//   * No local WaCalls process is spawned. It is an external service reached
//     through WACALLS_URL.
//   * No text messaging. Neither the video-capable WaCalls build nor this app
//     has a WhatsApp send-text path today; sendText() returns an explicit
//     unsupported error instead of pretending (see its comment).
//   * No fake state. Every function returns what WaCalls actually answered;
//     an unreachable instance surfaces as an error with the real cause.
//
// Video capability: the video-capable WaCalls build exposes per-call video
// routes (/video/start, /video/stop, /video/accept) and honours {video:true}
// on call start. The older audio-only build has neither. Rather than guess,
// VIDEO_CAPABILITY_PROBE (see probeVideoSupport()) asks the remote and caches
// the answer, and the frontend is told the truth: an audio-only build cannot
// send the avatar as video.

const TIMEOUT_MS = parseInt(process.env.WACALLS_TIMEOUT_MS || '15000', 10);
const SSE_RETRY_MIN_MS = 2000;
const SSE_RETRY_MAX_MS = 30000;

function log(...args) {
  console.log('[WaCalls]', ...args);
}
function warn(...args) {
  console.warn('[WaCalls]', ...args);
}

// ---------------------------------------------------------------------------
// CONFIG - everything is env-driven so the same build can point at any WaCalls
// instance (a hosted deploy, a LAN box, a tunnel):
//
//   WACALLS_URL        base URL of the WaCalls instance, e.g.
//                      https://wacalls.example.com  (no trailing slash needed)
//   WACALLS_API_KEY    value sent as the X-API-Key header. Only required when
//                      the WaCalls instance runs with WACALLS_API_KEY set
//                      (without it, WaCalls' API is open - see its README).
//   WACALLS_SESSION    optional session id to drive. When unset, the module
//                      picks the first PAIRED session on that instance and,
//                      if there is none, creates one and starts pairing.
//   WACALLS_CLIENT_ID  value sent as X-Client-Id (default "live-call"). WaCalls
//                      enforces one active call per client id, and this is the
//                      identity that claims/owns the call it places.
//   WACALLS_TIMEOUT_MS HTTP timeout, default 15000.
// ---------------------------------------------------------------------------
const CONFIG = {
  url: (process.env.WACALLS_URL || '').trim().replace(/\/+$/, ''),
  apiKey: (process.env.WACALLS_API_KEY || '').trim(),
  sessionId: (process.env.WACALLS_SESSION || '').trim() || null,
  clientId: (process.env.WACALLS_CLIENT_ID || 'live-call').trim(),
  timeoutMs: TIMEOUT_MS,
};

export function isConfigured() {
  return !!CONFIG.url;
}

export function configSummary() {
  return {
    url: CONFIG.url || null,
    sessionId: CONFIG.sessionId,
    clientId: CONFIG.clientId,
    // Whether a key is set, never the key itself - this object is log-safe.
    apiKeySet: !!CONFIG.apiKey,
  };
}

function headers(json = false) {
  const h = { 'X-Client-Id': CONFIG.clientId };
  if (json) h['Content-Type'] = 'application/json';
  // Present on every request. Never logged, never returned to the browser.
  if (CONFIG.apiKey) h['X-API-Key'] = CONFIG.apiKey;
  return h;
}

// One HTTP call to WaCalls. Returns { ok, status, data } - never throws for a
// non-2xx response (the caller decides what an error means), throws only for a
// transport failure, so "WaCalls said no" and "WaCalls is unreachable" stay
// distinguishable in the logs and in the UI.
async function apiFetch(path, { method = 'GET', body = null, timeoutMs = CONFIG.timeoutMs } = {}) {
  if (!isConfigured()) {
    const err = new Error('WaCalls is not configured: set WACALLS_URL (and WACALLS_API_KEY if the instance requires one).');
    err.code = 'not_configured';
    throw err;
  }
  const url = `${CONFIG.url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: headers(body !== null),
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 500) }; }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------
let sessionCache = { id: null, resolvedAt: 0 };
const SESSION_CACHE_MS = 30_000;

export async function listSessions() {
  const r = await apiFetch('/api/sessions');
  if (!r.ok) throw new Error(`WaCalls /api/sessions failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  return r.data?.sessions || [];
}

// Resolve the session this app drives. Preference order: the configured
// WACALLS_SESSION, then any paired session, then the first one, and if the
// instance has no sessions at all, create one and start pairing it (the QR
// then shows up through the event stream - see qrPayload()).
export async function resolveSession({ force = false } = {}) {
  if (!force && sessionCache.id && Date.now() - sessionCache.resolvedAt < SESSION_CACHE_MS) {
    return sessionCache.id;
  }
  const sessions = await listSessions();

  if (CONFIG.sessionId) {
    const found = sessions.find((s) => s.id === CONFIG.sessionId);
    if (!found) {
      warn(`WACALLS_SESSION=${CONFIG.sessionId} is not a session on this instance (known: ${sessions.map((s) => s.id).join(', ') || 'none'}). Using the first paired session instead.`);
    } else {
      sessionCache = { id: found.id, resolvedAt: Date.now() };
      return found.id;
    }
  }

  const paired = sessions.find((s) => s.paired);
  if (paired) {
    sessionCache = { id: paired.id, resolvedAt: Date.now() };
    return paired.id;
  }
  if (sessions.length) {
    sessionCache = { id: sessions[0].id, resolvedAt: Date.now() };
    return sessions[0].id;
  }

  // Nothing to drive yet: create the session this app will use. Pairing is
  // started too, so the QR box in Profile is populated without an extra tap.
  const created = await apiFetch('/api/sessions', { method: 'POST', body: { name: 'Live Call' } });
  if (!created.ok || !created.data?.id) {
    throw new Error(`WaCalls could not create a session (HTTP ${created.status}): ${created.data?.error || 'no detail'}`);
  }
  const id = created.data.id;
  sessionCache = { id, resolvedAt: Date.now() };
  log(`created Session ${id} on ${CONFIG.url} - starting pairing`);
  await apiFetch(`/api/sessions/${id}/pair`, { method: 'POST' }).catch((e) => warn('pair request failed:', e.message));
  return id;
}

export async function pairSession() {
  const id = await resolveSession({ force: true });
  const r = await apiFetch(`/api/sessions/${id}/pair`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls pair failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`session ${id}: pairing restarted, waiting for a QR through /api/events`);
  return { sessionId: id };
}

export async function logoutSession() {
  const id = await resolveSession();
  const r = await apiFetch(`/api/sessions/${id}/logout`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls logout failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  clearSessionEvents();
  sessionCache = { id, resolvedAt: 0 };
  log(`session ${id}: logged out`);
  return { sessionId: id };
}

// ---------------------------------------------------------------------------
// Call control
// ---------------------------------------------------------------------------

// Places a real 1:1 WhatsApp call. `video: true` asks for a video call: the
// video-capable build answers with a video call whose outgoing video is
// whatever the browser pushes over the "vp8" data channel (the live avatar).
export async function startCall({ target, video = true, name = null } = {}) {
  const sessionId = await resolveSession();
  // WaCalls takes the number as digits (it builds the WhatsApp JID from it),
  // so a contact saved as "+234 801 234 5678" has to be reduced to
  // 2348012345678 here rather than sent with a leading "+", spaces or dashes.
  const phone = String(target || '').replace(/\D/g, '');
  if (phone.length < 7) throw new Error('WaCalls call needs a phone number (E.164 digits, e.g. 2348012345678).');

  const r = await apiFetch(`/api/sessions/${sessionId}/calls`, {
    method: 'POST',
    body: { phone, video: !!video },
  });
  if (!r.ok || !r.data?.call?.callId) {
    throw new Error(`WaCalls call failed (HTTP ${r.status}): ${r.data?.error || 'no call id returned'}`);
  }
  const callId = r.data.call.callId;
  log(`OUTGOING ${video ? 'video' : 'audio'} call started: callId=${callId} peer=${phone}${name ? ` (${name})` : ''} session=${sessionId}`);
  return { callId, sessionId, peer: phone, video: !!video };
}

export async function answerCall(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}/accept`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls answer failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`INCOMING call answered: callId=${callId}`);
  return { callId, sessionId };
}

export async function rejectCall(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}/reject`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls reject failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`INCOMING call rejected: callId=${callId}`);
  return { callId };
}

export async function endCall(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}`, { method: 'DELETE' });
  // 404 means WaCalls already ended it (the peer hung up first) - that is a
  // success from our side and must not be reported as a failure.
  if (!r.ok && r.status !== 404) {
    throw new Error(`WaCalls hangup failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  }
  log(`call ended: callId=${callId}${r.status === 404 ? ' (already gone on WaCalls)' : ''}`);
  return { callId, status: r.status };
}

export async function getCall(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}`);
  if (!r.ok) throw new Error(`WaCalls call lookup failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  return r.data;
}

export async function listCalls() {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls`);
  if (!r.ok) throw new Error(`WaCalls call list failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  return r.data;
}

// ---------------------------------------------------------------------------
// WebRTC leg (browser <-> WaCalls)
//
// The browser builds the offer; it is relayed through server.mjs so the media
// path is direct but the API key never reaches the page (see server.mjs's
// /api/social-call/wacalls/webrtc route).
// ---------------------------------------------------------------------------
export async function submitOffer(callId, sdpOffer, { renegotiate = false } = {}) {
  const sessionId = await resolveSession();
  const path = renegotiate
    ? `/api/sessions/${sessionId}/calls/${callId}/webrtc/renegotiate`
    : `/api/sessions/${sessionId}/calls/${callId}/webrtc`;
  const r = await apiFetch(path, { method: 'POST', body: { sdp_offer: sdpOffer } });
  if (!r.ok || !r.data?.sdp_answer) {
    throw new Error(`WaCalls ${renegotiate ? 'renegotiate' : 'webrtc'} failed (HTTP ${r.status}): ${r.data?.error || 'no sdp_answer in response'}`);
  }
  log(`${renegotiate ? 'renegotiated' : 'established'} the browser media leg for callId=${callId} (answer ${r.data.sdp_answer.length} bytes)`);
  return r.data.sdp_answer;
}

// Signalling for an audio -> video upgrade on a call that is already up.
export async function videoStart(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}/video/start`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls video/start failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`VIDEO started (outgoing) for callId=${callId}`);
  return r.data;
}

export async function videoStop(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}/video/stop`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls video/stop failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`VIDEO stopped (outgoing) for callId=${callId}`);
  return r.data;
}

// Accepts a video upgrade the PEER asked for (never called automatically).
export async function videoAccept(callId) {
  const sessionId = await resolveSession();
  const r = await apiFetch(`/api/sessions/${sessionId}/calls/${callId}/video/accept`, { method: 'POST' });
  if (!r.ok) throw new Error(`WaCalls video/accept failed (HTTP ${r.status}): ${r.data?.error || 'no detail'}`);
  log(`VIDEO upgrade requested by the peer accepted for callId=${callId}`);
  return r.data;
}

// ---------------------------------------------------------------------------
// Text messaging - explicitly not part of this integration.
//
// WaCalls' API surface (either build) is calls: sessions, pairing, calls,
// video, history. There is no send-message endpoint, and this app has no
// WhatsApp send-text path of its own either. Returning a clear error keeps
// that honest instead of shipping a route that looks like it sends messages
// and silently does nothing.
// ---------------------------------------------------------------------------
export async function sendText() {
  return {
    ok: false,
    unsupported: true,
    error: 'WaCalls exposes no WhatsApp text-messaging endpoint (its API covers sessions, pairing and calls). '
      + 'Sending WhatsApp messages needs a messaging endpoint on the WaCalls side (whatsmeow SendMessage) before this app can route text through it.',
  };
}

// ---------------------------------------------------------------------------
// Video capability
//
// The audio-only WaCalls build and the video-capable one share most routes, so
// "does this instance do video?" is answered by probing a route only the video
// build has: GET /api/sessions/{sid}/calls/{id}. On the video build that is a
// real route and answers 404 {"error":"no such call"} for an unknown id; on the
// audio-only build it does not exist at all and Go's ServeMux answers 405
// (method not allowed) because only POST is registered on that path.
//
// The probe result is cached, and /status reports it, so the UI can say
// "audio-only WaCalls build" before someone waits for video that will never
// arrive. It is also verified per call: after starting a call with
// {video:true}, noteCallMedia() compares the media kind WaCalls reports on its
// own call-status event against what was asked for.
// ---------------------------------------------------------------------------
let videoSupport = { state: 'unknown', checkedAt: 0, detail: null };
const VIDEO_PROBE_TTL_MS = 5 * 60_000;

export function videoSupportState() {
  return { ...videoSupport };
}

export async function probeVideoSupport({ force = false } = {}) {
  if (!force && videoSupport.state !== 'unknown' && Date.now() - videoSupport.checkedAt < VIDEO_PROBE_TTL_MS) {
    return videoSupportState();
  }
  try {
    const sessionId = await resolveSession();
    const r = await apiFetch(`/api/sessions/${sessionId}/calls/probe-no-such-call`);
    if (r.status === 404) {
      videoSupport = { state: 'video', checkedAt: Date.now(), detail: 'per-call video routes present (404 for an unknown call id)' };
    } else if (r.status === 405) {
      videoSupport = { state: 'audio-only', checkedAt: Date.now(), detail: 'this WaCalls build has no per-call video routes (GET /calls/{id} answered 405)' };
    } else if (r.status === 200) {
      videoSupport = { state: 'video', checkedAt: Date.now(), detail: 'per-call lookup answered 200' };
    } else {
      videoSupport = { state: 'unknown', checkedAt: Date.now(), detail: `capability probe answered HTTP ${r.status}` };
    }
  } catch (e) {
    videoSupport = { state: 'unknown', checkedAt: Date.now(), detail: `capability probe failed: ${e.message}` };
  }
  return videoSupportState();
}

// Called with the media kind WaCalls itself reports for a call we placed.
// A video-capable build bumps a video call to "video"; an audio-only build
// keeps reporting "audio" no matter what was asked for - which is exactly the
// silent downgrade this app must not present as a video call.
export function noteCallMedia(callId, media, requestedVideo) {
  if (!requestedVideo || !media) return null;
  if (media === 'video') {
    videoSupport = { state: 'video', checkedAt: Date.now(), detail: 'a video call was accepted as video by this WaCalls instance' };
    return null;
  }
  const detail = `asked for {video:true} but WaCalls reports media="${media}" for callId=${callId} - this instance cannot send avatar video`;
  videoSupport = { state: 'audio-only', checkedAt: Date.now(), detail };
  warn(detail);
  return detail;
}

// ---------------------------------------------------------------------------
// Event stream (SSE)
//
// WaCalls' /api/events carries session state, auth/pairing, the full call
// lifecycle (incoming, accepted, ended, hold, transfer, pickup) and - on the
// video build - call-peer-video for a video upgrade the peer asked for.
//
// Everything is normalised here into a small vocabulary, so server.mjs and the
// frontend never have to know WaCalls' event names:
//
//   kind: 'session'       sessions list / auth state / pairing QR
//   kind: 'incoming'      a real incoming WhatsApp call (audio or video)
//   kind: 'accepted'      the peer (or we) accepted; call is up
//   kind: 'rejected'      rejected / declined
//   kind: 'ended'         ended, with WaCalls' own reason string
//   kind: 'media-ready'   the call is ACTIVE, or our WebRTC leg was negotiated
//   kind: 'media-not-ready'  the media plane is not up (offered / retrying)
//   kind: 'video-request' the peer asked to switch to video
//   kind: 'error'         an error reported by WaCalls
// ---------------------------------------------------------------------------
let sseState = {
  running: false,
  connected: false,
  lastEventAt: 0,
  lastError: null,
  attempts: 0,
  abort: null,
  sessionId: null,
  qr: null,            // raw QR payload last seen (rendered to a PNG by server.mjs)
  sessions: [],        // last session-list seen
  paired: null,        // last known pairing state for our session
  activeCalls: new Map(),
  callMedia: new Map(),// callId -> last media kind WaCalls reported
  recent: [],          // last few normalised events, for the status route
};
const subscribers = new Set();

function pushRecent(evt) {
  sseState.recent.push({ ...evt, at: Date.now() });
  if (sseState.recent.length > 40) sseState.recent.shift();
}

function emit(evt) {
  pushRecent(evt);
  for (const cb of subscribers) {
    try { cb(evt); } catch (e) { warn('event subscriber threw:', e.message); }
  }
}

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function clearSessionEvents() {
  sseState.qr = null;
  sseState.paired = null;
}

export function qrPayload() {
  return sseState.qr;
}

export function streamState() {
  return {
    running: sseState.running,
    connected: sseState.connected,
    lastEventAt: sseState.lastEventAt || null,
    lastError: sseState.lastError,
    recent: sseState.recent.slice(-10),
  };
}

// Maps one raw WaCalls event onto the normalised vocabulary. Pure, so it is
// directly unit-testable in test/wacalls-integration.mjs.
export function normaliseEvent(raw) {
  if (!raw || typeof raw !== 'object' || !raw.type) return null;
  const callId = raw.id || raw.callId || null;
  switch (raw.type) {
    case 'session-list':
      return { kind: 'session', subtype: 'list', sessions: raw.sessions || [] };
    case 'auth-state':
      return { kind: 'session', subtype: 'auth', sessionId: raw.sessionId, state: raw.state, paired: !!raw.paired, qr: raw.qr || null };
    case 'session-qr':
      return { kind: 'session', subtype: 'qr', sessionId: raw.sessionId, qr: raw.qr || null };
    case 'call-list': {
      const calls = raw.calls || [];
      return { kind: 'session', subtype: 'calls', calls };
    }
    case 'incoming':
      return {
        kind: 'incoming', subtype: 'offer', callId, sessionId: raw.sessionId,
        peer: raw.peer || null, media: raw.media || 'audio', direction: 'incoming',
      };
    case 'incoming-claimed':
      return { kind: 'accepted', subtype: 'claimed', callId, sessionId: raw.sessionId, owner: raw.owner || null };
    case 'call-status':
      // WaCalls' own status vocabulary: starting | ringing | connected | held
      // | transferring | ended. "connected" is the moment the media plane is
      // really up, which is what media-ready means here.
      return {
        kind: raw.status === 'connected' ? 'media-ready'
          : raw.status === 'ended' ? 'ended'
          : 'media-not-ready',
        subtype: 'call-status', callId, sessionId: raw.sessionId,
        status: raw.status || null, peer: raw.peer || null, media: raw.media || null,
        owner: raw.owner || null, direction: raw.direction || null,
      };
    case 'call-ended':
      return { kind: 'ended', subtype: 'call-ended', callId, sessionId: raw.sessionId, reason: raw.reason || 'ended' };
    case 'call-held':
      return { kind: 'media-not-ready', subtype: 'held', callId, sessionId: raw.sessionId };
    case 'call-unheld':
      return { kind: 'media-ready', subtype: 'unheld', callId, sessionId: raw.sessionId };
    case 'call-peer-video':
      return { kind: 'video-request', subtype: 'peer-video', callId, sessionId: raw.sessionId, upgrade: !!raw.upgrade };
    case 'call-reaction':
      return { kind: 'session', subtype: 'reaction', callId, text: raw.text || '' };
    case 'call-hand':
      return { kind: 'session', subtype: 'hand', callId, raised: !!raw.raised };
    case 'transfer-started':
      return { kind: 'media-not-ready', subtype: 'transfer-started', callId, sessionId: raw.sessionId };
    case 'transfer-completed':
      return { kind: 'ended', subtype: 'transfer-completed', callId, sessionId: raw.sessionId, reason: 'transferred' };
    case 'transfer-failed':
      return { kind: 'error', subtype: 'transfer-failed', callId, sessionId: raw.sessionId, error: raw.error || 'transfer failed' };
    default:
      return { kind: 'session', subtype: raw.type };
  }
}

function applyEvent(evt) {
  if (!evt) return null;
  sseState.lastEventAt = Date.now();

  if (evt.kind === 'session') {
    if (evt.subtype === 'list') {
      sseState.sessions = evt.sessions;
      const mine = evt.sessions.find((s) => s.id === (CONFIG.sessionId || sseState.sessionId));
      if (mine) sseState.paired = !!mine.paired;
      if (!sessionCache.id && evt.sessions.length) sessionCache = { id: evt.sessions[0].id, resolvedAt: Date.now() };
    } else if (evt.subtype === 'auth') {
      sseState.sessionId = evt.sessionId;
      if (evt.subtype === 'auth' && evt.sessionId === (CONFIG.sessionId || sessionCache.id || evt.sessionId)) {
        sseState.paired = !!evt.paired;
      }
      if (evt.qr) sseState.qr = evt.qr;
      if (evt.paired) { sseState.qr = null; log(`session ${evt.sessionId}: paired and open`); }
    } else if (evt.subtype === 'qr') {
      sseState.sessionId = evt.sessionId;
      sseState.qr = evt.qr;
    }
    return evt;
  }

  if (evt.callId) {
    if (evt.kind === 'ended') {
      sseState.activeCalls.delete(evt.callId);
      log(`call ended by WaCalls: callId=${evt.callId} reason=${evt.reason || 'unknown'}`);
    } else {
      sseState.activeCalls.set(evt.callId, evt);
    }
  }
  if (evt.media && evt.callId) sseState.callMedia.set(evt.callId, evt.media);
  return evt;
}

async function runSseLoop() {
  let backoff = SSE_RETRY_MIN_MS;
  while (sseState.running) {
    sseState.attempts += 1;
    const controller = new AbortController();
    sseState.abort = controller;
    try {
      const res = await fetch(`${CONFIG.url}/api/events?clientId=${encodeURIComponent(CONFIG.clientId)}`, {
        headers: headers(),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`SSE HTTP ${res.status}`);
      sseState.connected = true;
      sseState.lastError = null;
      backoff = SSE_RETRY_MIN_MS;
      log(`event stream connected to ${CONFIG.url}/api/events`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (sseState.running) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        // SSE frames are separated by a blank line; only "data:" is used by
        // WaCalls' broker (see broker.go's writeSSE).
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const evt = applyEvent(normaliseEvent(JSON.parse(payload)));
              if (evt) emit(evt);
            } catch (e) {
              warn('could not parse an event frame:', e.message);
            }
          }
        }
      }
      throw new Error('event stream closed by the remote');
    } catch (e) {
      if (!sseState.running) break;
      sseState.connected = false;
      sseState.lastError = e.name === 'AbortError' ? 'stream aborted' : e.message;
      warn(`event stream lost (${sseState.lastError}) - retrying in ${Math.round(backoff / 1000)}s`);
      emit({ kind: 'error', subtype: 'event-stream', error: sseState.lastError });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, SSE_RETRY_MAX_MS);
    }
  }
  sseState.connected = false;
}

// Starts the event stream if it isn't running. Safe to call repeatedly.
export function startEventStream() {
  if (!isConfigured()) {
    warn('not configured (WACALLS_URL unset) - WhatsApp calls through WaCalls are unavailable; Green API is unaffected');
    return false;
  }
  if (sseState.running) return true;
  sseState.running = true;
  log(`starting event stream against ${CONFIG.url} (session=${CONFIG.sessionId || 'auto'}, clientId=${CONFIG.clientId})`);
  runSseLoop().catch((e) => warn('event stream loop stopped:', e.message));
  return true;
}

export function stopEventStream() {
  sseState.running = false;
  if (sseState.abort) { try { sseState.abort.abort(); } catch (e) {} sseState.abort = null; }
}

// ---------------------------------------------------------------------------
// Status - the shape the frontend and server.mjs use. Built field by field:
// no spread of CONFIG, so the API key cannot leak into a response by accident.
// ---------------------------------------------------------------------------
export async function publicStatus({ probe = false, force = false } = {}) {
  const base = {
    configured: isConfigured(),
    url: CONFIG.url || null,
    clientId: CONFIG.clientId,
    sessionId: null,
    paired: false,
    state: isConfigured() ? 'unknown' : 'not_configured',
    video: videoSupportState(),
    stream: streamState(),
    error: null,
  };
  if (!isConfigured()) {
    base.error = 'WaCalls is not configured on the server: set WACALLS_URL (and WACALLS_API_KEY if your instance requires one).';
    return base;
  }
  try {
    const sessionId = await resolveSession();
    base.sessionId = sessionId;
    const sessions = sseState.sessions.length ? sseState.sessions : await listSessions();
    sseState.sessions = sessions;
    const mine = sessions.find((s) => s.id === sessionId);
    base.paired = !!mine?.paired;
    base.state = mine?.state || (base.paired ? 'open' : 'disconnected');
    base.jid = mine?.jid || null;
    // Phone number, when WaCalls reports it. JID looks like
    // "2348012345678:12@s.whatsapp.net" - the user part is the number.
    base.phone = mine?.jid ? mine.jid.split('@')[0].split(':')[0] : null;
    base.hasQr = !!sseState.qr;
    if (probe) base.video = await probeVideoSupport({ force });
  } catch (e) {
    base.state = 'unreachable';
    base.error = e.code === 'not_configured'
      ? e.message
      : `WaCalls unreachable at ${CONFIG.url}: ${e.message}`;
    warn('status check failed:', e.message);
  }
  return base;
}

export const wacalls = {
  isConfigured,
  configSummary,
  resolveSession,
  listSessions,
  pairSession,
  logoutSession,
  startCall,
  answerCall,
  rejectCall,
  endCall,
  getCall,
  listCalls,
  submitOffer,
  videoStart,
  videoStop,
  videoAccept,
  probeVideoSupport,
  videoSupportState,
  noteCallMedia,
  sendText,
  subscribe,
  startEventStream,
  stopEventStream,
  normaliseEvent,
  publicStatus,
  qrPayload,
  streamState,
  clearSessionEvents,
};
