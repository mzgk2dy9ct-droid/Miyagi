import { supabaseReady, sbSelect, getDoc, putDoc, sbUpsert } from "./_lib.js";
import { sendPush } from "./_webpush.js";
import { vapidKeys } from "./push.js";

// GET /api/cron?key=CRON_SECRET
// Lo llama Supabase cada 2 minutos. Envía los avisos cuya hora ya ha llegado.
// La app calcula en el móvil qué avisos tocan (colección "notif", documento "schedule").
export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) return res.status(401).json({ error: "No autorizado" });
  if (!supabaseReady()) return res.status(500).json({ error: "Falta configurar Supabase." });
  try {
    const now = Date.now();
    const schedule = (await getDoc("notif", "schedule"))?.items || [];
    const sentDoc = (await getDoc("_secret", "sent")) || { ids: [] };
    const sent = new Set(sentDoc.ids || []);
    const due = schedule.filter((n) => n && n.id && n.at <= now && n.at > now - 20 * 60e3 && !sent.has(n.id));
    if (!due.length) return res.status(200).json({ sent: 0 });

    const subs = (await sbSelect("col=eq.push&deleted=eq.false&select=id,data")).filter((r) => r.data?.endpoint);
    if (!subs.length) return res.status(200).json({ sent: 0, reason: "sin dispositivos" });
    const keys = await vapidKeys();
    const subject = `https://${req.headers["x-forwarded-host"] || req.headers.host || "miyagi.vercel.app"}`;
    const dead = new Set();
    let ok = 0;
    for (const n of due.slice(0, 10)) {
      for (const s of subs) {
        if (dead.has(s.id)) continue;
        try {
          const status = await sendPush(s.data, { title: n.title, body: n.body || "", tag: n.id, url: "/" }, keys, subject);
          if (status === 404 || status === 410) dead.add(s.id);
          else if (status < 300) ok++;
          else console.warn("push", status);
        } catch (e) { console.error(e); }
      }
      sent.add(n.id);
    }
    const ids = [...sent].slice(-800);
    await putDoc("_secret", "sent", { ids });
    if (dead.size) await sbUpsert([...dead].map((id) => ({ col: "push", id, data: null, deleted: true, updated_at: new Date().toISOString() })));
    res.status(200).json({ sent: ok, due: due.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fallo al enviar avisos." });
  }
}
