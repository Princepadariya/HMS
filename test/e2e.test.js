// End-to-end business flow against a fresh in-memory database (seeded with 30 days of history).
// Tests create their own bookings and items so they don't depend on the simulated history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../server/index.js';
import { INITIAL_PASSWORD } from '../server/seed.js';

let srv, base, dir;
const tokens = {};
before(async () => {
  // a fresh database file per run (libSQL transactions need a file, not :memory:)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotel-erp-test-'));
  srv = await start({ dbPath: path.join(dir, 'test.db'), port: 0, quiet: true });
  base = `http://localhost:${srv.port}/api`;
});
after(() => {
  srv.server.close();
  srv.db.close();
  // Windows can hold the file a moment after closing; leftover temp files are harmless
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
});

async function call(user, method, path, body) {
  if (user && !tokens[user]) tokens[user] = (await call(null, 'POST', '/login', { username: user, password: INITIAL_PASSWORD })).token;
  const r = await fetch(base + path, {
    method, body: body && JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(user && { Authorization: `Bearer ${tokens[user]}` }) },
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error), { status: r.status });
  return data;
}
const rejects = (p, status, re) => assert.rejects(p, e => e.status === status && (!re || re.test(e.message)));
const plus = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const gstOf = (amt, rate) => 2 * Math.round((amt * rate) / 200);

test('seeded history: books balance and the dashboard has real numbers', async () => {
  const dash = await call('owner', 'GET', '/reports/dashboard');
  assert.equal(dash.properties.length, 2);
  assert.ok(dash.group.room_nights > 0 && dash.group.room_revenue > 0 && dash.group.fnb_revenue > 0);
  for (const q of ['', '?property_id=1', '?property_id=2']) {
    const tb = await call('accounts', 'GET', `/reports/trial-balance${q}`);
    assert.equal(tb.total_dr, tb.total_cr);
    const bs = await call('accounts', 'GET', `/reports/balance-sheet${q}`);
    assert.equal(bs.total_assets, bs.total_liabilities_equity);
  }
  const pending = await call('gm.amd', 'GET', '/purchase-orders?status=requested');
  assert.ok(pending.length >= 1);
});

test('group performance: league, on-the-books forecast and channel mix', async () => {
  const g = await call('owner', 'GET', '/reports/group?days=30');
  assert.equal(g.hotels.length, 2);
  assert.deepEqual(g.hotels.map(h => h.rank), [1, 2]);
  assert.ok(g.hotels[0].revpar >= g.hotels[1].revpar, 'league is ranked by RevPAR');
  assert.ok(g.group.room_revenue > 0 && g.previous !== undefined);
  for (const h of g.hotels) {
    assert.equal(h.forecast.nights.length, 30);
    assert.ok(h.forecast.nights.every(n => n.occupancy >= 0 && n.occupancy <= 1 && n.sold <= h.rooms));
    assert.ok(h.forecast.room_nights > 0, 'seeded future bookings appear on the books');
  }
  assert.ok(Math.abs(g.channels.reduce((s, c) => s + c.share, 0) - 1) < 1e-9, 'channel shares add up to 100%');
  assert.ok(g.channels.every(c => ['website', 'ota', 'phone', 'walk_in'].includes(c.channel)));
  const direct = g.channels.filter(c => c.channel !== 'ota').reduce((s, c) => s + c.revenue, 0);
  assert.equal(g.ota_commission_saved, Math.round(direct * g.ota_commission_rate));
  // a GM sees only their hotel; front desk has no reports
  assert.equal((await call('gm.amd', 'GET', '/reports/group')).hotels.length, 1);
  await rejects(call('desk.amd', 'GET', '/reports/group'), 403);
});

test('restaurant tables are set per hotel and only an admin can change them', async () => {
  const me = await call('owner', 'GET', '/me');
  assert.ok(me.perms.includes('admin'), 'the owner screen must show admin-only setup');
  assert.ok(!(await call('gm.amd', 'GET', '/me')).perms.includes('admin'));
  const props = me.properties;
  assert.deepEqual(props.map(p => p.restaurant_tables), [18, 12]);
  await rejects(call('owner', 'PUT', '/properties/2', { restaurant_tables: 0 }), 400, /1 to 200/);
  await rejects(call('owner', 'PUT', '/properties/2', { restaurant_tables: 250 }), 400);
  await rejects(call('owner', 'PUT', '/properties/2', { restaurant_tables: 7.5 }), 400);
  await rejects(call('gm.brc', 'PUT', '/properties/2', { restaurant_tables: 20 }), 403);
  assert.equal((await call('owner', 'PUT', '/properties/2', { restaurant_tables: 14 })).restaurant_tables, 14);
  assert.equal((await call('gm.brc', 'GET', '/me')).properties[0].restaurant_tables, 14);
});

