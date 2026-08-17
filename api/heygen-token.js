import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';
import { getProviderKey } from '../lib/keys.js';

// Starts a LiveAvatar (HeyGen's real-time avatar product - a separate platform from
// the old HeyGen Interactive Avatar API, with its own key from app.liveavatar.com/developers)
// session for the signed-in user's own avatar and system prompt.
//
// The API key is looked up server-side from the signed-in user's own encrypted Vault
// secret - never trusted from a client-sent header, never a shared Vercel environment
// variable. This means every user burns their own LiveAvatar credits, never the app owner's.
//
// Flow: create a short-lived Context from the caller's system prompt -> mint a FULL-mode
// session token against the chosen avatar + that context -> start the session to get the
// LiveKit room the client connects to.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const apiKey = await getProviderKey(supabase, userId, 'heygen');
  if (!apiKey) return res.status(400).json({ error: 'No LiveAvatar API key set. Add yours in Profile settings.' });

  const { avatarId, systemPrompt } = req.body || {};
  if (!avatarId) return res.status(400).json({ error: 'avatarId is required' });

  const headers = { 'Content-Type': 'application/json', 'X-API-KEY': apiKey };

  try {
    // 1. Create a Context from the caller's brief so the avatar knows what to do.
    const contextResp = await fetch('https://api.liveavatar.com/v1/contexts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `live-call-${Date.now()}`,
        prompt: systemPrompt || 'You are a helpful, friendly assistant on a live video call.',
        opening_text: "Hi! I'm here - what can I help with?",
      }),
    });
    const contextRaw = await contextResp.text();
    let contextData;
    try { contextData = JSON.parse(contextRaw); }
    catch {
      return res.status(502).json({
        error: `LiveAvatar returned a non-JSON response (status ${contextResp.status}) creating the context. This usually means your LiveAvatar API key is invalid. Raw response: ${contextRaw.slice(0, 200)}`
      });
    }
    if (!contextResp.ok) return res.status(contextResp.status).json({ error: contextData, stage: 'context' });
    const contextId = contextData.data?.id;

    // 2. Mint a FULL-mode session token for this avatar + context.
    const tokenResp = await fetch('https://api.liveavatar.com/v1/sessions/token', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'FULL',
        avatar_id: avatarId,
        is_sandbox: false,
        video_settings: { quality: 'high', encoding: 'H264' },
        interactivity_type: 'CONVERSATIONAL',
        avatar_persona: { context_id: contextId, language: 'en' },
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok) return res.status(tokenResp.status).json({ error: tokenData, stage: 'token' });
    const sessionToken = tokenData.data?.session_token;

    // 3. Start the session to get the LiveKit room the client connects to.
    const startResp = await fetch('https://api.liveavatar.com/v1/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({}),
    });
    const startData = await startResp.json();
    if (!startResp.ok) return res.status(startResp.status).json({ error: startData, stage: 'start' });

    return res.status(200).json({
      sessionId: startData.data?.session_id,
      livekitUrl: startData.data?.livekit_url,
      livekitToken: startData.data?.livekit_client_token,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
