/* ======================================================================
   Lo propio de la versión app: avisos en el móvil, conexión y sesión.
   ====================================================================== */
(function () {
  const A = window.miyagiApp; if (!A) return;
  const $ = (id) => document.getElementById(id);
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushState = () => (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) ? "unsupported" : Notification.permission;
  const b64ToU8 = (s) => { const p = "=".repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const KINDS = [
    ["manana", "Buenos días con el plan del día", "9:00"],
    ["supl", "Suplementos, si te faltan", "10:00"],
    ["agua", "Agua, si vas corto", "17:30"],
    ["gym", "Hoy toca gym", "19:00"],
    ["noche", "Proteína pendiente", "21:30"],
    ["domingo", "Tu semana en historias", "domingo 20:00"],
  ];

  /* ---------- panel en Cuerpo ---------- */
  const anchor = $("bk-confirm") && $("bk-confirm").closest(".panel");
  const panel = document.createElement("div");
  panel.className = "panel"; panel.id = "app-panel";
  if (anchor) anchor.after(panel);
  function renderPanel() {
    const st = pushState(), pr = A.P().push || {};
    const label = st === "granted" ? "activados" : st === "denied" ? "bloqueados (Ajustes del iPhone → Notificaciones → Miyagi)" : st === "unsupported" ? (isStandalone() ? "este dispositivo no los admite" : "instala la app para activarlos") : "desactivados";
    panel.innerHTML = `<h2>Avisos y sesión</h2>
      <p class="small" style="margin-top:0">Avisos en este móvil: <b>${label}</b></p>
      ${st === "unsupported" && !isStandalone() ? `<p class="small muted">Safari → Compartir → «Añadir a pantalla de inicio», y abre Miyagi desde el icono.</p>` : ""}
      ${st === "default" ? `<button id="push-on" style="width:100%;margin-bottom:10px">Activar avisos</button>` : ""}
      ${KINDS.map(([k, t, h]) => `<label class="check"><input type="checkbox" data-pk="${k}" ${pr[k] !== false ? "checked" : ""}><span>${esc(t)} <span class="muted small">· ${h}</span></span></label>`).join("")}
      <button class="ghost" id="logout" style="width:100%;margin-top:10px">Cerrar sesión</button>`;
  }
  panel.addEventListener("change", (e) => {
    const k = e.target.dataset && e.target.dataset.pk; if (!k) return;
    A.saveProfile({ push: { ...(A.P().push || {}), [k]: e.target.checked } });
  });
  panel.addEventListener("click", (e) => {
    if (e.target.id === "push-on") enablePush();
    if (e.target.id === "logout") { try { localStorage.removeItem("miyagi-token"); } catch (_) {} location.reload(); }
  });

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { renderPanel(); return; }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await window.miyagiApi("/api/push");
      let s = await reg.pushManager.getSubscription();
      if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
      const j = s.toJSON();
      const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(j.endpoint)))).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
      window.miyagiDB.write("push", h, { endpoint: j.endpoint, keys: j.keys, device: /iPad/.test(navigator.userAgent) ? "iPad" : /iPhone/.test(navigator.userAgent) ? "iPhone" : "otro", at: Date.now() });
      lastSig = ""; buildSchedule(); A.stamp("鈴", "Avisos activados"); renderPanel();
    } catch (e) { console.warn(e); A.stamp("鈴", "No se han podido activar"); }
  }

  /* ---------- avisos: la app calcula cuáles tocan y el servidor los envía ---------- */
  let lastSig = "", schedT = null;
  function buildSchedule() {
    if (!window.miyagiDB) return;
    const P = A.P(), pr = P.push || {}, on = (k) => pr[k] !== false, now = Date.now(), items = [];
    const add = (t, id, title, body) => { if (t > now - 60e3) items.push({ id, at: t, title: title.slice(0, 90), body: body.slice(0, 220) }); };
    for (let i = 0; i < 3; i++) {
      const d = A.addDays(new Date(), i); d.setHours(12, 0, 0, 0);
      const k = A.ymd(d), at = (h, m) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
      const r = A.routine()[d.getDay()], dd = A.day(k), t = A.dayTotals(k), wg = A.waterGoal(d).g, ml = +dd.water || 0, PR = P.prot || 150;
      if (on("manana")) add(at(9, 0), `am_${k}`, "Buenos días", `${r.ex.length ? "Hoy toca " + r.name.toLowerCase() : r.note}. Objetivo: ${PR} g de proteína y ${A.fmtL(wg)} de agua.`);
      if (on("supl") && (P.supl || []).length) { const left = P.supl.filter((s) => !(dd.supl || {})[s]); if (left.length) add(at(10, 0), `supl_${k}`, "Suplementos", `No olvides: ${left.join(", ")}.`); }
      if (on("agua") && (i > 0 || ml < wg * 0.5)) add(at(17, 30), `agua_${k}`, i === 0 ? `Llevas ${A.fmtL(ml)} de agua` : "¿Cómo vas de agua?", i === 0 ? `Te quedan ${A.fmtL(wg - ml)} para cerrar el anillo.` : `Hoy el objetivo son ${A.fmtL(wg)}.`);
      if (on("gym") && r.ex.length && !dd.trained) add(at(19, 0), `gym_${k}`, `Hoy toca ${r.name.toLowerCase()}`, `A las 19:30, en el dojo. ${r.ex.slice(0, 3).map((x) => x[0]).join(", ")}…`);
      if (on("noche") && (i > 0 || t.p < PR)) add(at(21, 30), `noche_${k}`, i === 0 ? `Te faltan ${Math.round(PR - t.p)} g de proteína` : "¿Has cerrado la proteína?", "Cierra el anillo antes de dormir: yogur proteico, pechuga, atún o huevos.");
      if (on("domingo") && d.getDay() === 0) add(at(20, 0), `dom_${k}`, "Tu semana en el dojo está lista", "Abre Miyagi y mira tus historias.");
    }
    items.sort((a, b) => a.at - b.at);
    const out = items.slice(0, 60), sig = JSON.stringify(out);
    if (sig === lastSig) return; lastSig = sig;
    window.miyagiDB.write("notif", "schedule", { items: out, at: now });
  }
  window.miyagiOnSave = () => { clearTimeout(schedT); schedT = setTimeout(buildSchedule, 3000); };
  setInterval(buildSchedule, 10 * 60e3);
  setTimeout(buildSchedule, 4000);

  /* ---------- conexión ---------- */
  function conn() {
    const n = $("store-note"); if (!n) return;
    n.textContent = window.miyagiOnline && !window.miyagiOnline() ? "Sin conexión: lo que apuntes se guarda en el móvil y se sube al volver." : "";
  }
  window.addEventListener("miyagi-sync", conn);

  renderPanel();
  setTimeout(renderPanel, 2500);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch((e) => console.warn(e));
})();
