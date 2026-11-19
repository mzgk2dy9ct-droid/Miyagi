import { requireAuth, getRow, supabaseReady } from "./_lib.js";

// GET /api/shared → lo que Alfred (su agenda) sabe de David: memoria, agenda de hoy y mañana, exámenes y salidas.
// Miyagi lo usa para adaptar comida y entreno a sus días (exámenes, clases, gym, fútbol).
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (!supabaseReady()) return res.status(200).json({});
  res.setHeader("Cache-Control", "no-store");
  try {
    const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
    const [settings, brief] = await Promise.all([getRow("docs", "root", "settings").catch(() => null), getRow("docs", "export", "brief").catch(() => null)]);
    const dias = (brief?.agenda || []).filter((d) => d.date >= hoy).slice(0, 2).map((d) => ({ fecha: d.date, dia: d.dia, eventos: (d.eventos || []).map((e) => `${e.inicio}–${e.fin} ${e.que}${e.hecho ? " (hecho)" : ""}`) }));
    res.status(200).json({
      alfred: {
        memoria: (settings?.notes || []).filter((x) => typeof x === "string").slice(0, 40),
        agenda: dias,
        examenes: (brief?.examenes || []).filter((x) => x.fecha >= hoy).slice(0, 5).map((x) => ({ que: x.que, fecha: x.fecha })),
      },
    });
  } catch (e) { console.error(e); res.status(200).json({}); }
}
