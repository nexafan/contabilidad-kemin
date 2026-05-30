// =============================================================================
// Panel KEMIN — server.js
// -----------------------------------------------------------------------------
// Single-file Express app: DB SQLite + render HTML completo + API CRUD + OCR
// con Claude vision. Sin Notion: todo se gestiona desde el panel.
//
// Stack: Node 20, Express 4, better-sqlite3, @anthropic-ai/sdk, multer, dotenv.
// =============================================================================

import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '4125', 10);
const PANEL_USERS = parsePanelUsers(process.env.PANEL_USERS || 'admin:admin');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const DB_PATH = process.env.DB_PATH || './data/kemin.db';
const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads';
const EVENT_AUTO_TAB_THRESHOLD = parseInt(process.env.EVENT_AUTO_TAB_THRESHOLD || '40', 10);
const SLASH_CASHBACK_RATE = parseFloat(process.env.SLASH_CASHBACK_RATE || '0.02');

const RETAILERS = ['AXS', 'TICKETMASTER', 'TICKETONE', 'TICKETCORNER', 'SEETICKETS', 'EVENTIM', 'OTHER'];
const SELLING_PLATFORMS = ['StubHub', 'Ticombo', 'AXS Resale', 'Viagogo', 'Vivid Seats', 'Other'];
const TICKET_TYPES = ['MOBILE TRANSFER', 'PDF', 'HARD COPY', 'OTHER'];
const STATUSES = ['comprado', 'listed', 'sold', 'cobrado', 'lost'];
const EXPENSE_CATEGORIES = ['Proxy', 'Bot', 'Suscripción', 'Servidor', 'Bot operator', 'Otro'];

