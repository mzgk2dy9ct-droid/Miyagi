import { requireAuth, supabaseReady, sbSelect, sbUpsert } from "./_lib.js";

// Almacén de documentos de Miyagi (tabla "miyagi_docs" de Supabase).
// GET  /api/db?since=ISO      → cambios desde esa fecha (incluye borrados)
// POST /api/db { ops:[{op:"set"|"delete", col, id, data}] }
// Las colecciones que empiezan por "_" son privadas del servidor y nunca se devuelven.
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (!supabaseReady()) return res.status(500).json({ error: "Falta configurar Supabase en Vercel." });
  try {
    if (req.method === "GET") {
      const since = String(req.query.since || "1970-01-01T00:00:00Z");
      const rows = await sbSelect(
        `select=col,id,data,deleted,updated_at&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc&limit=400`
      ).then((rs) => rs.filter((r) => !String(r.col).startsWith("_")));
      // Las fotos pesan: se devuelven por tandas para no pasar del límite de Vercel.
      const out = []; let size = 0;
      for (const r of rows) { size += JSON.stringify(r).length; if (out.length && size > 3_500_000) break; out.push(r); }
      return res.status(200).json({ rows: out, more: out.length < rows.length || rows.length === 400, now: new Date().toISOString() });
    }
    if (req.method === "POST") {
      const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 500) : [];
      const now = new Date().toISOString();
      const rows = [];
      for (const o of ops) {
        const col = String(o.col || ""), id = String(o.id || "");
        if (!col || !id || col.startsWith("_") || col.length > 60 || id.length > 200) continue;
        rows.push(o.op === "delete"
          ? { col, id, data: null, deleted: true, updated_at: now }
          : { col, id, data: o.data ?? null, deleted: false, updated_at: now });
      }
      if (rows.length) await sbUpsert(rows);
      return res.status(200).json({ ok: true, n: rows.length, now });
    }
    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se ha podido acceder a los datos." });
  }
}

export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };
