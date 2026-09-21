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
// MULTI-TENANT: every function here takes the caller's OWN Green API
// credentials as an argument - there is no single global instance. Each
// app user brings their own Green API account (their own WhatsApp
// number), stored encrypted per-user via the same Supabase Vault
// mechanism already used for Anam/fal keys (see api/keys.js, lib/keys.js).
// server.mjs resolves the authenticated request's own credentials before
// calling any of these.
//
// IMPORTANT: unlike Baileys, Green API has no server-side "place a call"
// REST endpoint. Calling is a browser-side WebRTC SDK
// (@green-api/whatsapp-api-calls-client-js) that connects directly from
// the frontend to Green API's calls infrastructure, using that same
// user's own credentials - see app.src.js and the /whatsapp/call-config
// route in server.mjs.
//
// No fake fallback data anywhere in this file on purpose, matching the
// honesty fixes already applied elsewhere in this app.

function apiUrlFromInstance(idInstance) {
  const prefix = String(idInstance).slice(0, 4);
  return `https://${prefix}.api.greenapi.com`;
}

// Parses the single "idInstance:apiTokenInstance" string users paste into
// the Green API credentials field (see index.src.html) into the three
// values Green API's REST API actually needs.
export function parseCreds(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx === -1) return null;
  const idInstance = raw.slice(0, idx).trim();
  const apiTokenInstance = raw.slice(idx + 1).trim();
  if (!idInstance || !apiTokenInstance) return null;
  return { idInstance, apiTokenInstance, apiUrl: apiUrlFromInstance(idInstance) };
}

async function greenApiGet(creds, path) {
  const url = `${creds.apiUrl}/waInstance${creds.idInstance}/${path}/${creds.apiTokenInstance}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Green API ${path} returned ${res.status}`);
  }
  return data;
}

async function greenApiPost(creds, path, body) {
  const url = `${creds.apiUrl}/waInstance${creds.idInstance}/${path}/${creds.apiTokenInstance}`;
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

export async function getStatus(creds) {
  const state = await greenApiGet(creds, 'getStateInstance');
  const connected = state.stateInstance === 'authorized';
  let user = null;
  if (connected) {
    try {
      const settings = await greenApiGet(creds, 'getWaSettings');
      user = { id: settings.wid, name: settings.wid };
    } catch (e) { /* not fatal - status still reports authorized */ }
  }
  return { status: state.stateInstance, connected, user, error: null };
}

export async function getQrCode(creds) {
  const data = await greenApiGet(creds, 'qr');
  if (data.type === 'alreadyLogged') return { alreadyAuthorized: true };
  return { qr: data.message, dataUrl: `data:image/png;base64,${data.message}` };
}

export async function getContacts(creds) {
  const raw = await greenApiGet(creds, 'getContacts');
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

export async function disconnect(creds) {
  await greenApiPost(creds, 'logout', {});
  return { status: 'disconnected' };
}