function parsePanelUsers(s) {
  const out = {};
  for (const pair of s.split(',').map(x => x.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

// -----------------------------------------------------------------------------
// DB init
// -----------------------------------------------------------------------------
mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });
mkdirSync(join(__dirname, 'public', 'uploads-tmp'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaPath = join(__dirname, 'schema.sql');
if (existsSync(schemaPath)) {
  db.exec(readFileSync(schemaPath, 'utf8'));
} else {
  console.warn('schema.sql no encontrado, asumiendo DB ya inicializada');
}

// -----------------------------------------------------------------------------
// Anthropic client (lazy)
// -----------------------------------------------------------------------------
let anthropic = null;
function getAnthropic() {
  if (!anthropic) {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada en .env');
    anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

function fmtUSD(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  const fixed = abs.toFixed(decimals);
  const [int, dec] = fixed.split('.');
  const intWithCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + '$' + intWithCommas + (dec ? '.' + dec : '');
}
function fmtNum(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtPct(n, decimals = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}
function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${String(d.getUTCDate()).padStart(2,'0')} ${months[d.getUTCMonth()]}`;
}
function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(iso + 'T00:00:00Z');
  const now = new Date();
  return Math.ceil((target - now) / 86400000);
}
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return esc(s); }
function jsonScript(obj) { return JSON.stringify(obj).replace(/</g, '\\u003c'); }

// -----------------------------------------------------------------------------
// Status auto-compute (idempotent — se llama en GET y antes de INSERT/UPDATE)
// -----------------------------------------------------------------------------
function computeStatus(row) {
  if (row.status === 'lost') return 'lost';
  // Auto-lost: cobrado pero por debajo del retail (operación neta negativa)
  if (row.payout_amount != null && row.payout_date && row.price_retail != null
      && row.payout_amount < row.price_retail) return 'lost';
  if (row.payout_amount != null && row.payout_date) return 'cobrado';
  if (row.sold_at != null) return 'sold';
  if (row.listed_at != null) return 'listed';
  // Auto-lost: evento pasado + no vendido
  if (row.event_date) {
    const d = daysUntil(row.event_date);
    if (d !== null && d < 0 && !row.sold_at) return 'lost';
  }
  return 'comprado';
}

// -----------------------------------------------------------------------------
// DB queries
// -----------------------------------------------------------------------------
const Q = {
  insertStock: db.prepare(`
    INSERT INTO stock (id, evento, bought_date, event_date, retailer, cuenta, selling_platform,
                       ticket_type, seccion, fila, asiento, price_retail, listed_at, sold_at,
                       payout_amount, status, sold_date, payout_date, fulfilled, origin,
                       ocr_log_id, notas, created_at, updated_at)
    VALUES (@id, @evento, @bought_date, @event_date, @retailer, @cuenta, @selling_platform,
            @ticket_type, @seccion, @fila, @asiento, @price_retail, @listed_at, @sold_at,
            @payout_amount, @status, @sold_date, @payout_date, @fulfilled, @origin,
            @ocr_log_id, @notas, @created_at, @updated_at)
  `),
  updateStock: db.prepare(`
    UPDATE stock SET
      evento=@evento, bought_date=@bought_date, event_date=@event_date, retailer=@retailer,
      cuenta=@cuenta, selling_platform=@selling_platform, ticket_type=@ticket_type,
      seccion=@seccion, fila=@fila, asiento=@asiento, price_retail=@price_retail,
      listed_at=@listed_at, sold_at=@sold_at, payout_amount=@payout_amount, status=@status,
      sold_date=@sold_date, payout_date=@payout_date, fulfilled=@fulfilled, origin=@origin,
      notas=@notas, updated_at=@updated_at
    WHERE id=@id
  `),
  deleteStock: db.prepare(`DELETE FROM stock WHERE id = ?`),
  getStockById: db.prepare(`SELECT * FROM stock WHERE id = ?`),
  allStock: db.prepare(`SELECT * FROM stock ORDER BY bought_date DESC, evento ASC`),
  activeStock: db.prepare(`SELECT * FROM stock WHERE status NOT IN ('cobrado','lost') ORDER BY event_date ASC`),
  finalizadosByPeriod: db.prepare(`
    SELECT * FROM stock
    WHERE status IN ('cobrado','lost')
      AND (payout_date BETWEEN @from AND @to OR sold_date BETWEEN @from AND @to)
    ORDER BY COALESCE(payout_date, sold_date) DESC
  `),
  eventCounts: db.prepare(`
    SELECT evento, COUNT(*) as count, MIN(event_date) as event_date
    FROM stock GROUP BY evento ORDER BY count DESC
  `),
  stockByEvento: db.prepare(`SELECT * FROM stock WHERE evento = ? ORDER BY bought_date ASC`),

  insertExpense: db.prepare(`
    INSERT INTO expenses (id, nombre, fecha, categoria, modo, recurrente, precio_mes, porcentaje,
                          base_meses, base_profit, total_pagado, bot_origin_tag, notas, created_at, updated_at)
    VALUES (@id, @nombre, @fecha, @categoria, @modo, @recurrente, @precio_mes, @porcentaje,
            @base_meses, @base_profit, @total_pagado, @bot_origin_tag, @notas, @created_at, @updated_at)
  `),
  updateExpense: db.prepare(`
    UPDATE expenses SET nombre=@nombre, fecha=@fecha, categoria=@categoria, modo=@modo,
      recurrente=@recurrente, precio_mes=@precio_mes, porcentaje=@porcentaje, base_meses=@base_meses,
      base_profit=@base_profit, total_pagado=@total_pagado, bot_origin_tag=@bot_origin_tag,
      notas=@notas, updated_at=@updated_at
    WHERE id=@id
  `),
  deleteExpense: db.prepare(`DELETE FROM expenses WHERE id = ?`),
  allExpenses: db.prepare(`SELECT * FROM expenses ORDER BY fecha DESC`),

  insertEvent: db.prepare(`
    INSERT OR IGNORE INTO events (id, nombre, event_date, pinned, hidden, notas, created_at, updated_at)
    VALUES (@id, @nombre, @event_date, @pinned, @hidden, @notas, @created_at, @updated_at)
  `),
  updateEvent: db.prepare(`
    UPDATE events SET event_date=@event_date, pinned=@pinned, hidden=@hidden, notas=@notas, updated_at=@updated_at
    WHERE nombre=@nombre
  `),
  allEvents: db.prepare(`SELECT * FROM events`),

  insertOcrLog: db.prepare(`
    INSERT INTO ocr_log (id, uploaded_at, filename, filepath, context, input_tokens, output_tokens,
                         cost_usd, result_json, created_stock_ids, user, error)
    VALUES (@id, @uploaded_at, @filename, @filepath, @context, @input_tokens, @output_tokens,
            @cost_usd, @result_json, @created_stock_ids, @user, @error)
  `),
  updateOcrLogStockIds: db.prepare(`UPDATE ocr_log SET created_stock_ids = ? WHERE id = ?`),

  insertCapital: db.prepare(`
    INSERT INTO capital_movements (id, type, amount, fecha, source, notas, created_at, updated_at)
    VALUES (@id, @type, @amount, @fecha, @source, @notas, @created_at, @updated_at)
  `),
  allCapital: db.prepare(`SELECT * FROM capital_movements ORDER BY fecha DESC, created_at DESC`),
  deleteCapital: db.prepare(`DELETE FROM capital_movements WHERE id = ?`)
};

// -----------------------------------------------------------------------------
// Treasury calc
// -----------------------------------------------------------------------------
function calcTreasury() {
  const all = Q.allStock.all().map(applyStatusAuto);
  const expenses = Q.allExpenses.all();
  const capMovs = Q.allCapital.all();
  const sumRetail = rows => rows.reduce((s, r) => s + (r.price_retail || 0), 0);

  const buckets = {
    sinListar:    all.filter(r => r.status === 'comprado'),
    listado:      all.filter(r => r.status === 'listed'),
    pendingPayout: all.filter(r => r.status === 'sold'),
    cobrados:     all.filter(r => r.status === 'cobrado'),
    perdidas:     all.filter(r => r.status === 'lost')
  };

  const capSinListar = sumRetail(buckets.sinListar);
  const capListado   = sumRetail(buckets.listado);
  const capPending   = buckets.pendingPayout.reduce((s, r) => s + (r.sold_at || r.listed_at || r.price_retail || 0), 0);

  // Cash flow real en el banco (Slash)
  const deposits     = capMovs.filter(m => m.type === 'deposit').reduce((s, m) => s + m.amount, 0);
  const withdrawals  = capMovs.filter(m => m.type === 'withdrawal').reduce((s, m) => s + m.amount, 0);
  const payoutsCobrados = buckets.cobrados.reduce((s, r) => s + (r.payout_amount || 0), 0)
                        + buckets.perdidas.reduce((s, r) => s + (r.payout_amount || 0), 0);
  const compraTickets   = all.reduce((s, r) => s + (r.price_retail || 0), 0); // todo lo invertido en tickets
  const gastosPagados   = expenses.reduce((s, e) => s + (e.total_pagado || 0), 0);
  const totalInvertido  = compraTickets;
  const cashback        = totalInvertido * SLASH_CASHBACK_RATE;

  // Cash actualmente en el banco
  const cashEnBanco = deposits - withdrawals + payoutsCobrados + cashback - compraTickets - gastosPagados;

  // Capital total controlado = cash en banco + valor activo en tickets
  const capitalTotal = cashEnBanco + capSinListar + capListado + capPending;

  // Histórico: profit realizado y pérdidas
  const profitRealizado = buckets.cobrados.reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const lossesNet       = buckets.perdidas.reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);

  // < 7 días sin vender
  const lt7 = all.filter(r => {
    if (r.status === 'cobrado' || r.status === 'lost' || r.status === 'sold') return false;
    const d = daysUntil(r.event_date);
    return d !== null && d >= 0 && d < 7;
  });
  const lt7Cap = sumRetail(lt7);

  return {
    capitalTotal,
    cashback,
    totalInvertido,
    cashEnBanco,
    deposits, withdrawals,
    buckets: {
      cashEnBanco:  { amount: cashEnBanco, count: capMovs.length, label: 'Cash en Slash' },
      sinListar:    { amount: capSinListar, count: buckets.sinListar.length },
      listado:      { amount: capListado,   count: buckets.listado.length },
      pendingPayout:{ amount: capPending,   count: buckets.pendingPayout.length },
      profitRealizado: { amount: profitRealizado, count: buckets.cobrados.length },
      perdidas:     { amount: lossesNet,    count: buckets.perdidas.length }
    },
    lt7: { amount: lt7Cap, count: lt7.length }
  };
}

function applyStatusAuto(r) {
  return { ...r, status: computeStatus(r) };
}

// -----------------------------------------------------------------------------
// Dashboard calc
// -----------------------------------------------------------------------------
function calcDashboard(fromISO, toISO) {
  const all = Q.allStock.all().map(applyStatusAuto);
  const inRange = r => {
    const d = r.bought_date || r.created_at?.slice(0, 10);
    return d >= fromISO && d <= toISO;
  };
  const rows = all.filter(inRange);
  const cerrados = rows.filter(r => r.status === 'cobrado' || r.status === 'lost');

  const profitNeto = cerrados.reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const lost = cerrados.filter(r => r.status === 'lost').reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const ticketsComprados = rows.length;
  const restantesPorVender = all.filter(r => r.status === 'comprado' || r.status === 'listed').length;

  const expenses = Q.allExpenses.all().filter(e => e.fecha >= fromISO && e.fecha <= toISO);
  const expensesTotal = expenses.reduce((s, e) => s + (e.total_pagado || 0), 0);
  const cashback = rows.reduce((s, r) => s + (r.price_retail || 0), 0) * SLASH_CASHBACK_RATE;

  const beneficioNetoReal = profitNeto + cashback - expensesTotal; // lost ya está dentro de profitNeto (negativo)
  const capitalInv = rows.reduce((s, r) => s + (r.price_retail || 0), 0);
  const roi = capitalInv > 0 ? (profitNeto / capitalInv) * 100 : 0;

  // Profit por evento (top 6)
  const byEvento = {};
  for (const r of cerrados) {
    byEvento[r.evento] = (byEvento[r.evento] || 0) + ((r.payout_amount || 0) - (r.price_retail || 0));
  }
  const topEventos = Object.entries(byEvento).sort((a, b) => b[1] - a[1]).slice(0, 6);

  // Profit por selling platform
  const byPlatform = {};
  for (const r of cerrados) {
    const p = r.selling_platform || 'Other';
    byPlatform[p] = (byPlatform[p] || 0) + ((r.payout_amount || 0) - (r.price_retail || 0));
  }

  // Sell rate por evento
  const eventoCount = {}, eventoSold = {};
  for (const r of rows) {
    eventoCount[r.evento] = (eventoCount[r.evento] || 0) + 1;
    if (r.status === 'sold' || r.status === 'cobrado') eventoSold[r.evento] = (eventoSold[r.evento] || 0) + 1;
  }
  const sellRate = Object.keys(eventoCount).map(e => ({
    evento: e, rate: ((eventoSold[e] || 0) / eventoCount[e]) * 100
  })).sort((a, b) => b.rate - a.rate).slice(0, 6);

  // % margen mensual (últimos 5-6 meses)
  const margenMensual = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - i);
    const ym = d.toISOString().slice(0, 7);
    const monthRows = all.filter(r => (r.bought_date || '').startsWith(ym));
    const cap = monthRows.reduce((s, r) => s + (r.price_retail || 0), 0);
    const cerradosMonth = monthRows.filter(r => r.status === 'cobrado' || r.status === 'lost');
    const profit = cerradosMonth.reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
    margenMensual.push({
      mes: ym,
      label: ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][d.getUTCMonth()],
      margen: cap > 0 ? (profit / cap) * 100 : 0
    });
  }

  return {
    ticketsComprados, restantesPorVender, profitNeto, lost, expensesTotal,
    cashback, beneficioNetoReal, roi, topEventos, byPlatform, sellRate, margenMensual
  };
}

// -----------------------------------------------------------------------------
// Event tabs
// -----------------------------------------------------------------------------
function getDynamicEventTabs() {
  const counts = Q.eventCounts.all();
  const events = Object.fromEntries(Q.allEvents.all().map(e => [e.nombre, e]));
  return counts
    .filter(c => {
      const ev = events[c.evento];
      if (ev?.hidden) return false;
      if (ev?.pinned) return true;
      return c.count >= EVENT_AUTO_TAB_THRESHOLD;
    })
    .map(c => ({ ...c, slug: slugify(c.evento) }));
}
function slugify(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// -----------------------------------------------------------------------------
// OCR
// -----------------------------------------------------------------------------
const OCR_PROMPT = `Eres un asistente que extrae datos estructurados de capturas de pantalla de compra o venta de tickets para reventa (KEMIN LLC).

Devuelve EXCLUSIVAMENTE un JSON válido con esta forma (sin markdown, sin texto extra):
{
  "evento": "...",
  "bought_date": "YYYY-MM-DD or null",
  "event_date": "YYYY-MM-DD or null",
  "retailer": "AXS|TICKETMASTER|TICKETONE|TICKETCORNER|SEETICKETS|EVENTIM|OTHER or null",
  "cuenta": "alias de la cuenta del retailer si se ve, ej: axs_es_03",
  "selling_platform": "StubHub|Ticombo|AXS Resale|Viagogo|Vivid Seats|Other or null",
  "ticket_type": "MOBILE TRANSFER|PDF|HARD COPY|OTHER or null",
  "seccion": "...",
  "fila": "...",
  "asiento": "...",
  "n_tickets": <int>,
  "price_retail_per_ticket_usd": <float or null>,
  "price_total_usd": <float or null>,
  "currency_detected": "USD|EUR|GBP|...",
  "confidence": {
    "evento": 0-100,
    "bought_date": 0-100,
    "event_date": 0-100,
    "retailer": 0-100,
    "cuenta": 0-100,
    "seccion": 0-100,
    "fila": 0-100,
    "asiento": 0-100,
    "n_tickets": 0-100,
    "price_retail": 0-100
  },
  "raw_notes": "cualquier dato adicional observado"
}

Reglas:
- Si la captura es del retailer (compra), pon "bought_date" con la fecha visible o today.
- Si es del marketplace (venta), enfócate en sold_at, payout y selling_platform.
- Si hay varios tickets en el mismo precio, devuelve "n_tickets" > 1 (se crearán filas separadas en el panel).
- Para asientos múltiples, devuelve un rango "14-15" o lista "14, 15".
- Si no puedes leer un campo, ponlo a null y baja su confidence.`;

async function ocrTicketImage(imageBase64, mediaType) {
  const client = getAnthropic();
  const t0 = Date.now();
  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: OCR_PROMPT }
      ]
    }]
  });
  const txt = resp.content?.[0]?.text || '';
  let parsed = null, parseErr = null;
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e) { parseErr = e.message; }

  // Coste estimado: Haiku 4.5 ≈ $1/MTok input, $5/MTok output
  const inp = resp.usage?.input_tokens || 0;
  const out = resp.usage?.output_tokens || 0;
  const cost = (inp / 1_000_000) * 1.0 + (out / 1_000_000) * 5.0;

  return {
    parsed, raw: txt, parseError: parseErr,
    input_tokens: inp, output_tokens: out, cost_usd: cost,
    latency_ms: Date.now() - t0
  };
}

// -----------------------------------------------------------------------------
// Express
// -----------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const upload = multer({
  dest: join(__dirname, 'public', 'uploads-tmp'),
  limits: { fileSize: 12 * 1024 * 1024 } // 12 MB
});

// Auth básica
app.use((req, res, next) => {
  if (req.path.startsWith('/api/health')) return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return askAuth(res);
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  if (!PANEL_USERS[user] || PANEL_USERS[user] !== pass) return askAuth(res);
  req.user = user;
  next();
});
function askAuth(res) {
  res.set('WWW-Authenticate', 'Basic realm="KEMIN Panel"');
  return res.status(401).send('Auth required');
}

app.get('/api/health', (req, res) => res.json({ ok: true, ts: nowISO() }));

// =============================================================================
// API — STOCK
// =============================================================================
app.get('/api/stock', (req, res) => {
  const rows = Q.allStock.all().map(applyStatusAuto);
  res.json(rows);
});

app.post('/api/stock', (req, res) => {
  try {
    const row = buildStockRow(req.body, req.user);
    Q.insertStock.run(row);
    upsertEvent(row.evento, row.event_date);
    res.json({ ok: true, id: row.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/stock/bulk', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const ocrLogId = req.body.ocr_log_id || null;
  if (!items.length) return res.status(400).json({ error: 'sin items' });
  try {
    const ids = [];
    const tx = db.transaction((arr) => {
      for (const it of arr) {
        const row = buildStockRow({ ...it, ocr_log_id: ocrLogId }, req.user);
        Q.insertStock.run(row);
        upsertEvent(row.evento, row.event_date);
        ids.push(row.id);
      }
    });
    tx(items);
    if (ocrLogId) Q.updateOcrLogStockIds.run(JSON.stringify(ids), ocrLogId);
    res.json({ ok: true, ids });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/stock/:id', (req, res) => {
  const existing = Q.getStockById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  try {
    const merged = { ...existing, ...req.body, id: existing.id };
    const row = buildStockRow(merged, req.user, /*isUpdate*/ true);
    Q.updateStock.run(row);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/stock/:id', (req, res) => {
  const r = Q.deleteStock.run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

function buildStockRow(input, user, isUpdate = false) {
  const evento = (input.evento || '').trim();
  if (!evento) throw new Error('evento requerido');
  const now = nowISO();
  const partial = {
    id: input.id || randomUUID(),
    evento,
    bought_date: input.bought_date || today(),
    event_date: input.event_date || null,
    retailer: input.retailer || null,
    cuenta: input.cuenta || null,
    selling_platform: input.selling_platform || null,
    ticket_type: input.ticket_type || null,
    seccion: input.seccion || null,
    fila: input.fila || null,
    asiento: input.asiento || null,
    price_retail: numOrNull(input.price_retail),
    listed_at: numOrNull(input.listed_at),
    sold_at: numOrNull(input.sold_at),
    payout_amount: numOrNull(input.payout_amount),
    sold_date: input.sold_date || null,
    payout_date: input.payout_date || null,
    fulfilled: input.fulfilled ? 1 : 0,
    origin: input.origin || 'manual',
    ocr_log_id: input.ocr_log_id || null,
    notas: input.notas || null,
    created_at: input.created_at || now,
    updated_at: now
  };
  partial.status = computeStatus(partial);
  return partial;
}
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function upsertEvent(nombre, event_date) {
  if (!nombre) return;
  const now = nowISO();
  Q.insertEvent.run({
    id: randomUUID(), nombre, event_date: event_date || null,
    pinned: 0, hidden: 0, notas: null, created_at: now, updated_at: now
  });
}

// =============================================================================
// API — EXPENSES
// =============================================================================
app.get('/api/expenses', (req, res) => {
  res.json(Q.allExpenses.all());
});

app.post('/api/expenses', (req, res) => {
  try {
    const row = buildExpenseRow(req.body);
    Q.insertExpense.run(row);
    res.json({ ok: true, id: row.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/expenses/:id', (req, res) => {
  const all = Q.allExpenses.all();
  const existing = all.find(e => e.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  try {
    const merged = { ...existing, ...req.body, id: existing.id };
    const row = buildExpenseRow(merged, true);
    Q.updateExpense.run(row);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', (req, res) => {
  const r = Q.deleteExpense.run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

function buildExpenseRow(input) {
  const nombre = (input.nombre || '').trim();
  if (!nombre) throw new Error('nombre requerido');
  const modo = input.modo || 'fijo';
  const now = nowISO();
  const r = {
    id: input.id || randomUUID(),
    nombre,
    fecha: input.fecha || today(),
    categoria: input.categoria || 'Otro',
    modo,
    recurrente: input.recurrente ? 1 : 0,
    precio_mes: numOrNull(input.precio_mes),
    porcentaje: numOrNull(input.porcentaje),
    base_meses: numOrNull(input.base_meses),
    base_profit: numOrNull(input.base_profit),
    bot_origin_tag: input.bot_origin_tag || null,
    notas: input.notas || null,
    created_at: input.created_at || now,
    updated_at: now,
    total_pagado: null
  };
  if (modo === 'fijo') {
    r.total_pagado = (r.precio_mes || 0) * (r.base_meses || 1);
  } else {
    // % sobre profit: si bot_origin_tag presente, calcular profit de tickets con ese origin
    if (r.bot_origin_tag) {
      const rows = db.prepare(`SELECT * FROM stock WHERE origin = ?`).all(r.bot_origin_tag).map(applyStatusAuto);
      const profit = rows.filter(x => x.status === 'cobrado').reduce((s, x) => s + ((x.payout_amount || 0) - (x.price_retail || 0)), 0);
      r.base_profit = profit;
    }
    r.total_pagado = (r.base_profit || 0) * (r.porcentaje || 0);
  }
  return r;
}

// =============================================================================
// API — EVENTS (pin / hide / notas)
// =============================================================================
app.get('/api/events', (req, res) => res.json(Q.allEvents.all()));
app.patch('/api/events/:nombre', (req, res) => {
  const all = Q.allEvents.all();
  const ev = all.find(e => e.nombre === req.params.nombre);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const merged = { ...ev, ...req.body, updated_at: nowISO() };
  Q.updateEvent.run(merged);
  res.json({ ok: true });
});

// =============================================================================
// API — CAPITAL MOVEMENTS
// =============================================================================
app.get('/api/capital', (req, res) => res.json(Q.allCapital.all()));

app.post('/api/capital', (req, res) => {
  try {
    const type = (req.body.type === 'withdrawal') ? 'withdrawal' : 'deposit';
    const amount = numOrNull(req.body.amount);
    if (!amount || amount <= 0) throw new Error('amount > 0 requerido');
    const now = nowISO();
    const row = {
      id: randomUUID(),
      type,
      amount,
      fecha: req.body.fecha || today(),
      source: req.body.source || 'Slash transfer',
      notas: req.body.notas || null,
      created_at: now,
      updated_at: now
    };
    Q.insertCapital.run(row);
    res.json({ ok: true, id: row.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/capital/:id', (req, res) => {
  const r = Q.deleteCapital.run(req.params.id);
  res.json({ ok: r.changes > 0 });
});

// =============================================================================
// API — OCR
// =============================================================================
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'falta image' });
  const mediaType = req.file.mimetype || 'image/jpeg';
  let result, persistedPath = null;
  try {
    const buf = readFileSync(req.file.path);
    const base64 = buf.toString('base64');
    result = await ocrTicketImage(base64, mediaType);

    // Persist a uploads/YYYY-MM/
    const ym = new Date().toISOString().slice(0, 7);
    const dir = join(UPLOADS_DIR, ym);
    mkdirSync(dir, { recursive: true });
    const ext = extname(req.file.originalname) || '.jpg';
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    persistedPath = join(dir, filename);
    renameSync(req.file.path, persistedPath);

    // Log
    const logId = randomUUID();
    Q.insertOcrLog.run({
      id: logId,
      uploaded_at: nowISO(),
      filename: req.file.originalname || filename,
      filepath: `${ym}/${filename}`,
      context: req.body.context || 'compra',
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      cost_usd: result.cost_usd,
      result_json: JSON.stringify(result.parsed || { raw: result.raw }),
      created_stock_ids: null,
      user: req.user || null,
      error: result.parseError || null
    });

    res.json({
      ok: true,
      ocr_log_id: logId,
      fields: result.parsed || {},
      confidence: result.parsed?.confidence || {},
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      raw: result.parseError ? result.raw : undefined
    });
  } catch (e) {
    try { if (req.file?.path) unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// =============================================================================
// HTML render
// =============================================================================
app.get('/', (req, res) => {
  const treasury = calcTreasury();
  const stockAll = Q.allStock.all().map(applyStatusAuto);
  const stockActive = stockAll.filter(r => r.status !== 'cobrado' && r.status !== 'lost');
  const expenses = Q.allExpenses.all();
  const eventTabs = getDynamicEventTabs();
  const finalizadosPeriod = req.query.fin_period || today().slice(0, 7);
  const finalizadosFrom = finalizadosPeriod + '-01';
  const finalizadosTo = finalizadosPeriod + '-31';
  const finalizados = Q.finalizadosByPeriod.all({ from: finalizadosFrom, to: finalizadosTo }).map(applyStatusAuto);

  const dashFrom = today().slice(0, 4) + '-01-01';
  const dashTo = today();
  const dash = calcDashboard(dashFrom, dashTo);

  res.set('Cache-Control', 'no-store');
  res.send(renderPage({
    user: req.user,
    treasury, stockAll, stockActive, expenses, eventTabs,
    finalizados, finalizadosPeriod, dash,
    constants: { RETAILERS, SELLING_PLATFORMS, TICKET_TYPES, EXPENSE_CATEGORIES, STATUSES }
  }));
});

// Servir capturas con auth ya aplicada
app.get('/uploads/*', (req, res) => {
  const rel = req.params[0];
  if (rel.includes('..')) return res.status(400).end();
  const fp = join(UPLOADS_DIR, rel);
  if (!existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

// =============================================================================
// HTML template
// =============================================================================
function renderPage(ctx) {
  const { treasury, stockActive, expenses, eventTabs, finalizados, dash, constants } = ctx;

  const retailerOptions = constants.RETAILERS.map(r => `<option value="${r}">${r}</option>`).join('');
  const platformOptions = constants.SELLING_PLATFORMS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  const expCatOptions = constants.EXPENSE_CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  const stockRows = stockActive.map(r => renderStockRow(r)).join('');
  const expenseRows = expenses.map(e => renderExpenseRow(e)).join('');
  const finalRows = finalizados.map(r => renderFinalRow(r)).join('');

  const eventTabsHtml = eventTabs.map(t =>
    `<div class="tab dyn" data-tab="ev-${t.slug}">${esc(t.evento)} · ${t.count}</div>`
  ).join('');
  const eventPagesHtml = eventTabs.map(t => renderEventPage(t)).join('');

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>KEMIN · Panel</title>
<meta name="theme-color" content="#07090d" />
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#1d4ed8'/><stop offset='55%' stop-color='#22d3ee'/><stop offset='100%' stop-color='#a5f3fc'/></linearGradient></defs><rect width='64' height='64' rx='14' fill='#07090d'/><rect x='2' y='2' width='60' height='60' rx='12' fill='url(#g)' opacity='0.95'/><text x='32' y='44' text-anchor='middle' font-family='Georgia,serif' font-style='italic' font-weight='700' font-size='34' fill='#07090d' letter-spacing='-2'>KF</text><path d='M 14 53 Q 32 58 50 53' stroke='#07090d' stroke-width='1.6' fill='none' stroke-linecap='round'/></svg>`)}" />
<link rel="apple-touch-icon" href="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#1d4ed8'/><stop offset='55%' stop-color='#22d3ee'/><stop offset='100%' stop-color='#a5f3fc'/></linearGradient></defs><rect width='64' height='64' rx='14' fill='#07090d'/><rect x='2' y='2' width='60' height='60' rx='12' fill='url(#g)'/><text x='32' y='44' text-anchor='middle' font-family='Georgia,serif' font-style='italic' font-weight='700' font-size='34' fill='#07090d' letter-spacing='-2'>KF</text></svg>`)}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>${CSS}</style>
</head>
<body>
<div class="container">

  <header>
    <div class="brand-block">
      <div class="logo-mark" aria-label="KF monogram · Kevin + Fer">
        <svg viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="kgrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#e6edf6"/>
              <stop offset="100%" stop-color="#a5f3fc"/>
            </linearGradient>
          </defs>
          <text x="60" y="68" text-anchor="middle"
                font-family="'Playfair Display', serif"
                font-style="italic" font-weight="700"
                font-size="78" fill="url(#kgrad)"
                letter-spacing="-6">KF</text>
          <path d="M 18 86 Q 60 96 102 86" stroke="url(#kgrad)" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="brand-text">
        <div class="brand">KEMIN LLC</div>
        <div class="brand-sub">Panel de Tickets</div>
      </div>
    </div>
    <div class="header-right">
      <div class="user-chip">${esc(ctx.user || '')} · sesión activa</div>
      <div class="meta-info">${esc(new Date().toLocaleString('es-ES'))}</div>
    </div>
  </header>

  <nav class="tabs stagger">
    <div class="tab tab-treasury active" data-tab="tesoreria">💰 Tesorería</div>
    <div class="tab" data-tab="stock">Stock <span class="tab-badge">${stockActive.length}</span></div>
    <div class="tab" data-tab="expenses">Expenses</div>
    <div class="tab" data-tab="dashboard">Dashboard</div>
    <div class="tab" data-tab="finalizados">Finalizados <span class="tab-badge">${finalizados.length}</span></div>
    ${eventTabsHtml}
  </nav>

  ${renderTesoreriaPage(treasury)}
  ${renderStockPage(stockRows, stockActive.length, constants)}
  ${renderExpensesPage(expenseRows, expenses)}
  ${renderDashboardPage(dash)}
  ${renderFinalizadosPage(finalRows, finalizados, ctx.finalizadosPeriod)}
  ${eventPagesHtml}

  <div class="mockup-note">
    🟢 Panel en producción · datos reales desde SQLite · OCR vía Claude vision.
    Click "📸 Subir captura" en Stock para autodetectar tickets · "⋯" en cualquier fila para editar/eliminar.
  </div>
</div>

${renderOcrModal()}
${renderEditModal(constants)}
${renderCapitalModal()}

<script>
window.KEMIN = ${jsonScript({ retailers: constants.RETAILERS, platforms: constants.SELLING_PLATFORMS, ticketTypes: constants.TICKET_TYPES, expenseCats: constants.EXPENSE_CATEGORIES, statuses: constants.STATUSES })};
${CLIENT_JS}
</script>
</body></html>`;
}

function renderTesoreriaPage(t) {
  const total = t.capitalTotal;
  const buckets = t.buckets;
  const pct = v => total > 0 ? Math.round((Math.max(0, v) / total) * 100) : 0;
  return `
  <section class="page active" id="page-tesoreria">
    <h1 class="section-title collapsible"><span class="chev">▾</span> ¿Dónde está el dinero ahora mismo?</h1>
    <p class="section-sub">Cash en banco + lo que está invertido en tickets. Foto en vivo.</p>

    <div class="collapse-target">
      <div class="treasury-hero">
        <div class="treasury-total">
          <div class="treasury-label">Capital total controlado</div>
          <div class="treasury-value">${fmtUSD(total)}</div>
          <div class="treasury-delta">${t.deposits > 0 ? `${fmtUSD(t.deposits)} aportado · ${fmtUSD(t.cashback)} cashback` : 'snapshot ahora'}</div>
        </div>
        <div class="treasury-bars">
          ${bar('d-green', '💵 Cash en Slash (disponible)', buckets.cashEnBanco.amount, pct(buckets.cashEnBanco.amount), '--green')}
          ${bar('d-cyan', '🛒 Stock sin listar', buckets.sinListar.amount, pct(buckets.sinListar.amount), '--cyan')}
          ${bar('d-blue', '🏷 Stock listado para vender', buckets.listado.amount, pct(buckets.listado.amount), '--blue')}
          ${bar('d-amber', '⏳ Vendido sin payout', buckets.pendingPayout.amount, pct(buckets.pendingPayout.amount), '--amber')}
        </div>
      </div>
      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-bottom: 26px;">
        <button class="btn-ghost btn" onclick="openCapitalModal('withdrawal')">⤓ Retiro</button>
        <button class="btn" onclick="openCapitalModal('deposit')">＋ Capital injection</button>
      </div>
    </div>

    <h1 class="section-title collapsible"><span class="chev">▾</span> Desglose por bucket</h1>
    <p class="section-sub">Click en cada bucket → te lleva a la vista filtrada en Stock.</p>

    <div class="collapse-target">
      <div class="kpi-grid stagger">
        ${kpiCard('💵 Cash en Slash', fmtUSD(buckets.cashEnBanco.amount), `disponible para comprar`, 'accent-green', null, 'Depósitos − retiros + payouts + cashback − compras − gastos')}
        ${kpiCard('🛒 Stock sin listar', fmtUSD(buckets.sinListar.amount), `${buckets.sinListar.count} tickets · esperando publicación`, 'accent-cyan clickable', 'comprado')}
        ${kpiCard('🏷 Stock listado', fmtUSD(buckets.listado.amount), `${buckets.listado.count} tickets · en marketplaces`, 'accent-blue clickable', 'listed')}
        ${kpiCard('⏳ Vendido sin payout', fmtUSD(buckets.pendingPayout.amount), `${buckets.pendingPayout.count} tickets · pendiente cobro`, 'accent-amber clickable', 'sold')}
        ${kpiCard('✅ Profit realizado', (buckets.profitRealizado.amount >= 0 ? '+' : '') + fmtUSD(buckets.profitRealizado.amount), `${buckets.profitRealizado.count} cerrados con beneficio`, 'accent-green clickable', 'cobrado')}
        ${kpiCard('📉 Pérdidas realizadas', fmtUSD(buckets.perdidas.amount), `${buckets.perdidas.count} tickets cerrados a pérdida`, 'accent-red clickable', 'lost')}
        ${kpiCard('⏰ < 7 días, sin vender', fmtUSD(t.lt7.amount), `${t.lt7.count} tickets · urge bajar precio`, 'clickable', null)}
        ${kpiCard('💳 Cashback Slash (2%)', fmtUSD(t.cashback), `${fmtUSD(t.totalInvertido)} invertido × 2%`, 'accent-green', null, 'Slash devuelve 2% por cada compra. Sumado al cash en banco.')}
      </div>
    </div>
  </section>`;
}

function bar(dot, label, amount, pct, colorVar) {
  return `
  <div class="bar-row">
    <div class="bar-meta"><span class="dot ${dot}"></span> ${label}</div>
    <div class="bar-track"><div class="bar-fill" style="width: ${pct}%; background: var(${colorVar});"></div></div>
    <div class="bar-val">${fmtUSD(amount)}<span class="bar-pct">${pct}%</span></div>
  </div>`;
}
function kpiCard(label, value, delta, cls = '', filter = null, title = '') {
  return `
  <div class="kpi ${cls}" ${title ? `title="${escAttr(title)}"` : ''} ${filter ? `data-stock-filter="${filter}"` : ''}>
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-delta">${delta}</div>
  </div>`;
}

function renderStockPage(rowsHtml, count, constants) {
  const retailerOptions = constants.RETAILERS.map(r => `<option value="${r}">${r}</option>`).join('');
  return `
  <section class="page" id="page-stock">
    <h1 class="section-title collapsible"><span class="chev">▾</span> Resumen Stock</h1>
    <p class="section-sub">${count} tickets activos. KPIs derivados de Tesorería.</p>

    <h1 class="section-title collapsible" style="margin-top: 24px;"><span class="chev">▾</span> Tickets en stock</h1>
    <p class="section-sub">Filtrable, ordenable y editable inline.</p>

    <div class="collapse-target">
      <div class="toolbar">
        <input type="text" id="stock-search" placeholder="🔍 Buscar evento, sección, fila…" />
        <select id="stock-filter-evento"><option value="">Todos los eventos</option></select>
        <select id="stock-filter-retailer">
          <option value="">Todos los retailers</option>
          ${retailerOptions}
        </select>
        <select id="stock-filter-status">
          <option value="">Estado: Todos</option>
          <option value="comprado">Comprado (sin listar)</option>
          <option value="listed">Listed</option>
          <option value="sold">Vendido (pending payout)</option>
          <option value="cobrado">Cobrado</option>
          <option value="lost">Lost</option>
        </select>
        <div class="spacer"></div>
        <button class="btn btn-ocr" onclick="openOcrModal()">📸 Subir captura</button>
        <button class="btn" onclick="openEditModal('stock', null)">＋ Nuevo ticket</button>
      </div>

      <div class="table-wrap">
        <table id="stock-table">
          <thead>
            <tr>
              <th>Evento</th>
              <th>Bought</th>
              <th>Event</th>
              <th>Retailer</th>
              <th>Cuenta</th>
              <th>Selling</th>
              <th>Sección / Fila / Asiento</th>
              <th class="num">Retail</th>
              <th class="num">Listed</th>
              <th class="num">Sold At</th>
              <th class="num">Payout</th>
              <th class="num">Profit</th>
              <th>Estado</th>
              <th class="row-actions">⋯</th>
            </tr>
          </thead>
          <tbody>${rowsHtml || `<tr><td colspan="14" style="text-align:center;color:var(--text-mute);padding:32px;">Sin tickets aún. Click <strong>＋ Nuevo ticket</strong> o <strong>📸 Subir captura</strong>.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderStockRow(r) {
  const profit = (r.payout_amount != null && r.price_retail != null)
    ? (r.payout_amount - r.price_retail) : null;
  const profitCls = profit > 0 ? 'profit-pos' : (profit < 0 ? 'profit-neg' : '');
  const profitStr = profit != null ? (profit >= 0 ? '+' + fmtUSD(profit) : fmtUSD(profit)) : '—';
  const seccion = [r.seccion, r.fila, r.asiento].filter(Boolean).join(' · ') || '—';
  const rtag = retailerTag(r.retailer);
  const statusPill = statusToPill(r.status);
  return `
  <tr data-id="${escAttr(r.id)}" data-status="${escAttr(r.status)}" data-evento="${escAttr(r.evento)}" data-retailer="${escAttr(r.retailer || '')}">
    <td><strong>${esc(r.evento)}</strong></td>
    <td>${fmtDateShort(r.bought_date)}</td>
    <td>${fmtDateShort(r.event_date)}</td>
    <td>${rtag}</td>
    <td class="acct">${esc(r.cuenta || '—')}</td>
    <td>${r.selling_platform ? `<span class="pill pill-blue">${esc(r.selling_platform)}</span>` : '—'}</td>
    <td class="editable">${esc(seccion)}</td>
    <td class="num">${fmtUSD(r.price_retail)}</td>
    <td class="num">${fmtUSD(r.listed_at)}</td>
    <td class="num">${fmtUSD(r.sold_at)}</td>
    <td class="num">${fmtUSD(r.payout_amount, 2)}</td>
    <td class="num ${profitCls}">${profitStr}</td>
    <td>${statusPill}</td>
    <td><button class="row-menu" onclick="rowMenu(event, 'stock', '${escAttr(r.id)}')">⋯</button></td>
  </tr>`;
}

function retailerTag(r) {
  if (!r) return '<span class="retailer-tag r-OT">—</span>';
  const map = { 'TICKETMASTER': 'TM', 'TICKETONE': 'TO', 'TICKETCORNER': 'TC', 'SEETICKETS': 'ST', 'EVENTIM': 'EV', 'OTHER': 'OT' };
  const cls = 'r-' + (map[r] || r);
  return `<span class="retailer-tag ${cls}">${esc(r === 'TICKETMASTER' ? 'TM' : r === 'TICKETONE' ? 'TO' : r === 'TICKETCORNER' ? 'TC' : r === 'SEETICKETS' ? 'ST' : r === 'EVENTIM' ? 'EV' : r === 'OTHER' ? 'OT' : r)}</span>`;
}
function statusToPill(s) {
  const map = {
    'comprado': '<span class="pill pill-mute">🛒 Comprado</span>',
    'listed':   '<span class="pill pill-blue">🏷 Listed</span>',
    'sold':     '<span class="pill pill-pending">⏳ Pending payout</span>',
    'cobrado':  '<span class="pill pill-yes">💵 Cobrado</span>',
    'lost':     '<span class="pill pill-no">📉 Lost</span>'
  };
  return map[s] || '';
}

function renderExpensesPage(rowsHtml, expenses) {
  const ytd = expenses.reduce((s, e) => s + (e.total_pagado || 0), 0);
  const recurrente = expenses.filter(e => e.recurrente && e.modo === 'fijo').reduce((s, e) => s + (e.precio_mes || 0), 0);
  const botops = expenses.filter(e => e.modo === 'porcentaje').reduce((s, e) => s + (e.total_pagado || 0), 0);
  const thisMonth = today().slice(0, 7);
  const mes = expenses.filter(e => e.fecha.startsWith(thisMonth)).reduce((s, e) => s + (e.total_pagado || 0), 0);
  return `
  <section class="page" id="page-expenses">
    <h1 class="section-title collapsible"><span class="chev">▾</span> Resumen Expenses</h1>
    <p class="section-sub">Proxies, bots, suscripciones, servidor, comisiones bot-op.</p>

    <div class="kpi-grid stagger collapse-target">
      ${kpiCard('Gastos totales (YTD)', fmtUSD(ytd), `${expenses.length} líneas`, '')}
      ${kpiCard('Mensualidad fija', fmtUSD(recurrente) + '<span class="unit">/mes</span>', `${expenses.filter(e => e.recurrente && e.modo === 'fijo').length} suscripciones`, 'accent-cyan')}
      ${kpiCard('🤖 Comisiones bot-op', fmtUSD(botops), 'sobre profit acumulado', 'accent-violet', null, 'Operadores externos que cobran % sobre profit')}
      ${kpiCard('Gasto este mes', fmtUSD(mes), 'mes en curso', 'accent-amber')}
    </div>

    <h1 class="section-title collapsible" style="margin-top: 24px;"><span class="chev">▾</span> Listado de gastos</h1>
    <p class="section-sub">Recurrentes y puntuales · fijos y % sobre ganancia.</p>

    <div class="collapse-target">
      <div class="toolbar">
        <input type="text" id="exp-search" placeholder="🔍 Buscar gasto…" />
        <div class="spacer"></div>
        <button class="btn" onclick="openEditModal('expense', null)">＋ Nuevo gasto</button>
      </div>
      <div class="table-wrap">
        <table id="exp-table">
          <thead>
            <tr>
              <th>Gasto</th>
              <th>Fecha</th>
              <th>Categoría</th>
              <th>Modo</th>
              <th>Recurrente</th>
              <th class="num">Precio / %</th>
              <th class="num">Base</th>
              <th class="num">Total pagado</th>
              <th class="row-actions">⋯</th>
            </tr>
          </thead>
          <tbody>${rowsHtml || `<tr><td colspan="9" style="text-align:center;color:var(--text-mute);padding:32px;">Sin gastos aún. Click <strong>＋ Nuevo gasto</strong>.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderExpenseRow(e) {
  const modoPill = e.modo === 'porcentaje'
    ? '<span class="pill pill-cyan">% ganancia</span>'
    : '<span class="pill pill-mute">Fijo</span>';
  const recurrentePill = e.recurrente ? '<span class="pill pill-yes">Sí</span>' : '<span class="pill pill-no">No</span>';
  const precio = e.modo === 'porcentaje' ? ((e.porcentaje || 0) * 100).toFixed(1) + '%' : fmtUSD(e.precio_mes, 2);
  const base = e.modo === 'porcentaje'
    ? `${fmtUSD(e.base_profit, 0)} profit`
    : `${e.base_meses || 1} ${e.base_meses === 1 ? 'pago' : 'meses'}`;
  const catPillCls = {
    'Proxy': 'pill-cyan', 'Bot': 'pill-violet', 'Suscripción': 'pill-blue',
    'Servidor': 'pill-cyan', 'Bot operator': 'pill-violet', 'Otro': 'pill-mute'
  }[e.categoria || 'Otro'] || 'pill-mute';
  const nombrePrefix = e.modo === 'porcentaje' ? '🤖 ' : '';
  return `
  <tr data-id="${escAttr(e.id)}">
    <td><strong>${nombrePrefix}${esc(e.nombre)}</strong></td>
    <td>${fmtDateShort(e.fecha)}</td>
    <td><span class="pill ${catPillCls}">${esc(e.categoria || 'Otro')}</span></td>
    <td>${modoPill}</td>
    <td>${recurrentePill}</td>
    <td class="num">${precio}</td>
    <td class="num">${base}</td>
    <td class="num">${fmtUSD(e.total_pagado, 2)}</td>
    <td><button class="row-menu" onclick="rowMenu(event, 'expense', '${escAttr(e.id)}')">⋯</button></td>
  </tr>`;
}

function renderDashboardPage(d) {
  const margenLabels = d.margenMensual.map(m => m.label);
  const margenData = d.margenMensual.map(m => Math.round(m.margen));
  const eventoLabels = d.topEventos.map(e => e[0]);
  const eventoData = d.topEventos.map(e => Math.round(e[1]));
  const platformLabels = Object.keys(d.byPlatform);
  const platformData = platformLabels.map(p => Math.round(d.byPlatform[p]));
  const sellLabels = d.sellRate.map(s => s.evento);
  const sellData = d.sellRate.map(s => Math.round(s.rate));

  return `
  <section class="page" id="page-dashboard">
    <h1 class="section-title collapsible"><span class="chev">▾</span> Resumen Dashboard</h1>
    <p class="section-sub">Visión general · YTD ${today().slice(0, 4)}.</p>

    <div class="collapse-target">
      <div class="kpi-grid stagger">
        ${kpiCard('Tickets comprados', d.ticketsComprados, 'YTD')}
        ${kpiCard('🎟 Restantes por vender', d.restantesPorVender, 'activos en stock', 'accent-cyan')}
        ${kpiCard('Profit neto', (d.profitNeto >= 0 ? '+' : '') + fmtUSD(d.profitNeto), 'realizado', 'accent-green')}
        ${kpiCard('Lost', fmtUSD(d.lost), 'tickets fallidos', 'accent-red')}
        ${kpiCard('Expenses', fmtUSD(d.expensesTotal), 'incluye bot-ops', 'accent-amber')}
        ${kpiCard('Beneficio neto real', (d.beneficioNetoReal >= 0 ? '+' : '') + fmtUSD(d.beneficioNetoReal), 'Profit + Cashback − Lost − Gastos', 'accent-cyan', null, 'Profit cerrado − Pérdidas − Gastos operativos + Cashback Slash 2%')}
        ${kpiCard('ROI total', fmtPct(d.roi, 0), 'sobre capital invertido')}
      </div>
    </div>

    <h1 class="section-title collapsible" style="margin-top: 24px;"><span class="chev">▾</span> Gráficos</h1>
    <p class="section-sub">Margen, profit por dimensión, tasa de venta.</p>

    <div class="collapse-target">
      <div class="chart-row equal">
        <div class="chart-card">
          <div class="chart-title">% margen mensual</div>
          <div class="chart-sub">Profit neto / capital invertido en el mes</div>
          <div class="chart-canvas-wrap"><canvas id="chartMargin"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Profit por evento</div>
          <div class="chart-sub">Top 6 eventos · neto USD</div>
          <div class="chart-canvas-wrap"><canvas id="chartEvento"></canvas></div>
        </div>
      </div>
      <div class="chart-row equal" style="margin-top: 16px;">
        <div class="chart-card">
          <div class="chart-title">Profit por selling platform</div>
          <div class="chart-sub">Para detectar mejor canal de salida</div>
          <div class="chart-canvas-wrap"><canvas id="chartPlatform"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Tasa de venta por evento</div>
          <div class="chart-sub">% vendidos / total comprados</div>
          <div class="chart-canvas-wrap"><canvas id="chartSellRate"></canvas></div>
        </div>
      </div>
    </div>
  </section>

  <script>
    window.DASHBOARD_DATA = ${jsonScript({ margenLabels, margenData, eventoLabels, eventoData, platformLabels, platformData, sellLabels, sellData })};
  </script>`;
}

function renderFinalizadosPage(rowsHtml, finalizados, period) {
  const profit = finalizados.reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const losses = finalizados.filter(r => r.status === 'lost').reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const mejor = finalizados.reduce((acc, r) => {
    const p = (r.payout_amount || 0) - (r.price_retail || 0);
    return (!acc || p > acc.p) ? { p, evento: r.evento } : acc;
  }, null);
  return `
  <section class="page" id="page-finalizados">
    <h1 class="section-title collapsible"><span class="chev">▾</span> Finalizados</h1>
    <p class="section-sub">Tickets vendidos y cobrados · filtrable por periodo.</p>

    <div class="collapse-target">
      <div class="toolbar">
        <select id="fin-granularity">
          <option value="mes" selected>Granularidad: Mes</option>
          <option value="año">Año</option>
          <option value="semana">Semana</option>
          <option value="dia">Día</option>
        </select>
        <input type="month" id="fin-period" value="${escAttr(period)}" />
        <div class="spacer"></div>
        <button class="btn-ghost btn" onclick="exportCSV('finalizados')">⤓ Exportar CSV</button>
      </div>
      <div class="kpi-grid stagger" style="margin-top: 16px;">
        ${kpiCard('Operaciones cerradas', finalizados.length, period)}
        ${kpiCard('Profit cerrado', (profit >= 0 ? '+' : '') + fmtUSD(profit), 'realizado', 'accent-green')}
        ${kpiCard('Pérdidas cerradas', fmtUSD(losses), `${finalizados.filter(r => r.status === 'lost').length} a pérdida`, 'accent-red')}
        ${kpiCard('Mejor venta', mejor ? '+' + fmtUSD(mejor.p) : '—', mejor ? esc(mejor.evento) : '—', 'accent-amber')}
      </div>
    </div>

    <h1 class="section-title collapsible" style="margin-top: 24px;"><span class="chev">▾</span> Detalle de operaciones cerradas</h1>
    <p class="section-sub">Solo lectura.</p>

    <div class="collapse-target">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Evento</th><th>Cerrado</th><th>Retailer</th><th>Selling</th>
              <th class="num">Retail</th><th class="num">Sold At</th><th class="num">Payout</th>
              <th class="num">Profit</th><th class="num">ROI</th><th class="row-actions">⋯</th>
            </tr>
          </thead>
          <tbody>${rowsHtml || `<tr><td colspan="10" style="text-align:center;color:var(--text-mute);padding:32px;">Sin tickets cerrados en este periodo.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderFinalRow(r) {
  const profit = (r.payout_amount || 0) - (r.price_retail || 0);
  const profitCls = profit > 0 ? 'profit-pos' : (profit < 0 ? 'profit-neg' : '');
  const roi = r.price_retail ? (profit / r.price_retail) * 100 : 0;
  return `
  <tr data-id="${escAttr(r.id)}">
    <td>${esc(r.evento)}</td>
    <td>${fmtDateShort(r.payout_date || r.sold_date)}</td>
    <td>${retailerTag(r.retailer)}</td>
    <td>${r.selling_platform ? `<span class="pill pill-blue">${esc(r.selling_platform)}</span>` : '—'}</td>
    <td class="num">${fmtUSD(r.price_retail)}</td>
    <td class="num">${fmtUSD(r.sold_at)}</td>
    <td class="num">${fmtUSD(r.payout_amount, 2)}</td>
    <td class="num ${profitCls}">${profit >= 0 ? '+' : ''}${fmtUSD(profit)}</td>
    <td class="num">${fmtPct(roi, 0)}</td>
    <td><button class="row-menu" onclick="rowMenu(event, 'stock', '${escAttr(r.id)}')">⋯</button></td>
  </tr>`;
}

function renderEventPage(t) {
  const rows = Q.stockByEvento.all(t.evento).map(applyStatusAuto);
  const cap = rows.reduce((s, r) => s + (r.price_retail || 0), 0);
  const sold = rows.filter(r => r.status === 'sold' || r.status === 'cobrado').length;
  const profitCerrado = rows.filter(r => r.status === 'cobrado' || r.status === 'lost')
    .reduce((s, r) => s + ((r.payout_amount || 0) - (r.price_retail || 0)), 0);
  const roi = cap > 0 ? (profitCerrado / cap) * 100 : 0;
  const tbody = rows.map(r => {
    const profit = (r.payout_amount || 0) - (r.price_retail || 0);
    return `<tr data-id="${escAttr(r.id)}"><td>${fmtDateShort(r.bought_date)}</td><td>${retailerTag(r.retailer)}</td><td class="acct">${esc(r.cuenta || '—')}</td><td>${r.selling_platform ? `<span class="pill pill-blue">${esc(r.selling_platform)}</span>` : '—'}</td><td>${esc([r.seccion, r.fila, r.asiento].filter(Boolean).join(' · ') || '—')}</td><td class="num">${fmtUSD(r.price_retail)}</td><td class="num">${fmtUSD(r.listed_at)}</td><td class="num">${r.status === 'cobrado' || r.status === 'lost' ? (profit >= 0 ? '+' : '') + fmtUSD(profit) : '—'}</td><td>${statusToPill(r.status)}</td><td><button class="row-menu" onclick="rowMenu(event, 'stock', '${escAttr(r.id)}')">⋯</button></td></tr>`;
  }).join('');

  return `
  <section class="page" id="page-ev-${t.slug}">
    <div class="event-banner">
      <div class="event-banner-left">
        <h2>◆ ${esc(t.evento)}</h2>
        <p>${t.event_date ? fmtDateShort(t.event_date) : 'sin fecha'} · pestaña auto-generada (${rows.length} tickets)</p>
      </div>
      <div class="event-banner-right">
        <div class="mini-kpi"><div class="l">Capital</div><div class="v">${fmtUSD(cap)}</div></div>
        <div class="mini-kpi"><div class="l">Vendidos</div><div class="v">${sold} / ${rows.length}</div></div>
        <div class="mini-kpi"><div class="l">Profit cerrado</div><div class="v" style="color: var(--green);">${profitCerrado >= 0 ? '+' : ''}${fmtUSD(profitCerrado)}</div></div>
        <div class="mini-kpi"><div class="l">ROI</div><div class="v" style="color: var(--green);">${fmtPct(roi, 0)}</div></div>
      </div>
    </div>
    <h1 class="section-title collapsible" style="margin-top: 22px;"><span class="chev">▾</span> Tickets de ${esc(t.evento)}</h1>
    <div class="collapse-target">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Bought</th><th>Retailer</th><th>Cuenta</th><th>Selling</th><th>Sección / Fila / Asiento</th><th class="num">Retail</th><th class="num">Listed</th><th class="num">Profit</th><th>Estado</th><th class="row-actions">⋯</th></tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    </div>
  </section>`;
}

function renderCapitalModal() {
  return `
<div class="modal-overlay" id="capital-modal">
  <div class="modal" style="max-width: 520px;">
    <div class="modal-header">
      <h2 id="capital-modal-title">💵 Movimiento de capital</h2>
      <button class="close" onclick="closeModal('capital-modal')">✕</button>
    </div>
    <div class="modal-body" style="grid-template-columns: 1fr; padding: 24px 28px;">
      <form id="capital-form" onsubmit="return saveCapital(event)">
        <input type="hidden" name="type" value="deposit" />
        <div class="ocr-field"><label>Cantidad (USD) *</label><input type="number" step="0.01" name="amount" required placeholder="25000" /></div>
        <div class="ocr-field-row">
          <div class="ocr-field"><label>Fecha</label><input type="date" name="fecha" /></div>
          <div class="ocr-field" style="grid-column: span 2;"><label>Origen</label><input type="text" name="source" placeholder="Slash transfer" value="Slash transfer" /></div>
        </div>
        <div class="ocr-field"><label>Notas (opcional)</label><input type="text" name="notas" placeholder="ej. capital inicial Fer+Kevin 50/50" /></div>
        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px;">
          <button type="button" class="btn btn-ghost" onclick="closeModal('capital-modal')">Cancelar</button>
          <button type="submit" class="btn">✓ Guardar</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}

function renderOcrModal() {
  return `
<div class="modal-overlay" id="ocr-modal">
  <div class="modal">
    <div class="modal-header">
      <div>
        <h2>📸 Detección automática desde captura</h2>
        <div style="font-size: 12px; color: var(--text-mute); margin-top: 4px;">Sube la captura del retailer o del marketplace. Los campos se autorellenan — edita lo que haga falta y guarda.</div>
      </div>
      <button class="close" onclick="closeModal('ocr-modal')">✕</button>
    </div>
    <div class="modal-body">
      <div class="modal-drop" id="ocr-drop">
        <input type="file" id="ocr-file" accept="image/*" style="display:none;" />
        <div class="preview" id="ocr-preview">click o arrastra una captura aquí</div>
        <div class="hint">jpg / png / heic · máx 12 MB</div>
        <div id="ocr-loading" style="display:none; margin-top: 14px; color: var(--cyan); font-size: 13px;">⏳ Analizando con Claude vision…</div>
      </div>
      <div class="modal-fields" id="ocr-fields">
        <div class="ocr-status" id="ocr-status">Sube una captura para empezar.</div>
        <div id="ocr-form" style="display:none;">
          ${ocrField('Evento', 'evento', 'text')}
          <div class="ocr-field-row">
            ${ocrField('Bought Date', 'bought_date', 'date')}
            ${ocrField('Event Date', 'event_date', 'date')}
            ${ocrSelect('Retailer', 'retailer', ['', ...RETAILERS])}
          </div>
          <div class="ocr-field-row">
            ${ocrField('Sección', 'seccion', 'text')}
            ${ocrField('Fila', 'fila', 'text')}
            ${ocrField('Asiento', 'asiento', 'text')}
          </div>
          <div class="ocr-field-row">
            ${ocrField('Precio retail (USD)', 'price_retail', 'number')}
            ${ocrField('N tickets', 'n_tickets', 'number')}
            ${ocrField('Cuenta del retailer', 'cuenta', 'text')}
          </div>
          ${ocrSelect('Selling platform', 'selling_platform', ['', ...SELLING_PLATFORMS])}
          ${ocrField('Notas', 'notas', 'text')}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <div class="left" id="ocr-footer-info">—</div>
      <div style="display: flex; gap: 10px;">
        <button class="btn btn-ghost" onclick="closeModal('ocr-modal')">Cancelar</button>
        <button class="btn" id="ocr-confirm" disabled onclick="confirmOcr()">✓ Crear tickets</button>
      </div>
    </div>
  </div>
</div>`;
}

function ocrField(label, name, type) {
  return `<div class="ocr-field"><label>${label} <span class="conf" id="conf-${name}">—</span></label><input type="${type}" name="${name}" /></div>`;
}
function ocrSelect(label, name, options) {
  return `<div class="ocr-field"><label>${label} <span class="conf" id="conf-${name}">—</span></label><select name="${name}">${options.map(o => `<option value="${esc(o)}">${esc(o) || '—'}</option>`).join('')}</select></div>`;
}

function renderEditModal(constants) {
  const retailerOpts = ['', ...constants.RETAILERS].map(r => `<option value="${r}">${r || '—'}</option>`).join('');
  const platformOpts = ['', ...constants.SELLING_PLATFORMS].map(p => `<option value="${esc(p)}">${esc(p) || '—'}</option>`).join('');
  const ticketTypeOpts = ['', ...constants.TICKET_TYPES].map(t => `<option value="${esc(t)}">${esc(t) || '—'}</option>`).join('');
  const expCatOpts = ['', ...constants.EXPENSE_CATEGORIES].map(c => `<option value="${esc(c)}">${esc(c) || '—'}</option>`).join('');
  return `
<div class="modal-overlay" id="edit-modal">
  <div class="modal" style="max-width: 720px;">
    <div class="modal-header">
      <h2 id="edit-modal-title">Editar</h2>
      <button class="close" onclick="closeModal('edit-modal')">✕</button>
    </div>
    <div class="modal-body" style="grid-template-columns: 1fr; padding: 24px 28px;">
      <form id="edit-form" onsubmit="return saveEdit(event)">
        <input type="hidden" name="id" />
        <input type="hidden" name="_kind" value="stock" />

        <div id="edit-stock-fields">
          <div class="ocr-field"><label>Evento *</label><input type="text" name="evento" required /></div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Bought date</label><input type="date" name="bought_date" /></div>
            <div class="ocr-field"><label>Event date</label><input type="date" name="event_date" /></div>
            <div class="ocr-field"><label>Retailer</label><select name="retailer">${retailerOpts}</select></div>
          </div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Cuenta</label><input type="text" name="cuenta" placeholder="ej. axs_es_03" /></div>
            <div class="ocr-field"><label>Selling platform</label><select name="selling_platform">${platformOpts}</select></div>
            <div class="ocr-field"><label>Ticket type</label><select name="ticket_type">${ticketTypeOpts}</select></div>
          </div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Sección</label><input type="text" name="seccion" /></div>
            <div class="ocr-field"><label>Fila</label><input type="text" name="fila" /></div>
            <div class="ocr-field"><label>Asiento</label><input type="text" name="asiento" /></div>
          </div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Price retail (USD)</label><input type="number" step="0.01" name="price_retail" /></div>
            <div class="ocr-field"><label>Listed at (USD)</label><input type="number" step="0.01" name="listed_at" /></div>
            <div class="ocr-field"><label>Sold at (USD)</label><input type="number" step="0.01" name="sold_at" /></div>
          </div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Payout amount (USD)</label><input type="number" step="0.01" name="payout_amount" /></div>
            <div class="ocr-field"><label>Sold date</label><input type="date" name="sold_date" /></div>
            <div class="ocr-field"><label>Payout date</label><input type="date" name="payout_date" /></div>
          </div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Origin / Bot tag</label><input type="text" name="origin" placeholder="manual | JoeyTickets | ..." /></div>
            <div class="ocr-field"><label>Fulfilled</label><select name="fulfilled"><option value="0">No</option><option value="1">Sí</option></select></div>
            <div class="ocr-field"><label>Status (auto)</label><select name="status"><option value="">auto</option>${STATUSES.map(s => `<option value="${s}">${s}</option>`).join('')}</select></div>
          </div>
          <div class="ocr-field"><label>Notas</label><input type="text" name="notas" /></div>
        </div>

        <div id="edit-expense-fields" style="display:none;">
          <div class="ocr-field"><label>Nombre *</label><input type="text" name="nombre" /></div>
          <div class="ocr-field-row">
            <div class="ocr-field"><label>Fecha</label><input type="date" name="fecha" /></div>
            <div class="ocr-field"><label>Categoría</label><select name="categoria">${expCatOpts}</select></div>
            <div class="ocr-field"><label>Modo</label><select name="modo" onchange="toggleExpenseMode(this.value)"><option value="fijo">Fijo</option><option value="porcentaje">% sobre ganancia</option></select></div>
          </div>
          <div class="ocr-field-row" id="exp-fijo-fields">
            <div class="ocr-field"><label>Precio / mes (USD)</label><input type="number" step="0.01" name="precio_mes" /></div>
            <div class="ocr-field"><label>Meses pagados</label><input type="number" name="base_meses" value="1" /></div>
            <div class="ocr-field"><label>Recurrente</label><select name="recurrente"><option value="0">No</option><option value="1">Sí</option></select></div>
          </div>
          <div class="ocr-field-row" id="exp-pct-fields" style="display:none;">
            <div class="ocr-field"><label>% sobre profit (0.15 = 15%)</label><input type="number" step="0.01" name="porcentaje" placeholder="0.15" /></div>
            <div class="ocr-field"><label>Bot origin tag</label><input type="text" name="bot_origin_tag" placeholder="JoeyTickets" /></div>
            <div class="ocr-field"><label>Base profit (auto si tag)</label><input type="number" step="0.01" name="base_profit" /></div>
          </div>
          <div class="ocr-field"><label>Notas</label><input type="text" name="notas" /></div>
        </div>

        <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px;">
          <button type="button" class="btn btn-ghost" onclick="closeModal('edit-modal')">Cancelar</button>
          <button type="submit" class="btn">✓ Guardar</button>
        </div>
      </form>
    </div>
  </div>
</div>`;
}

// =============================================================================
// CSS y JS embebidos (mismo idioma que el mockup)
// =============================================================================
const CSS = `
:root {
  --bg: #07090d; --bg-2: #0c1118; --surface: #11161f; --surface-2: #161d28; --surface-3: #1d2532;
  --border: #1f2937; --border-soft: #182030; --text: #e6edf6; --text-dim: #93a1b5; --text-mute: #5a6a7e;
  --blue: #3b82f6; --blue-deep: #1d4ed8; --cyan: #22d3ee; --cyan-soft: #a5f3fc;
  --amber: #f59e0b; --amber-soft: #fcd34d; --green: #10b981; --red: #ef4444; --violet: #8b5cf6;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow-x: hidden; }
body {
  font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text);
  font-size: 14px; line-height: 1.5; padding: 36px 44px 60px; min-height: 100vh; position: relative;
}
body::before {
  content: ''; position: fixed; inset: 0;
  background: radial-gradient(ellipse 900px 500px at 10% -5%, rgba(34,211,238,0.10), transparent 60%),
              radial-gradient(ellipse 700px 400px at 95% 8%, rgba(59,130,246,0.10), transparent 55%);
  pointer-events: none; z-index: 0;
}
.container { max-width: 1440px; margin: 0 auto; position: relative; z-index: 2; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.stagger > * { animation: fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
.stagger > *:nth-child(1) { animation-delay: 0.04s; }
.stagger > *:nth-child(2) { animation-delay: 0.08s; }
.stagger > *:nth-child(3) { animation-delay: 0.12s; }
.stagger > *:nth-child(4) { animation-delay: 0.16s; }
.stagger > *:nth-child(5) { animation-delay: 0.20s; }
.stagger > *:nth-child(6) { animation-delay: 0.24s; }
header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; animation: fadeUp 0.5s both; }
.brand-block { display: flex; align-items: center; gap: 16px; }
.logo-mark { width: 70px; height: 60px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.logo-mark svg { width: 100%; height: 100%; filter: drop-shadow(0 4px 18px rgba(34,211,238,0.25)); }
.brand-text { display: flex; flex-direction: column; gap: 4px; }
.brand { font-family: 'Playfair Display', serif; font-size: 28px; font-weight: 700;
  background: linear-gradient(120deg, #a5f3fc 0%, #22d3ee 50%, #3b82f6 100%);
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  letter-spacing: -0.5px; }
.brand-sub { font-size: 12px; color: var(--text-mute); text-transform: uppercase; letter-spacing: 2px; font-weight: 500; }
.header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.user-chip { display: inline-flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border);
  border-radius: 999px; padding: 6px 14px; font-size: 12px; color: var(--text-dim); }
.user-chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
.meta-info { font-size: 11px; color: var(--text-mute); }
.tabs { display: flex; gap: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  padding: 6px; margin-bottom: 28px; overflow-x: auto; flex-wrap: wrap; }
.tab { padding: 10px 18px; border-radius: 10px; cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text-dim);
  transition: all 0.2s; white-space: nowrap; display: inline-flex; align-items: center; gap: 8px; border: 1px solid transparent; }
.tab:hover { background: var(--surface-2); color: var(--text); }
.tab.active { background: linear-gradient(135deg, rgba(34,211,238,0.15), rgba(59,130,246,0.15)); color: var(--cyan-soft);
  border-color: rgba(34,211,238,0.3); }
.tab-badge { background: rgba(34,211,238,0.15); color: var(--cyan); font-size: 10px; padding: 2px 7px; border-radius: 8px; font-weight: 600; }
.tab.dyn { background: rgba(139,92,246,0.08); color: var(--violet); }
.tab.dyn::before { content: '◆'; font-size: 10px; }
.tab.dyn.active { background: rgba(139,92,246,0.2); color: #c4b5fd; border-color: rgba(139,92,246,0.4); }
.tab.tab-treasury.active { background: linear-gradient(135deg, rgba(16,185,129,0.15), rgba(34,211,238,0.15)); color: #6ee7b7; border-color: rgba(16,185,129,0.3); }
.page { display: none; }
.page.active { display: block; animation: fadeUp 0.4s; }
.section-title { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700; margin-bottom: 6px; color: var(--text); }
.section-sub { color: var(--text-mute); font-size: 13px; margin-bottom: 22px; }
.section-title.collapsible { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 10px; transition: opacity 0.15s; }
.section-title.collapsible:hover { opacity: 0.85; }
.chev { display: inline-block; font-size: 14px; color: var(--cyan); transition: transform 0.25s; }
.section-title.collapsed .chev { transform: rotate(-90deg); }
.collapse-target { overflow: hidden; max-height: 4000px; transition: max-height 0.35s, opacity 0.25s, margin 0.25s; }
.section-title.collapsed + .section-sub + .collapse-target,
.section-title.collapsed + .collapse-target { max-height: 0 !important; opacity: 0; margin: 0 !important; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 28px; }
.kpi { background: linear-gradient(180deg, var(--surface), var(--surface-2)); border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 18px 16px; position: relative; overflow: hidden; }
.kpi::after { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, var(--cyan), transparent); opacity: 0.4; }
.kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text-mute); font-weight: 500; margin-bottom: 10px; }
.kpi-value { font-family: 'JetBrains Mono', monospace; font-size: 26px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
.kpi-value .unit { font-size: 14px; color: var(--text-dim); margin-left: 4px; font-weight: 500; }
.kpi-delta { font-size: 12px; margin-top: 6px; color: var(--text-mute); }
.kpi.accent-green .kpi-value { color: var(--green); }
.kpi.accent-red .kpi-value { color: var(--red); }
.kpi.accent-amber .kpi-value { color: var(--amber); }
.kpi.accent-cyan .kpi-value { color: var(--cyan); }
.kpi.accent-blue .kpi-value { color: var(--blue); }
.kpi.accent-violet .kpi-value { color: var(--violet); }
.kpi.clickable { cursor: pointer; transition: transform 0.15s, border-color 0.15s; }
.kpi.clickable:hover { transform: translateY(-2px); border-color: rgba(34,211,238,0.4); }
.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
.toolbar input[type="text"], .toolbar input[type="month"], .toolbar input[type="date"], .toolbar select {
  background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 9px 14px;
  border-radius: 10px; font-family: inherit; font-size: 13px; min-width: 160px; outline: none;
  transition: border 0.2s, background 0.2s; }
.toolbar input:focus, .toolbar select:focus { border-color: var(--cyan); background: var(--surface-2); }
.toolbar .spacer { flex: 1; }
.btn { background: linear-gradient(135deg, var(--blue-deep), var(--cyan)); color: #07090d; border: none;
  padding: 9px 18px; border-radius: 10px; font-weight: 600; font-size: 13px; cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s; display: inline-flex; align-items: center; gap: 7px; }
.btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(34,211,238,0.3); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost { background: var(--surface); border: 1px solid var(--border); color: var(--text-dim); }
.btn-ghost:hover { background: var(--surface-2); color: var(--text); box-shadow: none; }
.btn-ocr { background: linear-gradient(135deg, #8b5cf6, #22d3ee); }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
thead { background: var(--bg-2); }
th { text-align: left; padding: 12px 14px; font-size: 11px; font-weight: 600; color: var(--text-mute);
  text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 12px 14px; border-bottom: 1px solid var(--border-soft); color: var(--text); vertical-align: middle; }
tbody tr { transition: background 0.15s; }
tbody tr:hover { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: none; }
td.num { font-family: 'JetBrains Mono', monospace; text-align: right; white-space: nowrap; }
td.profit-pos { color: var(--green); font-weight: 600; }
td.profit-neg { color: var(--red); font-weight: 600; }
td.acct { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-dim);
  background: rgba(34,211,238,0.04); border-left: 2px solid rgba(34,211,238,0.2); padding-left: 10px; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 500; line-height: 1.4; white-space: nowrap; }
.pill-yes { background: rgba(16,185,129,0.15); color: var(--green); border: 1px solid rgba(16,185,129,0.3); }
.pill-no { background: rgba(239,68,68,0.12); color: var(--red); border: 1px solid rgba(239,68,68,0.25); }
.pill-pending { background: rgba(245,158,11,0.15); color: var(--amber); border: 1px solid rgba(245,158,11,0.3); }
.pill-blue { background: rgba(59,130,246,0.15); color: var(--blue); border: 1px solid rgba(59,130,246,0.3); }
.pill-cyan { background: rgba(34,211,238,0.12); color: var(--cyan); border: 1px solid rgba(34,211,238,0.25); }
.pill-violet { background: rgba(139,92,246,0.15); color: var(--violet); border: 1px solid rgba(139,92,246,0.3); }
.pill-mute { background: var(--surface-3); color: var(--text-dim); border: 1px solid var(--border); }
.retailer-tag { font-family: 'JetBrains Mono', monospace; font-size: 10px; padding: 3px 8px; border-radius: 999px; font-weight: 600; letter-spacing: 0.5px; }
.r-AXS { background: rgba(245,245,245,0.92); color: #1a1a1a; }
.r-TM { background: #1d4ed8; color: #fff; }
.r-TO { background: #f59e0b; color: #1a1a1a; }
.r-TC { background: #f9c4d2; color: #5a1a30; }
.r-ST { background: #c4b5fd; color: #2e1065; }
.r-EV { background: #0d9488; color: #fff; }
.r-OT { background: var(--surface-3); color: var(--text-dim); }
.row-actions { width: 36px; text-align: center; }
.row-menu { background: transparent; border: 1px solid transparent; color: var(--text-mute); width: 26px; height: 26px;
  border-radius: 6px; cursor: pointer; font-size: 16px; line-height: 1; transition: all 0.15s; }
tr:hover .row-menu { color: var(--text-dim); }
.row-menu:hover { background: var(--surface-3); color: var(--cyan); border-color: var(--border); }
.treasury-hero { display: grid; grid-template-columns: 1fr 2fr; gap: 28px;
  background: linear-gradient(135deg, rgba(34,211,238,0.08), rgba(59,130,246,0.04));
  border: 1px solid rgba(34,211,238,0.25); border-radius: 18px; padding: 28px 32px; margin-bottom: 32px; }
.treasury-total { display: flex; flex-direction: column; justify-content: center; padding-right: 28px;
  border-right: 1px solid rgba(34,211,238,0.2); }
.treasury-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--cyan-soft); font-weight: 600; margin-bottom: 10px; }
.treasury-value { font-family: 'JetBrains Mono', monospace; font-size: 42px; font-weight: 700;
  background: linear-gradient(120deg, #a5f3fc, #22d3ee 50%, #3b82f6); -webkit-background-clip: text;
  -webkit-text-fill-color: transparent; background-clip: text; letter-spacing: -1px; }
.treasury-delta { font-size: 12px; color: var(--green); margin-top: 8px; }
.treasury-bars { display: flex; flex-direction: column; gap: 14px; }
.bar-row { display: grid; grid-template-columns: 220px 1fr 130px; gap: 14px; align-items: center; }
.bar-meta { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.d-cyan { background: var(--cyan); } .d-blue { background: var(--blue); } .d-amber { background: var(--amber); } .d-green { background: var(--green); }
.bar-track { height: 10px; background: var(--surface-2); border-radius: 6px; overflow: hidden; border: 1px solid var(--border); }
.bar-fill { height: 100%; border-radius: 6px; transition: width 0.6s; }
.bar-val { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 600; text-align: right; color: var(--text); }
.bar-pct { font-size: 11px; color: var(--text-mute); margin-left: 6px; }
.chart-row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; margin-top: 22px; }
.chart-row.equal { grid-template-columns: 1fr 1fr; }
.chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
.chart-title { font-size: 13px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
.chart-sub { font-size: 11px; color: var(--text-mute); margin-bottom: 14px; }
.chart-canvas-wrap { position: relative; height: 240px; }
.event-banner { background: linear-gradient(135deg, rgba(139,92,246,0.18), rgba(34,211,238,0.12));
  border: 1px solid rgba(139,92,246,0.35); border-radius: 14px; padding: 20px 24px; margin-bottom: 22px;
  display: flex; align-items: center; justify-content: space-between; }
.event-banner-left h2 { font-family: 'Playfair Display', serif; font-size: 24px; font-weight: 700; margin-bottom: 4px; }
.event-banner-left p { color: var(--text-dim); font-size: 13px; }
.event-banner-right { display: flex; gap: 26px; align-items: center; }
.mini-kpi { text-align: right; }
.mini-kpi .l { font-size: 10px; color: var(--text-mute); text-transform: uppercase; letter-spacing: 1px; }
.mini-kpi .v { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; }
.modal-overlay { position: fixed; inset: 0; background: rgba(7,9,13,0.78); backdrop-filter: blur(6px); z-index: 100;
  display: none; align-items: center; justify-content: center; padding: 30px; }
.modal-overlay.open { display: flex; animation: fadeIn 0.2s; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 18px; width: 100%; max-width: 1100px;
  max-height: 92vh; overflow-y: auto; box-shadow: 0 30px 80px rgba(0,0,0,0.6); }
.modal-header { padding: 22px 28px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
.modal-header h2 { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 700;
  background: linear-gradient(120deg, #a5f3fc, #22d3ee); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.modal-header .close { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-dim);
  width: 32px; height: 32px; border-radius: 8px; cursor: pointer; font-size: 18px; }
.modal-body { padding: 26px 28px; display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.modal-drop { background: var(--bg-2); border: 2px dashed rgba(34,211,238,0.35); border-radius: 14px; padding: 28px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 380px;
  text-align: center; color: var(--text-dim); cursor: pointer; }
.modal-drop .preview { width: 100%; height: 300px; background: var(--surface-2); border-radius: 10px;
  display: flex; align-items: center; justify-content: center; color: var(--text-mute); font-size: 13px;
  border: 1px solid var(--border); background-size: cover; background-position: center; }
.modal-drop .hint { margin-top: 14px; font-size: 12px; color: var(--text-mute); }
.modal-fields { display: flex; flex-direction: column; gap: 14px; }
.ocr-status { background: rgba(34,211,238,0.08); border: 1px solid rgba(34,211,238,0.25); border-radius: 10px;
  padding: 10px 14px; font-size: 12px; color: var(--cyan-soft); }
.ocr-field { display: flex; flex-direction: column; gap: 5px; }
.ocr-field label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-mute); font-weight: 600; display: flex; justify-content: space-between; }
.conf { font-family: 'JetBrains Mono', monospace; text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 10px; padding: 1px 6px; border-radius: 6px; }
.conf-hi { background: rgba(16,185,129,0.15); color: var(--green); }
.conf-md { background: rgba(245,158,11,0.15); color: var(--amber); }
.conf-lo { background: rgba(239,68,68,0.18); color: #fca5a5; }
.ocr-field input, .ocr-field select { background: var(--bg-2); border: 1px solid var(--border); color: var(--text);
  padding: 9px 12px; border-radius: 8px; font-family: inherit; font-size: 13px; outline: none; transition: border 0.15s; }
.ocr-field input:focus, .ocr-field select:focus { border-color: var(--cyan); }
.ocr-field-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin: 14px 0; }
.modal-footer { padding: 18px 28px; border-top: 1px solid var(--border); display: flex; justify-content: space-between;
  align-items: center; gap: 10px; background: var(--bg-2); }
.modal-footer .left { font-size: 12px; color: var(--text-mute); }
.row-menu-dropdown { position: absolute; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 6px; box-shadow: 0 12px 30px rgba(0,0,0,0.5); z-index: 50; min-width: 180px; }
.row-menu-dropdown button { display: block; width: 100%; text-align: left; background: transparent; border: none;
  color: var(--text-dim); padding: 8px 12px; font-size: 12px; border-radius: 6px; cursor: pointer; }
.row-menu-dropdown button:hover { background: var(--surface-2); color: var(--text); }
.row-menu-dropdown button.danger { color: var(--red); }
.row-menu-dropdown button.danger:hover { background: rgba(239,68,68,0.1); }
.mockup-note { margin-top: 40px; padding: 16px 20px; background: rgba(16,185,129,0.05);
  border: 1px dashed rgba(16,185,129,0.3); border-radius: 10px; color: #6ee7b7; font-size: 12px; text-align: center; }
@media (max-width: 900px) {
  .chart-row, .chart-row.equal { grid-template-columns: 1fr; }
  .event-banner { flex-direction: column; gap: 16px; align-items: flex-start; }
  .treasury-hero { grid-template-columns: 1fr; }
  .treasury-total { padding-right: 0; padding-bottom: 20px; border-right: none; border-bottom: 1px solid rgba(34,211,238,0.2); }
  .bar-row { grid-template-columns: 1fr; gap: 6px; }
  .bar-val { text-align: left; }
  .modal-body { grid-template-columns: 1fr; }
  body { padding: 24px 18px 40px; }
}
`;

const CLIENT_JS = `
// Tabs
function activateTab(target, opts = {}) {
  const tab = document.querySelector('.tab[data-tab="' + target + '"]');
  if (!tab) return false;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  const page = document.getElementById('page-' + target);
  if (page) page.classList.add('active');
  if (opts.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (opts.updateHash !== false) history.replaceState(null, '', '#' + target);
  return true;
}
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
});
// Restaurar tab desde URL hash al cargar (sobrevive a location.reload)
(function restoreTab() {
  const hash = location.hash.slice(1);
  if (hash) activateTab(hash, { scroll: false, updateHash: false });
  // Restaurar posición de scroll si veníamos de un save (sessionStorage)
  const sy = sessionStorage.getItem('kemin_scroll');
  if (sy) {
    sessionStorage.removeItem('kemin_scroll');
    setTimeout(() => window.scrollTo(0, parseInt(sy, 10)), 30);
  }
})();
// Helper: guardar estado antes de un reload tras CRUD
window.softReload = function() {
  sessionStorage.setItem('kemin_scroll', String(window.scrollY));
  // El hash ya está en URL, location.reload() lo conserva
  location.reload();
};
// Collapsibles
document.querySelectorAll('.section-title.collapsible').forEach(t => {
  t.addEventListener('click', () => t.classList.toggle('collapsed'));
});
// Treasury → switch to stock filtered
document.querySelectorAll('.kpi.clickable[data-stock-filter]').forEach(k => {
  k.addEventListener('click', () => {
    const filter = k.dataset.stockFilter;
    document.querySelector('.tab[data-tab="stock"]').click();
    const sel = document.getElementById('stock-filter-status');
    if (sel) { sel.value = filter; sel.dispatchEvent(new Event('change')); }
  });
});
// Stock search & filters
function applyStockFilters() {
  const q = (document.getElementById('stock-search')?.value || '').toLowerCase();
  const ev = document.getElementById('stock-filter-evento')?.value || '';
  const rt = document.getElementById('stock-filter-retailer')?.value || '';
  const st = document.getElementById('stock-filter-status')?.value || '';
  document.querySelectorAll('#stock-table tbody tr[data-id]').forEach(tr => {
    const txt = tr.textContent.toLowerCase();
    const okQ = !q || txt.includes(q);
    const okEv = !ev || tr.dataset.evento === ev;
    const okRt = !rt || tr.dataset.retailer === rt;
    const okSt = !st || tr.dataset.status === st;
    tr.style.display = (okQ && okEv && okRt && okSt) ? '' : 'none';
  });
}
['stock-search','stock-filter-evento','stock-filter-retailer','stock-filter-status']
  .forEach(id => document.getElementById(id)?.addEventListener('input', applyStockFilters));
// Populate event filter dropdown
(function(){
  const sel = document.getElementById('stock-filter-evento');
  if (!sel) return;
  const eventos = new Set();
  document.querySelectorAll('#stock-table tbody tr[data-evento]').forEach(tr => eventos.add(tr.dataset.evento));
  Array.from(eventos).sort().forEach(e => {
    const o = document.createElement('option'); o.value = e; o.textContent = e; sel.appendChild(o);
  });
})();
// Row menu
window.rowMenu = function(e, kind, id) {
  e.stopPropagation();
  document.querySelectorAll('.row-menu-dropdown').forEach(d => d.remove());
  const dd = document.createElement('div');
  dd.className = 'row-menu-dropdown';
  const opts = [
    { label: '✏ Editar', fn: () => openEditModal(kind, id) },
    { label: '📋 Duplicar', fn: () => duplicateRow(kind, id) },
    ...(kind === 'stock' ? [
      { label: '🏷 Marcar Listed', fn: () => quickPatch(kind, id, { status: 'listed', listed_at: prompt('Listed at (USD)?') }) },
      { label: '💵 Marcar Sold', fn: () => quickPatch(kind, id, { status: 'sold', sold_at: prompt('Sold at (USD)?'), sold_date: new Date().toISOString().slice(0,10) }) },
      { label: '✅ Marcar Cobrado', fn: () => quickPatch(kind, id, { status: 'cobrado', payout_amount: prompt('Payout amount (USD)?'), payout_date: new Date().toISOString().slice(0,10) }) }
    ] : []),
    { label: '🗑 Eliminar', cls: 'danger', fn: () => deleteRow(kind, id) }
  ];
  for (const o of opts) {
    const b = document.createElement('button');
    b.textContent = o.label;
    if (o.cls) b.className = o.cls;
    b.onclick = () => { dd.remove(); o.fn(); };
    dd.appendChild(b);
  }
  const rect = e.target.getBoundingClientRect();
  dd.style.left = (rect.right - 180 + window.scrollX) + 'px';
  dd.style.top = (rect.bottom + 6 + window.scrollY) + 'px';
  document.body.appendChild(dd);
  setTimeout(() => {
    const close = (ev) => { if (!dd.contains(ev.target)) { dd.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 0);
};
window.quickPatch = async function(kind, id, body) {
  if (Object.values(body).some(v => v === null)) return; // user cancelled prompt
  const url = kind === 'stock' ? '/api/stock/' + id : '/api/expenses/' + id;
  const r = await fetch(url, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r.ok) softReload(); else alert('Error: ' + (await r.text()));
};
window.deleteRow = async function(kind, id) {
  if (!confirm('¿Eliminar definitivamente?')) return;
  const url = kind === 'stock' ? '/api/stock/' + id : '/api/expenses/' + id;
  const r = await fetch(url, { method: 'DELETE' });
  if (r.ok) softReload(); else alert('Error');
};
window.duplicateRow = async function(kind, id) {
  const url = kind === 'stock' ? '/api/stock' : '/api/expenses';
  const list = await (await fetch(url)).json();
  const src = list.find(x => x.id === id);
  if (!src) return;
  const copy = {...src}; delete copy.id; delete copy.created_at; delete copy.updated_at;
  const r = await fetch(url, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(copy) });
  if (r.ok) softReload();
};
// Modals
window.openModal = id => document.getElementById(id)?.classList.add('open');
window.closeModal = id => document.getElementById(id)?.classList.remove('open');
window.openOcrModal = () => {
  document.getElementById('ocr-status').textContent = 'Sube una captura para empezar.';
  document.getElementById('ocr-form').style.display = 'none';
  document.getElementById('ocr-preview').textContent = 'click o arrastra una captura aquí';
  document.getElementById('ocr-preview').style.backgroundImage = '';
  document.getElementById('ocr-confirm').disabled = true;
  document.getElementById('ocr-footer-info').textContent = '—';
  document.getElementById('ocr-loading').style.display = 'none';
  window.__ocr = null;
  openModal('ocr-modal');
};
// OCR flow
const ocrDrop = document.getElementById('ocr-drop');
const ocrFile = document.getElementById('ocr-file');
ocrDrop?.addEventListener('click', () => ocrFile.click());
ocrDrop?.addEventListener('dragover', e => { e.preventDefault(); ocrDrop.style.borderColor = 'var(--cyan)'; });
ocrDrop?.addEventListener('dragleave', () => { ocrDrop.style.borderColor = ''; });
ocrDrop?.addEventListener('drop', e => { e.preventDefault(); ocrDrop.style.borderColor = '';
  if (e.dataTransfer.files[0]) processOcrFile(e.dataTransfer.files[0]); });
ocrFile?.addEventListener('change', e => { if (e.target.files[0]) processOcrFile(e.target.files[0]); });

async function processOcrFile(file) {
  const preview = document.getElementById('ocr-preview');
  preview.style.backgroundImage = 'url(' + URL.createObjectURL(file) + ')';
  preview.textContent = '';
  document.getElementById('ocr-loading').style.display = 'block';
  document.getElementById('ocr-status').textContent = 'Procesando…';
  const fd = new FormData();
  fd.append('image', file);
  fd.append('context', 'compra');
  try {
    const r = await fetch('/api/ocr', { method: 'POST', body: fd });
    const data = await r.json();
    document.getElementById('ocr-loading').style.display = 'none';
    if (!r.ok || !data.ok) {
      document.getElementById('ocr-status').textContent = 'Error: ' + (data.error || 'desconocido');
      return;
    }
    window.__ocr = data;
    document.getElementById('ocr-status').textContent =
      '✓ Detección completada · coste $' + (data.cost_usd?.toFixed(4) || '0') + ' · ' + (data.latency_ms || 0) + 'ms';
    document.getElementById('ocr-form').style.display = '';
    const fields = data.fields || {};
    const conf = data.confidence || {};
    const setVal = (name, val) => { const el = document.querySelector('#ocr-form [name="'+name+'"]'); if (el && val != null) el.value = val; };
    setVal('evento', fields.evento);
    setVal('bought_date', fields.bought_date || new Date().toISOString().slice(0,10));
    setVal('event_date', fields.event_date);
    setVal('retailer', fields.retailer);
    setVal('seccion', fields.seccion);
    setVal('fila', fields.fila);
    setVal('asiento', fields.asiento);
    setVal('price_retail', fields.price_retail_per_ticket_usd || fields.price_total_usd);
    setVal('n_tickets', fields.n_tickets || 1);
    setVal('cuenta', fields.cuenta);
    setVal('selling_platform', fields.selling_platform);
    setVal('notas', fields.raw_notes);
    // Confidence badges
    for (const k of Object.keys(conf)) {
      const el = document.getElementById('conf-' + k);
      if (!el) continue;
      const v = conf[k];
      el.textContent = v + '%';
      el.className = 'conf ' + (v >= 85 ? 'conf-hi' : v >= 60 ? 'conf-md' : 'conf-lo');
    }
    const n = parseInt(fields.n_tickets || 1);
    document.getElementById('ocr-footer-info').innerHTML = 'Se crearán <strong style="color: var(--cyan);">' + n + ' fila' + (n>1?'s':'') + '</strong> en STOCK';
    document.getElementById('ocr-confirm').disabled = false;
  } catch (e) {
    document.getElementById('ocr-loading').style.display = 'none';
    document.getElementById('ocr-status').textContent = 'Error: ' + e.message;
  }
}
window.confirmOcr = async function() {
  const form = document.getElementById('ocr-form');
  const fd = new FormData(form);
  const obj = Object.fromEntries(fd);
  const n = parseInt(obj.n_tickets || 1);
  delete obj.n_tickets;
  const items = Array.from({length: n}, () => ({...obj}));
  const body = { items, ocr_log_id: window.__ocr?.ocr_log_id };
  const r = await fetch('/api/stock/bulk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r.ok) { closeModal('ocr-modal'); softReload(); }
  else alert('Error: ' + (await r.text()));
};
// Edit modal
window.openEditModal = async function(kind, id) {
  const form = document.getElementById('edit-form');
  form.reset();
  form.elements['_kind'].value = kind;
  document.getElementById('edit-modal-title').textContent = id ? 'Editar ' + kind : 'Nuevo ' + kind;
  document.getElementById('edit-stock-fields').style.display = kind === 'stock' ? '' : 'none';
  document.getElementById('edit-expense-fields').style.display = kind === 'expense' ? '' : 'none';
  if (id) {
    const url = kind === 'stock' ? '/api/stock' : '/api/expenses';
    const list = await (await fetch(url)).json();
    const row = list.find(x => x.id === id);
    if (row) {
      for (const k of Object.keys(row)) {
        const el = form.elements[k];
        if (el) el.value = row[k] ?? '';
      }
    }
  }
  openModal('edit-modal');
};
window.toggleExpenseMode = function(val) {
  document.getElementById('exp-fijo-fields').style.display = val === 'fijo' ? '' : 'none';
  document.getElementById('exp-pct-fields').style.display = val === 'porcentaje' ? '' : 'none';
};
window.saveEdit = async function(ev) {
  ev.preventDefault();
  const form = document.getElementById('edit-form');
  const fd = new FormData(form);
  const obj = Object.fromEntries(fd);
  const kind = obj._kind; delete obj._kind;
  const id = obj.id; if (!id) delete obj.id;
  if (kind === 'stock' && !obj.status) delete obj.status;
  const base = kind === 'stock' ? '/api/stock' : '/api/expenses';
  const url = id ? base + '/' + id : base;
  const method = id ? 'PATCH' : 'POST';
  const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(obj) });
  if (r.ok) { closeModal('edit-modal'); softReload(); }
  else alert('Error: ' + (await r.text()));
  return false;
};
// Capital modal
window.openCapitalModal = function(type) {
  const form = document.getElementById('capital-form');
  form.reset();
  form.elements['type'].value = type;
  form.elements['fecha'].value = new Date().toISOString().slice(0,10);
  document.getElementById('capital-modal-title').textContent =
    type === 'deposit' ? '💵 Inyección de capital (deposit)' : '⤓ Retiro de capital (withdrawal)';
  openModal('capital-modal');
};
window.saveCapital = async function(ev) {
  ev.preventDefault();
  const form = document.getElementById('capital-form');
  const fd = new FormData(form);
  const body = Object.fromEntries(fd);
  const r = await fetch('/api/capital', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r.ok) { closeModal('capital-modal'); softReload(); }
  else alert('Error: ' + (await r.text()));
  return false;
};
// Period change
document.getElementById('fin-period')?.addEventListener('change', e => {
  const url = new URL(location.href);
  url.searchParams.set('fin_period', e.target.value);
  location.href = url.toString();
});
// CSV export
window.exportCSV = function(kind) {
  const url = kind === 'finalizados' ? '/api/stock' : '/api/expenses';
  fetch(url).then(r => r.json()).then(rows => {
    if (!rows.length) return alert('Vacío');
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = kind + '-' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
  });
};
// ESC closes modals
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
});
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});
// Chart.js
if (window.Chart && window.DASHBOARD_DATA) {
  Chart.defaults.color = '#93a1b5'; Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size = 11; Chart.defaults.borderColor = '#1f2937';
  const D = window.DASHBOARD_DATA;
  if (document.getElementById('chartMargin')) {
    new Chart(document.getElementById('chartMargin'), {
      type: 'bar',
      data: { labels: D.margenLabels, datasets: [{
        data: D.margenData, borderRadius: 6,
        backgroundColor: ctx => { const v = ctx.raw; if (v >= 65) return 'rgba(16,185,129,0.65)';
          if (v >= 50) return 'rgba(34,211,238,0.55)'; return 'rgba(245,158,11,0.6)'; }
      }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { grid: { display: false } }, y: { ticks: { callback: v => v + '%' }, max: 100 } } }
    });
  }
  if (document.getElementById('chartEvento')) {
    new Chart(document.getElementById('chartEvento'), {
      type: 'bar',
      data: { labels: D.eventoLabels, datasets: [{ data: D.eventoData, backgroundColor: 'rgba(34,211,238,0.5)', borderRadius: 6, borderColor: '#22d3ee', borderWidth: 1 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { callback: v => '$' + v } } } }
    });
  }
  if (document.getElementById('chartPlatform')) {
    new Chart(document.getElementById('chartPlatform'), {
      type: 'bar',
      data: { labels: D.platformLabels, datasets: [{ data: D.platformData, backgroundColor: ['#3b82f6','#22d3ee','#ef4444','#f59e0b','#8b5cf6'], borderRadius: 6 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => '$' + v } } } }
    });
  }
  if (document.getElementById('chartSellRate')) {
    new Chart(document.getElementById('chartSellRate'), {
      type: 'bar',
      data: { labels: D.sellLabels, datasets: [{ data: D.sellData, backgroundColor: D.sellData.map(v => v >= 70 ? '#10b981' : v >= 40 ? '#f59e0b' : '#ef4444'), borderRadius: 6 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { max: 100, ticks: { callback: v => v + '%' } } } }
    });
  }
}
`;

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Panel KEMIN escuchando en http://0.0.0.0:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Uploads: ${UPLOADS_DIR}`);
  console.log(`Modelo OCR: ${ANTHROPIC_MODEL}`);
  console.log(`Usuarios: ${Object.keys(PANEL_USERS).join(', ')}`);
});
