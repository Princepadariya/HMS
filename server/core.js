import crypto from 'node:crypto';

// ---------- routing ----------
export const routes = [];
// perm: null = public, 'auth' = any signed-in user, string/array = any of these permissions
export function route(method, path, perm, fn) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, perm, fn });
}

export const err = (status, message) => Object.assign(new Error(message), { status });

// ---------- roles ----------
// reports = operational dashboard; books = financial statements; rack = front-desk view of room status
export const PERMS = {
  admin: ['*'],
  central_revenue: ['res', 'rates', 'reports'],
  central_purchasing: ['po', 'po_gm', 'po_central', 'inv', 'reports'],
  accountant: ['acc', 'books', 'reports'],
  gm: ['res', 'override', 'hk', 'hk_inspect', 'mt', 'pos', 'menu', 'inv', 'po', 'po_gm', 'reports', 'books', 'audit', 'rack'],
  duty_manager: ['res', 'override', 'hk', 'hk_inspect', 'mt', 'pos', 'reports', 'audit', 'rack'],
  front_desk: ['res', 'audit', 'rack'],
  hk_supervisor: ['hk', 'hk_inspect', 'mt'],
  housekeeper: ['hk'],
  maintenance: ['mt'],
  restaurant: ['pos'],
  storekeeper: ['inv', 'po'],
};
export const has = (user, perm) => {
  const p = PERMS[user.role] || [];
  return p.includes('*') || [].concat(perm).some(x => p.includes(x));
};
// '*' means every permission, including 'admin', which no other role lists
export const permsOf = user => (PERMS[user.role]?.includes('*') ? [...new Set([...Object.values(PERMS).flat(), 'admin'])].filter(p => p !== '*') : PERMS[user.role] || []);

// ---------- passwords ----------
// Initial password for every starter account. Each user should change it on first use.
export const INITIAL_PASSWORD = 'Hotel@2026';
export function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw err(400, 'Password must be at least 8 characters');
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
export function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(String(pw ?? ''), salt, 32));
}

// ---------- validation ----------
export function need(o, fields) {
  for (const f of fields) if (o?.[f] === undefined || o[f] === null || String(o[f]).trim() === '') throw err(400, `${f} is required`);
}
export function paise(v, name, { neg = false } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n === 0 || (!neg && n < 0)) throw err(400, `${name} must be a non-zero amount in paise`);
  return n;
}
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
export function date(v, name) {
  if (!isDate(v)) throw err(400, `${name} must be a date (YYYY-MM-DD)`);
  return v;
}

// ---------- dates ----------
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
export function nightsBetween(a, b) {
  const out = [];
  for (let d = a; d < b; d = addDays(d, 1)) out.push(d);
  return out;
}
// Indian financial year (Apr-Mar), e.g. 2026-11-17 -> "26-27"
export const fy = d => {
  const y = +d.slice(0, 4), start = +d.slice(5, 7) >= 4 ? y : y - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
};

// ---------- db helpers ----------
export const tx = (db, fn) => db.tx(fn);
export const setting = async (db, key) => (await db.prepare('SELECT value FROM settings WHERE key=?').get(key))?.value;
export async function prop(db, id) {
  const p = await db.prepare('SELECT * FROM properties WHERE id=?').get(Number(id));
  if (!p) throw err(404, 'Property not found');
  return p;
}
export async function audit(db, userId, propertyId, action, entity, entityId, detail) {
  await db.prepare('INSERT INTO audit_log(user_id, property_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)')
    .run(userId ?? null, propertyId ?? null, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null);
}

