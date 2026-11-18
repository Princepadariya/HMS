import { hashPassword, post, addDays, tx, routes, has, err, INITIAL_PASSWORD } from './core.js';
import './api.js';

export { INITIAL_PASSWORD };

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

export async function seed(db, { businessDate = today(), days = 30 } = {}) {
  await tx(db, async () => {
    const run = async (sql, ...a) => (await db.prepare(sql).run(...a)).lastInsertRowid;
    const start = addDays(businessDate, -days);

    // GST room slabs by nightly tariff (paise). Confirm current rates with the group's accountant.
    await run(`INSERT INTO settings(key, value) VALUES ('room_gst_slabs', ?)`,
      JSON.stringify([{ upto: 100000, rate: 0 }, { upto: 750000, rate: 5 }, { upto: null, rate: 18 }]));

    for (const [code, name, type] of [
      ['1000', 'Cash', 'asset'], ['1010', 'Bank (card / UPI / online)', 'asset'], ['1100', 'Guest ledger', 'asset'],
      ['1200', 'Inventory', 'asset'], ['1300', 'GST input credit', 'asset'], ['2000', 'Accounts payable', 'liability'],
      ['2100', 'CGST output', 'liability'], ['2110', 'SGST output', 'liability'], ['3000', "Owner's capital", 'equity'],
      ['4000', 'Room revenue', 'income'], ['4100', 'F&B revenue', 'income'], ['4200', 'Other revenue', 'income'],
      ['5000', 'F&B cost', 'expense'], ['5100', 'Housekeeping supplies', 'expense'], ['5200', 'Maintenance supplies', 'expense'],
      ['5300', 'Salaries', 'expense'], ['5400', 'Utilities', 'expense'], ['5500', 'Other expenses', 'expense'],
    ]) await run('INSERT INTO accounts(code, name, type) VALUES (?,?,?)', code, name, type);

    const props = [
      await run(`INSERT INTO properties(code, name, gstin, state, address, phone, business_date) VALUES (?,?,?,?,?,?,?)`,
        'AMD', 'Grand Residency Ahmedabad', '24AABCG1234M1Z5', 'Gujarat', 'Near Municipal Market, CG Road, Navrangpura, Ahmedabad 380009', '+91 79 4000 1000', start),
      await run(`INSERT INTO properties(code, name, gstin, state, address, phone, business_date) VALUES (?,?,?,?,?,?,?)`,
        'BRC', 'Grand Residency Vadodara', '24AABCG1234M2Z4', 'Gujarat', 'Race Course Circle, Alkapuri, Vadodara 390007', '+91 265 400 2000', start),
    ];

    await run('UPDATE properties SET restaurant_tables=12 WHERE id=?', props[1]);

    const typeIds = []; // one at a time so the ids stay in this order
    for (const [code, name, occ] of [['STD', 'Standard', 2], ['DLX', 'Deluxe', 3], ['STE', 'Suite', 4]])
      typeIds.push(await run('INSERT INTO room_types(code, name, max_occupancy) VALUES (?,?,?)', code, name, occ));
    const [std, dlx, ste] = typeIds;
    // floors: [property, floor, room type, rooms on floor]
    for (const [pid, floors] of [
      [props[0], [[1, std, 10], [2, std, 10], [3, std, 10], [4, dlx, 12], [5, dlx, 12], [6, ste, 6]]],
      [props[1], [[1, std, 12], [2, std, 12], [3, dlx, 10], [4, dlx, 10], [5, ste, 4]]],
    ]) for (const [floor, type, n] of floors) for (let i = 1; i <= n; i++)
      await run('INSERT INTO rooms(property_id, number, room_type_id, floor) VALUES (?,?,?,?)', pid, `${floor}${String(i).padStart(2, '0')}`, type, String(floor));

    const bar = {};
    for (const [type, code, price] of [[std, 'STD', 350000], [dlx, 'DLX', 550000], [ste, 'STE', 950000]]) {
      bar[code] = await run('INSERT INTO rate_plans(code, name, room_type_id, base_price) VALUES (?,?,?,?)', `BAR-${code}`, 'Best available rate (room only)', type, price);
      await run('INSERT INTO rate_plans(code, name, room_type_id, base_price) VALUES (?,?,?,?)', `CP-${code}`, 'Room + breakfast', type, price + 60000);
    }
    await run('INSERT INTO rate_prices(rate_plan_id, property_id, date_from, date_to, price) VALUES (?,?,?,?,?)', bar.DLX, null, '2026-12-20', '2027-01-05', 650000);
    await run('INSERT INTO rate_prices(rate_plan_id, property_id, date_from, date_to, price) VALUES (?,?,?,?,?)', bar.STD, props[1], '2026-01-01', '2027-12-31', 320000);

    const menu = [['Masala Chai', 'Beverages', 6000], ['Filter Coffee', 'Beverages', 8000], ['Fresh Lime Soda', 'Beverages', 12000],
      ['Cold Coffee', 'Beverages', 16000], ['Buttermilk (Chaas)', 'Beverages', 7000], ['Poha', 'Breakfast', 12000], ['Aloo Paratha', 'Breakfast', 16000],
      ['Veg Club Sandwich', 'Snacks', 22000], ['Khaman Dhokla', 'Snacks', 14000], ['Paneer Tikka', 'Starters', 32000], ['Hara Bhara Kebab', 'Starters', 26000],
      ['Gujarati Thali', 'Mains', 45000], ['Paneer Butter Masala', 'Mains', 34000], ['Dal Makhani', 'Mains', 28000], ['Veg Biryani', 'Mains', 30000],
      ['Dal Khichdi', 'Mains', 24000], ['Butter Naan', 'Breads', 7000], ['Tandoori Roti', 'Breads', 4000], ['Gulab Jamun', 'Desserts', 12000],
      ['Kesar Kulfi', 'Desserts', 15000]];
    for (const pid of props) for (const [n, cat, price] of menu) await run('INSERT INTO menu_items(property_id, name, category, price) VALUES (?,?,?,?)', pid, n, cat, price);

    await run('INSERT INTO suppliers(name, gstin, phone) VALUES (?,?,?)', 'Shree Provision Stores', '24AAACS1234B1Z2', '+91 98250 11111');
    await run('INSERT INTO suppliers(name, gstin, phone) VALUES (?,?,?)', 'CleanPro Hygiene Supplies', '24AAACC5678D1Z8', '+91 98250 22222');
    await run('INSERT INTO suppliers(name, gstin, phone) VALUES (?,?,?)', 'Gujarat Electricals', '24AAACG9012F1Z4', '+91 98250 33333');
    for (const [code, name, unit, cat, rate] of [
      ['RICE', 'Basmati rice', 'kg', 'fnb', 5], ['ATTA', 'Wheat flour', 'kg', 'fnb', 5], ['OIL', 'Groundnut oil', 'litre', 'fnb', 5],
      ['MILK', 'Milk', 'litre', 'fnb', 0], ['PANEER', 'Paneer', 'kg', 'fnb', 5], ['TEA', 'Tea leaves', 'kg', 'fnb', 5],
      ['SOAP', 'Guest soap 30g', 'pcs', 'housekeeping', 18], ['SHAMP', 'Shampoo sachet', 'pcs', 'housekeeping', 18],
      ['TISSUE', 'Tissue roll', 'pcs', 'housekeeping', 18], ['BULB', 'LED bulb 9W', 'pcs', 'maintenance', 18],
    ]) await run('INSERT INTO items(code, name, unit, category, tax_rate) VALUES (?,?,?,?,?)', code, name, unit, cat, rate);

    const pw = hashPassword(INITIAL_PASSWORD);
    for (const [u, name, role, pid] of [
      ['owner', 'Rajesh Mehta', 'admin', null], ['revenue', 'Ananya Iyer', 'central_revenue', null],
      ['purchase', 'Vivek Agarwal', 'central_purchasing', null], ['accounts', 'Hemant Bhatt', 'accountant', null],
      ['gm.amd', 'Nirav Shah', 'gm', props[0]], ['duty.amd', 'Meghna Joshi', 'duty_manager', props[0]],
      ['desk.amd', 'Riya Patel', 'front_desk', props[0]], ['hk.amd', 'Sunita Parmar', 'hk_supervisor', props[0]],
      ['maid.amd', 'Kanta Vaghela', 'housekeeper', props[0]], ['maint.amd', 'Ramesh Solanki', 'maintenance', props[0]],
      ['cafe.amd', 'Imran Sheikh', 'restaurant', props[0]], ['store.amd', 'Dinesh Rathod', 'storekeeper', props[0]],
      ['gm.brc', 'Ketan Desai', 'gm', props[1]], ['duty.brc', 'Farhan Qureshi', 'duty_manager', props[1]],
      ['desk.brc', 'Pooja Trivedi', 'front_desk', props[1]], ['hk.brc', 'Lata Makwana', 'hk_supervisor', props[1]],
      ['cafe.brc', 'Joseph D\'Souza', 'restaurant', props[1]], ['store.brc', 'Mahesh Chauhan', 'storekeeper', props[1]],
    ]) await run('INSERT INTO users(username, name, role, property_id, pass_hash) VALUES (?,?,?,?,?)', u, name, role, pid, pw);

    for (const pid of props) await post(db, { pid, date: start, memo: 'Opening capital introduced', source: 'manual' }, [['1000', 5000000], ['1010', 250000000], ['3000', -255000000]]);

    await simulate(db, days);
  });
}

