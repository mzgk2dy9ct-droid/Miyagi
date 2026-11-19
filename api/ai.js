import { requireAuth, getDoc, supabaseReady } from "./_lib.js";
import { groqCall } from "./_groq.js";

// Miyagi puede pensar con dos cerebros:
//  · GEMINI_API_KEY (gratis, de aistudio.google.com) → Gemini Flash. Si está puesta, se usa esta.
//  · ANTHROPIC_API_KEY (de pago, console.anthropic.com) → Claude.
// La app no nota la diferencia: aquí se traduce todo al formato de Claude.
export const MODEL = "claude-sonnet-5-5";
export const QUICK_MODEL = "claude-haiku-5-5";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
export const GEMINI_QUICK_MODEL = process.env.GEMINI_QUICK_MODEL || "gemini-flash-lite-latest";

const KEY_CACHE = { key: null, t: 0 }, GROQ_CACHE = { key: null, t: 0 };

// POST /api/ai { messages, tools?, system?, max_tokens?, tier? }
// Las herramientas se ejecutan en el móvil: aquí solo se hace de puente.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  const { messages, tools, system, max_tokens, tier, stream } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Sin mensajes." });
  const maxTokens = Math.min(Number(max_tokens) || 4096, 16000);
  try {
    // La clave de Gemini puede estar en Supabase (fila _config/gemini) o en Vercel. Manda la de Supabase.
    let gkey = null, src = "Supabase", why = "";
    try {
      if (!supabaseReady()) why = "faltan SUPABASE_URL o SUPABASE_SECRET_KEY";
      else if (KEY_CACHE.key && Date.now() - KEY_CACHE.t < 300000) gkey = KEY_CACHE.key;
      else { const d = await getDoc("_config", "gemini"); if (d && d.key) Object.assign(KEY_CACHE, { key: d.key, t: Date.now() }); gkey = d && d.key ? d.key : null; if (!gkey) why = "no hay fila _config/gemini en " + String(process.env.SUPABASE_URL).replace(/^https?:\/\//, "").split(".")[0]; }
    } catch (e) { why = String(e.message || e).slice(0, 160); console.error("config", e); }
    if (!gkey && process.env.GEMINI_API_KEY) { gkey = process.env.GEMINI_API_KEY; src = "Vercel (Supabase: " + why + ")"; }
    // Limpia lo que se cuela al copiar y pegar: espacios, saltos de línea, comillas.
    if (gkey) gkey = String(gkey).replace(/[\s'"`\u200B-\u200D\uFEFF]/g, "");
    // Segundo cerebro (Groq, gratis): fila _config/groq o GROQ_API_KEY. Entra si Gemini está saturado o sin cuota.
    let qkey = process.env.GROQ_API_KEY || null;
    if (!qkey && supabaseReady()) {
      if (GROQ_CACHE.key && Date.now() - GROQ_CACHE.t < 300000) qkey = GROQ_CACHE.key;
      else try { const d = await getDoc("_config", "groq"); qkey = d && d.key ? d.key : null; if (qkey) Object.assign(GROQ_CACHE, { key: qkey, t: Date.now() }); } catch (e) { console.error("config groq", e); }
    }
    if (qkey) qkey = String(qkey).replace(/[\s'"`\u200B-\u200D\uFEFF]/g, "");
    const viaGroq = async (budgetMs) => { const g = await groqCall({ messages, tools, system, maxTokens, key: qkey, budgetMs });
      if (stream && g.status === 200) { res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" }); const t = (g.body.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""); if (t) res.write(JSON.stringify({ d: t }) + "\n"); return res.end(JSON.stringify({ done: g.body }) + "\n"); }
      return res.status(g.status).json(g.body); };
    if (gkey) {
      const cap = { code: 200, body: null, headersSent: false, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      if (stream) {
        // En directo: si Gemini empieza a escribir, sigue él; si falla antes de empezar, contesta Groq.
        const fail = await geminiStream(res, { messages, tools, system, maxTokens, tier, key: gkey, src, budgetMs: qkey ? 20000 : 38000, onFail: qkey ? (st, b) => ({ st, b }) : null });
        if (!fail || !("st" in fail)) return;
        const transient = fail.st === 429 || fail.st >= 500;
        if (qkey && transient) return await viaGroq(30000);
        return res.status(fail.st).json(fail.b);
      }
      await gemini(cap, { messages, tools, system, maxTokens, tier, key: gkey, src, budgetMs: qkey ? 20000 : 45000 });
      const transient = cap.code === 429 || cap.code >= 500 || ["unavailable", "rate_limited"].includes(cap.body?.code);
      if (cap.code === 200 || !qkey || !transient) return res.status(cap.code).json(cap.body);
    }
    if (qkey) return await viaGroq(gkey ? 35000 : 50000);
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
  res.status(200).json({ content: data.content, stop_reason: data.stop_reason, via: "Claude" });
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

/* ---------- Gemini en directo: el texto llega a trozos, como en ChatGPT ----------
   Responde líneas JSON: {"d":"trozo"} … y al final {"done":{content,stop_reason}} o {"error","code"}.
   Si un modelo no empieza a hablar en 12 s, o está saturado, se pasa al siguiente sin que se note. */
function geminiBody({ messages, tools, system, maxTokens }) {
  return {
    contents: toGemini(messages),
    generationConfig: { maxOutputTokens: maxTokens },
    ...(system ? { systemInstruction: { parts: [{ text: typeof system === "string" ? system : JSON.stringify(system) }] } } : {}),
    ...(Array.isArray(tools) && tools.length
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parametersJsonSchema: t.input_schema || { type: "object", properties: {} } })) }] }
      : {}),
  };
}
const thinkFor = (m) => (/2\.5/.test(m) ? { thinkingBudget: /lite/.test(m) ? 0 : 512 } : { thinkingLevel: "low" });

async function geminiStream(res, { messages, tools, system, maxTokens, tier, key, src, budgetMs = 38000, onFail = null }) {
  const body = geminiBody({ messages, tools, system, maxTokens });
  const model = tier === "quick" ? GEMINI_QUICK_MODEL : GEMINI_MODEL;
  const chain = [...new Set([model, tier === "quick" ? GEMINI_MODEL : GEMINI_QUICK_MODEL, "gemini-3.5-flash-lite", "gemini-3.5-flash"])];
  const t0 = Date.now();
  let lastErr = null, started = false;
  for (let i = 0; i < chain.length && Date.now() - t0 < budgetMs; i++) {
    const ctrl = new AbortController();
    let firstTimer = setTimeout(() => ctrl.abort(), 12000);
    const hardTimer = setTimeout(() => ctrl.abort(), Math.max(5000, (onFail ? budgetMs + 10000 : 55000) - (Date.now() - t0)));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${chain[i]}:streamGenerateContent?alt=sse`;
    const send = (tc) => fetch(url, { method: "POST", signal: ctrl.signal, headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ ...body, generationConfig: { ...body.generationConfig, ...(tc ? { thinkingConfig: tc } : {}) } }) });
    try {
      let r = await send(thinkFor(chain[i]));
      if (r.status === 400) {
        const d = await r.json().catch(() => ({}));
        if (/think/i.test(d?.error?.message || "")) r = await send(null);
        else { lastErr = { status: 400, msg: d?.error?.message }; clearTimeout(firstTimer); clearTimeout(hardTimer); break; }
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        clearTimeout(firstTimer); clearTimeout(hardTimer);
        const e = { status: r.status, msg: d?.error?.message || "Gemini no ha respondido." };
        console.error("Gemini stream", chain[i], r.status, e.msg);
        if (r.status !== 404 || !lastErr) lastErr = e;
        if ([429, 500, 503, 404].includes(r.status)) continue;
        break;
      }
      // Lee el flujo SSE de Google
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = "", parts = [], finish = null, block = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
          if (!line.startsWith("data:")) continue;
          let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (j.promptFeedback?.blockReason) block = j.promptFeedback.blockReason;
          const c = j.candidates?.[0]; if (!c) continue;
          if (c.finishReason) finish = c.finishReason;
          for (const p of c.content?.parts || []) {
            if (p.thought) { if (p.thoughtSignature) parts.push({ thoughtSignature: p.thoughtSignature, text: "" }); continue; }
            parts.push(p);
            if (p.text) {
              if (!started) { started = true; clearTimeout(firstTimer); res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" }); }
              res.write(JSON.stringify({ d: p.text }) + "\n");
            }
          }
          if (!started && parts.some((p) => p.functionCall)) { started = true; clearTimeout(firstTimer); res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" }); }
        }
      }
      clearTimeout(firstTimer); clearTimeout(hardTimer);
      // Junta los trozos de texto seguidos en uno (con su firma), deja las llamadas a herramientas tal cual.
      const merged = [];
      for (const p of parts) {
        const prev = merged[merged.length - 1];
        if (!p.functionCall && prev && !prev.functionCall && typeof prev.text === "string") {
          prev.text += p.text || ""; if (p.thoughtSignature) prev.thoughtSignature = p.thoughtSignature;
        } else merged.push({ ...p });
      }
      const cleaned = merged.filter((p) => p.functionCall || p.text || p.thoughtSignature);
      if (!started) {
        if (block) return res.status(502).json({ error: "Gemini no ha querido mirar eso (" + block + ").", code: "unavailable" });
        if (!cleaned.length) { lastErr = { status: 503, msg: "respuesta vacía de " + chain[i] }; continue; }
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
      }
      const out = fromGemini({ candidates: [{ content: { parts: cleaned }, finishReason: finish }] });
      res.end(JSON.stringify({ done: { ...out, via: "Gemini" } }) + "\n");
      return;
    } catch (e) {
      clearTimeout(firstTimer); clearTimeout(hardTimer);
      if (started) { try { res.end(JSON.stringify({ error: "Se ha cortado la respuesta. Vuelve a probar.", code: "unavailable" }) + "\n"); } catch (_) {} return; }
      console.error("Gemini stream", chain[i], "timeout/abort", e && e.name);
      lastErr = lastErr || { status: 503, msg: "high demand (timeout " + chain[i] + ")" };
      continue;
    }
  }
  const st = lastErr?.status || 503, m = lastErr?.msg || "";
  const busy = st === 503 || /high demand|overloaded/i.test(m);
  const msg = busy ? "Los servidores gratis de Google están saturados ahora mismo. Prueba en un minuto." : m + (st === 400 || st === 401 || st === 403 ? ` [clave de ${src}, ${key.length} caracteres]` : "");
  const code = st === 429 ? "rate_limited" : (st === 401 || st === 403 || /API key/i.test(m)) ? "bad_key" : "unavailable";
  if (onFail) return onFail(st === 429 ? 429 : 502, { error: msg, code });
  return res.status(st === 429 ? 429 : 502).json({ error: msg, code });
}

async function gemini(res, { messages, tools, system, maxTokens, tier, key, src, budgetMs = 45000 }) {
  const model = tier === "quick" ? GEMINI_QUICK_MODEL : GEMINI_MODEL;
  const body = {
    contents: toGemini(messages),
    generationConfig: { maxOutputTokens: maxTokens },
    ...(system ? { systemInstruction: { parts: [{ text: typeof system === "string" ? system : JSON.stringify(system) }] } } : {}),
    ...(Array.isArray(tools) && tools.length
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parametersJsonSchema: t.input_schema || { type: "object", properties: {} } })) }] }
      : {}),
  };
  // Si un modelo está saturado (503) o sin cuota (429), se prueba con el siguiente.
  const chain = [...new Set([model, GEMINI_MODEL, GEMINI_QUICK_MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite"])];
  let best = null; // el primer fallo "de verdad" (cuota, saturado), para no enseñar un 404 del último intento
  let url, r, data;
  const t0 = Date.now();
  for (let i = 0; i < chain.length; i++) {
    if (i > 0 && Date.now() - t0 > budgetMs - 8000) break; // sin tiempo para otro intento (Vercel corta a los 60 s)
    url = `https://generativelanguage.googleapis.com/v1beta/models/${chain[i]}:generateContent`;
    // Pensar poco = responder rápido. Los 2.5 usan thinkingBudget; los nuevos, thinkingLevel.
    const think = /2\.5/.test(chain[i]) ? { thinkingBudget: /lite/.test(chain[i]) ? 0 : 512 } : { thinkingLevel: "low" };
    const send = (tc) => fetch(url, { method: "POST", signal: AbortSignal.timeout(Math.max(6000, Math.min(budgetMs * 0.6, budgetMs - (Date.now() - t0)))), headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ ...body, generationConfig: { ...body.generationConfig, ...(tc ? { thinkingConfig: tc } : {}) } }) });
    try { r = await send(think); } catch (e) {
      r = { ok: false, status: 503 }; data = { error: { message: "high demand (timeout " + chain[i] + ")" } };
      if (!best) best = { r, data };
      continue;
    }
    data = await r.json().catch(() => ({}));
    if (r.status === 400 && /think/i.test(data?.error?.message || "")) { r = await send(null); data = await r.json().catch(() => ({})); }
    if (r.ok || ![429, 500, 503, 404].includes(r.status)) break;
    console.error("Gemini", chain[i], r.status, data?.error?.message);
    if (r.status !== 404 && !best) best = { r, data };
    if (i < chain.length - 1) await new Promise((ok) => setTimeout(ok, 600));
  }
  if (!r.ok && r.status === 404 && best) ({ r, data } = best);
  // Algunas claves nuevas (AQ.) solo funcionan como parámetro ?key= o como Bearer: se prueba antes de rendirse.
  if (!r.ok && (r.status === 400 || r.status === 401 || r.status === 403)) {
    for (const alt of [
      () => fetch(url + "?key=" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      () => fetch(url, { method: "POST", headers: { Authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify(body) }),
    ]) {
      const r2 = await alt(); const d2 = await r2.json().catch(() => ({}));
      if (r2.ok) { r = r2; data = d2; break; }
    }
  }
  if (!r.ok) {
    const hint = ` [clave de ${src}, ${key.length} caracteres, empieza por ${key.slice(0, 4)}]`;
    const busy = r.status === 503 || /high demand|overloaded/i.test(data?.error?.message || "");
    const msg = busy ? "Los servidores gratis de Google están saturados ahora mismo. Prueba en un par de minutos." : (data?.error?.message || "Gemini no ha respondido.") + (r.status === 400 || r.status === 401 || r.status === 403 ? hint : "");
    console.error("Gemini", r.status, msg);
    const code = r.status === 429 ? "rate_limited" : (r.status === 401 || r.status === 403 || /API key/i.test(msg)) ? "bad_key" : "unavailable";
    return res.status(r.status === 429 ? 429 : 502).json({ error: msg, code });
  }
  if (!data?.candidates?.length) {
    const why = data?.promptFeedback?.blockReason;
    return res.status(502).json({ error: why ? "Gemini no ha querido mirar eso (" + why + ")." : "Gemini no ha respondido.", code: "unavailable" });
  }
  res.status(200).json({ ...fromGemini(data), via: "Gemini" });
}

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: "4mb" } } };