// ---------- ledger ----------
// lines: [accountCode, signedAmount]  (+ = debit, - = credit)
export async function post(db, { pid, date: d, memo, source, sourceId = null, userId = null }, lines) {
  const rows = lines.filter(([, a]) => a).map(([code, a]) => [code, a > 0 ? a : 0, a < 0 ? -a : 0]);
  if (!rows.length) return null;
  const dr = rows.reduce((s, r) => s + r[1], 0), cr = rows.reduce((s, r) => s + r[2], 0);
  if (dr !== cr) throw err(500, `Unbalanced journal "${memo}" (${dr} vs ${cr})`);
  const j = await db.prepare('INSERT INTO journals(property_id, date, memo, source, source_id, created_by) VALUES (?,?,?,?,?,?)')
    .run(pid, d, memo, source, sourceId, userId);
  await db.prepare(`INSERT INTO journal_lines(journal_id, account_code, debit, credit) VALUES ${rows.map(() => '(?,?,?,?)').join(',')}`)
    .run(...rows.flatMap(([code, debit, credit]) => [j.lastInsertRowid, code, debit, credit]));
  return j.lastInsertRowid;
}

// ---------- GST ----------
let slabCache = null; // shortcut: GST slabs are re-read at most once a minute per server instance; edits to the setting take up to 60 s
export async function roomTaxRate(db, nightly) {
  if (!slabCache || slabCache.db !== db || Date.now() - slabCache.at > 60e3) slabCache = { db, at: Date.now(), slabs: JSON.parse(await setting(db, 'room_gst_slabs')) };
  return slabCache.slabs.find(s => s.upto == null || nightly <= s.upto).rate;
}
// Intra-state supply: half CGST, half SGST. Sign follows the amount (discounts/reversals are negative).
export function taxOf(amount, rate) {
  const half = Math.round((Math.abs(amount) * rate) / 200);
  return amount < 0 ? { cgst: -half, sgst: -half } : { cgst: half, sgst: half };
}
export async function taxRateFor(db, p, category, amount, given) {
  if (category === 'room') return roomTaxRate(db, amount);
  if (category === 'fnb') return p.fnb_gst_rate;
  const r = given ?? 18;
  if (![0, 5, 12, 18, 28, 40].includes(Number(r))) throw err(400, 'tax_rate must be a GST rate (0, 5, 12, 18, 28 or 40)');
  return Number(r);
}

// ---------- folio & payments ----------
const REVENUE = { room: '4000', fnb: '4100', extra: '4200' };
export const PAY_ACCOUNT = { cash: '1000', card: '1010', upi: '1010', online: '1010' };

