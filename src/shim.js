/* ======================================================================
   Puente de Miyagi con su servidor (Vercel + Supabase + Claude).
   Ofrece la misma interfaz que la versión dentro de Claude
   (window.claude.use("db" | "user" | "sample" | "downloads")),
   así el código de la app no cambia.
   ====================================================================== */
(function () {
  const K = { token: "miyagi-token", queue: "miyagi-queue", cache: "miyagi-cache", since: "miyagi-since" };
  let TOKEN = null;
  try { TOKEN = localStorage.getItem(K.token); } catch (e) {}
  let setReady;
  const ready = new Promise((r) => (setReady = r));
  window.miyagiNeedsLogin = !TOKEN;

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: "Bearer " + TOKEN } : {}), ...(opts.headers || {}) },
    });
    if (r.status === 401 && !path.includes("/api/login")) {
      try { localStorage.removeItem(K.token); } catch (e) {}
      TOKEN = null; showLogin();
      throw { code: "not_granted", message: "Sesión caducada" };
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: j.code || (r.status === 413 ? "too_big" : r.status === 504 ? "timeout" : r.status === 429 ? "rate_limited" : "unavailable"), message: j.error || "Error " + r.status, status: r.status };
    return j;
  }
  window.miyagiApi = api;

  /* ---------- Pantalla de entrada ---------- */
  function showLogin() {
    window.miyagiNeedsLogin = true;
    if (document.getElementById("login")) return;
    const el = document.createElement("div");
    el.id = "login";
    el.innerHTML = `<form id="loginform" autocomplete="on">
      <div class="seal lg-seal" aria-hidden="true">道</div>
      <div class="lg-brand">Miyagi</div><div class="lg-sub">Entra en el dojo</div>
      <input id="lg-pass" type="password" autocomplete="current-password" placeholder="Contraseña" aria-label="Contraseña" required>
      <button type="submit">Entrar</button><div class="lg-err" id="lg-err" role="alert"></div></form>`;
    document.body.appendChild(el);
    const f = el.querySelector("form"), err = el.querySelector("#lg-err"), btn = f.querySelector("button");
    setTimeout(() => el.querySelector("#lg-pass").focus(), 100);
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true; btn.textContent = "Comprobando…";
      try {
        const j = await api("/api/login", { method: "POST", body: JSON.stringify({ password: el.querySelector("#lg-pass").value }) });
        TOKEN = j.token; try { localStorage.setItem(K.token, TOKEN); } catch (e) {}
        location.reload();
      } catch (e2) {
        err.textContent = e2.message || "No se ha podido entrar."; btn.disabled = false; btn.textContent = "Entrar";
      }
    });
  }
  if (TOKEN) setReady(); else document.addEventListener("DOMContentLoaded", showLogin);

  /* ---------- Almacén sincronizado (con copia en el móvil para abrir sin conexión) ---------- */
  const store = {};            // col -> Map(id -> data)
  const colSubs = {}, docSubs = {};
  let queue = [];
  try { queue = JSON.parse(localStorage.getItem(K.queue) || "[]"); } catch (e) {}
  let since = "1970-01-01T00:00:00Z", loaded = false, onLoaded;
  const firstLoad = new Promise((r) => (onLoaded = r));
  const map = (c) => (store[c] || (store[c] = new Map()));
  // Copia local (IndexedDB): abre al instante y funciona sin conexión.
  const idb = new Promise((res) => {
    try { const rq = indexedDB.open("miyagi", 1); rq.onupgradeneeded = () => rq.result.createObjectStore("kv"); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }
    catch (e) { res(null); }
  });
  const idbGet = async (k) => { const d = await idb; if (!d) return null; return new Promise((r) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); };
  let saveT = null;
  function persist() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => { const d = await idb; if (!d) return; try { const tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").put({ since, store: Object.fromEntries(Object.entries(store).map(([c, m]) => [c, [...m]])) }, K.cache); } catch (e) {} }, 800);
  }
  const docSnap = (col, id) => { const d = map(col).get(id); return { id, exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))), metadata: { fromCache: false } }; };
  const colSnap = (col) => { const docs = [...map(col).keys()].map((id) => docSnap(col, id)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false } }; };
  function notify(cols, docs) {
    queueMicrotask(() => {
      cols.forEach((c) => (colSubs[c] || []).forEach((fn) => { try { fn(colSnap(c)); } catch (e) { console.warn(e); } }));
      docs.forEach((k) => { const i = k.indexOf("/"); const c = k.slice(0, i), id = k.slice(i + 1); (docSubs[k] || []).forEach((fn) => { try { fn(docSnap(c, id)); } catch (e) { console.warn(e); } }); });
    });
  }
  function saveQueue() { try { localStorage.setItem(K.queue, JSON.stringify(queue)); } catch (e) { /* lleno: se mantiene en memoria */ } }
  let flushT = null, flushing = false;
  function write(col, id, data, del) {
    if (del) map(col).delete(id); else map(col).set(id, JSON.parse(JSON.stringify(data)));
    queue = queue.filter((o) => !(o.col === col && o.id === id));
    queue.push(del ? { op: "delete", col, id } : { op: "set", col, id, data });
    saveQueue(); persist(); notify([col], [col + "/" + id]);
    clearTimeout(flushT); flushT = setTimeout(flush, 250);
    return Promise.resolve();
  }
  async function flush() {
    if (flushing || !queue.length || !TOKEN) return;
    flushing = true;
    // Tandas de hasta ~3 MB (las fotos pesan) para no pasar del límite de Vercel.
    const batch = []; let size = 0;
    for (const o of queue) { const s = JSON.stringify(o).length; if (batch.length && (size + s > 3_000_000 || batch.length >= 200)) break; batch.push(o); size += s; }
    try {
      await api("/api/db", { method: "POST", body: JSON.stringify({ ops: batch }) });
      queue = queue.filter((o) => !batch.includes(o)); saveQueue(); setSync(true);
    } catch (e) { setSync(false); setTimeout(flush, 15000); }
    flushing = false;
    if (queue.length) setTimeout(flush, 50);
  }
  async function pull() {
    if (!TOKEN) return;
    try {
      for (let round = 0; round < 30; round++) {
        const j = await api("/api/db?since=" + encodeURIComponent(since));
        const cols = new Set(), docs = new Set();
        const pending = new Set(queue.map((o) => o.col + "/" + o.id));
        for (const r of j.rows || []) {
          since = r.updated_at > since ? r.updated_at : since;
          if (pending.has(r.col + "/" + r.id)) continue;
          if (r.deleted) map(r.col).delete(r.id); else map(r.col).set(r.id, r.data);
          cols.add(r.col); docs.add(r.col + "/" + r.id);
        }
        if (cols.size) { persist(); if (loaded) notify([...cols], [...docs]); }
        if (!j.more || !(j.rows || []).length) break;
      }
      setSync(true);
    } catch (e) { setSync(false); }
    if (!loaded) { loaded = true; onLoaded(); }
  }
  let online = true;
  function setSync(ok) { if (online !== ok) { online = ok; window.dispatchEvent(new Event("miyagi-sync")); } }
  window.miyagiOnline = () => online;
  ready.then(async () => {
    // 1) Lo guardado en el móvil, al instante. 2) Lo nuevo del servidor.
    const c = await idbGet(K.cache);
    if (c && c.store) { since = c.since || since; for (const [col, entries] of Object.entries(c.store)) for (const [id, d] of entries) map(col).set(id, d); if (!loaded) { loaded = true; onLoaded(); } }
    await pull(); flush();
    setInterval(() => { if (!document.hidden) pull(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { pull(); flush(); } });
    window.addEventListener("online", () => { pull(); flush(); });
  });
  function sub(col, id, fn) {
    const key = id == null ? col : col + "/" + id;
    const bag = id == null ? colSubs : docSubs;
    (bag[key] || (bag[key] = new Set())).add(fn);
    firstLoad.then(() => queueMicrotask(() => fn(id == null ? colSnap(col) : docSnap(col, id))));
    return () => bag[key].delete(fn);
  }
  function colRef(col) {
    return { path: col, doc: (id) => docRef(col, id), onSnapshot: (next) => sub(col, null, next), get: async () => (await firstLoad, colSnap(col)) };
  }
  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      set: (data) => write(col, id, data),
      update: (data) => write(col, id, { ...(map(col).get(id) || {}), ...data }),
      delete: () => write(col, id, null, true),
      get: async () => (await firstLoad, docSnap(col, id)),
      onSnapshot: (next) => sub(col, id, next),
    };
  }
  // La app guarda todo en "data/users/<id>": aquí es la colección "m".
  const APP_COL = "m";
  const db = { collection: (n) => colRef(/^data\/users\//.test(n) ? APP_COL : n), doc: (p) => { const i = p.lastIndexOf("/"); return docRef(p.slice(0, i), p.slice(i + 1)); } };
  window.miyagiDB = { col: (c) => [...map(c).entries()], write, flush, pull };

  /* ---------- Claude (a través de /api/ai) ---------- */
  // Toda foto sale como JPEG de 1280 px como mucho: así nunca pasa del límite de Vercel (4,5 MB)
  // ni llega en un formato que Claude no lee (HEIC del iPhone).
  async function decode(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) {}
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = url; }); return img; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function toImageBlock(blob, budget = 700_000) {
    let out = null;
    try {
      const im = await decode(blob);
      const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
      for (const [max, q] of [[1280, 0.8], [1024, 0.72], [800, 0.65]]) {
        const s = Math.min(1, max / Math.max(w, h));
        const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
        c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
        out = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
        if (out && out.size < budget) break;
      }
    } catch (e) { out = null; }
    if (!out) throw { code: "bad_image", message: "No he podido leer esa foto. Prueba con otra o hazle una captura de pantalla." };
    const b64 = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(",")[1]); fr.readAsDataURL(out); });
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
  }
  async function sample(input, opts = {}) {
    let messages = typeof input === "string" ? [{ role: "user", content: input }] : input.map((m) => ({ role: m.role, content: m.content }));
    const imgs = opts.images ? [...(opts.images instanceof Blob ? [opts.images] : opts.images)].slice(0, 6) : [];
    if (imgs.length) {
      const last = messages[messages.length - 1];
      const budget = Math.min(700_000, Math.floor(2_400_000 / imgs.length));
      const blocks = await Promise.all(imgs.map((b) => toImageBlock(b, budget)));
      last.content = [...blocks, { type: "text", text: typeof last.content === "string" ? last.content : "" }];
    }
    const tools = (opts.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let all = "";
    for (let round = 0; round < 14; round++) {
      if (opts.signal?.aborted) throw { code: "cancelled", text: all };
      let res;
      try { res = await api("/api/ai", { method: "POST", body: JSON.stringify({ messages, tools, max_tokens: 4096, tier: opts.modelTier }) }); }
      catch (e) { throw { ...e, text: all || undefined }; }
      const content = res.content || [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text) { all = text; opts.onText && opts.onText({ text: all, delta: text }); }
      if (res.stop_reason === "tool_use" && opts.tools) {
        messages.push({ role: "assistant", content });
        const results = [];
        for (const c of content.filter((c) => c.type === "tool_use")) {
          const tool = opts.tools.find((t) => t.name === c.name);
          let out, isErr = false;
          try { out = tool ? await tool.execute(c.input || {}, { signal: opts.signal }) : "Herramienta desconocida"; if (!tool) isErr = true; }
          catch (e) { out = String((e && e.message) || e); isErr = true; }
          results.push({ type: "tool_result", tool_use_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out ?? "ok"), ...(isErr ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
        continue;
      }
      return { text: all, truncated: res.stop_reason === "max_tokens" };
    }
    return { text: all, truncated: true };
  }
  sample.json = async (input, opts) => {
    const { text } = await sample(input, opts);
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    try { return JSON.parse(m ? m[0] : text); } catch (e) { throw { code: "invalid_json", message: "Respuesta no válida" }; }
  };
  sample.limits = async () => ({ maxPromptBytes: 3_000_000, tools: { maxCount: 16 }, images: { maxCount: 6, maxBytes: 20e6, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"] } });

  /* ---------- Descargas ---------- */
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      // En el iPhone, la hoja de compartir deja guardarla en Archivos.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return { status: "saved" }; }
        catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; }
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      return { status: "saved" };
    },
  };

  const user = { id: async () => "david", me: async () => ({ id: "david", name: "David" }), isOwner: () => true, canEdit: () => true, can: () => true, profiles: async () => ({}) };

  window.claude = {
    use: async (name) => {
      await ready; await firstLoad;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "sample") return sample;
      if (name === "downloads") return downloads;
      return null;
    },
  };
})();
