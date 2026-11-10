import { requireAuth } from "./_lib.js";

// Miyagi puede pensar con dos cerebros:
//  · GEMINI_API_KEY (gratis, de aistudio.google.com) → Gemini Flash. Si está puesta, se usa esta.
//  · ANTHROPIC_API_KEY (de pago, console.anthropic.com) → Claude.
// La app no nota la diferencia: aquí se traduce todo al formato de Claude.
export const MODEL = "claude-sonnet-5-5";
export const QUICK_MODEL = "claude-haiku-5-5";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
export const GEMINI_QUICK_MODEL = process.env.GEMINI_QUICK_MODEL || "gemini-flash-lite-latest";

// POST /api/ai { messages, tools?, system?, max_tokens?, tier? }
// Las herramientas se ejecutan en el móvil: aquí solo se hace de puente.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const { messages, tools, system, max_tokens, tier } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Sin mensajes." });
  const maxTokens = Math.min(Number(max_tokens) || 4096, 16000);
  try {
    if (process.env.GEMINI_API_KEY) return await gemini(res, { messages, tools, system, maxTokens, tier });
    if (process.env.ANTHROPIC_API_KEY) return await claude(res, { messages, tools, system, maxTokens, tier });
    return res.status(503).json({ error: "Falta GEMINI_API_KEY (gratis) o ANTHROPIC_API_KEY en Vercel.", code: "no_key" });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "No se ha podido contactar con la IA.", code: "unavailable" });
  }
}

/* ---------------- Claude ---------------- */
async function claude(res, { messages, tools, system, maxTokens, tier }) {
  const body = {
    model: tier === "quick" ? QUICK_MODEL : MODEL,
    max_tokens: maxTokens,
    messages: messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map(({ _g, ...b }) => b) } : m)),
    ...(system ? { system } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = data?.error?.message || "Claude no ha respondido.";
    console.error("Anthropic", r.status, msg);
    const code = /credit balance/i.test(msg) ? "no_credit" : r.status === 401 ? "no_key" : r.status === 429 ? "rate_limited" : "unavailable";
    return res.status(r.status === 429 ? 429 : 502).json({ error: msg, code });
  }
  res.status(200).json({ content: data.content, stop_reason: data.stop_reason });
}

/* ---------------- Gemini ---------------- */
// Convierte la conversación de formato Claude a formato Gemini.
export function toGemini(messages) {
  const names = {}; // tool_use_id → nombre de la herramienta
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (const b of blocks) if (b.type === "tool_use") names[b.id] = b.name;
    // Si la respuesta vino de Gemini, se devuelve tal cual (lleva las "firmas" que Gemini exige).
    const raw = blocks.find((b) => Array.isArray(b._g));
    let parts;
    if (role === "model" && raw) parts = raw._g;
    else parts = blocks.map((b) => {
      if (b.type === "text") return b.text ? { text: b.text } : null;
      if (b.type === "image" && b.source?.data) return { inlineData: { mimeType: b.source.media_type || "image/jpeg", data: b.source.data } };
      if (b.type === "tool_use") return { functionCall: { name: b.name, args: b.input || {} } };
      if (b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        return { functionResponse: { name: names[b.tool_use_id] || "herramienta", response: b.is_error ? { error: out } : { result: out } } };
      }
      return null;
    }).filter(Boolean);
    if (!parts.length) parts = [{ text: "…" }];
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  }
  return contents;
}

// Convierte la respuesta de Gemini a formato Claude.
export function fromGemini(data) {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const content = [];
  parts.forEach((p, i) => {
    if (p.thought) return;
    if (p.text) content.push({ type: "text", text: p.text });
    if (p.functionCall) content.push({ type: "tool_use", id: "g" + Date.now().toString(36) + i, name: p.functionCall.name, input: p.functionCall.args || {} });
  });
  if (!content.length) content.push({ type: "text", text: "" });
  content[0]._g = parts;
  const stop_reason = content.some((c) => c.type === "tool_use") ? "tool_use" : cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  return { content, stop_reason };
}

async function gemini(res, { messages, tools, system, maxTokens, tier }) {
  const model = tier === "quick" ? GEMINI_QUICK_MODEL : GEMINI_MODEL;
  const body = {
    contents: toGemini(messages),
    generationConfig: { maxOutputTokens: maxTokens },
    ...(system ? { systemInstruction: { parts: [{ text: typeof system === "string" ? system : JSON.stringify(system) }] } } : {}),
    ...(Array.isArray(tools) && tools.length
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parametersJsonSchema: t.input_schema || { type: "object", properties: {} } })) }] }
      : {}),
  };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || "Gemini no ha respondido.";
    console.error("Gemini", r.status, msg);
    const code = r.status === 429 ? "rate_limited" : (r.status === 401 || r.status === 403 || /API key/i.test(msg)) ? "no_key" : "unavailable";
    return res.status(r.status === 429 ? 429 : 502).json({ error: msg, code });
  }
  if (!data?.candidates?.length) {
    const why = data?.promptFeedback?.blockReason;
    return res.status(502).json({ error: why ? "Gemini no ha querido mirar eso (" + why + ")." : "Gemini no ha respondido.", code: "unavailable" });
  }
  res.status(200).json(fromGemini(data));
}

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4mb" } } };