test('audit log is for the owner only', async () => {
  for (const u of ['gm.amd', 'duty.amd', 'desk.amd', 'accounts', 'revenue']) await rejects(call(u, 'GET', '/audit-log'), 403);
  const all = await call('owner', 'GET', '/audit-log');
  assert.ok(all.length > 0 && all.every(r => 'user_role' in r && 'property_code' in r));
  assert.ok(all.some(r => r.property_id === null), 'all-hotels view includes group-level entries such as owner sign-ins');
  assert.ok((await call('owner', 'GET', '/audit-log?property_id=1')).every(r => r.property_id === 1));
  // the maintenance list shares the same hotel filter: all hotels must work too
  assert.ok(Array.isArray(await call('owner', 'GET', '/tickets')));
});

test('opening a database made before the tables setting adds the column and keeps the data', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../server/db.js');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hotel-erp-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE properties(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, gstin TEXT, state TEXT, address TEXT, phone TEXT,
    business_date TEXT NOT NULL, fnb_gst_rate REAL NOT NULL DEFAULT 5, discount_limit_pct REAL NOT NULL DEFAULT 10, po_auto_limit INTEGER NOT NULL DEFAULT 2500000,
    po_gm_limit INTEGER NOT NULL DEFAULT 10000000, invoice_seq INTEGER NOT NULL DEFAULT 0, pos_seq INTEGER NOT NULL DEFAULT 0, po_seq INTEGER NOT NULL DEFAULT 0);
    INSERT INTO properties(code, name, business_date) VALUES ('OLD', 'Old Hotel', '2026-11-01');`);
  old.close();
  const db = await openDb(file);
  assert.deepEqual({ ...(await db.prepare('SELECT code, restaurant_tables FROM properties').get()) }, { code: 'OLD', restaurant_tables: 18 });
  db.close();
  (await openDb(file)).close(); // a second open must not try to add the column again
});

test('login page quick sign-in lists every starter role and those logins work', async () => {
  const list = await call(null, 'GET', '/public/quick-logins');
  assert.equal(list.length, 18);
  assert.ok(list.every(u => !('pass_hash' in u)));
  for (const u of list) assert.ok((await call(null, 'POST', '/login', { username: u.username, password: u.password })).token);
});

test('full hotel day: check-in, charges, approvals, POS, night audit, checkout, GST invoice', async () => {
  await rejects(call(null, 'POST', '/login', { username: 'desk.amd', password: 'wrong-password' }), 401);
  await rejects(call(null, 'GET', '/reservations'), 401);
  // property users cannot see another hotel
  await rejects(call('desk.amd', 'GET', '/reservations?property_id=2'), 403);

  const bd = (await call('desk.amd', 'GET', '/me')).properties[0].business_date;
  const av = await call('desk.amd', 'GET', `/availability?arrival=${bd}&departure=${plus(bd, 2)}`);
  const plan = av.find(t => t.room_type === 'Standard').plans.find(p => p.code === 'BAR-STD');
  const book = (name, phone, nationality = 'Indian', type = 'BAR-STD', nights = 2) => call('desk.amd', 'POST', '/reservations', {
    rate_plan_id: av.flatMap(t => t.plans).find(p => p.code === type).rate_plan_id, arrival: bd, departure: plus(bd, nights), adults: 2, source: 'phone',
    guest: { name, phone, nationality },
  });
  const res = await book('Test Guest One', '+91 91111 00001');
  const noShow = await book('Test Guest Two', '+91 91111 00002', 'Indian', 'BAR-STD', 1);

  const rooms = await call('desk.amd', 'GET', '/housekeeping');
  const room = rooms.find(r => r.room_type === 'Standard' && r.status === 'available' && r.hk_status !== 'dirty');
  await rejects(call('desk.amd', 'POST', `/reservations/${res.id}/check-in`, { room_id: room.id }), 400, /id_type/);
  let r = await call('desk.amd', 'POST', `/reservations/${res.id}/check-in`, { room_id: room.id, id_type: 'Aadhaar', id_number: 'XXXX XXXX 9012' });
  assert.equal(r.status, 'checked_in');

  // a foreign guest needs Form C
  const foreign = await book('Test Visitor', '+44 7700 900999', 'British', 'BAR-DLX', 1);
  const dlx = rooms.find(x => x.room_type === 'Deluxe' && x.status === 'available' && x.hk_status !== 'dirty');
  await rejects(call('desk.amd', 'POST', `/reservations/${foreign.id}/check-in`, { room_id: dlx.id, id_type: 'Passport', id_number: 'X1234567' }), 400, /Form C/);
  await call('desk.amd', 'POST', `/reservations/${foreign.id}/cancel`, { reason: 'test' });

  r = await call('desk.amd', 'POST', `/reservations/${res.id}/charges`, { category: 'extra', description: 'Laundry', amount: 50000, tax_rate: 18 });
  const laundry = r.lines.find(l => l.description === 'Laundry');
  assert.equal(laundry.cgst, 4500);

  // 20% discount is over the 10% desk limit -> needs a manager
  await rejects(call('desk.amd', 'POST', `/reservations/${res.id}/discount`, { line_id: laundry.id, amount: 10000, reason: 'Late delivery' }), 403, /needs manager approval/);
  await rejects(call('desk.amd', 'POST', `/reservations/${res.id}/discount`, { line_id: laundry.id, amount: 10000, reason: 'x', override: { username: 'desk.amd', password: INITIAL_PASSWORD } }), 403);
  r = await call('desk.amd', 'POST', `/reservations/${res.id}/discount`, { line_id: laundry.id, amount: 10000, reason: 'Late delivery', override: { username: 'duty.amd', password: INITIAL_PASSWORD } });
  assert.equal(r.lines.at(-1).amount, -10000);

  // void needs approval
  r = await call('desk.amd', 'POST', `/reservations/${res.id}/charges`, { category: 'extra', description: 'Wrong charge', amount: 20000 });
  const wrong = r.lines.at(-1);
  await rejects(call('desk.amd', 'POST', `/folio-lines/${wrong.id}/void`, { reason: 'mistake' }), 403, /needs manager approval/);
  r = await call('duty.amd', 'POST', `/folio-lines/${wrong.id}/void`, { reason: 'mistake' });
  assert.ok(r.lines.find(l => l.id === wrong.id).voided);

  // restaurant bill to the room, and a walk-in bill paid directly
  const thali = (await call('cafe.amd', 'GET', '/menu_items')).find(m => m.name === 'Gujarati Thali');
  let o = await call('cafe.amd', 'POST', '/pos/orders', { table_no: '4' });
  o = await call('cafe.amd', 'POST', `/pos/orders/${o.id}/lines`, { menu_item_id: thali.id, qty: 2 });
  assert.equal(o.total, 90000);
  o = await call('cafe.amd', 'POST', `/pos/orders/${o.id}/settle`, { to: 'room', reservation_id: res.id });
  assert.equal(o.status, 'settled_room');
  let w = await call('cafe.amd', 'POST', '/pos/orders', { table_no: '7' });
  // the same dish twice merges into one line; quantity can be edited and a line removed by setting 0
  const chai = (await call('cafe.amd', 'GET', '/menu_items')).find(m => m.name === 'Masala Chai');
  w = await call('cafe.amd', 'POST', `/pos/orders/${w.id}/lines`, { menu_item_id: thali.id, qty: 1 });
  w = await call('cafe.amd', 'POST', `/pos/orders/${w.id}/lines`, { menu_item_id: chai.id, qty: 1 });
  w = await call('cafe.amd', 'POST', `/pos/orders/${w.id}/lines`, { menu_item_id: chai.id, qty: 1 });
  assert.equal(w.lines.length, 2);
  assert.equal(w.lines.find(l => l.menu_item_id === chai.id).qty, 2);
  w = await call('cafe.amd', 'POST', `/pos/orders/${w.id}/lines/${w.lines.find(l => l.menu_item_id === chai.id).id}/qty`, { qty: 0 });
  assert.equal(w.lines.length, 1);
  await rejects(call('cafe.amd', 'POST', `/pos/orders/${w.id}/lines/${w.lines[0].id}/qty`, { qty: 101 }), 400);
  w = await call('cafe.amd', 'POST', `/pos/orders/${w.id}/settle`, { to: 'direct', mode: 'upi' });
  assert.match(w.invoice.number, /^AMD\/POS\//);

  // night audit posts the room night, marks the unarrived booking as a no-show, advances the date
  const audit = await call('desk.amd', 'POST', '/night-audit', {});
  assert.ok(audit.summary.posted_room_nights >= 1);
  assert.equal(audit.next_business_date, plus(bd, 1));
  assert.equal((await call('desk.amd', 'GET', `/reservations/${noShow.id}`)).status, 'no_show');

  r = await call('desk.amd', 'GET', `/reservations/${res.id}`);
  const night = r.lines.find(l => l.category === 'room');
  const n = plan.nightly[0];
  assert.equal(night.amount, n);
  assert.equal(night.tax_rate, 5);
  const expected = n + gstOf(n, 5) + 50000 + 9000 - 10000 - 1800 + 90000 + gstOf(90000, 5);
  assert.equal(r.balance, expected);

  await rejects(call('desk.amd', 'POST', `/reservations/${res.id}/check-out`, {}), 400, /Settle/);
  await call('desk.amd', 'POST', `/reservations/${res.id}/payments`, { mode: 'card', amount: expected });
  const out = await call('desk.amd', 'POST', `/reservations/${res.id}/check-out`, { bill_to: 'Acme Pvt Ltd', bill_to_gstin: '24AAACA1234B1Z5' });
  const inv = await call('accounts', 'GET', `/invoices/${out.invoice_id}`);
  assert.equal(inv.total, expected);
  assert.equal(inv.taxable, n + 50000 - 10000 + 90000);
  assert.match(inv.number, /^AMD\/INV\/\d{2}-\d{2}\/\d{5}$/);

  // room goes dirty; a housekeeper cleans it but only a supervisor inspects it
  assert.equal((await call('maid.amd', 'GET', '/housekeeping')).find(x => x.id === room.id).hk_status, 'dirty');
  await call('maid.amd', 'POST', `/rooms/${room.id}/hk`, { hk_status: 'clean' });
  await rejects(call('maid.amd', 'POST', `/rooms/${room.id}/hk`, { hk_status: 'inspected' }), 403);
  await call('hk.amd', 'POST', `/rooms/${room.id}/hk`, { hk_status: 'inspected' });

  const tb = await call('accounts', 'GET', '/reports/trial-balance');
  assert.equal(tb.total_dr, tb.total_cr);
  const gst = await call('accounts', 'GET', `/reports/gst?property_id=1&from=${inv.business_date}&to=${inv.business_date}`);
  assert.ok(gst.b2b.some(b => b.number === inv.number));
});

test('purchasing approvals, goods receipt, stock issue, supplier payment', async () => {
  const flour = await call('store.amd', 'POST', '/items', { code: 'TFLOUR', name: 'Test flour', unit: 'kg', category: 'fnb', tax_rate: 5 });
  const [sup] = await call('store.amd', 'GET', '/suppliers');

  // small PO: auto-approved
  let po = await call('store.amd', 'POST', '/purchase-orders', { supplier_id: sup.id, lines: [{ item_id: flour.id, qty: 50, rate: 9000 }] });
  assert.equal(po.status, 'approved');
  assert.equal(po.total, 50 * 9000 + Math.round(50 * 9000 * 0.05));

  // 1 lakh+ PO: needs central purchasing, a GM is not enough
  let big = await call('store.amd', 'POST', '/purchase-orders', { supplier_id: sup.id, lines: [{ item_id: flour.id, qty: 1500, rate: 9000 }] });
  assert.equal(big.status, 'requested');
  assert.equal(big.needs, 'central');
  await rejects(call('store.amd', 'POST', `/purchase-orders/${big.id}/approve`), 403);
  await rejects(call('gm.amd', 'POST', `/purchase-orders/${big.id}/approve`), 403, /central/);
  big = await call('purchase', 'POST', `/purchase-orders/${big.id}/approve`);
  assert.equal(big.status, 'approved');

  po = await call('store.amd', 'POST', `/purchase-orders/${po.id}/receive`);
  assert.equal(po.status, 'received');
  assert.equal((await call('store.amd', 'GET', '/stock')).find(s => s.id === flour.id).qty, 50);

  const cogs = async () => (await call('accounts', 'GET', '/reports/pnl?property_id=1')).expense.find(e => e.code === '5000').amount;
  const before = await cogs();
  await rejects(call('store.amd', 'POST', '/stock/issue', { item_id: flour.id, qty: 60, department: 'Kitchen' }), 400, /in stock/);
  const issue = await call('store.amd', 'POST', '/stock/issue', { item_id: flour.id, qty: 10, department: 'Kitchen' });
  assert.equal(issue.cost, 90000);
  assert.equal(await cogs(), before + 90000);
  assert.equal((await call('store.amd', 'GET', '/stock')).find(s => s.id === flour.id).qty, 40);

  await rejects(call('store.amd', 'POST', `/purchase-orders/${po.id}/pay`, { mode: 'bank' }), 403);
  po = await call('accounts', 'POST', `/purchase-orders/${po.id}/pay`, { mode: 'bank' });
  assert.equal(po.status, 'paid');

  // manual journal must balance
  await rejects(call('accounts', 'POST', '/journals', { property_id: 1, date: '2026-11-30', memo: 'bad', lines: [{ account_code: '5300', debit: 100 }, { account_code: '1010', credit: 50 }] }), 400, /equal/);
  await call('accounts', 'POST', '/journals', { property_id: 1, date: '2026-11-30', memo: 'Salaries', lines: [{ account_code: '5300', debit: 30000000 }, { account_code: '1010', credit: 30000000 }] });
  const tb = await call('accounts', 'GET', '/reports/trial-balance');
  assert.equal(tb.total_dr, tb.total_cr);
});

test('maintenance ticket blocks a room and frees it when resolved', async () => {
  const room = (await call('maint.amd', 'GET', '/housekeeping')).find(r => r.status === 'available');
  const bd = (await call('desk.amd', 'GET', '/me')).properties[0].business_date;
  const free = async () => (await call('desk.amd', 'GET', `/availability?arrival=${bd}&departure=${plus(bd, 1)}`)).find(t => t.room_type === room.room_type).available;
  const freeBefore = await free();

  const t = await call('hk.amd', 'POST', '/tickets', { room_id: room.id, title: 'AC not cooling', priority: 'high', blocks_room: 1 });
  assert.equal((await call('maint.amd', 'GET', '/housekeeping')).find(r => r.id === room.id).status, 'out_of_order');
  assert.equal(await free(), freeBefore - 1);

  await call('maint.amd', 'POST', `/tickets/${t.id}/resolve`, { resolution: 'Gas refilled' });
  const after = (await call('maint.amd', 'GET', '/housekeeping')).find(r => r.id === room.id);
  assert.equal(after.status, 'available');
  assert.equal(after.hk_status, 'dirty');
});

test('booking website: pay-at-hotel booking, validation and overbooking guard', async () => {
  const brc = (await call(null, 'GET', '/public/properties')).find(h => h.name.includes('Vadodara'));
  const arrival = brc.business_date, departure = plus(arrival, 2);
  const av = await call(null, 'GET', `/public/availability?property_id=${brc.id}&arrival=${arrival}&departure=${departure}`);
  const suite = av.find(t => t.room_type === 'Suite');
  assert.ok(suite?.available > 0, 'a suite should be free in the seeded data');
  const plan = suite.plans[0];
  const guest = i => ({ property_id: brc.id, rate_plan_id: plan.rate_plan_id, arrival, departure, adults: 2, name: `Web Guest ${i}`, phone: `+91 90000 0000${i}`, email: `g${i}@example.com` });

  await rejects(call(null, 'POST', '/public/book', { ...guest(0), phone: 'abc' }), 400, /phone/);

  const b1 = await call(null, 'POST', '/public/book', guest(1));
  assert.match(b1.code, /^BRC-/);
  assert.equal(b1.total, plan.total + plan.tax);
  // keep booking suites until the hotel is full: the next one must be refused
  let refused = false;
  for (let i = 2; i < 10 && !refused; i++) await call(null, 'POST', '/public/book', guest(i)).catch(e => { assert.equal(e.status, 409); refused = true; });
  assert.ok(refused);

  const [listed] = await call('gm.brc', 'GET', `/reservations?q=${encodeURIComponent(b1.code)}`);
  assert.equal(listed.balance, 0); // pay at hotel: nothing charged or paid yet
  assert.equal(listed.source, 'website');
});
