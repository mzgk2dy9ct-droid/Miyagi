"""Genera index.html a partir de la app (src/app.html) + el puente con el servidor (src/shim.js)
+ lo propio de la versión app (src/app-extra.js).
Uso:  python3 src/build.py
src/app.html es la misma página que funciona dentro de Claude: se puede seguir mejorando allí,
copiarla aquí y volver a generar.
"""
import re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
src = root / "src"
app = (src / "app.html").read_text()
shim = (src / "shim.js").read_text()
extra = (src / "app-extra.js").read_text()
splash = (src / "splash-links.html").read_text().strip()

def r(s, a, b, cnt=None):
    n = s.count(a)
    assert n >= 1 and (cnt is None or n == cnt), (a[:80], n)
    return s.replace(a, b)

# --- textos pensados para la versión dentro de Claude ---
app = r(app, "Miyagi no está disponible en esta vista.", "Miyagi no responde ahora mismo. Revisa la conexión.")
app = r(app, '"Miyagi necesita permiso para usar Claude en esta página."', '"Tu sesión ha caducado. Vuelve a entrar."')
app = r(app, '''  const c = e && e.code;
  if(c==="not_granted"''', '''  const c = e && e.code;
  if(!navigator.onLine) return "Sin conexión. Vuelve a probar cuando tengas internet.";
  if(c==="no_key") return "La IA aún no está activada: falta la clave de Anthropic en Vercel.";
  if(c==="no_credit") return "No queda saldo en Anthropic. Recarga en console.anthropic.com y vuelve a probar.";
  if(c==="too_big") return "La foto pesa demasiado para enviarla. Prueba con una captura de pantalla de la foto.";
  if(c==="timeout") return "Miyagi ha tardado demasiado en mirar la foto. Vuelve a probar.";
  if(c==="bad_image") return e.message;
  if(c==="unavailable" && e.message && e.message!=="Error") return "Miyagi no ha podido responder: "+e.message;
  if(c==="not_granted"''', 1)

app = r(app, "Guárdala antes de pasar Miyagi a app de verdad.", "Guárdala de vez en cuando, por si acaso.", 1)

# --- la entrada de cine no tapa la pantalla de contraseña ---
app = r(app, "if(RM || seen) return;", "if(RM || seen || window.miyagiNeedsLogin) return;", 1)

# --- avisar a la versión app de cada cambio (para recalcular los avisos) ---
app = r(app, "lastSaveAt = Date.now(); apply(id, obj); render();", "lastSaveAt = Date.now(); apply(id, obj); render(); window.miyagiOnSave && window.miyagiOnSave();", 1)

# --- exponer lo que necesita src/app-extra.js ---
i = app.rindex("})();\n</script>")
app = app[:i] + "window.miyagiApp = {P, day, saveProfile, routine, dayTotals, waterGoal, stamp, ymd, addDays, fmtL, render};\n" + app[i:]

# --- separar cabecera, estilos, HTML y script ---
i = app.index("<script>")
head_part, body_script = app[:i], app[i:]
title = re.search(r"<title>.*?</title>", head_part).group(0)
head_part = head_part.replace(title, "")
head_part = re.sub(r'<meta name="claude:viewport-fit-sides"[^>]*>\n?', "", head_part)
links = "".join(re.findall(r'<link [^>]*>\n?', head_part))
head_part = re.sub(r'<link [^>]*>\n?', "", head_part)
style_end = head_part.index("</style>") + len("</style>")
styles, body_html = head_part[:style_end], head_part[style_end:]

RESET = """<style>
/* Lo que la página tenía dentro de Claude, más ajustes para sentirse app nativa */
:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
html,body{margin:0;-webkit-text-size-adjust:100%}
html{-webkit-tap-highlight-color:transparent}
body{font:14px/1.4 system-ui,-apple-system,sans-serif;overscroll-behavior-y:none}
img{max-width:100%}[hidden]{display:none!important}
button,a,label,.chip,.opt,nav{touch-action:manipulation}
nav.tabs,.beam,.chip,button{-webkit-user-select:none;user-select:none}
</style>"""
LOGIN_CSS = """<style>
#login{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:24px;background-color:#f1e8d3;
  background-image:linear-gradient(rgba(122,85,51,.16) 2px,transparent 2px),linear-gradient(90deg,rgba(122,85,51,.16) 2px,transparent 2px);background-size:33.33% 16.66%}
#login form{width:min(320px,100%);display:grid;gap:12px;justify-items:center;text-align:center;background:#f8f2e4;padding:30px 22px 24px;border-radius:24px;box-shadow:0 20px 50px rgba(60,35,10,.25)}
#login .lg-seal{width:66px;height:66px;font-size:36px}
.lg-brand{font-family:var(--display);font-weight:800;font-size:2.4rem;line-height:1.1;color:#1f1a14}
.lg-sub{font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:#5a5046;margin-bottom:6px}
#login input,#login button{width:100%;box-sizing:border-box}
#login input{color:#1f1a14;background:#f3ecdc;border-color:#d6cab0}
#login button{background:#1f1a14;color:#f3ecdc;border-color:#1f1a14}
.lg-err{min-height:1.2em;color:#b3261e;font-size:.85rem}
</style>"""

doc = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
{title}
<meta name="description" content="Tu sensei de físico y nutrición.">
<meta name="theme-color" content="#8b5f36">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Miyagi">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
{splash}
{links}{RESET}
{styles}
{LOGIN_CSS}
</head>
<body>
{body_html}
<script>
{shim}
</script>
{body_script}
<script>
{extra}
</script>
</body>
</html>
"""
(root / "index.html").write_text(doc)
print("index.html generado:", len(doc), "bytes")
