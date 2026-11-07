import { requireAuth } from "./_lib.js";

// Modelos de Miyagi. Cámbialos aquí si quieres:
// MODEL para casi todo (fotos, chat, revisiones) y QUICK_MODEL para lo rápido (mensajes, avisos).
export const MODEL = "claude-sonnet-5-5";
export const QUICK_MODEL = "claude-haiku-5-5";

// POST /api/ai { messages, tools?, system?, max_tokens?, tier? }
// Reenvía la conversación a Claude con tu clave (ANTHROPIC_API_KEY).
// Las herramientas se ejecutan en el móvil: aquí solo se hace de puente.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Falta ANTHROPIC_API_KEY en Vercel.", code: "no_key" });
  const { messages, tools, system, max_tokens, tier } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Sin mensajes." });
  const body = {
    model: tier === "quick" ? QUICK_MODEL : MODEL,
    max_tokens: Math.min(Number(max_tokens) || 4096, 16000),
    messages,
    ...(system ? { system } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools } : {}),
  };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
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
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: "No se ha podido contactar con Claude.", code: "unavailable" });
  }
}

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4mb" } } };
