// Utilidades compartidas por las funciones del servidor de Miyagi.
// Sin librerías: solo Node (fetch y crypto).
import { createHmac, timingSafeEqual } from "node:crypto";

// Tabla de Supabase de Miyagi. Va aparte de la de Alfred ("docs") aunque compartan proyecto.
export const TABLE = "miyagi_docs";

// ---------- Contraseña de entrada (variable APP_PASSWORD en Vercel) ----------
// No distingue mayúsculas, tildes ni espacios de más.
function normalize(p) {
  return String(p || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}
function sign(text) {
  return createHmac("sha256", normalize(process.env.APP_PASSWORD)).update(text).digest("base64url");
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}
export function checkPassword(attempt) {
  if (!process.env.APP_PASSWORD) return false;
  return safeEqual(sign("pw:" + normalize(attempt)), sign("pw:" + normalize(process.env.APP_PASSWORD)));
}
// Sesión de 365 días. Si cambias APP_PASSWORD, todas las sesiones dejan de valer.
export function makeToken() {
  const exp = Date.now() + 365 * 864e5;
  return `${exp}.${sign("miyagi-session:" + exp)}`;
}
export function isValidToken(token) {
  if (!process.env.APP_PASSWORD || !token) return false;
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign("miyagi-session:" + exp));
}
export function requireAuth(req, res) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!isValidToken(token)) {
    res.status(401).json({ error: "Sesión no válida. Vuelve a entrar." });
    return false;
  }
  return true;
}

// ---------- Supabase (API REST) ----------
// Variables: SUPABASE_URL y SUPABASE_SECRET_KEY (las mismas que Alfred).
function sbHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || "";
  const h = { apikey: key, "Content-Type": "application/json", ...extra };
  if (!key.startsWith("sb_")) h.Authorization = `Bearer ${key}`; // claves antiguas (JWT)
  return h;
}
function sbUrl(path) {
  return `${String(process.env.SUPABASE_URL || "").replace(/\/+$/, "")}/rest/v1/${path}`;
}
export function supabaseReady() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}
export async function sbSelect(query) {
  const r = await fetch(sbUrl(`${TABLE}?${query}`), { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
export async function sbUpsert(rows) {
  const r = await fetch(sbUrl(`${TABLE}?on_conflict=col,id`), {
    method: "POST",
    headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
}
export async function getDoc(col, id) {
  const rows = await sbSelect(`col=eq.${encodeURIComponent(col)}&id=eq.${encodeURIComponent(id)}&select=data,deleted`);
  return rows[0] && !rows[0].deleted ? rows[0].data : null;
}
export async function putDoc(col, id, data) {
  await sbUpsert([{ col, id, data, deleted: false, updated_at: new Date().toISOString() }]);
}
