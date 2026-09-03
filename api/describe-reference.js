import { getServiceClient, getAuthedUserId } from '../lib/supabaseAdmin.js';

// POST {imageUrl} -> {description}. Used to auto-fill the Live Swap prompt
// per Decart's documented pattern (docs.platform.decart.ai/models/realtime/lucy-2.5):
// resemblance is weak unless the prompt literally describes what's in the
// reference photo. This has to be STRICT - describe only what's visible,
// never invent hair/clothing/marks that aren't there - since an embellished
// description is exactly what makes the swap drift from the actual photo.
// Uses Groq (server-side GROQ_API_KEY, same as chat-respond.js) so no new
// provider key or setup is needed. qwen/qwen3.6-27b is Groq's current
// vision-capable model as of this writing (Llama 4 Scout/Maverick are both
// deprecated) - check console.groq.com/docs/deprecations if this starts failing.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not set on server' });

  const supabase = getServiceClient();
  const userId = await getAuthedUserId(req, supabase);
  if (!userId) return res.status(401).json({ error: 'Not signed in' });

  const { imageUrl } = req.body || {};
  if (!imageUrl || typeof imageUrl !== 'string') return res.status(400).json({ error: 'Missing imageUrl' });

  const systemPrompt = `You describe a reference photo for an AI video character-swap tool. Your description gets pasted directly into the instruction "Substitute the character in the video with <your description>."

STRICT RULES - precision matters more than detail:
- Describe ONLY what is clearly, visibly present in the photo: hairstyle and hair color exactly as shown, skin tone, visible clothing (type, color, pattern), and any distinctive visible features (glasses, jewelry, facial hair).
- NEVER invent, assume, or add anything not clearly visible - no tattoos, accessories, or clothing details that aren't actually in the photo. If you're not sure about a detail, leave it out rather than guess.
- Do not describe the background or setting, only the person/character.
- Output ONLY the description clause itself (lowercase start, no leading "a photo of" or "the image shows"), 1-2 sentences, in this exact style:
"a young person wearing a short-sleeved pink top with white ribbon ties on the back, loose pink pants, and short brown hair tied in a side ponytail."`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: 'Describe this reference photo per the rules.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ] },
        ],
        temperature: 0.2,
        max_completion_tokens: 200,
      }),
    });
    const data = await r.json().catch(() => ({}));
    const description = data?.choices?.[0]?.message?.content?.trim();
    if (!r.ok || !description) {
      return res.status(r.status || 500).json({ error: data.error?.message || 'Description request failed' });
    }
    return res.status(200).json({ description });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
