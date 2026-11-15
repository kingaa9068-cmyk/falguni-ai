// Falguni AI backend — keeps the Gemini API key secret on the server.
// Runs as a Vercel serverless function. Never put the API key in the frontend.

const MODEL = "gemini-3.8-flash"; // gemini-2.5-flash was retired by Google — update this if Google renames the model again
const MAX_TEXT = 8000; // characters per message, keeps requests cheap and fast
const MAX_TURNS = 10; // how much chat history we forward
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8MB after the browser already downsized it

// Best-effort per-IP rate limit. Serverless instances are short-lived and can be
// many at once, so this is a soft limiter, not a hard guarantee — the real backstop
// is Gemini's own free-tier daily quota.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = 15; // ~15 messages per minute per IP
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // guard against unbounded memory growth
  return arr.length > limit;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "server_misconfigured", message: "GEMINI_API_KEY is not set on the server." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  if (rateLimited(ip)) {
    res.status(429).json({ error: "rate_limited", message: "Too many messages. Wait a bit and try again." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const turns = Array.isArray(body && body.turns) ? body.turns : null;
  if (!turns || !turns.length) {
    res.status(400).json({ error: "bad_request", message: "No message turns provided." });
    return;
  }

  const image = body.image; // { mimeType, data } — data is base64, no data: prefix
  if (image) {
    if (typeof image.data !== "string" || typeof image.mimeType !== "string") {
      res.status(400).json({ error: "bad_request", message: "Malformed image." });
      return;
    }
    if (!/^image\/(jpeg|png|webp|gif)$/.test(image.mimeType)) {
      res.status(400).json({ error: "image_rejected", message: "Only JPG, PNG, WebP or GIF photos are supported." });
      return;
    }
    if (image.data.length > MAX_IMAGE_BYTES * 1.4) { // base64 is ~1.37x the raw size
      res.status(400).json({ error: "image_rejected", message: "That photo is too large." });
      return;
    }
  }

  const trimmed = turns.slice(-MAX_TURNS).map((t) => ({
    role: t && t.role === "assistant" ? "assistant" : "user",
    content: String((t && t.content) || "").slice(0, MAX_TEXT),
  }));

  const contents = trimmed.map((t, i) => {
    const parts = [{ text: t.content }];
    if (image && i === trimmed.length - 1 && t.role === "user") {
      parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
    }
    return { role: t.role === "assistant" ? "model" : "user", parts };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 4096, temperature: 0.8 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      const code = upstream.status === 429 ? "rate_limited" : "upstream_error";
      res.status(upstream.status === 429 ? 429 : 502).json({
        error: code,
        message: (data && data.error && data.error.message) || "The AI service did not respond.",
      });
      return;
    }

    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || "").join("")
      : "";

    if (!text) {
      const blocked = candidate && candidate.finishReason === "SAFETY";
      res.status(200).json({ error: blocked ? "refused" : "empty_completion", message: blocked ? "That request was declined." : "No answer came back." });
      return;
    }

    res.status(200).json({ text, truncated: candidate.finishReason === "MAX_TOKENS" });
  } catch (e) {
    res.status(502).json({ error: "upstream_error", message: "Could not reach the AI service." });
  }
};
