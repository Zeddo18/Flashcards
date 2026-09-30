// api/notes.js — serverless function (Vercel / Netlify-style handler)
// Receives PDF text + optional page images, asks Google Gemini for either
// study notes (Markdown) or flashcards (JSON).
// Falls back between models on transient errors, aborts before the platform timeout.
// API key stays on the server via process.env.GEMINI_API_KEY.

const MODELS = ["gemini-flash-lite-latest", "gemini-flash-latest"];
const HARD_LIMIT_MS = 45000;   // stay under a 60s platform cap
const PER_CALL_MS   = 22000;   // abort any single call that drags
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function askGemini(prompt, generationConfig, imgs = []) {
  const started = Date.now();
  let last = { status: 503, message: "The free AI is busy right now." };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = HARD_LIMIT_MS - (Date.now() - started);
      if (left < 3000) return { ok: false, ...last };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(PER_CALL_MS, left));

      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": process.env.GEMINI_API_KEY
            },
            signal: ctrl.signal,
            body: JSON.stringify({
              contents: [{
                parts: [
                  { text: prompt },
                  ...imgs.map(d => ({ inline_data: { mime_type: "image/jpeg", data: d } }))
                ]
              }],
              generationConfig
            })
          }
        );

        const data = await r.json();

        if (r.ok) {
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const text = parts.map(p => p.text || "").join("\n").trim();
          if (text) return { ok: true, text };
          last = { status: 502, message: "The AI returned nothing. Try again." };
        } else {
          const msg = data?.error?.message || "AI request failed.";
          last = { status: r.status, message: msg };

          // Fatal — retrying or switching models won't help
          if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
            return { ok: false, ...last };
          }
          // Anything else (429/500/502/503) is transient — keep trying
        }
      } catch (e) {
        const aborted = e.name === "AbortError";
        last = {
          status: aborted ? 504 : 500,
          message: aborted ? "The AI took too long to respond." : "Server error: " + e.message
        };
      } finally {
        clearTimeout(timer);
      }

      if (Date.now() - started < HARD_LIMIT_MS) await sleep(1500);
    }
  }
  return { ok: false, ...last };
}

/* Pull a JSON array out of whatever Gemini returned, even if it's messy. */
function extractCardArray(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // strip ```json ... ``` fences (anywhere, not just at the ends)
  s = s.replace(/```(?:json)?/gi, "").trim();

  // fast path: whole thing parses
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch {}

  // salvage: first [ ... last ]
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a === -1 || b <= a) return null;

  let slice = s.slice(a, b + 1);
  try {
    const v = JSON.parse(slice);
    if (Array.isArray(v)) return v;
  } catch {
    // drop a trailing incomplete object and close the array
    slice = slice.replace(/,\s*\{[^{}]*$/, "").replace(/,\s*$/, "") + "]";
    try {
      const v = JSON.parse(slice);
      if (Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}

module.exports = async (req, res) => {
  // CORS (harmless if same-origin; useful if you test from another host)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { text, pages, detail, mode, count, images, lang, style } = req.body || {};
  const t = typeof text === "string" ? text : "";
  const imgs = Array.isArray(images)
    ? images.filter(x => typeof x === "string").slice(0, 8)
    : [];

  if (t.trim().length < 50 && !imgs.length) {
    return res.status(400).json({ error: "No readable content was sent." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
  }

  const isCards = mode === "flashcards";
  const n = Math.min(Math.max(parseInt(count, 10) || 20, 5), 40);
  const level = ["concise", "balanced", "detailed"].includes(detail) ? detail : "balanced";

  const doc =
    `DOCUMENT (${Number(pages) || "?"} pages)` +
    (imgs.length
      ? " is attached as page pictures. Read the pictures.\n" + t.slice(0, 80000)
      : ":\n" + t.slice(0, 80000));

  const prompt = isCards
    ? `You are a study assistant. Create exactly ${n} flashcards from the document below.
Rules: each card tests one idea. The front is a short question or a term. The back is a clear, short answer (1–3 sentences). Cover the most important facts, definitions, and concepts across the whole document. No duplicates. Use only information from the document.
Return ONLY a JSON array like [{"front":"...","back":"..."}].

${doc}`
    : `You are a study assistant. Turn the document text below into clear study notes in Markdown.
Detail level: ${level}.
Format: start with a # title, use ## for main sections, short bullet points, and **bold** for key terms. Add a "## Key Terms" list with short definitions, and end with "## Quick Review Questions" containing 5 numbered questions. Use only information from the document. Output only the notes.

${doc}`;

  const styleTxt = {
    cloze: "Card style: each front is a sentence from the document with the key term replaced by ____, and the back is the missing term plus one short explanation.\n",
    tf:    "Card style: each front is a statement that is either true or false, and the back starts with True or False followed by a one-sentence reason. Make about half of the statements false.\n"
  }[style] || "";

  const langLine = (typeof lang === "string" && lang.trim())
    ? `Write everything in ${lang.trim().slice(0, 30)}.\n`
    : "";

  const generationConfig = isCards
    ? { maxOutputTokens: 8192, responseMimeType: "application/json", temperature: 0.6 }
    : { maxOutputTokens: 4096, temperature: 0.4 };

  const result = await askGemini(
    (isCards ? styleTxt : "") + langLine + prompt,
    generationConfig,
    imgs
  );

  if (!result.ok) {
    const busy = result.status === 429 || result.status === 503 ||
                 /high demand|overloaded|too long/i.test(result.message);
    return res.status(busy ? 503 : 502).json({
      error: busy
        ? "The free AI is very busy right now. Please wait a minute and try again."
        : result.message
    });
  }

  if (!isCards) return res.status(200).json({ notes: result.text });

  const raw = extractCardArray(result.text);
  if (!raw) {
    return res.status(502).json({
      error: "The AI gave a bad format. Please try again."
    });
  }

  const cards = raw
    .filter(c => c && typeof c.front === "string" && typeof c.back === "string")
    .map(c => ({ front: c.front.trim(), back: c.back.trim() }))
    .filter(c => c.front && c.back);

  if (!cards.length) {
    return res.status(502).json({ error: "No flashcards were made. Try again." });
  }

  return res.status(200).json({ cards });
};
