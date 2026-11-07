import { requireAuth, supabaseReady, getDoc, putDoc } from "./_lib.js";
import { generateVapidKeys } from "./_webpush.js";

// Claves VAPID de las notificaciones. Se crean solas la primera vez y se guardan
// en Supabase (colección privada "_secret"); la privada nunca sale del servidor.
export async function vapidKeys() {
  let keys = await getDoc("_secret", "vapid");
  if (!keys?.publicKey || !keys?.privateKey) {
    keys = generateVapidKeys();
    await putDoc("_secret", "vapid", keys);
  }
  return keys;
}

// GET /api/push → { publicKey }
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (!supabaseReady()) return res.status(500).json({ error: "Falta configurar Supabase." });
  try {
    const keys = await vapidKeys();
    res.status(200).json({ publicKey: keys.publicKey });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se han podido preparar las notificaciones." });
  }
}
