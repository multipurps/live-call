import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// POST {app} -> a short-lived Fal realtime token (plain text body, not JSON -
// the fal client's tokenProvider calls response.text() on whatever this
// returns). Mirrors the pattern documented at
// fal.ai/docs/documentation/model-apis/inference/real-time: the token is
// minted server-side against https://rest.fal.ai/tokens/realtime using the
// caller's OWN Fal key (never a shared server key), scoped to the one app
// they're connecting to and expiring quickly.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const { app } = req.body || {};
  if (!app || typeof app !== 'string') return res.status(400).json({ error: 'Missing app' });

  const falKey = await getProviderKey(supabase, userId, 'fal');
  if (!falKey) return res.status(400).json({ error: 'Add your Fal API key in Profile > API first' });

  try {
    const resp = await fetch('https://rest.fal.ai/tokens/realtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Key ${falKey}` },
      body: JSON.stringify({ allowed_apps: [app], duration: 120 }),
    });
    const raw = await resp.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) { /* not JSON - raw is shown below */ }

    if (!resp.ok || !data.token) {
      // Masked key fingerprint (never the key itself) so a 401 can be
      // cross-checked against the exact key saved in Profile > API without
      // ever putting the plaintext key in a log or response.
      const keyFingerprint = falKey.length > 8
        ? `${falKey.slice(0, 4)}…${falKey.slice(-4)} (${falKey.length} chars)`
        : `(${falKey.length} chars)`;
      const detail = data.error || data.message || data.detail || raw || 'no response body';
      console.error(`[fal-realtime-token] ${resp.status} from Fal. key=${keyFingerprint} detail=${detail}`);
      return res.status(resp.status || 500).json({
        error: `Fal returned ${resp.status}: ${detail}`,
        keyFingerprint,
      });
    }
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(data.token);
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