export async function addCharge(db, userId, l) {
  const { cgst, sgst } = l.cgst !== undefined ? l : taxOf(l.amount, l.tax_rate);
  const r = await db.prepare(`INSERT INTO folio_lines(property_id, reservation_id, pos_order_id, business_date, category, description,
      amount, tax_rate, cgst, sgst, night, discount_of, reverses_id, voided, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(l.property_id, l.reservation_id ?? null, l.pos_order_id ?? null, l.business_date, l.category, l.description,
      l.amount, l.tax_rate, cgst, sgst, l.night ?? null, l.discount_of ?? null, l.reverses_id ?? null, l.reverses_id ? 1 : 0, userId);
  await post(db, { pid: l.property_id, date: l.business_date, memo: l.description, source: 'folio', sourceId: r.lastInsertRowid, userId },
    [['1100', l.amount + cgst + sgst], [REVENUE[l.category], -l.amount], ['2100', -cgst], ['2110', -sgst]]);
  return r.lastInsertRowid;
}

export async function addPayment(db, userId, p) {
  if (!PAY_ACCOUNT[p.mode]) throw err(400, 'mode must be cash, card, upi or online');
  const r = await db.prepare(`INSERT INTO payments(property_id, reservation_id, pos_order_id, business_date, mode, amount, reference, created_by)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(p.property_id, p.reservation_id ?? null, p.pos_order_id ?? null, p.business_date, p.mode, p.amount, p.reference ?? null, userId);
  await post(db, { pid: p.property_id, date: p.business_date, memo: `${p.amount < 0 ? 'Refund' : 'Payment'} (${p.mode})`, source: 'payment', sourceId: r.lastInsertRowid, userId },
    [[PAY_ACCOUNT[p.mode], p.amount], ['1100', -p.amount]]);
  return r.lastInsertRowid;
}

export async function balanceOf(db, col, id) {
  const charges = (await db.prepare(`SELECT COALESCE(SUM(amount + cgst + sgst), 0) v FROM folio_lines WHERE ${col}=?`).get(id)).v;
  const paid = (await db.prepare(`SELECT COALESCE(SUM(amount), 0) v FROM payments WHERE ${col}=?`).get(id)).v;
  return charges - paid;
}

// Issues a numbered GST invoice for every non-voided line of a folio (reservation or POS order).
export async function issueInvoice(db, p, col, id, billTo, gstin) {
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) throw err(400, 'bill_to_gstin is not a valid GSTIN');
  const lines = (await db.prepare(`SELECT business_date, category, description, amount, tax_rate, cgst, sgst FROM folio_lines
      WHERE ${col}=? AND voided=0 ORDER BY id`).all(id)).map(l => ({ ...l }));
  const sum = k => lines.reduce((s, l) => s + l[k], 0);
  const paid = (await db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM payments WHERE ${col}=?`).get(id)).v;
  const seqCol = col === 'reservation_id' ? 'invoice_seq' : 'pos_seq';
  await db.prepare(`UPDATE properties SET ${seqCol} = ${seqCol} + 1 WHERE id=?`).run(p.id);
  const seq = (await db.prepare(`SELECT ${seqCol} s FROM properties WHERE id=?`).get(p.id)).s;
  const number = `${p.code}/${col === 'reservation_id' ? 'INV' : 'POS'}/${fy(p.business_date)}/${String(seq).padStart(5, '0')}`;
  const r = await db.prepare(`INSERT INTO invoices(property_id, number, reservation_id, pos_order_id, bill_to, bill_to_gstin, business_date,
      taxable, cgst, sgst, total, paid, lines_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(p.id, number, col === 'reservation_id' ? id : null, col === 'pos_order_id' ? id : null, billTo, gstin || null, p.business_date,
      sum('amount'), sum('cgst'), sum('sgst'), sum('amount') + sum('cgst') + sum('sgst'), paid, JSON.stringify(lines));
  return r.lastInsertRowid;
}

// ---------- rates & availability ----------
// Price for each night. Most specific wins: a hotel override before a group-wide one, then the shortest date range, else the plan's base price.
export async function nightlyPrices(db, planId, pid, nights) {
  const [overrides, plan] = await Promise.all([
    db.prepare(`SELECT property_id, date_from, date_to, price FROM rate_prices WHERE rate_plan_id=? AND (property_id=? OR property_id IS NULL)
      AND date_from <= ? AND date_to >= ?`).all(planId, pid, nights.at(-1), nights[0]),
    db.prepare('SELECT base_price FROM rate_plans WHERE id=?').get(planId),
  ]);
  const rank = o => [o.property_id == null ? 1 : 0, diffDays(o.date_from, o.date_to)];
  return nights.map(d => {
    const best = overrides.filter(o => o.date_from <= d && d <= o.date_to)
      .sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1])[0];
    return best ? best.price : plan.base_price;
  });
}

// Free rooms of a type on the tightest night of the stay (one query for all nights).
export async function available(db, pid, typeId, arrival, departure) {
  const rooms = (await db.prepare(`SELECT COUNT(*) n FROM rooms WHERE property_id=? AND room_type_id=? AND status != 'out_of_order'`).get(pid, typeId)).n;
  const res = await db.prepare(`SELECT arrival, departure FROM reservations WHERE property_id=? AND room_type_id=?
      AND status IN ('booked','checked_in') AND arrival < ? AND departure > ?`).all(pid, typeId, departure, arrival);
  return Math.min(...nightsBetween(arrival, departure).map(d => rooms - res.filter(r => r.arrival <= d && r.departure > d).length));
}

