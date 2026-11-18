import { createClient } from '@libsql/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS properties(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gstin TEXT, state TEXT, address TEXT, phone TEXT,
  business_date TEXT NOT NULL,
  fnb_gst_rate REAL NOT NULL DEFAULT 5,
  discount_limit_pct REAL NOT NULL DEFAULT 10,
  po_auto_limit INTEGER NOT NULL DEFAULT 2500000,
  po_gm_limit INTEGER NOT NULL DEFAULT 10000000,
  restaurant_tables INTEGER NOT NULL DEFAULT 18 CHECK(restaurant_tables BETWEEN 1 AND 200),
  invoice_seq INTEGER NOT NULL DEFAULT 0, pos_seq INTEGER NOT NULL DEFAULT 0, po_seq INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  property_id INTEGER REFERENCES properties(id), pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS room_types(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, max_occupancy INTEGER NOT NULL DEFAULT 2);

CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), number TEXT NOT NULL,
  room_type_id INTEGER NOT NULL REFERENCES room_types(id), floor TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','occupied','out_of_order')),
  hk_status TEXT NOT NULL DEFAULT 'clean' CHECK(hk_status IN ('clean','dirty','inspected')),
  UNIQUE(property_id, number));

CREATE TABLE IF NOT EXISTS rate_plans(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  base_price INTEGER NOT NULL CHECK(base_price > 0), public INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS rate_prices(
  id INTEGER PRIMARY KEY, rate_plan_id INTEGER NOT NULL REFERENCES rate_plans(id), property_id INTEGER REFERENCES properties(id),
  date_from TEXT NOT NULL, date_to TEXT NOT NULL, price INTEGER NOT NULL CHECK(price > 0), CHECK(date_to >= date_from));

CREATE TABLE IF NOT EXISTS guests(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, nationality TEXT NOT NULL DEFAULT 'Indian',
  id_type TEXT, id_number TEXT, address TEXT, gstin TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS guests_phone ON guests(phone);

CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, property_id INTEGER NOT NULL REFERENCES properties(id),
  guest_id INTEGER NOT NULL REFERENCES guests(id), room_type_id INTEGER NOT NULL REFERENCES room_types(id),
  rate_plan_id INTEGER NOT NULL REFERENCES rate_plans(id), room_id INTEGER REFERENCES rooms(id),
  arrival TEXT NOT NULL, departure TEXT NOT NULL, adults INTEGER NOT NULL DEFAULT 1, rates_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked','checked_in','checked_out','cancelled','no_show')),
  source TEXT NOT NULL CHECK(source IN ('website','walk_in','phone','ota','central')), ota_ref TEXT, form_c_no TEXT, notes TEXT,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, checked_in_at TEXT, checked_out_at TEXT,
  CHECK(departure > arrival));
CREATE INDEX IF NOT EXISTS res_dates ON reservations(property_id, status, arrival, departure);

CREATE TABLE IF NOT EXISTS menu_items(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), name TEXT NOT NULL, category TEXT,
  price INTEGER NOT NULL CHECK(price > 0), active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS pos_orders(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), table_no TEXT,
  reservation_id INTEGER REFERENCES reservations(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','settled_room','settled_direct','void')),
  business_date TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS pos_order_lines(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES pos_orders(id), menu_item_id INTEGER REFERENCES menu_items(id),
  name TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty > 0), price INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS folio_lines(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id),
  reservation_id INTEGER REFERENCES reservations(id), pos_order_id INTEGER REFERENCES pos_orders(id),
  business_date TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('room','fnb','extra')), description TEXT NOT NULL,
  amount INTEGER NOT NULL, tax_rate REAL NOT NULL, cgst INTEGER NOT NULL, sgst INTEGER NOT NULL, night TEXT,
  discount_of INTEGER REFERENCES folio_lines(id), reverses_id INTEGER REFERENCES folio_lines(id), voided INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS folio_res ON folio_lines(reservation_id);
CREATE INDEX IF NOT EXISTS folio_date ON folio_lines(property_id, business_date);

CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id),
  reservation_id INTEGER REFERENCES reservations(id), pos_order_id INTEGER REFERENCES pos_orders(id),
  business_date TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('cash','card','upi','online')), amount INTEGER NOT NULL,
  reference TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS pay_res ON payments(reservation_id);

CREATE TABLE IF NOT EXISTS invoices(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), number TEXT UNIQUE NOT NULL,
  reservation_id INTEGER REFERENCES reservations(id), pos_order_id INTEGER REFERENCES pos_orders(id),
  bill_to TEXT NOT NULL, bill_to_gstin TEXT, issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, business_date TEXT NOT NULL,
  taxable INTEGER NOT NULL, cgst INTEGER NOT NULL, sgst INTEGER NOT NULL, total INTEGER NOT NULL, paid INTEGER NOT NULL, lines_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, gstin TEXT, phone TEXT);

CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('fnb','housekeeping','maintenance')), tax_rate REAL NOT NULL DEFAULT 18);

CREATE TABLE IF NOT EXISTS stock(
  property_id INTEGER NOT NULL REFERENCES properties(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL DEFAULT 0 CHECK(qty >= 0), avg_cost INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(property_id, item_id));

CREATE TABLE IF NOT EXISTS purchase_orders(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, property_id INTEGER NOT NULL REFERENCES properties(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL CHECK(status IN ('requested','approved','rejected','received','paid')),
  needs TEXT, subtotal INTEGER NOT NULL, tax INTEGER NOT NULL, total INTEGER NOT NULL,
  created_by INTEGER, approved_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, received_at TEXT, paid_at TEXT);

CREATE TABLE IF NOT EXISTS po_lines(
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id), item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL CHECK(qty > 0), rate INTEGER NOT NULL CHECK(rate > 0), tax_rate REAL NOT NULL);

CREATE TABLE IF NOT EXISTS stock_moves(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL, item_id INTEGER NOT NULL REFERENCES items(id), qty REAL NOT NULL,
  unit_cost INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('receive','issue')), department TEXT, ref TEXT,
  business_date TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), room_id INTEGER REFERENCES rooms(id),
  title TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high')),
  blocks_room INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  resolution TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_by INTEGER, resolved_at TEXT);

CREATE TABLE IF NOT EXISTS accounts(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')));

CREATE TABLE IF NOT EXISTS journals(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), date TEXT NOT NULL, memo TEXT NOT NULL,
  source TEXT NOT NULL, source_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS journals_prop_date ON journals(property_id, date);

CREATE TABLE IF NOT EXISTS journal_lines(
  id INTEGER PRIMARY KEY, journal_id INTEGER NOT NULL REFERENCES journals(id), account_code TEXT NOT NULL REFERENCES accounts(code),
  debit INTEGER NOT NULL DEFAULT 0 CHECK(debit >= 0), credit INTEGER NOT NULL DEFAULT 0 CHECK(credit >= 0));
CREATE INDEX IF NOT EXISTS jl_journal ON journal_lines(journal_id);

CREATE TABLE IF NOT EXISTS night_audits(
  id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL REFERENCES properties(id), business_date TEXT NOT NULL,
  run_by INTEGER, run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, summary_json TEXT NOT NULL, UNIQUE(property_id, business_date));

CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, property_id INTEGER,
  action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT);
`;

// The transaction a request is running in, if any, follows that request through its awaits.
const current = new AsyncLocalStorage();
const args = a => a.map(v => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

// Wraps a libSQL client in the small API the app uses: db.prepare(sql).get/all/run(...args) and db.tx(fn), all async.
function wrap(client) {
  // inside a transaction statements run strictly one after another, even when the caller fires several at once
  const execute = (sql, a) => {
    const t = current.getStore();
    if (!t) return client.execute({ sql, args: args(a) });
    const p = t.queue.then(() => t.tx.execute({ sql, args: args(a) }));
    t.queue = p.catch(() => {});
    return p;
  };
  return {
    prepare: sql => ({
      get: async (...a) => (await execute(sql, a)).rows[0],
      all: async (...a) => (await execute(sql, a)).rows,
      run: async (...a) => { const r = await execute(sql, a); return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.rowsAffected }; },
    }),
    exec: sql => client.executeMultiple(sql),
    // re-entrant: nested calls join the transaction already open for this request
    async tx(fn) {
      if (current.getStore()) return fn();
      const t = await client.transaction('write');
      try {
        const r = await current.run({ tx: t, queue: Promise.resolve() }, fn);
        await t.commit();
        return r;
      } catch (e) {
        await t.rollback().catch(() => {});
        throw e;
      } finally {
        t.close();
      }
    },
    close: () => client.close(),
  };
}

// target: a local file path (development, tests) or { url, authToken } for Turso (libsql://...).
export async function openDb(target) {
  let client;
  if (typeof target === 'string') {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    client = createClient({ url: `file:${path.resolve(target)}` });
    await client.executeMultiple('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  } else {
    client = createClient({ url: target.url, authToken: target.authToken });
  }
  await client.executeMultiple('PRAGMA foreign_keys = ON;');
  const db = wrap(client);
  await db.exec(SCHEMA);
  // migration for databases created before the column existed; keeps all data
  if (!(await db.prepare('PRAGMA table_info(properties)').all()).some(c => c.name === 'restaurant_tables'))
    await db.exec('ALTER TABLE properties ADD COLUMN restaurant_tables INTEGER NOT NULL DEFAULT 18 CHECK(restaurant_tables BETWEEN 1 AND 200)');
  return db;
}
