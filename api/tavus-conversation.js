// Creates a Tavus persona (with the given system prompt) and a conversation, returns conversation_url.
// TAVUS_API_KEY must be set as a Vercel environment variable — never sent to the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.TAVUS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'TAVUS_API_KEY not set on server' });

  const { systemPrompt, replicaId, greeting } = req.body || {};
  if (!systemPrompt) return res.status(400).json({ error: 'systemPrompt is required' });

  try {
    // 1. Create a persona carrying the system prompt (the LLM + voice pipeline live entirely on Tavus's side).
    const personaResp = await fetch('https://tavusapi.com/v2/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        persona_name: 'Live Call Persona',
        pipeline_mode: 'full',
        system_prompt: systemPrompt,
      }),
    });
    const persona = await personaResp.json();
    if (!personaResp.ok) return res.status(personaResp.status).json({ error: persona, stage: 'persona' });

    // 2. Create the conversation. A replica_id is required unless the persona has a default_replica_id set —
    // pass the one from settings (paste from your Tavus dashboard) if the account has no default.
    const convBody = { persona_id: persona.persona_id };
    if (replicaId) convBody.replica_id = replicaId;
    if (greeting) convBody.custom_greeting = greeting;

    const convResp = await fetch('https://tavusapi.com/v2/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(convBody),
    });
    const conversation = await convResp.json();
    if (!convResp.ok) return res.status(convResp.status).json({ error: conversation, stage: 'conversation' });

    return res.status(200).json({ conversation_url: conversation.conversation_url, conversation_id: conversation.conversation_id });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
