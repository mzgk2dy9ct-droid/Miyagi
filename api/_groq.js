// Segundo cerebro gratis: Groq (api.groq.com, formato OpenAI). Entra solo si Gemini falla o está saturado.
// La app habla "formato Claude"; aquí se traduce ida y vuelta.
export const GROQ_MODELS = (process.env.GROQ_MODELS || "openai/gpt-oss-120b,llama-3.3-70b-versatile,openai/gpt-oss-20b").split(",").map((s) => s.trim()).filter(Boolean);
export const GROQ_VISION = (process.env.GROQ_VISION || "meta-llama/llama-4-scout-17b-16e-instruct,meta-llama/llama-4-maverick-17b-128e-instruct").split(",").map((s) => s.trim()).filter(Boolean);

function txt(c) { return typeof c === "string" ? c : (c || []).filter((b) => b.type === "text").map((b) => b.text).join("\n"); }

export function toOpenAI(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: typeof system === "string" ? system : JSON.stringify(system) });
  let vision = false;
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === "assistant") {
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: "assistant", content: txt(blocks) || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // usuario: primero los resultados de herramientas (rol "tool"), luego el texto e imágenes
    for (const b of blocks.filter((b) => b.type === "tool_result")) {
      const c = typeof b.content === "string" ? b.content : txt(b.content) || JSON.stringify(b.content ?? "");
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: c });
    }
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      if (b.type === "image" && b.source?.data) { vision = true; parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type || "image/jpeg"};base64,${b.source.data}` } }); }
    }
    if (parts.length) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
  }
  return { msgs: out, vision };
}

export function fromOpenAI(data) {
  const m = data?.choices?.[0]?.message || {};
  const content = [];
  if (m.content) content.push({ type: "text", text: m.content });
  for (const c of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: c.id || "g" + Math.random().toString(36).slice(2), name: c.function?.name, input });
  }
  return { content, stop_reason: (m.tool_calls || []).length ? "tool_use" : "end_turn" };
}

// Devuelve {status, body} sin escribir la respuesta (así se puede encadenar).
export async function groqCall({ messages, tools, system, maxTokens, key, budgetMs = 40000 }) {
  const { msgs, vision } = toOpenAI(messages, system);
  const chain = vision ? [...GROQ_VISION, ...GROQ_MODELS] : GROQ_MODELS;
  const t0 = Date.now();
  let last = { status: 502, body: { error: "Groq no ha respondido.", code: "unavailable" } };
  for (const model of chain) {
    if (Date.now() - t0 > budgetMs - 5000) break;
    const body = { model, messages: msgs, max_tokens: Math.min(maxTokens || 4096, 8192), temperature: 0.4,
      ...(Array.isArray(tools) && tools.length ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } })), tool_choice: "auto" } : {}) };
    try {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(Math.max(6000, budgetMs - (Date.now() - t0))),
        headers: { Authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return { status: 200, body: { ...fromOpenAI(data), via: "Groq" }, model };
      const msg = data?.error?.message || "Groq " + r.status;
      console.error("Groq", model, r.status, msg);
      if (r.status === 401 || r.status === 403) return { status: 502, body: { error: "La clave de Groq no es válida.", code: "bad_key" } };
      last = { status: r.status === 429 ? 429 : 502, body: { error: r.status === 429 ? "Límite gratuito de Groq alcanzado por ahora." : msg, code: r.status === 429 ? "rate_limited" : "unavailable" } };
    } catch (e) { console.error("Groq", model, "timeout", e && e.name); }
  }
  return last;
}
