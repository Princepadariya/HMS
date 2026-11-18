import crypto from 'node:crypto';
import {
  route, err, has, permsOf, PERMS, hashPassword, checkPassword, need, paise, date, isDate, addDays, diffDays, nightsBetween, tx, prop, audit,
  post, taxRateFor, roomTaxRate, addCharge, addPayment, balanceOf, issueInvoice, nightlyPrices, available, createReservation, INITIAL_PASSWORD,
} from './core.js';

const bindable = v => (typeof v === 'boolean' ? Number(v) : v);
const inList = n => Array(n).fill('?').join(',');

// ---------- scoping helpers ----------
// Property users are locked to their hotel; group users must name one.
async function pidOf(c, v = c.query.property_id ?? c.body?.property_id) {
  if (c.user.property_id) {
    if (v && Number(v) !== c.user.property_id) throw err(403, 'You can only work on your own hotel');
    return c.user.property_id;
  }
  if (!v) throw err(400, 'property_id is required');
  return (await prop(c.db, v)).id;
}
// For lists: a group user may omit property_id to see every hotel.
const pidAll = async c => (c.user.property_id ? pidOf(c) : c.query.property_id ? (await prop(c.db, c.query.property_id)).id : null);
function own(c, row, what = 'Record') {
  if (!row) throw err(404, `${what} not found`);
  if (c.user.property_id && row.property_id !== c.user.property_id) throw err(403, 'You can only work on your own hotel');
  return row;
}
const byPid = pid => (pid ? ['property_id = ?', [pid]] : ['1=1', []]);

// Manager approval: the signed-in user has 'override', or a GM/duty manager types their credentials into the same request.
async function approver(c, pid, what) {
  if (has(c.user, 'override')) return c.user;
  const o = c.body?.override;
  if (o?.username && o?.password) {
    const u = await c.db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(o.username));
    if (u && checkPassword(o.password, u.pass_hash) && has(u, 'override') && (!u.property_id || u.property_id === pid)) return u;
    throw err(403, 'Manager approval rejected (wrong credentials or not a manager of this hotel)');
  }
  throw err(403, `${what} needs manager approval`);
}

// ---------- auth ----------
const failures = new Map(); // username -> { n, until }; shortcut: per server instance, so on Vercel the lockout is best-effort
route('POST', '/api/login', null, async c => {
  need(c.body, ['username', 'password']);
  const name = String(c.body.username);
  const f = failures.get(name);
  if (f?.until > Date.now()) throw err(429, 'Too many failed attempts. Try again in 5 minutes.');
  const u = await c.db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(name);
  if (!u || !checkPassword(c.body.password, u.pass_hash)) {
    const n = (f?.n || 0) + 1;
    failures.set(name, { n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
    throw err(401, 'Wrong username or password');
  }
  failures.delete(name);
  const token = crypto.randomBytes(32).toString('hex');
  await c.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  await c.db.prepare('INSERT INTO sessions(token, user_id, expires) VALUES (?,?,?)').run(token, u.id, Date.now() + 12 * 3600e3);
  await audit(c.db, u.id, u.property_id, 'login', 'user', u.id);
  return { token, user: { id: u.id, name: u.name, role: u.role, property_id: u.property_id } };
});
// Quick sign-in list on the login page: active users still on the initial password. Set HIDE_QUICK_LOGIN=1 before real use.
route('GET', '/api/public/quick-logins', null, async c => {
  if (process.env.HIDE_QUICK_LOGIN) return [];
  return (await c.db.prepare(`SELECT u.username, u.name, u.role, u.pass_hash, p.code property_code, p.name property_name FROM users u LEFT JOIN properties p ON p.id=u.property_id
    WHERE u.active=1 ORDER BY u.property_id IS NOT NULL, p.code, u.id`).all())
    .filter(u => checkPassword(INITIAL_PASSWORD, u.pass_hash))
    .map(({ pass_hash, ...u }) => ({ ...u, password: INITIAL_PASSWORD }));
});
route('POST', '/api/logout', 'auth', async c => {
  await c.db.prepare('DELETE FROM sessions WHERE token=?').run(c.token);
  return { ok: true };
});
route('GET', '/api/me', 'auth', async c => ({
  user: { id: c.user.id, name: c.user.name, username: c.user.username, role: c.user.role, property_id: c.user.property_id },
  perms: permsOf(c.user),
  roles: Object.keys(PERMS),
  properties: c.user.property_id
    ? await c.db.prepare('SELECT * FROM properties WHERE id=?').all(c.user.property_id)
    : await c.db.prepare('SELECT * FROM properties ORDER BY id').all(),
}));

// ---------- simple master data ----------
function crud(table, cols, { read = 'auth', write, required = [], scoped = false, search, validate }) {
  route('GET', `/api/${table}`, read, async c => {
    const where = [], args = [];
    if (scoped) { const pid = await pidAll(c); if (pid) { where.push('property_id=?'); args.push(pid); } }
    if (search && c.query.q) { where.push(`(${search.map(s => `${s} LIKE ?`).join(' OR ')})`); args.push(...search.map(() => `%${c.query.q}%`)); }
    return c.db.prepare(`SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id LIMIT 500`).all(...args);
  });
  route('POST', `/api/${table}`, write, async c => {
    need(c.body, required);
    if (scoped) c.body.property_id = await pidOf(c);
    validate?.(c.body, c);
    const keys = cols.filter(k => c.body[k] !== undefined);
    const r = await c.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => bindable(c.body[k])));
    await audit(c.db, c.user.id, c.body.property_id, `${table}.create`, table, r.lastInsertRowid, c.body);
    return c.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid);
  });
  route('PUT', `/api/${table}/:id`, write, async c => {
    const row = await c.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(c.params.id));
    if (!row) throw err(404, 'Not found');
    if (scoped) { own(c, row); delete c.body.property_id; }
    validate?.({ ...row, ...c.body }, c);
    const keys = cols.filter(k => c.body[k] !== undefined);
    if (keys.length) await c.db.prepare(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => bindable(c.body[k])), row.id);
    await audit(c.db, c.user.id, row.property_id, `${table}.update`, table, row.id, c.body);
    return c.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);
  });
}
const gstinOk = v => !v || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
crud('properties', ['code', 'name', 'gstin', 'state', 'address', 'phone', 'business_date', 'fnb_gst_rate', 'discount_limit_pct', 'po_auto_limit', 'po_gm_limit', 'restaurant_tables'],
  { write: 'admin', required: ['code', 'name', 'business_date'], validate: b => {
    date(b.business_date, 'business_date');
    if (!gstinOk(b.gstin)) throw err(400, 'gstin is not valid');
    if (b.restaurant_tables !== undefined && !(Number.isInteger(Number(b.restaurant_tables)) && b.restaurant_tables >= 1 && b.restaurant_tables <= 200))
      throw err(400, 'Restaurant tables must be a whole number from 1 to 200');
  } });
crud('room_types', ['code', 'name', 'max_occupancy'], { write: 'admin', required: ['code', 'name'] });
crud('rooms', ['property_id', 'number', 'room_type_id', 'floor'], { write: 'admin', required: ['number', 'room_type_id'], scoped: true });
crud('rate_plans', ['code', 'name', 'room_type_id', 'base_price', 'public', 'active'], { write: 'rates', required: ['code', 'name', 'room_type_id', 'base_price'] });
crud('rate_prices', ['rate_plan_id', 'property_id', 'date_from', 'date_to', 'price'], {
  write: 'rates', required: ['rate_plan_id', 'date_from', 'date_to', 'price'],
  validate: b => { date(b.date_from, 'date_from'); date(b.date_to, 'date_to'); if (b.property_id === '') b.property_id = null; },
});
crud('menu_items', ['property_id', 'name', 'category', 'price', 'active'], { write: 'menu', required: ['name', 'price'], scoped: true });
crud('suppliers', ['name', 'gstin', 'phone'], { read: ['po', 'inv', 'acc'], write: 'po', required: ['name'], validate: b => { if (!gstinOk(b.gstin)) throw err(400, 'gstin is not valid'); } });
crud('items', ['code', 'name', 'unit', 'category', 'tax_rate'], { read: ['po', 'inv', 'acc'], write: ['po', 'inv'], required: ['code', 'name', 'unit', 'category'] });
crud('guests', ['name', 'phone', 'email', 'nationality', 'id_type', 'id_number', 'address', 'gstin'], {
  read: ['res', 'pos'], write: 'res', required: ['name', 'phone'], search: ['name', 'phone', 'email'],
  validate: b => { if (!gstinOk(b.gstin)) throw err(400, 'gstin is not valid'); },
});

route('GET', '/api/users', 'admin', c => c.db.prepare('SELECT id, username, name, role, property_id, active FROM users ORDER BY id').all());
route('POST', '/api/users', 'admin', async c => {
  need(c.body, ['username', 'name', 'role', 'password']);
  if (!PERMS[c.body.role]) throw err(400, 'Unknown role');
  const pid = c.body.property_id ? (await prop(c.db, c.body.property_id)).id : null;
  const r = await c.db.prepare('INSERT INTO users(username, name, role, property_id, pass_hash) VALUES (?,?,?,?,?)')
    .run(String(c.body.username).trim(), c.body.name, c.body.role, pid, hashPassword(c.body.password));
  await audit(c.db, c.user.id, pid, 'user.create', 'user', r.lastInsertRowid, { username: c.body.username, role: c.body.role });
  return { id: r.lastInsertRowid };
});
route('PUT', '/api/users/:id', 'admin', async c => {
  const u = await c.db.prepare('SELECT * FROM users WHERE id=?').get(Number(c.params.id));
  if (!u) throw err(404, 'User not found');
  const b = c.body;
  if (b.role && !PERMS[b.role]) throw err(400, 'Unknown role');
  const pid = b.property_id === undefined ? u.property_id : (b.property_id ? (await prop(c.db, b.property_id)).id : null);
  await c.db.prepare('UPDATE users SET name=?, role=?, property_id=?, active=? WHERE id=?')
    .run(b.name ?? u.name, b.role ?? u.role, pid, b.active === undefined ? u.active : Number(Boolean(b.active)), u.id);
  if (b.password) await c.db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(b.password), u.id);
  if ((b.active !== undefined && !b.active) || b.password) await c.db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
  await audit(c.db, c.user.id, u.property_id, 'user.update', 'user', u.id, { ...b, password: b.password ? '***' : undefined });
  return { ok: true };
});

