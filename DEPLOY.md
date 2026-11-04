# Poner Mareas online (todo desde el móvil, sin instalar nada)

El servidor (`server/`) sirve el juego Y las partidas online. Una sola URL para todo.

## 1. Subir el proyecto a GitHub
1. Entra en github.com (crea cuenta si no tienes) → **New repository** → nombre `mareas` → marca **Add a README** → Create.
2. Descomprime `mareas.zip` con la app Archivos del móvil.
3. En el repo: **Add file → Upload files** y sube los archivos sueltos de la raíz: `render.yaml`, `DEPLOY.md`, `.gitignore`. Commit.
4. Las carpetas, una a una:
   - **Add file → Create new file**, en el nombre escribe `server/.gitkeep` y haz Commit. Ya existe la carpeta `server`.
   - Entra en `server` → **Add file → Upload files** → sube `index.js` y `package.json`. Commit.
   - Repite con `client/` (sube `index.html`, `sim.js`, `sw.js`, `icon.svg`, `manifest.webmanifest`),
     `client/downloads/` (`LEEME.txt`) y `test/` (`sim.test.js`, `online.test.js`).
   - Consejo: si pulsas "Desktop site" en Chrome, la subida de archivos va mejor.

## 2. Desplegar en Render
1. render.com → entra con tu cuenta de GitHub.
2. **New → Blueprint** → elige el repo `mareas` → **Apply**.
3. Espera 2–4 minutos. Te dará una URL tipo `https://mareas-xxxx.onrender.com`.
4. Ábrela en dos móviles (o un móvil y el PC) y pulsa **Jugar online 1v1** en ambos.

## Cosas que debes saber
- El plan gratis de Render **duerme el servidor tras 15 min sin uso**: la primera conexión tarda ~1 min. Para evitarlo:
  un monitor gratuito (UptimeRobot) que visite `https://TU-URL/health` cada 5 min, o el plan de pago.
- `https://TU-URL/stats` muestra jugadores conectados y partidas en curso.
- Cada vez que cambies un archivo en GitHub, Render redespliega solo.
- **APK:** con la URL de Render ya puedes usar PWABuilder (pwabuilder.com). No hace falta tocar `SERVER_URL`.
- **iPhone:** abre la URL en Safari → Compartir → Añadir a pantalla de inicio.
