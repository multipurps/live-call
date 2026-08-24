export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages array required' });

  const systemPrompt = `You are the planning assistant for a live AI video-call app, in the style of Mitra.
The user is briefing you on a persona/role they want an AI avatar to play on an upcoming live call
(e.g. "you are my friend Marilyn, keep it casual, mention you missed work because...").
Your job here is NOT to roleplay yet — the live call happens later, in a different system.
Your job is to:
1. Briefly confirm you understood the brief, in your own words, 1-2 sentences, warm and casual — the same
   pattern Mitra uses ("Got it — I'll keep it casual and bring that up naturally, not right away.").
2. If the brief is vague or missing something important (who to be, the goal, the tone), ask ONE short
   clarifying question instead of confirming.
3. Never break into full roleplay dialogue here — this is planning chat, not the call itself.
Keep the reply under 40 words.

Respond with ONLY a JSON object, no other text: {"reply": "...", "title": "..."}
"title" is a short 2-4 word label for this chat — use a name mentioned in the brief if there is one
(e.g. "Marilyn call"), otherwise a short topic label (e.g. "Work excuse call"). Keep the same title across
the conversation once you've set it unless the topic clearly changes.`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_completion_tokens: 600,
        reasoning_effort: 'low',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'chat_reply',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                reply: { type: 'string' },
                title: { type: 'string' },
              },
              required: ['reply', 'title'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    let parsed = { reply: '', title: '' };
    try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}'); } catch (e) {}
    return res.status(200).json({ reply: parsed.reply || '', title: parsed.title || '' });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
