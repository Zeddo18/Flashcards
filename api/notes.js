// Serverless function: receives PDF text, asks Google Gemini (free tier)
// for either study notes (Markdown) or flashcards (JSON).
// If Google is busy, it retries and falls back to another model.
// Your API key stays here on the server, never in the browser.
const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"]; // tried in this order
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function askGemini(prompt, generationConfig) {
  const started = Date.now();
  let last = { status: 503, message: "The free AI is busy right now." };
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > 42000) return { ok: false, ...last }; // stay under the 60s limit
      try {
        const r = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig })
          }
        );
        const data = await r.json();
        if (r.ok) {
          const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
          const text = parts.map(p => p.text || "").join("\n").trim();
          if (text) return { ok: true, text };
          last = { status: 502, message: "The AI returned nothing. Try again." };
        } else {
          const msg = (data.error && data.error.message) || "AI request failed.";
          last = { status: r.status, message: msg };
          const busy = r.status === 429 || r.status === 500 || r.status === 503 || /high demand|overloaded|unavailable/i.test(msg);
          if (!busy) return { ok: false, ...last }; // real error (bad key, bad model name): stop
        }
      } catch (e) {
        last = { status: 500, message: "Server error: " + e.message };
      }
      await sleep(2000);
    }
  }
  return { ok: false, ...last };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { text, pages, detail, mode, count } = req.body || {};
  if (typeof text !== "string" || text.trim().length < 50) {
    return res.status(400).json({ error: "No readable text was sent." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
  }

  const doc = "DOCUMENT (" + (Number(pages) || "?") + " pages):\n" + text.slice(0, 80000);
  const isCards = mode === "flashcards";
  const n = Math.min(Math.max(parseInt(count, 10) || 20, 5), 40);
  const level = ["concise", "balanced", "detailed"].includes(detail) ? detail : "balanced";

  const prompt = isCards
    ? "You are a study assistant. Create exactly " + n + " flashcards from the document below.\n" +
      "Rules: each card tests one idea. The front is a short question or a term. The back is a clear, short answer (1-3 sentences). " +
      "Cover the most important facts, definitions, and concepts across the whole document. No duplicates. Use only information from the document.\n" +
      'Return ONLY a JSON array like [{"front":"...","back":"..."}].\n\n' + doc
    : "You are a study assistant. Turn the document text below into clear study notes in Markdown.\n" +
      "Detail level: " + level + ".\n" +
      "Format: start with a # title, use ## for main sections, short bullet points, and **bold** for key terms. " +
      "Add a '## Key Terms' list with short definitions, and end with '## Quick Review Questions' containing 5 numbered questions. " +
      "Use only information from the document. Output only the notes.\n\n" + doc;

  const generationConfig = { maxOutputTokens: isCards ? 8000 : 4000 };
  if (isCards) generationConfig.responseMimeType = "application/json";

  const result = await askGemini(prompt, generationConfig);
  if (!result.ok) {
    const busy = result.status === 429 || result.status === 503 || /high demand|overloaded/i.test(result.message);
    return res.status(busy ? 503 : 502).json({
      error: busy ? "The free AI is very busy right now. Please wait a minute and try again." : result.message
    });
  }

  if (!isCards) return res.status(200).json({ notes: result.text });

  let cards;
  try {
    cards = JSON.parse(result.text.replace(/^```json|```$/g, "").trim());
  } catch {
    return res.status(502).json({ error: "The AI gave a bad format. Please try again." });
  }
  cards = (Array.isArray(cards) ? cards : [])
    .filter(c => c && typeof c.front === "string" && typeof c.back === "string")
    .map(c => ({ front: c.front.trim(), back: c.back.trim() }));
  if (!cards.length) return res.status(502).json({ error: "No flashcards were made. Try again." });
  return res.status(200).json({ cards });
};
