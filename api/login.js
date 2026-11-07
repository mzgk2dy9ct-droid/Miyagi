import { checkPassword, makeToken, supabaseReady } from "./_lib.js";

// POST /api/login  { password }  →  { token }
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.APP_PASSWORD) return res.status(500).json({ error: "Falta APP_PASSWORD en Vercel." });
  const { password } = req.body || {};
  // Pequeña pausa para que no se puedan probar contraseñas a toda velocidad.
  await new Promise((r) => setTimeout(r, 400));
  if (!checkPassword(password)) return res.status(401).json({ error: "Contraseña incorrecta." });
  res.status(200).json({ token: makeToken(), storage: supabaseReady() });
}
