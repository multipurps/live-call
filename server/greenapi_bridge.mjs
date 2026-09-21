// greenapi_bridge.mjs
//
// Replaces whatsapp_bridge.mjs (Baileys) for status/contacts/QR pairing.
// Baileys' "Link a Device" pairing never succeeded on this Render
// deployment across two separate projects - the working theory is that
// WhatsApp blocks device-linking attempts from known datacenter/cloud IP
// ranges. Green API sidesteps this because the actual WhatsApp connection
// lives on THEIR infrastructure, not Render's - we only ever talk to their
// REST API.
//
// IMPORTANT: unlike Baileys, Green API has no server-side "place a call"
// REST endpoint. Calling is a browser-side WebRTC SDK
// (@green-api/whatsapp-api-calls-client-js) that connects directly from
// the frontend to Green API's calls infrastructure. This bridge only
// covers status/QR/contacts/disconnect - see app.src.js for the
// client-side calling integration, and the /whatsapp/call-config route in
// server.mjs that hands the frontend what it needs to init that SDK.
//
// No fake fallback data anywhere in this file on purpose, matching the
// honesty fixes already applied elsewhere in this app.

import { EventEmitter } from 'events';

const API_URL = (process.env.GREENAPI_API_URL || '').replace(/\/$/, '');
const ID_INSTANCE = process.env.GREENAPI_ID_INSTANCE || '';
const API_TOKEN = process.env.GREENAPI_API_TOKEN || '';

function configured() {
  return !!(API_URL && ID_INSTANCE && API_TOKEN);
}

async function greenApiGet(path) {
  const url = `${API_URL}/waInstance${ID_INSTANCE}/${path}/${API_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Green API ${path} returned ${res.status}`);
  }
  return data;
}

async function greenApiPost(path, body) {
  const url = `${API_URL}/waInstance${ID_INSTANCE}/${path}/${API_TOKEN}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Green API ${path} returned ${res.status}`);
  }
  return data;
}

class GreenApiBridge extends EventEmitter {
  constructor() {
    super();
    this.lastState = null;
    this.user = null;
    this.lastError = null;
    this.pollTimer = null;
  }

  async init() {
    if (!configured()) {
      this.lastError = 'Green API not configured (GREENAPI_ID_INSTANCE/GREENAPI_API_TOKEN/GREENAPI_API_URL missing)';
      console.warn('[GreenApiBridge] ' + this.lastError);
      return;
    }
    await this._refresh();
    // Poll every 10s so status/contacts reflect reality without the
    // frontend having to hammer this itself - matches the polling pattern
    // already used for tgcalls_bridge's call state.
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._refresh().catch(() => {}), 10000);
  }

  async _refresh() {
    try {
      const state = await greenApiGet('getStateInstance');
      const changed = state.stateInstance !== this.lastState;
      this.lastState = state.stateInstance;
      this.lastError = null;

      if (state.stateInstance === 'authorized' && !this.user) {
        try {
          const settings = await greenApiGet('getWaSettings');
          this.user = { id: settings.wid, name: settings.wid };
        } catch (e) { /* not fatal - status still reports authorized */ }
      }
      if (state.stateInstance !== 'authorized') {
        this.user = null;
      }
      if (changed) {
        this.emit('status', this.getStatusSync());
        if (state.stateInstance === 'authorized') this.emit('connected', this.user);
      }
    } catch (e) {
      this.lastError = e.message;
      this.emit('status', this.getStatusSync());
    }
  }

  getStatusSync() {
    return {
      status: this.lastState || 'unknown',
      connected: this.lastState === 'authorized',
      user: this.user,
      error: this.lastError || null,
    };
  }

  async getStatus() {
    await this._refresh();
    return this.getStatusSync();
  }

  async getQrCode() {
    if (!configured()) throw new Error('Green API not configured');
    const data = await greenApiGet('qr');
    if (data.type === 'alreadyLogged') {
      return { alreadyAuthorized: true };
    }
    // Green API returns the QR as base64 in `message` for type "qrCode".
    return { qr: data.message, dataUrl: `data:image/png;base64,${data.message}` };
  }

  async getContacts() {
    if (!configured()) return [];
    const raw = await greenApiGet('getContacts');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c) => c.id && !c.id.endsWith('@g.us')) // exclude groups
      .map((c) => ({
        id: c.id,
        name: c.name || c.id.split('@')[0],
        phone: c.id.split('@')[0],
        platform: 'whatsapp',
      }));
  }

  async disconnect() {
    if (!configured()) return { status: 'not_configured' };
    await greenApiPost('logout', {});
    this.lastState = 'notAuthorized';
    this.user = null;
    this.emit('status', this.getStatusSync());
    return { status: 'disconnected' };
  }

  // No server-side calling with Green API - see the module comment above.
  // Kept as clear errors rather than silently no-op-ing, so a stale
  // server-side call attempt fails honestly instead of looking like it
  // did something.
  async startCall() {
    throw new Error('WhatsApp calling now happens client-side via the Green API calls SDK - see /api/social-call/whatsapp/call-config');
  }
  async hangup() {
    throw new Error('WhatsApp calling now happens client-side via the Green API calls SDK');
  }
}

export const waBridge = new GreenApiBridge();
export function isGreenApiConfigured() { return configured(); }