const PHONE = /^\+?[0-9][0-9 -]{6,18}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function upsertGuest(db, g) {
  need(g, ['name', 'phone']);
  const name = String(g.name).trim().slice(0, 120), phone = String(g.phone).trim();
  if (!PHONE.test(phone)) throw err(400, 'phone is not valid');
  if (g.email && !EMAIL.test(g.email)) throw err(400, 'email is not valid');
  const found = await db.prepare('SELECT * FROM guests WHERE phone=? ORDER BY id LIMIT 1').get(phone);
  if (found) {
    // never overwrite an existing profile's name from an unauthenticated form; only fill blanks
    if (g.email && !found.email) await db.prepare('UPDATE guests SET email=? WHERE id=?').run(g.email, found.id);
    return found.id;
  }
  return (await db.prepare('INSERT INTO guests(name, phone, email, nationality, address) VALUES (?,?,?,?,?)')
    .run(name, phone, g.email || null, g.nationality || 'Indian', g.address || null)).lastInsertRowid;
}

export async function createReservation(db, userId, b) {
  need(b, ['property_id', 'rate_plan_id', 'arrival', 'departure', 'source']);
  const p = await prop(db, b.property_id);
  date(b.arrival, 'arrival');
  date(b.departure, 'departure');
  if (b.arrival < p.business_date) throw err(400, `Arrival cannot be before the hotel's business date (${p.business_date})`);
  const n = diffDays(b.arrival, b.departure);
  if (n < 1 || n > 60) throw err(400, 'Stay must be 1 to 60 nights');
  const plan = await db.prepare('SELECT * FROM rate_plans WHERE id=? AND active=1').get(Number(b.rate_plan_id));
  if (!plan) throw err(400, 'Unknown rate plan');
  const type = await db.prepare('SELECT * FROM room_types WHERE id=?').get(plan.room_type_id);
  const adults = Number(b.adults || 1);
  if (!Number.isInteger(adults) || adults < 1 || adults > type.max_occupancy) throw err(400, `${type.name} takes 1 to ${type.max_occupancy} adults`);
  if (!['website', 'walk_in', 'phone', 'ota', 'central'].includes(b.source)) throw err(400, 'Unknown booking source');

  return tx(db, async () => {
    if ((await available(db, p.id, plan.room_type_id, b.arrival, b.departure)) < 1) throw err(409, `No ${type.name} rooms free for these dates`);
    let guestId = b.guest_id && Number(b.guest_id);
    if (guestId) { if (!(await db.prepare('SELECT 1 FROM guests WHERE id=?').get(guestId))) throw err(400, 'Unknown guest'); }
    else guestId = await upsertGuest(db, b.guest || {});
    const rates = await nightlyPrices(db, plan.id, p.id, nightsBetween(b.arrival, b.departure));
    const r = await db.prepare(`INSERT INTO reservations(code, property_id, guest_id, room_type_id, rate_plan_id, arrival, departure, adults,
        rates_json, source, ota_ref, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), p.id, guestId, type.id, plan.id, b.arrival, b.departure, adults, JSON.stringify(rates),
        b.source, b.ota_ref || null, b.notes || null, userId);
    const id = r.lastInsertRowid;
    await db.prepare('UPDATE reservations SET code=? WHERE id=?').run(`${p.code}-${String(id).padStart(6, '0')}`, id);
    await audit(db, userId, p.id, 'reservation.create', 'reservation', id, { source: b.source, arrival: b.arrival, departure: b.departure });
    if (b.advance?.amount) {
      await addPayment(db, userId, { property_id: p.id, reservation_id: id, business_date: p.business_date, mode: b.advance.mode,
        amount: paise(b.advance.amount, 'advance amount'), reference: b.advance.reference });
    }
    return id;
  });
}