// ---------- availability & reservations ----------
async function availability(db, pid, arrival, departure, publicOnly) {
  date(arrival, 'arrival'); date(departure, 'departure');
  if (departure <= arrival) throw err(400, 'departure must be after arrival');
  const nights = nightsBetween(arrival, departure);
  if (nights.length > 60) throw err(400, 'Stay must be 60 nights or fewer');
  const types = await db.prepare('SELECT * FROM room_types ORDER BY id').all();
  const plans = await db.prepare(`SELECT id, code, name, room_type_id FROM rate_plans WHERE active=1 ${publicOnly ? 'AND public=1' : ''} ORDER BY id`).all();
  return (await Promise.all(types.map(async t => ({
    room_type_id: t.id, room_type: t.name, max_occupancy: t.max_occupancy,
    available: await available(db, pid, t.id, arrival, departure),
    plans: await Promise.all(plans.filter(pl => pl.room_type_id === t.id).map(async pl => {
      const nightly = await nightlyPrices(db, pl.id, pid, nights);
      const total = nightly.reduce((s, n) => s + n, 0);
      let tax = 0;
      for (const n of nightly) tax += 2 * Math.round((n * (await roomTaxRate(db, n))) / 200);
      return { rate_plan_id: pl.id, code: pl.code, name: pl.name, nightly, total, tax };
    })),
  })))).filter(t => t.plans.length);
}
route('GET', '/api/availability', 'res', async c => availability(c.db, await pidOf(c), c.query.arrival, c.query.departure, false));

const RES_LIST = `SELECT r.*, g.name guest_name, g.phone guest_phone, t.name room_type, rm.number room_number, p.code property_code,
  (SELECT COALESCE(SUM(amount+cgst+sgst),0) FROM folio_lines WHERE reservation_id=r.id) -
  (SELECT COALESCE(SUM(amount),0) FROM payments WHERE reservation_id=r.id) balance
  FROM reservations r JOIN guests g ON g.id=r.guest_id JOIN room_types t ON t.id=r.room_type_id JOIN properties p ON p.id=r.property_id
  LEFT JOIN rooms rm ON rm.id=r.room_id`;
route('GET', '/api/reservations', 'res', async c => {
  const where = [], args = [];
  const pid = await pidAll(c);
  if (pid) { where.push('r.property_id=?'); args.push(pid); }
  for (const k of ['status', 'arrival', 'departure']) if (c.query[k]) { where.push(`r.${k}=?`); args.push(c.query[k]); }
  if (c.query.q) { where.push('(g.name LIKE ? OR g.phone LIKE ? OR r.code LIKE ?)'); args.push(...Array(3).fill(`%${c.query.q}%`)); }
  return c.db.prepare(`${RES_LIST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.arrival DESC, r.id DESC LIMIT 300`).all(...args);
});
route('POST', '/api/reservations', 'res', async c => {
  c.body.property_id = await pidOf(c);
  if (c.body.source === 'website') throw err(400, 'Website bookings come only from the booking site');
  return resDetail(c, await createReservation(c.db, c.user.id, c.body));
});

async function loadRes(c) {
  return own(c, await c.db.prepare('SELECT * FROM reservations WHERE id=?').get(Number(c.params.id)), 'Reservation');
}
async function resDetail(c, id) {
  const r = await c.db.prepare(`${RES_LIST} WHERE r.id=?`).get(id);
  const [guest, lines, payments, invoice, p] = await Promise.all([
    c.db.prepare('SELECT * FROM guests WHERE id=?').get(r.guest_id),
    c.db.prepare('SELECT * FROM folio_lines WHERE reservation_id=? ORDER BY id').all(id),
    c.db.prepare('SELECT * FROM payments WHERE reservation_id=? ORDER BY id').all(id),
    c.db.prepare('SELECT id, number FROM invoices WHERE reservation_id=?').get(id),
    prop(c.db, r.property_id),
  ]);
  return { ...r, rates: JSON.parse(r.rates_json), guest, lines, payments, invoice: invoice || null, business_date: p.business_date };
}
route('GET', '/api/reservations/:id', 'res', async c => resDetail(c, (await loadRes(c)).id));
route('GET', '/api/guests/:id/history', 'res', async c => {
  const g = await c.db.prepare('SELECT * FROM guests WHERE id=?').get(Number(c.params.id));
  if (!g) throw err(404, 'Guest not found');
  return { guest: g, stays: await c.db.prepare(`${RES_LIST} WHERE r.guest_id=? ORDER BY r.arrival DESC`).all(g.id) };
});

route('POST', '/api/reservations/:id/check-in', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id), b = c.body;
  if (r.status !== 'booked') throw err(400, `Reservation is ${r.status}`);
  if (r.arrival > p.business_date) throw err(400, `Arrival is ${r.arrival}; today's business date is ${p.business_date}`);
  if (r.departure <= p.business_date) throw err(400, 'Departure date has passed; amend the booking first');
  need(b, ['room_id', 'id_type', 'id_number']);
  const g = await c.db.prepare('SELECT * FROM guests WHERE id=?').get(r.guest_id);
  const nationality = b.nationality || g.nationality;
  if (nationality.toLowerCase() !== 'indian' && !b.form_c_no) throw err(400, 'Form C number is required for foreign nationals');
  return tx(c.db, async () => {
    const room = await c.db.prepare('SELECT * FROM rooms WHERE id=? AND property_id=?').get(Number(b.room_id), r.property_id);
    if (!room) throw err(400, 'Room not found at this hotel');
    if (room.room_type_id !== r.room_type_id) throw err(400, 'Room is a different room type than booked');
    if (room.status !== 'available') throw err(409, `Room ${room.number} is ${room.status.replace('_', ' ')}`);
    if (room.hk_status === 'dirty') throw err(409, `Room ${room.number} is dirty`);
    if ((await busyRooms(c.db, p, p.business_date, r.departure, r.id)).has(room.id)) throw err(409, `Room ${room.number} is reserved for another guest on these dates`);
    await c.db.prepare('UPDATE guests SET id_type=?, id_number=?, nationality=? WHERE id=?').run(b.id_type, String(b.id_number).trim(), nationality, g.id);
    await c.db.prepare(`UPDATE reservations SET status='checked_in', room_id=?, form_c_no=?, checked_in_at=CURRENT_TIMESTAMP WHERE id=?`).run(room.id, b.form_c_no || null, r.id);
    await c.db.prepare(`UPDATE rooms SET status='occupied' WHERE id=?`).run(room.id);
    await audit(c.db, c.user.id, r.property_id, 'reservation.check_in', 'reservation', r.id, { room: room.number });
    return resDetail(c, r.id);
  });
});

route('POST', '/api/reservations/:id/cancel', 'res', async c => {
  const r = await loadRes(c);
  if (r.status !== 'booked') throw err(400, `Only booked reservations can be cancelled (this one is ${r.status})`);
  await c.db.prepare(`UPDATE reservations SET status='cancelled' WHERE id=?`).run(r.id);
  await audit(c.db, c.user.id, r.property_id, 'reservation.cancel', 'reservation', r.id, { reason: c.body.reason });
  return resDetail(c, r.id);
});

route('POST', '/api/reservations/:id/charges', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id), b = c.body;
  if (!['booked', 'checked_in'].includes(r.status)) throw err(400, `Cannot post to a ${r.status} reservation`);
  need(b, ['category', 'description', 'amount']);
  if (!['room', 'fnb', 'extra'].includes(b.category)) throw err(400, 'category must be room, fnb or extra');
  const amount = paise(b.amount, 'amount');
  const taxRate = await taxRateFor(c.db, p, b.category, amount, b.tax_rate);
  await tx(c.db, async () => {
    const id = await addCharge(c.db, c.user.id, { property_id: p.id, reservation_id: r.id, business_date: p.business_date, category: b.category,
      description: String(b.description).slice(0, 200), amount, tax_rate: taxRate });
    await audit(c.db, c.user.id, p.id, 'folio.charge', 'folio_line', id, { amount, category: b.category });
  });
  return resDetail(c, r.id);
});

route('POST', '/api/reservations/:id/discount', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id), b = c.body;
  if (!['booked', 'checked_in'].includes(r.status)) throw err(400, `Cannot discount a ${r.status} reservation`);
  need(b, ['line_id', 'amount', 'reason']);
  const line = await c.db.prepare('SELECT * FROM folio_lines WHERE id=? AND reservation_id=?').get(Number(b.line_id), r.id);
  if (!line || line.voided || line.amount <= 0 || line.discount_of) throw err(400, 'Pick a live charge line to discount');
  const already = -(await c.db.prepare('SELECT COALESCE(SUM(amount),0) v FROM folio_lines WHERE discount_of=? AND voided=0').get(line.id)).v;
  const amount = paise(b.amount, 'amount');
  if (amount + already > line.amount) throw err(400, 'Discount is larger than the charge');
  const pct = ((amount + already) / line.amount) * 100;
  const ok = pct > p.discount_limit_pct ? await approver(c, p.id, `A ${pct.toFixed(1)}% discount (limit ${p.discount_limit_pct}%)`) : c.user;
  await tx(c.db, async () => {
    const id = await addCharge(c.db, c.user.id, { property_id: p.id, reservation_id: r.id, business_date: p.business_date, category: line.category,
      description: `Discount on: ${line.description} (${String(b.reason).slice(0, 100)})`, amount: -amount, tax_rate: line.tax_rate, discount_of: line.id });
    await audit(c.db, c.user.id, p.id, 'folio.discount', 'folio_line', id, { amount, pct: +pct.toFixed(2), approved_by: ok.username, reason: b.reason });
  });
  return resDetail(c, r.id);
});