// ---------- operating history ----------
// Replays `days` of hotel operations through the real API handlers, so every rule, posting and approval applies.
async function simulate(db, days) {
  let ipN = 0;
  const call = async (user, method, url, body = {}) => {
    const u = new URL(url, 'http://seed');
    const r = routes.find(x => x.method === method && x.re.test(u.pathname));
    if (!r) throw err(404, `No route ${method} ${u.pathname}`);
    if (r.perm && r.perm !== 'auth' && !has(user, r.perm)) throw err(403, `${user.username} cannot ${method} ${u.pathname}`);
    const m = u.pathname.match(r.re);
    return r.fn({ db, user, body, ip: `seed-${ipN++}`, query: Object.fromEntries(u.searchParams), params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) });
  };
  // business refusals (hotel full, no stock) are normal in a simulation
  const soft = async p => { try { return await p; } catch (e) { if (!e.status || e.status >= 500) throw e; return null; } };

  let s = 20261118; // deterministic random numbers
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const pick = a => a[Math.floor(rand() * a.length)];
  const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

  const FIRST = ['Rahul', 'Priya', 'Amit', 'Neha', 'Vikram', 'Anjali', 'Rohan', 'Kavya', 'Arjun', 'Sneha', 'Karan', 'Pooja', 'Siddharth', 'Meera', 'Aditya',
    'Riya', 'Harsh', 'Isha', 'Manish', 'Divya', 'Nikhil', 'Shreya', 'Varun', 'Tanvi', 'Yash', 'Krupa', 'Jignesh', 'Hetal', 'Parth', 'Bhavna', 'Sanjay', 'Komal'];
  const LAST = ['Shah', 'Patel', 'Mehta', 'Desai', 'Joshi', 'Trivedi', 'Sharma', 'Iyer', 'Nair', 'Reddy', 'Gupta', 'Agarwal', 'Kapoor', 'Bhatt', 'Parekh',
    'Rao', 'Verma', 'Chauhan', 'Kulkarni', 'Menon', 'Saxena', 'Pandya'];
  const FOREIGN = [['John Miller', 'British', '+44 7700 900'], ['Emma Schmidt', 'German', '+49 151 2345'], ['Kenji Sato', 'Japanese', '+81 90 1234'],
    ['Sarah Johnson', 'American', '+1 415 555'], ['Lucas Martin', 'French', '+33 6 1234'], ['Olivia Brown', 'Australian', '+61 412 345']];
  const COMPANIES = [['Sabarmati Textiles Pvt Ltd', '24AAKCS4821M1Z3'], ['Narmada Pharma Ltd', '24AABCN7310K1Z9'], ['Kutch Infra Projects LLP', '24AAQFK2290H1Z6'],
    ['Saurashtra Agro Exports', '24AAPFS6634Q1Z1']];
  const EXTRAS = [['Laundry', 30000, 70000], ['Airport transfer', 120000, 180000], ['Late check-out', 100000, 200000], ['Extra bed', 80000, 80000]];

  const guests = [];
  const guest = () => {
    if (guests.length > 20 && rand() < 0.2) return pick(guests); // returning guest, possibly at the other hotel
    const i = guests.length;
    let g;
    if (rand() < 0.06) {
      const [name, nationality, pre] = pick(FOREIGN);
      g = { name, nationality, phone: `${pre} ${String(100 + i).slice(-3)}`, email: `${name.toLowerCase().replace(' ', '.')}${i}@example.com` };
    } else {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      g = { name, nationality: 'Indian', phone: `+91 9${String(800000000 + i * 7919).slice(0, 4)} ${String(800000000 + i * 7919).slice(4, 9)}`,
        email: `${name.toLowerCase().replace(' ', '.')}${i}@example.com` };
    }
    guests.push(g);
    return g;
  };

  const user = u => db.prepare('SELECT * FROM users WHERE username=?').get(u);
  const [accounts, central, revenue] = [await user('accounts'), await user('purchase'), await user('revenue')];
  const plans = await db.prepare('SELECT p.*, t.code type FROM rate_plans p JOIN room_types t ON t.id=p.room_type_id').all();
  const items = Object.fromEntries((await db.prepare('SELECT * FROM items').all()).map(i => [i.code, i]));
  const sup = (await db.prepare('SELECT id FROM suppliers ORDER BY id').all()).map(x => x.id);
  const COST = { RICE: 9500, ATTA: 4200, OIL: 19000, MILK: 6200, PANEER: 38000, TEA: 45000, SOAP: 950, SHAMP: 300, TISSUE: 2800, BULB: 11000 };
  const props = await db.prepare('SELECT * FROM properties ORDER BY id').all();
  const gms = Object.fromEntries(await Promise.all(props.map(async p => [p.id, await user(`gm.${p.code.toLowerCase()}`)])));

  for (let day = 0; day < days; day++) {
    for (const { id: pid, code, restaurant_tables: tables } of props) {
      const gm = gms[pid];
      const d = (await db.prepare('SELECT business_date FROM properties WHERE id=?').get(pid)).business_date;
      const q = `property_id=${pid}`;

      // morning: settle and check out today's departures
      for (const r of (await call(gm, 'GET', `/api/reservations?${q}&status=checked_in`)).filter(r => r.departure <= d)) {
        if (r.balance > 0) await call(gm, 'POST', `/api/reservations/${r.id}/payments`, { mode: pick(['upi', 'upi', 'card', 'card', 'cash']), amount: r.balance });
        const co = rand() < 0.15 ? pick(COMPANIES) : null;
        await call(gm, 'POST', `/api/reservations/${r.id}/check-out`, co ? { bill_to: co[0], bill_to_gstin: co[1] } : {});
      }
      // housekeeping turns the rooms
      for (const rm of (await call(gm, 'GET', `/api/housekeeping?${q}`)).filter(x => x.hk_status === 'dirty'))
        await call(gm, 'POST', `/api/rooms/${rm.id}/hk`, { hk_status: rand() < 0.6 ? 'inspected' : 'clean' });

      // new reservations: same-day and ahead, from every channel
      const roomCount = (await db.prepare('SELECT COUNT(*) n FROM rooms WHERE property_id=?').get(pid)).n;
      for (let k = between(Math.round(roomCount * 0.2), Math.round(roomCount * 0.32)); k > 0; k--) {
        const lead = pick([0, 0, 0, 1, 1, 2, 3, 4, 6, 8, 12]);
        const type = pick(['STD', 'STD', 'STD', 'STD', 'STD', 'DLX', 'DLX', 'DLX', 'DLX', 'STE']);
        const planCode = `${rand() < 0.65 ? 'BAR' : 'CP'}-${type}`;
        const plan = plans.find(p => p.code === planCode);
        const arrival = addDays(d, lead), departure = addDays(arrival, pick([1, 1, 1, 2, 2, 2, 3, 3, 4, 5]));
        const g = guest(), adults = between(1, 2);
        const source = lead === 0 && rand() < 0.4 ? 'walk_in' : pick(['website', 'website', 'phone', 'ota', 'ota', 'ota', 'central']);
        if (source === 'website') await soft(call(null, 'POST', '/api/public/book', { property_id: pid, rate_plan_id: plan.id, arrival, departure, adults, ...g }));
        else await soft(call(source === 'central' ? revenue : gm, 'POST', '/api/reservations', {
          property_id: pid, rate_plan_id: plan.id, arrival, departure, adults, source, guest: g,
          ota_ref: source === 'ota' ? `${pick(['BKG', 'MMT', 'AGD', 'EXP'])}-${between(1000000, 9999999)}` : undefined,
          advance: source === 'phone' && rand() < 0.4 ? { amount: 200000, mode: pick(['upi', 'card']) } : undefined,
        }));
      }

      // arrivals: about 5% never show up
      const free = (await call(gm, 'GET', `/api/housekeeping?${q}`)).filter(x => x.status === 'available' && x.hk_status !== 'dirty');
      for (const r of await call(gm, 'GET', `/api/reservations?${q}&status=booked&arrival=${d}`)) {
        if (rand() < 0.05) continue;
        const idx = free.findIndex(x => x.room_type === r.room_type);
        if (idx < 0) continue;
        const room = free.splice(idx, 1)[0];
        const foreign = (await call(gm, 'GET', `/api/reservations/${r.id}`)).guest.nationality !== 'Indian';
        await call(gm, 'POST', `/api/reservations/${r.id}/check-in`, {
          room_id: room.id, id_type: foreign ? 'Passport' : pick(['Aadhaar', 'Aadhaar', 'Aadhaar', 'Driving licence', 'Voter ID']),
          id_number: foreign ? `P${between(1000000, 9999999)}` : `XXXX XXXX ${between(1000, 9999)}`, form_c_no: foreign ? `FC/${code}/${between(10000, 99999)}` : undefined,
        });
      }

      // restaurant: room service to in-house guests and walk-in diners
      const menu = await call(gm, 'GET', `/api/menu_items?${q}`);
      const order = async table => {
        const o = await call(gm, 'POST', '/api/pos/orders', { property_id: pid, table_no: table });
        for (let n = between(1, 4); n > 0; n--) await call(gm, 'POST', `/api/pos/orders/${o.id}/lines`, { menu_item_id: pick(menu).id, qty: between(1, 3) });
        return o;
      };
      for (const r of await call(gm, 'GET', `/api/reservations?${q}&status=checked_in`)) {
        if (rand() < 0.35) await call(gm, 'POST', `/api/pos/orders/${(await order('Room service')).id}/settle`, { to: 'room', reservation_id: r.id });
        if (rand() < 0.08) {
          const [description, lo, hi] = pick(EXTRAS);
          await call(gm, 'POST', `/api/reservations/${r.id}/charges`, { category: 'extra', description, amount: between(lo / 100, hi / 100) * 100, tax_rate: 18 });
        }
      }
      for (let n = between(5, 12); n > 0; n--) {
        const co = rand() < 0.05 ? pick(COMPANIES) : null;
        await call(gm, 'POST', `/api/pos/orders/${(await order(String(between(1, tables)))).id}/settle`, { to: 'direct', mode: pick(['upi', 'upi', 'card', 'cash']), bill_to: co?.[0], bill_to_gstin: co?.[1] });
      }

      // stores: weekly purchasing, daily issues, supplier payments
      if (day % 7 === 0) {
        for (const [supplier, lines] of [
          [sup[0], [['RICE', 120], ['ATTA', 80], ['OIL', 60], ['MILK', 350], ['PANEER', 40], ['TEA', 10]]],
          [sup[1], [['SOAP', 700], ['SHAMP', 700], ['TISSUE', 150]]],
        ]) {
          let po = await call(gm, 'POST', '/api/purchase-orders', { property_id: pid, supplier_id: supplier, lines: lines.map(([c, qty]) => ({ item_id: items[c].id, qty, rate: COST[c] })) });
          if (po.status === 'requested') po = await call(central, 'POST', `/api/purchase-orders/${po.id}/approve`);
          await call(gm, 'POST', `/api/purchase-orders/${po.id}/receive`);
        }
      }
      if (day % 7 === 3) for (const po of await call(accounts, 'GET', `/api/purchase-orders?${q}&status=received`)) await call(accounts, 'POST', `/api/purchase-orders/${po.id}/pay`, { mode: 'bank' });
      for (const [c, qty, dept] of [['RICE', between(12, 18), 'Kitchen'], ['ATTA', between(8, 12), 'Kitchen'], ['OIL', between(6, 9), 'Kitchen'], ['MILK', between(40, 50), 'Kitchen'],
        ['PANEER', between(4, 6), 'Kitchen'], ['TEA', 1, 'Kitchen'], ['SOAP', between(60, 90), 'Housekeeping'], ['SHAMP', between(60, 90), 'Housekeeping'], ['TISSUE', between(12, 20), 'Housekeeping']])
        await soft(call(gm, 'POST', '/api/stock/issue', { property_id: pid, item_id: items[c].id, qty, department: dept }));

      // maintenance
      if (rand() < 0.35) {
        const rm = pick(await call(gm, 'GET', `/api/housekeeping?${q}`));
        await call(gm, 'POST', '/api/tickets', { property_id: pid, room_id: rm.id, title: pick(['AC not cooling', 'Bathroom tap leaking', 'TV remote not working', 'Geyser not heating', 'Door lock battery low', 'Wi-Fi weak in room']),
          priority: pick(['normal', 'normal', 'high', 'low']), blocks_room: rm.status === 'available' && rand() < 0.3 ? 1 : 0 });
      }
      for (const t of await call(gm, 'GET', `/api/tickets?${q}&status=open`)) if (rand() < 0.6) await call(gm, 'POST', `/api/tickets/${t.id}/resolve`, { resolution: pick(['Fixed', 'Part replaced', 'Serviced and tested']) });

      await call(gm, 'POST', '/api/night-audit', { property_id: pid });
    }
  }

  // month-end payroll and utilities, plus a purchase request waiting for the GM
  for (const { id: pid, code } of props) {
    const d = addDays((await db.prepare('SELECT business_date FROM properties WHERE id=?').get(pid)).business_date, -1);
    const big = code === 'AMD';
    await call(accounts, 'POST', '/api/journals', { property_id: pid, date: d, memo: 'Staff salaries for the month', lines: [{ account_code: '5300', debit: big ? 68000000 : 52000000 }, { account_code: '1010', credit: big ? 68000000 : 52000000 }] });
    await call(accounts, 'POST', '/api/journals', { property_id: pid, date: d, memo: 'Electricity and water bills', lines: [{ account_code: '5400', debit: big ? 21500000 : 16800000 }, { account_code: '1010', credit: big ? 21500000 : 16800000 }] });
    await call(accounts, 'POST', '/api/journals', { property_id: pid, date: d, memo: 'Building lease rent and OTA commissions', lines: [{ account_code: '5500', debit: big ? 185000000 : 140000000 }, { account_code: '1010', credit: big ? 185000000 : 140000000 }] });
    await call(await user(`store.${code.toLowerCase()}`), 'POST', '/api/purchase-orders', { property_id: pid, supplier_id: sup[2], lines: [{ item_id: items.BULB.id, qty: 300, rate: COST.BULB }] });
  }
}
