-- =============================================================================
-- Panel KEMIN — schema SQLite
-- Se ejecuta automáticamente al arrancar el server si las tablas no existen.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- STOCK: una fila por ticket individual.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock (
  id              TEXT PRIMARY KEY,
  evento          TEXT NOT NULL,
  bought_date     TEXT,                                -- ISO YYYY-MM-DD
  event_date      TEXT,
  retailer        TEXT,                                -- AXS|TICKETMASTER|TICKETONE|TICKETCORNER|SEETICKETS|EVENTIM|OTHER
  cuenta          TEXT,                                -- texto libre, ej. axs_es_03
  selling_platform TEXT,                               -- StubHub|Ticombo|AXS Resale|Viagogo|Vivid Seats|Other
  ticket_type     TEXT,                                -- MOBILE TRANSFER|PDF|HARD COPY|OTHER
  seccion         TEXT,
  fila            TEXT,
  asiento         TEXT,
  price_retail    REAL,
  listed_at       REAL,
  sold_at         REAL,
  payout_amount   REAL,
  status          TEXT NOT NULL DEFAULT 'comprado',    -- comprado|listed|sold|cobrado|lost
  sold_date       TEXT,
  payout_date     TEXT,
  fulfilled       INTEGER NOT NULL DEFAULT 0,          -- 0 / 1
  origin          TEXT NOT NULL DEFAULT 'manual',      -- manual | JoeyTickets | NinjaDrops | <bot-op>
  ocr_log_id      TEXT,                                -- si vino de OCR
  notas           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_status    ON stock(status);
CREATE INDEX IF NOT EXISTS idx_stock_evento    ON stock(evento);
CREATE INDEX IF NOT EXISTS idx_stock_event_dt  ON stock(event_date);
CREATE INDEX IF NOT EXISTS idx_stock_bought    ON stock(bought_date);
CREATE INDEX IF NOT EXISTS idx_stock_origin    ON stock(origin);

-- -----------------------------------------------------------------------------
-- EXPENSES: gastos operativos. Recurrentes/puntuales/% sobre ganancia.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL,
  fecha           TEXT NOT NULL,                       -- fecha alta
  categoria       TEXT,                                -- Proxy|Bot|Suscripción|Servidor|Bot operator|Otro
  modo            TEXT NOT NULL DEFAULT 'fijo',        -- fijo | porcentaje
  recurrente      INTEGER NOT NULL DEFAULT 0,          -- 0/1
  precio_mes      REAL,                                -- si modo=fijo
  porcentaje      REAL,                                -- si modo=porcentaje (0.15 = 15%)
  base_meses      INTEGER,                             -- si fijo
  base_profit     REAL,                                -- si porcentaje, profit acumulado del bot-op
  total_pagado    REAL,                                -- snapshot calculado
  bot_origin_tag  TEXT,                                -- si % de un bot-op, su tag (=stock.origin)
  notas           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_fecha ON expenses(fecha);
CREATE INDEX IF NOT EXISTS idx_expenses_mode  ON expenses(modo);

-- -----------------------------------------------------------------------------
-- EVENTS: metadatos de eventos. Auto-detect de tabs por count en stock.
-- Solo se usa para overrides (pinned / hidden / notas).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  nombre          TEXT NOT NULL UNIQUE,
  event_date      TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,          -- forzar tab aunque < umbral
  hidden          INTEGER NOT NULL DEFAULT 0,          -- ocultar tab aunque >= umbral
  notas           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_pinned ON events(pinned);
CREATE INDEX IF NOT EXISTS idx_events_hidden ON events(hidden);

-- -----------------------------------------------------------------------------
-- OCR_LOG: histórico de capturas procesadas con Claude vision.
-- Sirve para auditar coste y reprocessar si hace falta.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ocr_log (
  id                 TEXT PRIMARY KEY,
  uploaded_at        TEXT NOT NULL,
  filename           TEXT,
  filepath           TEXT,                             -- ruta relativa en uploads/
  context            TEXT,                             -- compra | venta | otro
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cost_usd           REAL,
  result_json        TEXT,                             -- JSON del modelo
  created_stock_ids  TEXT,                             -- JSON array
  user               TEXT,                             -- quién subió
  error              TEXT
);

CREATE INDEX IF NOT EXISTS idx_ocr_log_date ON ocr_log(uploaded_at);

-- -----------------------------------------------------------------------------
-- CAPITAL_MOVEMENTS: depósitos y retiros de cash en la cuenta bancaria (Slash).
-- Esto permite separar "dinero que tenemos en el banco" de "dinero invertido en
-- tickets activos". El cash en banco = sum(deposits) - sum(withdrawals)
--                                       + sum(payouts cobrados) + cashback
--                                       - sum(precio retail tickets comprados)
--                                       - sum(gastos operativos).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capital_movements (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT 'deposit',     -- deposit | withdrawal
  amount       REAL NOT NULL,                        -- USD (siempre positivo)
  fecha        TEXT NOT NULL,
  source       TEXT,                                 -- 'Slash transfer' | 'Wire' | 'Wise' | ...
  notas        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cap_fecha ON capital_movements(fecha);
