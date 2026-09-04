import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// POST {} -> a short-lived Decart client token (ek_...), scoped to lucy-2.5,
// minted server-side against https://api.decart.ai/v1/client/tokens using the
// caller's OWN Decart key (never a shared server key). Per Decart's docs
// (docs.platform.decart.ai/getting-started/authentication): browser/mobile
// apps must use these short-lived client tokens, never the permanent
// dct_... key directly - that key never leaves this endpoint.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const decartKey = await getProviderKey(supabase, userId, 'decart');
  if (!decartKey) return res.status(400).json({ error: 'Add your Decart API key in Profile > API first' });

  try {
    const resp = await fetch('https://api.decart.ai/v1/client/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': decartKey },
      body: JSON.stringify({ expiresIn: 120, allowedModels: ['lucy-2.5'] }),
    });
    const raw = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* not JSON - raw handled below */ }

    // Defensive about the exact response shape, same lesson learned the hard
    // way with Fal's /tokens/realtime: docs show `{ apiKey, expiresAt }`, but
    // handle a bare string or a differently-named field too rather than
    // assuming the shape and silently misreading a real success as a failure.
    let token = null;
    if (typeof parsed === 'string') {
      token = parsed;
    } else if (parsed && typeof parsed === 'object') {
      token = parsed.apiKey || parsed.token || parsed.clientToken || null;
    } else if (resp.ok && parsed === null && raw) {
      token = raw;
    }
    const data = (parsed && typeof parsed === 'object') ? parsed : null;

    if (!resp.ok || !token) {
      // Masked key fingerprint (never the key itself) so a failure can be
      // cross-checked against the exact key saved in Profile > API without
      // ever putting the plaintext key in a log or response.
      const keyFingerprint = decartKey.length > 8
        ? `${decartKey.slice(0, 4)}…${decartKey.slice(-4)} (${decartKey.length} chars)`
        : `(${decartKey.length} chars)`;
      const detail = (data && (data.error || data.message || data.detail)) || raw || 'no response body';
      const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
      console.error(`[decart-realtime-token] ${resp.status} from Decart. key=${keyFingerprint} detail=${detailStr}`);
      // A 2xx with no usable token is still an error on our end and must
      // never be forwarded as 2xx, or the browser's `!r.ok` check misses it
      // and hands the error body to the SDK as if it were a real token.
      const statusToSend = resp.ok ? 502 : (resp.status || 500);
      return res.status(statusToSend).json({
        error: `Decart returned ${resp.status}: ${detailStr}`,
        keyFingerprint,
      });
    }
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(token);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
