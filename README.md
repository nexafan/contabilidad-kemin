# Contabilidad KEMIN

Panel web para contabilidad y stock de tickets para reventa. Pensado para una LLC pequeña con 1-2 socios. **Sin Notion, sin SaaS de pago**: SQLite local + storage en disco + Claude vision para OCR de capturas. Todo se gestiona desde la propia web.

> **Fork-friendly.** Si te dedicas también a reventa de tickets y quieres tu propio panel idéntico al nuestro, fork → cambia variables del `.env` → deploy en cualquier VPS de 4€/mes. Setup completo: ~20 min.

---

## ¿Qué hace?

- **Tesorería** — vista en vivo de dónde está cada dólar invertido (en stock sin listar, en stock listado, en vendidos sin payout, en cash recibido, en pérdidas).
- **Stock** — todos los tickets activos con filtros, edición inline y subida de capturas con OCR automático.
- **Expenses** — gastos fijos + comisiones a operadores de bots externos (% sobre profit).
- **Dashboard** — KPIs YTD + gráficos (margen mensual, profit por evento, por selling platform, tasa de venta).
- **Finalizados** — operaciones cerradas filtrables por año / mes / semana / día.
- **Pestañas dinámicas** — cuando un evento concentra muchos tickets (umbral configurable), se auto-genera una tab con vista filtrada y KPIs propios.
- **OCR de capturas** — sube screenshot del retailer o del marketplace → Claude vision extrae evento, fecha, retailer, sección/fila/asiento, precio, n_tickets, con badge de confianza por campo. Edita lo que necesites y crea N filas de golpe.
- **Cashback Slash 2%** — calculado automáticamente sobre todo el capital invertido.

---

## Stack

- **Node 20+** (probado en 20.20.2)
- **Express 4** (single-file server.js con HTML+API+OCR)
- **better-sqlite3** (DB embebida síncrona, sin servidor aparte)
- **multer** (subida de capturas)
- **@anthropic-ai/sdk** (Claude vision para OCR)
- **PM2** (recomendado para producción)
- **Chart.js** (CDN, sin build)

---

## Setup local (5 min)

```bash
# 1) Clonar
git clone https://github.com/nexafan/contabilidad-kemin.git
cd contabilidad-kemin

# 2) Dependencias
npm install

# 3) Config
cp .env.example .env
# edita .env con tus credenciales (mínimo: PANEL_USERS, ANTHROPIC_API_KEY)

# 4) Arrancar
npm start
```

Abre `http://localhost:4125`, login con cualquier user definido en `PANEL_USERS`. La DB se crea sola (`./data/kemin.db`).

---

## Variables de entorno

Mira [`.env.example`](.env.example) para la lista completa. Lo crítico:

| Variable | Descripción | Default |
|---|---|---|
| `PORT` | Puerto del servidor | `4125` |
| `PANEL_USERS` | Usuarios `"u1:p1,u2:p2"` (auth básica) | `admin:admin` ⚠ |
| `ANTHROPIC_API_KEY` | Para OCR — saca en https://console.anthropic.com/settings/keys | — |
| `ANTHROPIC_MODEL` | Modelo vision | `claude-haiku-4-5` |
| `DB_PATH` | Ruta del SQLite | `./data/kemin.db` |
| `UPLOADS_DIR` | Carpeta para capturas | `./uploads` |
| `EVENT_AUTO_TAB_THRESHOLD` | Umbral tickets para tab dinámica | `40` |
| `SLASH_CASHBACK_RATE` | Tasa cashback (decimal) | `0.02` |
| `B2_ENABLED` | Backups off-site a Backblaze | `false` |

---

## Deploy a producción (VPS)

Probado en Hetzner Ubuntu 24.04 (4€/mes). Cualquier VPS con Node 20+ vale.

### 1. Preparar VPS

```bash
ssh root@TU-VPS
apt update && apt install -y nodejs npm sqlite3 rclone
npm install -g pm2

mkdir -p /opt/contabilidad-kemin
cd /opt/contabilidad-kemin
```

### 2. Subir el código

```bash
# desde tu local
rsync -avz --exclude node_modules --exclude .env --exclude data --exclude uploads \
  ./ root@TU-VPS:/opt/contabilidad-kemin/

# en el VPS
cd /opt/contabilidad-kemin
npm install --production
cp .env.example .env
nano .env  # editar con valores reales
```