route('POST', '/api/folio-lines/:id/void', ['res', 'pos'], async c => {
  const line = own(c, await c.db.prepare('SELECT * FROM folio_lines WHERE id=?').get(Number(c.params.id)), 'Charge');
  need(c.body, ['reason']);
  if (line.voided) throw err(400, 'Line is already voided');
  if (!line.reservation_id) throw err(400, 'Restaurant bills are voided from the POS');
  const r = await c.db.prepare('SELECT * FROM reservations WHERE id=?').get(line.reservation_id);
  if (!['booked', 'checked_in'].includes(r.status)) throw err(400, `Cannot change a ${r.status} folio`);
  const ok = await approver(c, line.property_id, 'Voiding a charge');
  const p = await prop(c.db, line.property_id);
  await tx(c.db, async () => {
    // a discount attached to this line goes with it
    for (const l of [line, ...await c.db.prepare('SELECT * FROM folio_lines WHERE discount_of=? AND voided=0').all(line.id)]) {
      await addCharge(c.db, c.user.id, { property_id: p.id, reservation_id: l.reservation_id, business_date: p.business_date, category: l.category,
        description: `VOID: ${l.description}`, amount: -l.amount, tax_rate: l.tax_rate, cgst: -l.cgst, sgst: -l.sgst, reverses_id: l.id, night: l.night });
      await c.db.prepare('UPDATE folio_lines SET voided=1 WHERE id=?').run(l.id);
    }
    await audit(c.db, c.user.id, p.id, 'folio.void', 'folio_line', line.id, { amount: line.amount, approved_by: ok.username, reason: c.body.reason });
  });
  return resDetail(c, line.reservation_id);
});

route('POST', '/api/reservations/:id/payments', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id), b = c.body;
  const amount = paise(b.amount, 'amount', { neg: true });
  if (amount > 0 && !['booked', 'checked_in'].includes(r.status)) throw err(400, `Cannot take payment on a ${r.status} reservation`);
  if (amount < 0 && r.status === 'checked_out') throw err(400, 'Folio is closed');
  let ok = c.user;
  if (amount < 0) {
    ok = await approver(c, p.id, 'A refund');
    if (-amount > -(await balanceOf(c.db, 'reservation_id', r.id))) throw err(400, 'Refund is more than the guest has in credit');
  }
  await tx(c.db, async () => {
    const id = await addPayment(c.db, c.user.id, { property_id: p.id, reservation_id: r.id, business_date: p.business_date, mode: b.mode, amount, reference: b.reference });
    await audit(c.db, c.user.id, p.id, amount < 0 ? 'payment.refund' : 'payment.receive', 'payment', id, { amount, mode: b.mode, approved_by: ok.username });
  });
  return resDetail(c, r.id);
});

route('POST', '/api/reservations/:id/check-out', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id);
  if (r.status !== 'checked_in') throw err(400, `Reservation is ${r.status}`);
  return tx(c.db, async () => {
    // same-day stay: charge the first night so a stay is never free
    const nights = (await c.db.prepare(`SELECT COUNT(*) n FROM folio_lines WHERE reservation_id=? AND night IS NOT NULL AND voided=0`).get(r.id)).n;
    if (!nights) {
      const rate = JSON.parse(r.rates_json)[0];
      await addCharge(c.db, c.user.id, { property_id: p.id, reservation_id: r.id, business_date: p.business_date, category: 'room',
        description: `Room charge ${p.business_date}`, amount: rate, tax_rate: await roomTaxRate(c.db, rate), night: p.business_date });
    }
    const bal = await balanceOf(c.db, 'reservation_id', r.id);
    if (bal !== 0) throw err(400, `Settle the folio first: balance ${bal > 0 ? 'due' : 'in credit'} Rs ${(Math.abs(bal) / 100).toFixed(2)}`);
    const g = await c.db.prepare('SELECT * FROM guests WHERE id=?').get(r.guest_id);
    const invId = await issueInvoice(c.db, p, 'reservation_id', r.id, c.body.bill_to || g.name, c.body.bill_to_gstin || g.gstin);
    await c.db.prepare(`UPDATE reservations SET status='checked_out', checked_out_at=CURRENT_TIMESTAMP WHERE id=?`).run(r.id);
    const blocked = await c.db.prepare(`SELECT 1 FROM tickets WHERE room_id=? AND status='open' AND blocks_room=1`).get(r.room_id);
    await c.db.prepare(`UPDATE rooms SET status=?, hk_status='dirty' WHERE id=?`).run(blocked ? 'out_of_order' : 'available', r.room_id);
    await audit(c.db, c.user.id, p.id, 'reservation.check_out', 'reservation', r.id, { invoice_id: invId });
    return { ...await resDetail(c, r.id), invoice_id: invId };
  });
});

route('GET', '/api/invoices', ['res', 'pos', 'acc', 'reports'], async c => {
  const [w, a] = byPid(await pidAll(c));
  const from = c.query.from || '0000-01-01', to = c.query.to || '9999-12-31';
  return c.db.prepare(`SELECT id, property_id, number, bill_to, bill_to_gstin, business_date, taxable, cgst, sgst, total, reservation_id, pos_order_id
    FROM invoices WHERE ${w} AND business_date BETWEEN ? AND ? ORDER BY id DESC LIMIT 500`).all(...a, from, to);
});
route('GET', '/api/invoices/:id', ['res', 'pos', 'acc', 'reports'], async c => {
  const inv = own(c, await c.db.prepare('SELECT * FROM invoices WHERE id=?').get(Number(c.params.id)), 'Invoice');
  const r = inv.reservation_id && await c.db.prepare(`${RES_LIST} WHERE r.id=?`).get(inv.reservation_id);
  return { ...inv, lines: JSON.parse(inv.lines_json), property: await prop(c.db, inv.property_id), reservation: r || null };
});

// ---------- housekeeping & maintenance ----------
route('GET', '/api/housekeeping', ['hk', 'res', 'mt'], async c => {
  const pid = await pidOf(c), bd = (await prop(c.db, pid)).business_date;
  return c.db.prepare(`SELECT rm.*, t.name room_type, g.name guest_name, r.id reservation_id, r.departure,
      (r.departure <= ?) departing,
      (SELECT COUNT(*) FROM tickets WHERE room_id=rm.id AND status='open') open_tickets
    FROM rooms rm JOIN room_types t ON t.id=rm.room_type_id
    LEFT JOIN reservations r ON r.room_id=rm.id AND r.status='checked_in' LEFT JOIN guests g ON g.id=r.guest_id
    WHERE rm.property_id=? ORDER BY rm.number`).all(bd, pid);
});
route('POST', '/api/rooms/:id/hk', 'hk', async c => {
  const room = own(c, await c.db.prepare('SELECT * FROM rooms WHERE id=?').get(Number(c.params.id)), 'Room');
  const s = c.body.hk_status;
  if (!['clean', 'dirty', 'inspected'].includes(s)) throw err(400, 'hk_status must be clean, dirty or inspected');
  if (s === 'inspected' && !has(c.user, 'hk_inspect')) throw err(403, 'Only a supervisor can mark a room inspected');
  await c.db.prepare('UPDATE rooms SET hk_status=? WHERE id=?').run(s, room.id);
  await audit(c.db, c.user.id, room.property_id, 'room.hk', 'room', room.id, { from: room.hk_status, to: s });
  return c.db.prepare('SELECT * FROM rooms WHERE id=?').get(room.id);
});

