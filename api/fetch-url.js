// api/fetch-url.js — fetch a URL server-side and return either text or a PDF.
// Needed because browsers can't cross-origin fetch most article pages.
// Also converts Google Docs / Drive share links to their export form.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const { url } = req.body || {};
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Send a valid http(s) URL." });
  }

  // Rewrite Google share links to their export endpoints
  let fetchUrl = url;
  const gdoc = url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (gdoc) fetchUrl = `https://docs.google.com/document/d/${gdoc[1]}/export?format=txt`;
  const gsheet = url.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (gsheet) fetchUrl = `https://docs.google.com/spreadsheets/d/${gsheet[1]}/export?format=csv`;
  const gdrive = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (gdrive) fetchUrl = `https://drive.google.com/uc?export=download&id=${gdrive[1]}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  try {
    const r = await fetch(fetchUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; FlashcardsBot/1.0; +https://example.com)",
        "accept": "text/html,application/xhtml+xml,application/pdf,text/plain,*/*"
      }
    });
    clearTimeout(timer);

    if (!r.ok) {
      return res.status(502).json({ error: `The site returned ${r.status}. It may block automated access.` });
    }

    const ct = (r.headers.get("content-type") || "").toLowerCase();

    // ---- PDF ----
    if (ct.includes("application/pdf") || /\.pdf(\?|#|$)/i.test(fetchUrl)) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) {
        return res.status(413).json({ error: "That PDF is over 15 MB. Download it and upload it instead." });
      }
      const rawName = decodeURIComponent((fetchUrl.split("?")[0].split("/").pop() || "document.pdf"));
      return res.status(200).json({
        kind: "pdf",
        data: buf.toString("base64"),
        name: rawName.slice(0, 80)
      });
    }

    // ---- HTML / plain text ----
    const raw = await r.text();
    const title = ((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [null, ""])[1] || "")
      .replace(/\s+/g, " ").trim().slice(0, 120) || "Imported page";

    let body = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");

    // Wikipedia: prefer the article body
    const wp = body.match(/<div[^>]*id=["']mw-content-text["'][^>]*>([\s\S]*?)<div[^>]*class=["'][^"']*printfooter/i);
    if (wp) body = wp[1];

    body = body
      .replace(/<\/(p|div|li|h[1-6]|tr|article|section|blockquote)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (body.length < 200) {
      return res.status(422).json({ error: "Couldn't find much readable text on that page." });
    }

    return res.status(200).json({ kind: "text", text: body.slice(0, 80000), title });
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === "AbortError" ? "The site took too long to respond." : e.message;
    return res.status(502).json({ error: "Could not fetch that URL: " + msg });
  }
};