### 3. Lanzar con PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # te imprime un comando, ejecútalo
```

### 4. Firewall

```bash
ufw allow 4125/tcp
ufw reload
```

### 5. Backups automáticos

```bash
chmod +x /opt/contabilidad-kemin/deploy/backup.sh
crontab -e
# añade:
30 4 * * * /opt/contabilidad-kemin/deploy/backup.sh >> /var/log/kemin-backup.log 2>&1
```

Esto guarda snapshot diario del `.db` + tarball de `uploads/` en `/opt/backups/kemin/` con rotación de 30 días.

### 6. (Opcional pero MUY recomendado) Backblaze B2

Sin esto, si el VPS muere pierdes todo el histórico de tickets. Setup en 5 min:

1. Crea cuenta en https://www.backblaze.com/b2 (gratis los primeros 10GB).
2. Crea un bucket **privado** llamado `kemin-backups`.
3. Application Keys → "Add a New Application Key" con scope solo a ese bucket. Anota `keyID` y `applicationKey`.
4. En el VPS:
   ```bash
   rclone config
   # n) new remote → name: b2-kemin → storage: 5 (Backblaze B2)
   # account: tu keyID
   # key: tu applicationKey
   # hard_delete: yes
   ```
5. Edita `.env` y pon `B2_ENABLED=true` + las claves.

El cron diario hará `rclone sync` automáticamente. Coste real: < $1/mes para nuestro volumen.

---

## Cómo funciona el OCR

1. Click **📸 Subir captura** en Stock.
2. Arrastra la imagen → server la guarda en `public/uploads-tmp/`.
3. Server llama a Claude vision (`claude-haiku-4-5` por defecto) con un prompt que pide JSON estructurado con los campos del ticket + score de confianza por campo (0-100).
4. La imagen se mueve a `uploads/YYYY-MM/<uuid>.jpg`.
5. El JSON parseado rellena el formulario del modal — verde si confianza ≥85%, ámbar 60-84%, rojo <60%.
6. Editas lo que haga falta y "Crear N tickets" → se insertan N filas (una por ticket si la captura tenía varios).
7. Se loguea cada llamada en la tabla `ocr_log` con tokens + coste.

Coste por captura con Haiku 4.5: ~$0.003. Cargando $20 = ~6,500 capturas.

Para cambiar el modelo (ej. Sonnet 4.6 si quieres más precisión): `ANTHROPIC_MODEL=claude-sonnet-4-6` en `.env`.

---

## Estructura del proyecto

```
contabilidad-kemin/
├── server.js              # todo el backend + render HTML (single file)
├── schema.sql             # tablas SQLite (auto-creado en boot)
├── package.json
├── README.md              # este archivo
├── LICENSE                # MIT
├── .env.example           # plantilla de configuración
├── .gitignore             # .env, data/, uploads/, *.db, node_modules
├── ecosystem.config.cjs   # PM2 config
├── deploy/
│   └── backup.sh          # backup diario local + B2
├── data/                  # ⛔ git-ignored. Contiene kemin.db
└── uploads/               # ⛔ git-ignored. Capturas organizadas por YYYY-MM
```

---

## API

Todos los endpoints requieren auth básica.

| Método | Endpoint | Descripción |
|---|---|---|
| `GET`  | `/` | Panel HTML completo |
| `GET`  | `/api/health` | Ping (sin auth) |
| `GET`  | `/api/stock` | Listar todos los tickets |
| `POST` | `/api/stock` | Crear ticket |
| `POST` | `/api/stock/bulk` | Crear N tickets (usado por OCR) |
| `PATCH`| `/api/stock/:id` | Editar ticket |
| `DELETE`| `/api/stock/:id` | Eliminar |
| `GET/POST/PATCH/DELETE` | `/api/expenses[/:id]` | CRUD gastos |
| `GET`  | `/api/events` | Eventos (auto-creados al insertar stock) |
| `PATCH`| `/api/events/:nombre` | Pin/hide tab dinámica |
| `POST` | `/api/ocr` | Multipart con `image` → JSON con campos detectados |
| `GET`  | `/uploads/*` | Servir capturas (auth-protected) |

---

## Modelo de datos

### Estados de un ticket

```
comprado → listed → sold → cobrado
                       └→ lost (auto si event_date < hoy y sold_at = null)
```

- **comprado** — comprado pero aún no listado en marketplace
- **listed** — listado para venta con `listed_at`
- **sold** — vendido (`sold_at` set), pending payout del marketplace
- **cobrado** — payout recibido (`payout_amount` y `payout_date` set)
- **lost** — perdido (no se vendió o se vendió por debajo del retail)

### Profit

```
profit_real = payout_amount - price_retail        # solo si cobrado
profit_estimado = listed_at - price_retail        # si listado
```

### Bot operators (% sobre ganancia)

Si un gasto se modela como `modo = 'porcentaje'` y se le asigna un `bot_origin_tag`, el panel calcula automáticamente:

```
base_profit = sum(payout - retail) for stock WHERE origin = bot_origin_tag
total_pagado = base_profit × porcentaje
```

Así puedes auditar exactamente qué tickets consiguió cada bot-op y cuánto le debes.

---

## Cómo retomar / extender

El código está pensado para que un dev junior pueda iterarlo. Convenciones:

- **Single-file `server.js`** — todo en uno. Es largo (~1400 líneas) pero claro: imports → config → DB → helpers → API routes → render HTML → boot.
- **HTML inline** con template strings + helpers `esc()` para sanitizar.
- **CSS y client JS** son constantes al final de server.js. Si crecen mucho, mover a `/public/styles.css` y `/public/app.js` y servir con `express.static`.
- **Sin frameworks frontend.** Vanilla JS + fetch. Si necesitas reactividad de verdad, considera Alpine.js (~10KB).
- **Migraciones**: editar `schema.sql` con `CREATE TABLE IF NOT EXISTS` o `ALTER TABLE`. Se ejecuta en cada boot.

---

## Troubleshooting

**El panel no arranca.** Mira los logs: `pm2 logs contabilidad-kemin`. Lo más común: falta `ANTHROPIC_API_KEY` o `PANEL_USERS` mal formateado.

**OCR devuelve null en muchos campos.** La captura es de baja resolución o el modelo no la entiende. Prueba con Sonnet (`ANTHROPIC_MODEL=claude-sonnet-4-6`) que es ~5× más preciso aunque 10× más caro.

**DB corrupta.** Restaura el último backup: `cp /opt/backups/kemin/kemin-FECHA.db.gz - | gunzip > /opt/contabilidad-kemin/data/kemin.db && pm2 restart contabilidad-kemin`.

**Quiero borrar todo y empezar de cero.** `rm data/kemin.db uploads/* && npm start`. Se recreará vacío.

---

## Licencia

MIT. Forkea, modifica, ponle el nombre de tu LLC, deploy. Si te ahorra horas de admin, dale ⭐ al repo.

---

## Créditos

Hecho por **NexaFans / KEMIN LLC** (2026). Inspirado en el panel hermano `contabilidad-nexafans` (gestión de agencia OnlyFans).
