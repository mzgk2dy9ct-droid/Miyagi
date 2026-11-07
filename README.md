# Miyagi

Tu sensei de físico y nutrición: comida por foto, anillos del día, gym con mapa de músculos y récords, progreso, Mercadona y un entrenador con IA que apunta lo que le cuentas. Estética de dojo.

App web pensada para el iPhone. No hay nada que instalar ni compilar: Vercel sirve la página y las funciones de `api/`, y los datos viven en Supabase (el mismo proyecto que Alfred, en su propia tabla).

## Cómo está hecha

| Pieza | Dónde | Para qué |
|---|---|---|
| `index.html` | Vercel | La app entera. **No se edita a mano**: se genera con `python3 src/build.py`. |
| `src/app.html` | — | La app (la misma página que funciona dentro de Claude). |
| `src/shim.js` | — | El puente con el servidor: sincroniza datos, guarda una copia en el móvil, habla con Claude y descarga archivos. |
| `src/app-extra.js` | — | Lo propio de la versión app: avisos en el móvil, conexión y cerrar sesión. |
| `api/login.js` | Vercel | Comprueba la contraseña. |
| `api/db.js` | Vercel → Supabase | Lee y guarda tus datos (tabla `miyagi_docs`). |
| `api/ai.js` | Vercel → Claude | Miyagi habla con Claude con tu clave. **Los modelos se cambian aquí.** |
| `api/push.js`, `api/cron.js` | Vercel | Avisos en el iPhone aunque la app esté cerrada. |
| `sw.js` | Navegador | Recibe los avisos y deja abrir la app sin conexión. |
| `supabase.sql`, `supabase-avisos.sql` | Supabase | La tabla de datos y el temporizador de avisos. |
| `icons/`, `splash/` | Vercel | Icono y pantalla de carga. |

## Puesta en marcha (unos 15 minutos)

### 1. Supabase: la tabla de Miyagi
1. Abre tu proyecto de Supabase (el de Alfred) → **SQL Editor** → **New query**.
2. Pega todo el contenido de `supabase.sql` y pulsa **Run**. Debe decir *Success*.

### 2. Vercel: publicar la app
1. En vercel.com → **Add New… → Project** → importa el repositorio **Miyagi**.
2. **Framework Preset: Other**. No toques Build ni Output.
3. En **Environment Variables** añade estas 5. Las tres primeras son las mismas que en Alfred: cópialas de *Alfred → Settings → Environment Variables*.

| Nombre | Valor |
|---|---|
| `SUPABASE_URL` | La misma que en Alfred. |
| `SUPABASE_SECRET_KEY` | La misma que en Alfred. |
| `ANTHROPIC_API_KEY` | La misma que en Alfred o Q Wardrobe (con saldo en console.anthropic.com). |
| `APP_PASSWORD` | La contraseña para entrar en Miyagi. Puede ser distinta de la de Alfred. |
| `CRON_SECRET` | Una palabra larga inventada (20 letras al azar). Solo sirve para los avisos. |

4. Pulsa **Deploy** y apunta la dirección (por ejemplo `miyagi-xxxx.vercel.app`).

Si cambias una variable más adelante: *Settings → Environment Variables*, y luego *Deployments → ⋯ → Redeploy*.

### 3. Los avisos
1. Supabase → **SQL Editor** → **New query**.
2. Pega `supabase-avisos.sql`, cambia `TU-APP.vercel.app` por tu dirección y `TU_CRON_SECRET` por tu `CRON_SECRET`. Pulsa **Run**.

### 4. Instalarla en el iPhone
1. Abre la dirección de Vercel en **Safari** y entra con tu contraseña.
2. **Compartir → Añadir a pantalla de inicio**.
3. Ábrela **desde el icono** → pestaña **Cuerpo** → **Avisos y sesión** → **Activar avisos**.

### 5. Traer tus datos de la versión de Claude
1. En la Miyagi de Claude: **Cuerpo → Tus datos → Descargar copia**.
2. En la app: **Cuerpo → Tus datos → Importar copia** y elige ese archivo.

## Cambiar algo de la app
Mejora la página dentro de Claude (o pídele a Claude que lo haga aquí), copia el resultado en `src/app.html` y ejecuta `python3 src/build.py`. Sube los cambios a GitHub y Vercel publica solo.