route('GET', '/api/tickets', ['mt', 'hk', 'res'], async c => {
  const [w, a] = byPid(await pidAll(c));
  const st = c.query.status ? 'AND t.status=?' : '';
  return c.db.prepare(`SELECT t.*, rm.number room_number, u.name created_by_name FROM tickets t LEFT JOIN rooms rm ON rm.id=t.room_id
    LEFT JOIN users u ON u.id=t.created_by WHERE ${w.replace('property_id', 't.property_id')} ${st} ORDER BY t.status, t.id DESC LIMIT 300`).all(...a, ...(st ? [c.query.status] : []));
});
route('POST', '/api/tickets', ['mt', 'hk', 'res'], async c => {
  const pid = await pidOf(c), b = c.body;
  need(b, ['title']);
  const priority = b.priority || 'normal';
  if (!['low', 'normal', 'high'].includes(priority)) throw err(400, 'priority must be low, normal or high');
  return tx(c.db, async () => {
    let room = null;
    if (b.room_id) {
      room = await c.db.prepare('SELECT * FROM rooms WHERE id=? AND property_id=?').get(Number(b.room_id), pid);
      if (!room) throw err(400, 'Room not found at this hotel');
    }
    const blocks = room && b.blocks_room ? 1 : 0;
    const r = await c.db.prepare('INSERT INTO tickets(property_id, room_id, title, priority, blocks_room, created_by) VALUES (?,?,?,?,?,?)')
      .run(pid, room?.id ?? null, String(b.title).slice(0, 200), priority, blocks, c.user.id);
    // an occupied room is blocked when the guest checks out
    if (blocks && room.status === 'available') await c.db.prepare(`UPDATE rooms SET status='out_of_order' WHERE id=?`).run(room.id);
    await audit(c.db, c.user.id, pid, 'ticket.create', 'ticket', r.lastInsertRowid, { room: room?.number, blocks });
    return c.db.prepare('SELECT * FROM tickets WHERE id=?').get(r.lastInsertRowid);
  });
});
route('POST', '/api/tickets/:id/resolve', 'mt', async c => {
  const t = own(c, await c.db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(c.params.id)), 'Ticket');
  if (t.status !== 'open') throw err(400, 'Ticket is already resolved');
  return tx(c.db, async () => {
    await c.db.prepare(`UPDATE tickets SET status='resolved', resolution=?, resolved_by=?, resolved_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(c.body.resolution || null, c.user.id, t.id);
    if (t.room_id && !(await c.db.prepare(`SELECT 1 FROM tickets WHERE room_id=? AND status='open' AND blocks_room=1`).get(t.room_id)))
      await c.db.prepare(`UPDATE rooms SET status='available', hk_status='dirty' WHERE id=? AND status='out_of_order'`).run(t.room_id);
    await audit(c.db, c.user.id, t.property_id, 'ticket.resolve', 'ticket', t.id, { resolution: c.body.resolution });
    return c.db.prepare('SELECT * FROM tickets WHERE id=?').get(t.id);
  });
});

// ---------- restaurant POS ----------
// Loads orders with their lines and invoice in three queries, however many orders there are.
async function orderDetails(db, ids) {
  if (!ids.length) return [];
  const q = inList(ids.length);
  const [orders, lines, invoices] = await Promise.all([
    db.prepare(`SELECT o.*, r.code reservation_code, rm.number room_number, g.name guest_name FROM pos_orders o
      LEFT JOIN reservations r ON r.id=o.reservation_id LEFT JOIN rooms rm ON rm.id=r.room_id LEFT JOIN guests g ON g.id=r.guest_id WHERE o.id IN (${q})`).all(...ids),
    db.prepare(`SELECT * FROM pos_order_lines WHERE order_id IN (${q}) ORDER BY id`).all(...ids),
    db.prepare(`SELECT id, number, pos_order_id FROM invoices WHERE pos_order_id IN (${q})`).all(...ids),
  ]);
  const byId = Object.fromEntries(orders.map(o => [o.id, o]));
  return ids.map(id => {
    const ls = lines.filter(l => l.order_id === id), inv = invoices.find(i => i.pos_order_id === id);
    return { ...byId[id], lines: ls, total: ls.reduce((s, l) => s + l.qty * l.price, 0), invoice: inv ? { id: inv.id, number: inv.number } : null };
  });
}
const orderDetail = async (db, id) => (await orderDetails(db, [id]))[0];
const loadOrder = async c => own(c, await c.db.prepare('SELECT * FROM pos_orders WHERE id=?').get(Number(c.params.id)), 'Order');
route('GET', '/api/pos/orders', 'pos', async c => {
  const [w, a] = byPid(await pidAll(c));
  const st = c.query.status ? 'AND status=?' : '';
  const ids = (await c.db.prepare(`SELECT id FROM pos_orders WHERE ${w} ${st} ORDER BY id DESC LIMIT 200`).all(...a, ...(st ? [c.query.status] : []))).map(o => o.id);
  return orderDetails(c.db, ids);
});
route('GET', '/api/pos/orders/:id', 'pos', async c => orderDetail(c.db, (await loadOrder(c)).id));
// in-house guests a bill can be charged to; restaurant staff get room and name only, not the front-desk booking list
route('GET', '/api/pos/inhouse', 'pos', async c => c.db.prepare(`SELECT r.id, rm.number room_number, g.name guest_name FROM reservations r
  JOIN rooms rm ON rm.id=r.room_id JOIN guests g ON g.id=r.guest_id WHERE r.property_id=? AND r.status='checked_in' ORDER BY rm.number`).all(await pidOf(c)));
route('POST', '/api/pos/orders', 'pos', async c => {
  const p = await prop(c.db, await pidOf(c));
  const r = await c.db.prepare('INSERT INTO pos_orders(property_id, table_no, business_date, created_by) VALUES (?,?,?,?)')
    .run(p.id, c.body.table_no ? String(c.body.table_no).slice(0, 20) : null, p.business_date, c.user.id);
  return orderDetail(c.db, r.lastInsertRowid);
});
route('POST', '/api/pos/orders/:id/lines', 'pos', async c => {
  const o = await loadOrder(c);
  if (o.status !== 'open') throw err(400, 'Order is closed');
  const item = await c.db.prepare('SELECT * FROM menu_items WHERE id=? AND property_id=? AND active=1').get(Number(c.body.menu_item_id), o.property_id);
  if (!item) throw err(400, 'Menu item not found');
  const qty = Number(c.body.qty || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw err(400, 'qty must be 1 to 100');
  // the same dish at the same price goes on one line
  const line = await c.db.prepare('SELECT * FROM pos_order_lines WHERE order_id=? AND menu_item_id=? AND price=?').get(o.id, item.id, item.price);
  if (line && line.qty + qty > 100) throw err(400, 'qty must be 1 to 100');
  if (line) await c.db.prepare('UPDATE pos_order_lines SET qty = qty + ? WHERE id=?').run(qty, line.id);
  else await c.db.prepare('INSERT INTO pos_order_lines(order_id, menu_item_id, name, qty, price) VALUES (?,?,?,?,?)').run(o.id, item.id, item.name, qty, item.price);
  return orderDetail(c.db, o.id);
});
route('POST', '/api/pos/orders/:id/lines/:lineId/qty', 'pos', async c => {
  const o = await loadOrder(c);
  if (o.status !== 'open') throw err(400, 'Order is closed');
  const qty = Number(c.body.qty);
  if (!Number.isInteger(qty) || qty < 0 || qty > 100) throw err(400, 'qty must be 0 to 100');
  if (qty === 0) await c.db.prepare('DELETE FROM pos_order_lines WHERE id=? AND order_id=?').run(Number(c.params.lineId), o.id);
  else await c.db.prepare('UPDATE pos_order_lines SET qty=? WHERE id=? AND order_id=?').run(qty, Number(c.params.lineId), o.id);
  return orderDetail(c.db, o.id);
});
route('POST', '/api/pos/orders/:id/lines/:lineId/remove', 'pos', async c => {
  const o = await loadOrder(c);
  if (o.status !== 'open') throw err(400, 'Order is closed');
  await c.db.prepare('DELETE FROM pos_order_lines WHERE id=? AND order_id=?').run(Number(c.params.lineId), o.id);
  return orderDetail(c.db, o.id);
});
route('POST', '/api/pos/orders/:id/settle', 'pos', async c => {
  const o = await loadOrder(c), p = await prop(c.db, o.property_id), b = c.body;
  if (o.status !== 'open') throw err(400, 'Order is closed');
  const d = await orderDetail(c.db, o.id);
  if (!d.total) throw err(400, 'Order is empty');
  const desc = `Restaurant bill #${o.id}${o.table_no ? ` (table ${o.table_no})` : ''}: ${d.lines.map(l => `${l.qty}x ${l.name}`).join(', ')}`.slice(0, 200);
  return tx(c.db, async () => {
    if (b.to === 'room') {
      const r = await c.db.prepare(`SELECT * FROM reservations WHERE id=? AND property_id=? AND status='checked_in'`).get(Number(b.reservation_id), p.id);
      if (!r) throw err(400, 'Pick an in-house guest of this hotel');
      await addCharge(c.db, c.user.id, { property_id: p.id, reservation_id: r.id, business_date: p.business_date, category: 'fnb',
        description: desc, amount: d.total, tax_rate: p.fnb_gst_rate });
      await c.db.prepare(`UPDATE pos_orders SET status='settled_room', reservation_id=? WHERE id=?`).run(r.id, o.id);
    } else if (b.to === 'direct') {
      await addCharge(c.db, c.user.id, { property_id: p.id, pos_order_id: o.id, business_date: p.business_date, category: 'fnb',
        description: desc, amount: d.total, tax_rate: p.fnb_gst_rate });
      await addPayment(c.db, c.user.id, { property_id: p.id, pos_order_id: o.id, business_date: p.business_date, mode: b.mode,
        amount: await balanceOf(c.db, 'pos_order_id', o.id), reference: b.reference });
      await issueInvoice(c.db, p, 'pos_order_id', o.id, b.bill_to || 'Walk-in guest', b.bill_to_gstin);
      await c.db.prepare(`UPDATE pos_orders SET status='settled_direct' WHERE id=?`).run(o.id);
    } else throw err(400, "to must be 'room' or 'direct'");
    await audit(c.db, c.user.id, p.id, 'pos.settle', 'pos_order', o.id, { to: b.to, total: d.total });
    return orderDetail(c.db, o.id);
  });
});
route('POST', '/api/pos/orders/:id/void', 'pos', async c => {
  const o = await loadOrder(c);
  if (o.status !== 'open') throw err(400, 'Only open orders can be voided; for a settled bill void the folio line');
  need(c.body, ['reason']);
  const ok = await approver(c, o.property_id, 'Voiding a restaurant order');
  await c.db.prepare(`UPDATE pos_orders SET status='void' WHERE id=?`).run(o.id);
  await audit(c.db, c.user.id, o.property_id, 'pos.void', 'pos_order', o.id, { reason: c.body.reason, approved_by: ok.username });
  return orderDetail(c.db, o.id);
});

// ---------- inventory & purchasing ----------
const EXPENSE = { fnb: '5000', housekeeping: '5100', maintenance: '5200' };
route('GET', '/api/stock', ['inv', 'po', 'acc', 'reports'], async c => {
  const pid = await pidOf(c);
  return c.db.prepare(`SELECT i.*, COALESCE(s.qty,0) qty, COALESCE(s.avg_cost,0) avg_cost, CAST(ROUND(COALESCE(s.qty,0)*COALESCE(s.avg_cost,0)) AS INTEGER) value
    FROM items i LEFT JOIN stock s ON s.item_id=i.id AND s.property_id=? ORDER BY i.category, i.name`).all(pid);
});
route('GET', '/api/stock/moves', ['inv', 'po', 'acc', 'reports'], async c => {
  const pid = await pidOf(c);
  return c.db.prepare(`SELECT m.*, i.name item_name, i.unit FROM stock_moves m JOIN items i ON i.id=m.item_id WHERE m.property_id=? ORDER BY m.id DESC LIMIT 300`).all(pid);
});
route('POST', '/api/stock/issue', 'inv', async c => {
  const p = await prop(c.db, await pidOf(c)), b = c.body;
  need(b, ['item_id', 'qty', 'department']);
  const qty = Number(b.qty);
  if (!(qty > 0)) throw err(400, 'qty must be positive');
  const item = await c.db.prepare('SELECT * FROM items WHERE id=?').get(Number(b.item_id));
  if (!item) throw err(400, 'Item not found');
  return tx(c.db, async () => {
    const s = await c.db.prepare('SELECT * FROM stock WHERE property_id=? AND item_id=?').get(p.id, item.id);
    if (!s || s.qty < qty) throw err(400, `Only ${s?.qty || 0} ${item.unit} of ${item.name} in stock`);
    const cost = Math.round(qty * s.avg_cost);
    await c.db.prepare('UPDATE stock SET qty = qty - ? WHERE property_id=? AND item_id=?').run(qty, p.id, item.id);
    const m = await c.db.prepare(`INSERT INTO stock_moves(property_id, item_id, qty, unit_cost, kind, department, business_date, created_by) VALUES (?,?,?,?,'issue',?,?,?)`)
      .run(p.id, item.id, -qty, s.avg_cost, String(b.department).slice(0, 50), p.business_date, c.user.id);
    await post(c.db, { pid: p.id, date: p.business_date, memo: `Issue ${qty} ${item.unit} ${item.name} to ${b.department}`, source: 'stock', sourceId: m.lastInsertRowid, userId: c.user.id },
      [[EXPENSE[item.category], cost], ['1200', -cost]]);
    await audit(c.db, c.user.id, p.id, 'stock.issue', 'item', item.id, { qty, department: b.department, cost });
    return { ok: true, cost };
  });
});

// Loads purchase orders with their lines in two queries.
async function poDetails(db, ids) {
  if (!ids.length) return [];
  const q = inList(ids.length);
  const [pos, lines] = await Promise.all([
    db.prepare(`SELECT po.*, s.name supplier_name, p.code property_code FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
      JOIN properties p ON p.id=po.property_id WHERE po.id IN (${q})`).all(...ids),
    db.prepare(`SELECT l.*, i.name item_name, i.unit FROM po_lines l JOIN items i ON i.id=l.item_id WHERE po_id IN (${q})`).all(...ids),
  ]);
  const byId = Object.fromEntries(pos.map(p => [p.id, p]));
  return ids.map(id => ({ ...byId[id], lines: lines.filter(l => l.po_id === id) }));
}
const poDetail = async (db, id) => (await poDetails(db, [id]))[0];
const loadPo = async c => own(c, await c.db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(Number(c.params.id)), 'Purchase order');
const PO_LEVEL = { gm: 'po_gm', central: 'po_central' };
route('GET', '/api/purchase-orders', ['po', 'inv', 'acc'], async c => {
  const [w, a] = byPid(await pidAll(c));
  const st = c.query.status ? 'AND status=?' : '';
  const ids = (await c.db.prepare(`SELECT id FROM purchase_orders WHERE ${w} ${st} ORDER BY id DESC LIMIT 300`).all(...a, ...(st ? [c.query.status] : []))).map(r => r.id);
  return poDetails(c.db, ids);
});
route('GET', '/api/purchase-orders/:id', ['po', 'inv', 'acc'], async c => poDetail(c.db, (await loadPo(c)).id));
route('POST', '/api/purchase-orders', 'po', async c => {
  const p = await prop(c.db, await pidOf(c)), b = c.body;
  need(b, ['supplier_id']);
  if (!(await c.db.prepare('SELECT 1 FROM suppliers WHERE id=?').get(Number(b.supplier_id)))) throw err(400, 'Supplier not found');
  if (!Array.isArray(b.lines) || !b.lines.length) throw err(400, 'Add at least one line');
  const lines = [];
  for (const l of b.lines) {
    const item = await c.db.prepare('SELECT * FROM items WHERE id=?').get(Number(l.item_id));
    if (!item) throw err(400, 'Item not found');
    const qty = Number(l.qty);
    if (!(qty > 0)) throw err(400, 'qty must be positive');
    lines.push({ item, qty, rate: paise(l.rate, 'rate') });
  }
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.rate), 0);
  const tax = lines.reduce((s, l) => s + Math.round((l.qty * l.rate * l.item.tax_rate) / 100), 0);
  const total = subtotal + tax;
  const needs = total <= p.po_auto_limit ? null : total <= p.po_gm_limit ? 'gm' : 'central';
  // the creator approves at once if they hold the authority this amount needs
  const auto = !needs || has(c.user, PO_LEVEL[needs]) || (needs === 'gm' && has(c.user, 'po_central'));
  return tx(c.db, async () => {
    await c.db.prepare('UPDATE properties SET po_seq = po_seq + 1 WHERE id=?').run(p.id);
    const seq = (await c.db.prepare('SELECT po_seq s FROM properties WHERE id=?').get(p.id)).s;
    const r = await c.db.prepare(`INSERT INTO purchase_orders(number, property_id, supplier_id, status, needs, subtotal, tax, total, created_by, approved_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`${p.code}/PO/${String(seq).padStart(5, '0')}`, p.id, Number(b.supplier_id), auto ? 'approved' : 'requested',
      needs, subtotal, tax, total, c.user.id, auto ? c.user.id : null);
    const id = r.lastInsertRowid;
    for (const l of lines) await c.db.prepare('INSERT INTO po_lines(po_id, item_id, qty, rate, tax_rate) VALUES (?,?,?,?,?)').run(id, l.item.id, l.qty, l.rate, l.item.tax_rate);
    await audit(c.db, c.user.id, p.id, 'po.create', 'purchase_order', id, { total, needs, auto });
    return poDetail(c.db, id);
  });
});
for (const action of ['approve', 'reject']) {
  route('POST', `/api/purchase-orders/:id/${action}`, ['po_gm', 'po_central'], async c => {
    const po = await loadPo(c);
    if (po.status !== 'requested') throw err(400, `PO is ${po.status}`);
    const okGm = has(c.user, 'po_gm') || has(c.user, 'po_central');
    if (po.needs === 'central' ? !has(c.user, 'po_central') : !okGm) throw err(403, `This PO needs ${po.needs === 'central' ? 'central purchasing' : 'GM'} approval`);
    await c.db.prepare('UPDATE purchase_orders SET status=?, approved_by=? WHERE id=?').run(action === 'approve' ? 'approved' : 'rejected', c.user.id, po.id);
    await audit(c.db, c.user.id, po.property_id, `po.${action}`, 'purchase_order', po.id, { total: po.total });
    return poDetail(c.db, po.id);
  });
}
route('POST', '/api/purchase-orders/:id/receive', ['inv', 'po'], async c => {
  const po = await loadPo(c), p = await prop(c.db, po.property_id);
  if (po.status !== 'approved') throw err(400, `Only approved POs can be received (this one is ${po.status})`);
  return tx(c.db, async () => {
    for (const l of await c.db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id)) {
      const s = (await c.db.prepare('SELECT * FROM stock WHERE property_id=? AND item_id=?').get(p.id, l.item_id)) || { qty: 0, avg_cost: 0 };
      const avg = Math.round((s.qty * s.avg_cost + l.qty * l.rate) / (s.qty + l.qty));
      await c.db.prepare(`INSERT INTO stock(property_id, item_id, qty, avg_cost) VALUES (?,?,?,?)
        ON CONFLICT(property_id, item_id) DO UPDATE SET qty = qty + excluded.qty, avg_cost = ?`).run(p.id, l.item_id, l.qty, avg, avg);
      await c.db.prepare(`INSERT INTO stock_moves(property_id, item_id, qty, unit_cost, kind, ref, business_date, created_by) VALUES (?,?,?,?,'receive',?,?,?)`)
        .run(p.id, l.item_id, l.qty, l.rate, po.number, p.business_date, c.user.id);
    }
    await c.db.prepare(`UPDATE purchase_orders SET status='received', received_at=CURRENT_TIMESTAMP WHERE id=?`).run(po.id);
    await post(c.db, { pid: p.id, date: p.business_date, memo: `Goods received ${po.number}`, source: 'po', sourceId: po.id, userId: c.user.id },
      [['1200', po.subtotal], ['1300', po.tax], ['2000', -po.total]]);
    await audit(c.db, c.user.id, p.id, 'po.receive', 'purchase_order', po.id, { total: po.total });
    return poDetail(c.db, po.id);
  });
});
route('POST', '/api/purchase-orders/:id/pay', 'acc', async c => {
  const po = await loadPo(c), p = await prop(c.db, po.property_id);
  if (po.status !== 'received') throw err(400, `Only received POs can be paid (this one is ${po.status})`);
  const acct = { cash: '1000', bank: '1010' }[c.body.mode];
  if (!acct) throw err(400, 'mode must be cash or bank');
  return tx(c.db, async () => {
    await c.db.prepare(`UPDATE purchase_orders SET status='paid', paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(po.id);
    await post(c.db, { pid: p.id, date: p.business_date, memo: `Supplier payment ${po.number}`, source: 'po_payment', sourceId: po.id, userId: c.user.id },
      [['2000', po.total], [acct, -po.total]]);
    await audit(c.db, c.user.id, p.id, 'po.pay', 'purchase_order', po.id, { total: po.total, mode: c.body.mode });
    return poDetail(c.db, po.id);
  });
});

// ---------- accounting ----------
route('GET', '/api/accounts', ['acc', 'books'], c => c.db.prepare('SELECT * FROM accounts ORDER BY code').all());
route('GET', '/api/journals', ['acc', 'books'], async c => {
  const [w, a] = byPid(await pidAll(c));
  const from = c.query.from || '0000-01-01', to = c.query.to || '9999-12-31';
  const js = await c.db.prepare(`SELECT * FROM journals WHERE ${w} AND date BETWEEN ? AND ? ORDER BY id DESC LIMIT 300`).all(...a, from, to);
  if (!js.length) return [];
  const ls = await c.db.prepare(`SELECT l.*, a.name account_name FROM journal_lines l JOIN accounts a ON a.code=l.account_code
    WHERE journal_id IN (${inList(js.length)}) ORDER BY l.id`).all(...js.map(j => j.id));
  return js.map(j => ({ ...j, lines: ls.filter(l => l.journal_id === j.id) }));
});
route('POST', '/api/journals', 'acc', async c => {
  const p = await prop(c.db, await pidOf(c)), b = c.body;
  need(b, ['date', 'memo']);
  date(b.date, 'date');
  if (!Array.isArray(b.lines) || b.lines.length < 2) throw err(400, 'A journal needs at least two lines');
  const codes = new Set((await c.db.prepare('SELECT code FROM accounts').all()).map(a => a.code));
  const lines = b.lines.map(l => {
    if (!codes.has(String(l.account_code))) throw err(400, `Unknown account ${l.account_code}`);
    const d = Number(l.debit || 0), cr = Number(l.credit || 0);
    if (!Number.isInteger(d) || !Number.isInteger(cr) || d < 0 || cr < 0 || (d > 0) === (cr > 0)) throw err(400, 'Each line needs either a debit or a credit (paise)');
    return [String(l.account_code), d - cr];
  });
  if (lines.reduce((s, l) => s + l[1], 0) !== 0) throw err(400, 'Debits must equal credits');
  return tx(c.db, async () => {
    const id = await post(c.db, { pid: p.id, date: b.date, memo: String(b.memo).slice(0, 200), source: 'manual', userId: c.user.id }, lines);
    await audit(c.db, c.user.id, p.id, 'journal.manual', 'journal', id, b);
    return { id };
  });
});

function balances(db, pid, from, to) {
  return db.prepare(`SELECT a.code, a.name, a.type, COALESCE(SUM(x.debit),0) debit, COALESCE(SUM(x.credit),0) credit FROM accounts a
    LEFT JOIN (SELECT l.account_code, l.debit, l.credit FROM journal_lines l JOIN journals j ON j.id=l.journal_id
      WHERE j.date BETWEEN ? AND ? AND (? IS NULL OR j.property_id=?)) x ON x.account_code=a.code
    GROUP BY a.code ORDER BY a.code`).all(from, to, pid, pid);
}
const NORMAL_DEBIT = { asset: true, expense: true };
const bal = a => (NORMAL_DEBIT[a.type] ? a.debit - a.credit : a.credit - a.debit);
route('GET', '/api/reports/trial-balance', ['acc', 'books'], async c => {
  const rows = (await balances(c.db, await pidAll(c), '0000-01-01', c.query.to || '9999-12-31'))
    .map(a => ({ ...a, dr: Math.max(a.debit - a.credit, 0), cr: Math.max(a.credit - a.debit, 0) }));
  return { rows, total_dr: rows.reduce((s, r) => s + r.dr, 0), total_cr: rows.reduce((s, r) => s + r.cr, 0) };
});
route('GET', '/api/reports/pnl', ['acc', 'books'], async c => {
  const rows = (await balances(c.db, await pidAll(c), c.query.from || '0000-01-01', c.query.to || '9999-12-31')).map(a => ({ ...a, amount: bal(a) }));
  const income = rows.filter(r => r.type === 'income'), expense = rows.filter(r => r.type === 'expense');
  const ti = income.reduce((s, r) => s + r.amount, 0), te = expense.reduce((s, r) => s + r.amount, 0);
  return { income, expense, total_income: ti, total_expense: te, net_profit: ti - te };
});
route('GET', '/api/reports/balance-sheet', ['acc', 'books'], async c => {
  const rows = (await balances(c.db, await pidAll(c), '0000-01-01', c.query.to || '9999-12-31')).map(a => ({ ...a, amount: bal(a) }));
  const pick = t => rows.filter(r => r.type === t);
  const sum = rs => rs.reduce((s, r) => s + r.amount, 0);
  const profit = sum(pick('income')) - sum(pick('expense'));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  return { assets, liabilities, equity, retained_earnings: profit, total_assets: sum(assets),
    total_liabilities_equity: sum(liabilities) + sum(equity) + profit };
});
route('GET', '/api/reports/gst', ['acc', 'books'], async c => {
  const pid = await pidAll(c), from = c.query.from || '0000-01-01', to = c.query.to || '9999-12-31';
  const [output, input, b2b] = await Promise.all([
    c.db.prepare(`SELECT category, tax_rate, SUM(amount) taxable, SUM(cgst) cgst, SUM(sgst) sgst FROM folio_lines
      WHERE business_date BETWEEN ? AND ? AND (? IS NULL OR property_id=?) GROUP BY category, tax_rate ORDER BY category, tax_rate`).all(from, to, pid, pid),
    c.db.prepare(`SELECT COALESCE(SUM(po.tax),0) tax, COALESCE(SUM(po.subtotal),0) taxable FROM purchase_orders po JOIN journals j ON j.source='po' AND j.source_id=po.id
      WHERE j.date BETWEEN ? AND ? AND (? IS NULL OR po.property_id=?)`).get(from, to, pid, pid),
    c.db.prepare(`SELECT number, bill_to, bill_to_gstin, business_date, taxable, cgst, sgst, total FROM invoices
      WHERE bill_to_gstin IS NOT NULL AND business_date BETWEEN ? AND ? AND (? IS NULL OR property_id=?) ORDER BY id`).all(from, to, pid, pid),
  ]);
  const out = output.reduce((s, r) => s + r.cgst + r.sgst, 0);
  return { output, input, b2b, output_tax: out, input_tax: input.tax };
});

async function kpis(db, p, from, to) {
  const days = nightsBetween(from, addDays(to, 1)).length;
  const n = (sql, ...a) => db.prepare(sql).get(...a).then(r => r?.n ?? 0);
  const [rooms, sold, revRows, collected, in_house, arrivals, departures, dirty, out_of_order, open_tickets, pending_pos] = await Promise.all([
    n('SELECT COUNT(*) n FROM rooms WHERE property_id=?', p.id),
    n('SELECT COUNT(*) n FROM folio_lines WHERE property_id=? AND night BETWEEN ? AND ? AND voided=0 AND reverses_id IS NULL', p.id, from, to),
    db.prepare('SELECT category, SUM(amount) v FROM folio_lines WHERE property_id=? AND business_date BETWEEN ? AND ? GROUP BY category').all(p.id, from, to),
    n('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE property_id=? AND business_date BETWEEN ? AND ?', p.id, from, to),
    n(`SELECT COUNT(*) n FROM reservations WHERE property_id=? AND status='checked_in'`, p.id),
    n(`SELECT COUNT(*) n FROM reservations WHERE property_id=? AND status='booked' AND arrival=?`, p.id, p.business_date),
    n(`SELECT COUNT(*) n FROM reservations WHERE property_id=? AND status='checked_in' AND departure<=?`, p.id, p.business_date),
    n(`SELECT COUNT(*) n FROM rooms WHERE property_id=? AND hk_status='dirty'`, p.id),
    n(`SELECT COUNT(*) n FROM rooms WHERE property_id=? AND status='out_of_order'`, p.id),
    n(`SELECT COUNT(*) n FROM tickets WHERE property_id=? AND status='open'`, p.id),
    n(`SELECT COUNT(*) n FROM purchase_orders WHERE property_id=? AND status='requested'`, p.id),
  ]);
  const rev = Object.fromEntries(revRows.map(r => [r.category, r.v]));
  const roomRev = rev.room || 0, capacity = rooms * days;
  return {
    property_id: p.id, code: p.code, name: p.name, business_date: p.business_date, rooms,
    room_nights: sold, occupancy: capacity ? sold / capacity : 0, adr: sold ? Math.round(roomRev / sold) : 0, revpar: capacity ? Math.round(roomRev / capacity) : 0,
    room_revenue: roomRev, fnb_revenue: rev.fnb || 0, other_revenue: rev.extra || 0, collected,
    in_house, arrivals, departures, dirty, out_of_order, open_tickets, pending_pos,
  };
}
route('GET', '/api/reports/dashboard', 'reports', async c => {
  const pid = await pidAll(c);
  const props = pid ? [await prop(c.db, pid)] : await c.db.prepare('SELECT * FROM properties ORDER BY id').all();
  const to = c.query.to || props[0].business_date, from = c.query.from || addDays(to, -6);
  date(from, 'from'); date(to, 'to');
  if (from > to) throw err(400, 'from must be on or before to');
  const scope = pid ? 'property_id = ?' : '1=1', a = pid ? [pid] : [];
  const [list, revRows, nightRows, paidRows, payments_by_mode] = await Promise.all([
    Promise.all(props.map(p => kpis(c.db, p, from, to))),
    c.db.prepare(`SELECT business_date d, category, SUM(amount) v FROM folio_lines WHERE ${scope} AND business_date BETWEEN ? AND ? GROUP BY d, category`).all(...a, from, to),
    c.db.prepare(`SELECT night d, COUNT(*) n FROM folio_lines WHERE ${scope} AND night BETWEEN ? AND ? AND voided=0 AND reverses_id IS NULL GROUP BY night`).all(...a, from, to),
    c.db.prepare(`SELECT business_date d, SUM(amount) v FROM payments WHERE ${scope} AND business_date BETWEEN ? AND ? GROUP BY d`).all(...a, from, to),
    c.db.prepare(`SELECT mode, SUM(amount) amount FROM payments WHERE ${scope} AND business_date BETWEEN ? AND ? GROUP BY mode`).all(...a, from, to),
  ]);
  const sum = k => list.reduce((s, r) => s + r[k], 0);
  const days = nightsBetween(from, addDays(to, 1)).length, cap = sum('rooms') * days, roomRev = sum('room_revenue'), sold = sum('room_nights');
  const group = { name: 'All hotels', rooms: sum('rooms'), room_nights: sold, occupancy: cap ? sold / cap : 0, adr: sold ? Math.round(roomRev / sold) : 0,
    revpar: cap ? Math.round(roomRev / cap) : 0, room_revenue: roomRev, fnb_revenue: sum('fnb_revenue'), other_revenue: sum('other_revenue'),
    collected: sum('collected'), in_house: sum('in_house'), arrivals: sum('arrivals'), departures: sum('departures'), dirty: sum('dirty'),
    out_of_order: sum('out_of_order'), open_tickets: sum('open_tickets'), pending_pos: sum('pending_pos') };
  // daily series for charts and sparklines
  const rev = {};
  for (const r of revRows) (rev[r.d] ||= {})[r.category] = r.v;
  const nightsSold = Object.fromEntries(nightRows.map(r => [r.d, r.n])), paid = Object.fromEntries(paidRows.map(r => [r.d, r.v]));
  const daily = nightsBetween(from, addDays(to, 1)).map(d => ({ date: d, room_revenue: rev[d]?.room || 0, fnb_revenue: rev[d]?.fnb || 0, other_revenue: rev[d]?.extra || 0,
    room_nights: nightsSold[d] || 0, occupancy: group.rooms ? (nightsSold[d] || 0) / group.rooms : 0, collected: paid[d] || 0 }));
  return { from, to, properties: list, group, daily, payments_by_mode };
});

// ---------- advance room assignment ----------
// Rooms already taken between arrival and departure by another booked or in-house stay.
// A guest still in house past their departure date keeps the room until they actually leave.
async function busyRooms(db, p, arrival, departure, excludeId = 0) {
  const rows = await db.prepare(`SELECT room_id, arrival, departure, status FROM reservations WHERE property_id=? AND room_id IS NOT NULL
    AND status IN ('booked','checked_in') AND id != ?`).all(p.id, excludeId);
  const tomorrow = addDays(p.business_date, 1), busy = new Set();
  for (const r of rows) {
    const leaves = r.status === 'checked_in' && r.departure < tomorrow ? tomorrow : r.departure;
    if (r.arrival < departure && leaves > arrival) busy.add(r.room_id);
  }
  return busy;
}
// Rooms of the booked type that are free for every night of this booking (out-of-order rooms excluded).
async function freeRoomsFor(db, p, r) {
  const busy = await busyRooms(db, p, r.arrival, r.departure, r.id);
  const rooms = await db.prepare(`SELECT id, number, floor, status, hk_status FROM rooms WHERE property_id=? AND room_type_id=? AND status != 'out_of_order' ORDER BY number`)
    .all(p.id, r.room_type_id);
  return rooms.filter(x => !busy.has(x.id));
}
route('GET', '/api/reservations/:id/rooms', 'res', async c => {
  const r = await loadRes(c);
  return freeRoomsFor(c.db, await prop(c.db, r.property_id), r);
});
route('POST', '/api/reservations/:id/assign', 'res', async c => {
  const r = await loadRes(c), p = await prop(c.db, r.property_id);
  if (r.status !== 'booked') throw err(400, `Only bookings not yet checked in can be given a room (this one is ${r.status})`);
  return tx(c.db, async () => {
    let room = null;
    if (c.body.room_id) {
      room = await c.db.prepare('SELECT * FROM rooms WHERE id=? AND property_id=?').get(Number(c.body.room_id), r.property_id);
      if (!room) throw err(400, 'Room not found at this hotel');
      if (room.room_type_id !== r.room_type_id) throw err(400, 'Room is a different room type than booked');
      if (room.status === 'out_of_order') throw err(409, `Room ${room.number} is out of order`);
      if ((await busyRooms(c.db, p, r.arrival, r.departure, r.id)).has(room.id)) throw err(409, `Room ${room.number} is taken on some of these nights`);
    }
    await c.db.prepare('UPDATE reservations SET room_id=? WHERE id=?').run(room?.id ?? null, r.id);
    await audit(c.db, c.user.id, r.property_id, room ? 'reservation.assign' : 'reservation.unassign', 'reservation', r.id, { room: room?.number });
    return resDetail(c, r.id);
  });
});
// Gives every unassigned booking arriving in the window a free room, clean rooms first.
route('POST', '/api/calendar/auto-assign', 'res', async c => {
  const p = await prop(c.db, await pidOf(c));
  const from = isDate(c.body.from) ? c.body.from : p.business_date, to = isDate(c.body.to) ? c.body.to : addDays(from, 14);
  return tx(c.db, async () => {
    const todo = await c.db.prepare(`SELECT * FROM reservations WHERE property_id=? AND status='booked' AND room_id IS NULL AND arrival >= ? AND arrival < ?
      ORDER BY arrival, departure DESC, id`).all(p.id, from, to);
    const rank = { inspected: 0, clean: 1, dirty: 2 };
    let assigned = 0;
    for (const r of todo) {
      const free = (await freeRoomsFor(c.db, p, r)).sort((a, b) => rank[a.hk_status] - rank[b.hk_status] || a.number.localeCompare(b.number));
      if (!free.length) continue;
      await c.db.prepare('UPDATE reservations SET room_id=? WHERE id=?').run(free[0].id, r.id);
      assigned++;
    }
    await audit(c.db, c.user.id, p.id, 'calendar.auto_assign', 'property', p.id, { from, to, assigned, waiting: todo.length - assigned });
    return { assigned, unassigned: todo.length - assigned };
  });
});

// ---------- room calendar (tape chart) ----------
route('GET', '/api/calendar', ['res', 'rack'], async c => {
  const p = await prop(c.db, await pidOf(c));
  const from = isDate(c.query.from) ? c.query.from : p.business_date;
  const days = Math.min(Math.max(Number(c.query.days) || 14, 1), 31);
  const to = addDays(from, days); // exclusive
  const [rooms, types, stays, demand] = await Promise.all([
    c.db.prepare(`SELECT rm.id, rm.number, rm.floor, rm.status, rm.hk_status, rm.room_type_id, t.name room_type FROM rooms rm
      JOIN room_types t ON t.id=rm.room_type_id WHERE rm.property_id=? ORDER BY t.id, rm.number`).all(p.id),
    c.db.prepare('SELECT id, code, name FROM room_types ORDER BY id').all(),
    // every stay in the window: on a room (booked with a room, in house, checked out) or still waiting for a room
    c.db.prepare(`SELECT r.id, r.code, r.room_id, r.room_type_id, r.arrival, r.departure, r.status, r.adults, r.source, g.name guest_name FROM reservations r
      JOIN guests g ON g.id=r.guest_id WHERE r.property_id=? AND r.status IN ('booked','checked_in','checked_out')
      AND (r.room_id IS NOT NULL OR r.status='booked') AND r.arrival < ? AND r.departure > ? ORDER BY r.arrival, r.id`).all(p.id, to, from),
    // everything that needs a room, assigned or not, for the free-room counts
    c.db.prepare(`SELECT room_type_id, arrival, departure, status FROM reservations WHERE property_id=? AND status IN ('booked','checked_in')
      AND arrival < ? AND departure > ?`).all(p.id, to, from),
  ]);
  const nights = nightsBetween(from, to);
  const typeRows = types.map(t => {
    const sellable = rooms.filter(r => r.room_type_id === t.id && r.status !== 'out_of_order').length;
    const mine = demand.filter(x => x.room_type_id === t.id);
    return {
      id: t.id, code: t.code, name: t.name, rooms: rooms.filter(r => r.room_type_id === t.id).length,
      free: nights.map(d => sellable - mine.filter(x => x.arrival <= d && x.departure > d).length),
      arriving: nights.map(d => mine.filter(x => x.status === 'booked' && x.arrival === d).length),
    };
  }).filter(t => t.rooms);
  return { property_id: p.id, business_date: p.business_date, from, to, days, nights, types: typeRows, rooms,
    stays: stays.filter(s => s.room_id), unassigned: stays.filter(s => !s.room_id) };
});

// ---------- group performance ----------
const OTA_COMMISSION = 0.18; // shortcut: assumed typical OTA commission for the "saved" estimate; make it a setting if rates are negotiated per OTA
const CHANNEL = { website: 'website', ota: 'ota', phone: 'phone', central: 'phone', walk_in: 'walk_in' }; // phone + central desk shown together

// Room nights and revenue already booked for the next `n` nights, night by night.
async function forecast(db, p, n) {
  const start = p.business_date, end = addDays(start, n);
  const [rooms, rows] = await Promise.all([
    db.prepare('SELECT COUNT(*) n FROM rooms WHERE property_id=?').get(p.id).then(r => r.n),
    db.prepare(`SELECT arrival, departure, rates_json FROM reservations WHERE property_id=? AND status IN ('booked','checked_in') AND arrival < ? AND departure > ?`).all(p.id, end, start),
  ]);
  const nights = nightsBetween(start, end).map(d => {
    let sold = 0, revenue = 0;
    for (const r of rows) {
      if (!(r.arrival <= d && r.departure > d)) continue;
      const rates = JSON.parse(r.rates_json);
      sold++;
      revenue += rates[Math.min(diffDays(r.arrival, d), rates.length - 1)];
    }
    return { date: d, sold, revenue, occupancy: rooms ? sold / rooms : 0 };
  });
  const avg = k => (k ? nights.slice(0, k).reduce((s, x) => s + x.occupancy, 0) / k : 0);
  return { rooms, nights, next7: avg(7), next30: avg(n), room_nights: nights.reduce((s, x) => s + x.sold, 0), revenue: nights.reduce((s, x) => s + x.revenue, 0) };
}

route('GET', '/api/reports/group', 'reports', async c => {
  const pid = await pidAll(c);
  const props = pid ? [await prop(c.db, pid)] : await c.db.prepare('SELECT * FROM properties ORDER BY id').all();
  const days = [7, 30, 90].includes(Number(c.query.days)) ? Number(c.query.days) : 30;
  const pick = k => ({ occupancy: k.occupancy, adr: k.adr, revpar: k.revpar, room_revenue: k.room_revenue, fnb_revenue: k.fnb_revenue,
    other_revenue: k.other_revenue, collected: k.collected, room_nights: k.room_nights, rooms: k.rooms });
  // each hotel is measured over its own last closed days, against the same number of days before that
  const hotels = await Promise.all(props.map(async p => {
    const to = addDays(p.business_date, -1), from = addDays(to, -(days - 1));
    const pto = addDays(from, -1), pfrom = addDays(pto, -(days - 1));
    const [cur, prev, fc] = await Promise.all([kpis(c.db, p, from, to), kpis(c.db, p, pfrom, pto), forecast(c.db, p, 30)]);
    return { property_id: p.id, code: p.code, name: p.name, from, to, ...pick(cur), prev: pick(prev), forecast: fc };
  }));
  hotels.sort((a, b) => b.revpar - a.revpar).forEach((h, i) => { h.rank = i + 1; });

  const total = (list, side) => {
    const s = k => list.reduce((t, h) => t + (side ? h[side][k] : h[k]), 0);
    const cap = s('rooms') * days, rev = s('room_revenue'), sold = s('room_nights');
    return { rooms: s('rooms'), room_nights: sold, occupancy: cap ? sold / cap : 0, adr: sold ? Math.round(rev / sold) : 0, revpar: cap ? Math.round(rev / cap) : 0,
      room_revenue: rev, fnb_revenue: s('fnb_revenue'), other_revenue: s('other_revenue'), collected: s('collected') };
  };

  // channel mix: stays arriving in the period, by booking source
  const from = hotels.reduce((m, h) => (h.from < m ? h.from : m), hotels[0].from), to = hotels.reduce((m, h) => (h.to > m ? h.to : m), hotels[0].to);
  const stays = await c.db.prepare(`SELECT source, arrival, departure, rates_json FROM reservations
    WHERE property_id IN (${inList(props.length)}) AND arrival BETWEEN ? AND ? AND status NOT IN ('cancelled','no_show')`).all(...props.map(p => p.id), from, to);
  const channels = {};
  for (const r of stays) {
    const k = CHANNEL[r.source] || r.source;
    const ch = (channels[k] ||= { channel: k, bookings: 0, room_nights: 0, revenue: 0 });
    const rates = JSON.parse(r.rates_json);
    ch.bookings++;
    ch.room_nights += rates.length;
    ch.revenue += rates.reduce((s, x) => s + x, 0);
  }
  const channelList = Object.values(channels);
  const allRevenue = channelList.reduce((s, x) => s + x.revenue, 0);
  const direct = channelList.filter(x => x.channel !== 'ota').reduce((s, x) => s + x.revenue, 0);
  channelList.forEach(x => { x.share = allRevenue ? x.revenue / allRevenue : 0; });

  return {
    days, from, to, hotels, channels: channelList,
    group: total(hotels), previous: total(hotels, 'prev'),
    forecast: { revenue: hotels.reduce((s, h) => s + h.forecast.revenue, 0), room_nights: hotels.reduce((s, h) => s + h.forecast.room_nights, 0),
      next7: hotels.reduce((s, h) => s + h.forecast.next7 * h.forecast.rooms, 0) / Math.max(1, hotels.reduce((s, h) => s + h.forecast.rooms, 0)),
      next30: hotels.reduce((s, h) => s + h.forecast.next30 * h.forecast.rooms, 0) / Math.max(1, hotels.reduce((s, h) => s + h.forecast.rooms, 0)) },
    direct_share: allRevenue ? direct / allRevenue : 0,
    ota_commission_saved: Math.round(direct * OTA_COMMISSION), ota_commission_rate: OTA_COMMISSION,
  };
});

// ---------- night audit ----------
route('GET', '/api/night-audit', 'audit', async c => {
  const p = await prop(c.db, await pidOf(c)), d = p.business_date;
  const [inHouse, pending_arrivals, overdue_departures, openPos, history] = await Promise.all([
    c.db.prepare(`SELECT COUNT(*) n FROM reservations WHERE property_id=? AND status='checked_in'`).get(p.id),
    c.db.prepare(`${RES_LIST} WHERE r.property_id=? AND r.status='booked' AND r.arrival<=?`).all(p.id, d),
    c.db.prepare(`${RES_LIST} WHERE r.property_id=? AND r.status='checked_in' AND r.departure<=?`).all(p.id, d),
    c.db.prepare(`SELECT COUNT(*) n FROM pos_orders WHERE property_id=? AND status='open'`).get(p.id),
    c.db.prepare('SELECT * FROM night_audits WHERE property_id=? ORDER BY id DESC LIMIT 30').all(p.id),
  ]);
  return { business_date: d, in_house: inHouse.n, pending_arrivals, overdue_departures, open_pos_orders: openPos.n,
    history: history.map(h => ({ ...h, summary: JSON.parse(h.summary_json) })) };
});
export function runNightAudit(db, userId, pid) {
  return tx(db, async () => {
    const p = await prop(db, pid), d = p.business_date;
    const inHouse = await db.prepare(`SELECT r.*, rm.number room_number FROM reservations r JOIN rooms rm ON rm.id=r.room_id WHERE r.property_id=? AND r.status='checked_in'`).all(p.id);
    const done = new Set((await db.prepare(`SELECT f.reservation_id FROM folio_lines f JOIN reservations r ON r.id=f.reservation_id
      WHERE r.property_id=? AND r.status='checked_in' AND f.night=? AND f.voided=0`).all(p.id, d)).map(x => x.reservation_id));
    let posted = 0;
    for (const r of inHouse) {
      if (r.arrival > d || done.has(r.id)) continue;
      const rates = JSON.parse(r.rates_json);
      const rate = rates[Math.min(nightsBetween(r.arrival, d).length, rates.length - 1)]; // overstay nights repeat the last rate
      await addCharge(db, userId, { property_id: p.id, reservation_id: r.id, business_date: d, category: 'room',
        description: `Room ${r.room_number} night ${d}`, amount: rate, tax_rate: await roomTaxRate(db, rate), night: d });
      posted++;
    }
    const noShows = (await db.prepare(`UPDATE reservations SET status='no_show' WHERE property_id=? AND status='booked' AND arrival<=?`).run(p.id, d)).changes;
    const k = await kpis(db, p, d, d);
    const summary = { posted_room_nights: posted, no_shows: Number(noShows), occupancy: k.occupancy, adr: k.adr, revpar: k.revpar,
      room_revenue: k.room_revenue, fnb_revenue: k.fnb_revenue, other_revenue: k.other_revenue, collected: k.collected,
      payments_by_mode: await db.prepare('SELECT mode, SUM(amount) amount FROM payments WHERE property_id=? AND business_date=? GROUP BY mode').all(p.id, d) };
    await db.prepare('INSERT INTO night_audits(property_id, business_date, run_by, summary_json) VALUES (?,?,?,?)').run(p.id, d, userId, JSON.stringify(summary));
    await db.prepare('UPDATE properties SET business_date=? WHERE id=?').run(addDays(d, 1), p.id);
    await audit(db, userId, p.id, 'night_audit', 'property', p.id, { business_date: d, ...summary });
    return { business_date: d, next_business_date: addDays(d, 1), summary };
  });
}
route('POST', '/api/night-audit', 'audit', async c => runNightAudit(c.db, c.user.id, await pidOf(c)));

route('GET', '/api/audit-log', 'admin', async c => { // owner / group admin only
  const [w, a] = byPid(await pidAll(c));
  return c.db.prepare(`SELECT l.*, u.name user_name, u.role user_role, p.code property_code FROM audit_log l LEFT JOIN users u ON u.id=l.user_id
    LEFT JOIN properties p ON p.id=l.property_id WHERE ${w.replace('property_id', 'l.property_id')} ORDER BY l.id DESC LIMIT 500`).all(...a);
});

// ---------- public booking website ----------
route('GET', '/api/public/properties', null, c => c.db.prepare('SELECT id, name, address, phone, business_date FROM properties ORDER BY id').all());
route('GET', '/api/public/availability', null, async c => {
  const p = await prop(c.db, c.query.property_id);
  if (!isDate(c.query.arrival) || c.query.arrival < p.business_date) throw err(400, `Choose an arrival date from ${p.business_date}`);
  return (await availability(c.db, p.id, c.query.arrival, c.query.departure, true)).filter(t => t.available > 0);
});
const bookings = new Map(); // ip -> timestamps; shortcut: per server instance, so on Vercel the limit is best-effort
route('POST', '/api/public/book', null, async c => {
  const now = Date.now(), recent = (bookings.get(c.ip) || []).filter(t => now - t < 3600e3);
  if (recent.length >= 10) throw err(429, 'Too many bookings from this connection. Please call the hotel.');
  const b = c.body;
  const plan = await c.db.prepare('SELECT * FROM rate_plans WHERE id=? AND public=1 AND active=1').get(Number(b.rate_plan_id));
  if (!plan) throw err(400, 'Unknown rate plan');
  if (!b.email) throw err(400, 'email is required');
  const p = await prop(c.db, b.property_id);
  // pay-at-hotel booking: no online payment is taken
  const id = await createReservation(c.db, null, {
    property_id: p.id, rate_plan_id: plan.id, arrival: b.arrival, departure: b.departure, adults: b.adults, source: 'website',
    guest: { name: b.name, phone: b.phone, email: b.email, nationality: b.nationality }, notes: b.notes ? String(b.notes).slice(0, 500) : null,
  });
  bookings.set(c.ip, [...recent, now]);
  const r = await c.db.prepare(`${RES_LIST} WHERE r.id=?`).get(id);
  const rates = JSON.parse(r.rates_json);
  let total = 0;
  for (const n of rates) total += n + 2 * Math.round((n * (await roomTaxRate(c.db, n))) / 200);
  return { code: r.code, arrival: r.arrival, departure: r.departure, room_type: r.room_type, hotel: p.name, hotel_phone: p.phone, total };
});
