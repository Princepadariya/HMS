'use strict';

// ---------- state & helpers ----------
const S = { token: null, me: null, pid: null, dash: {} };
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
S.token = store.get('erp.token');
S.pid = Number(store.get('erp.pid')) || null;
S.all = store.get('erp.pid') === 'all'; // group users can look at every hotel at once

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const rs = p => '₹' + ((p || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toPaise = v => Math.round(parseFloat(v) * 100);
const pct = v => (v * 100).toFixed(1) + '%';
const badge = s => h('span', { class: `badge ${s}` }, String(s).replace(/_/g, ' '));
const can = p => [].concat(p).some(x => S.me?.perms.includes(x));
const curProp = () => S.me.properties.find(p => p.id === S.pid) || S.me.properties[0];
const pq = () => (S.all ? '' : `property_id=${curProp().id}`); // empty = all hotels (server scopes property users anyway)
const scopeName = () => (S.all ? 'All hotels' : curProp().name);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function flash(msg, isErr) {
  const el = h('div', { class: isErr ? 'err' : '' }, msg);
  document.getElementById('flash').append(el);
  setTimeout(() => el.remove(), isErr ? 7000 : 3500);
}

async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token && path !== '/login') { S.token = null; store.set('erp.token', null); boot(); }
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// fields: [{name, label, type: text|number|money|date|checkbox|password|email, options: [[v,l]], value, required, step, placeholder}]
function form(fields, submitLabel, onSubmit, opts = {}) {
  const f = h('form', { class: 'form' });
  for (const fd of fields) {
    let input;
    if (fd.options) {
      input = h('select', { name: fd.name, required: fd.required }, fd.options.map(([v, l]) => h('option', { value: v, selected: fd.value != null && String(fd.value) === String(v) }, l)));
    } else if (fd.type === 'checkbox') {
      f.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: fd.name, checked: !!fd.value }), fd.label));
      continue;
    } else {
      const money = fd.type === 'money';
      input = h('input', {
        name: fd.name, type: money ? 'number' : fd.type || 'text', step: money ? '0.01' : fd.step, min: fd.min,
        value: fd.value == null ? '' : money ? fd.value / 100 : fd.value, required: fd.required, placeholder: fd.placeholder, autocomplete: fd.autocomplete,
      });
    }
    f.append(h('label', {}, fd.label, input));
  }
  f.append(h('div', {}, h('button', { type: 'submit' }, submitLabel)));
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const v = {};
    for (const fd of fields) {
      const el = f.elements[fd.name], raw = fd.type === 'checkbox' ? null : el.value.trim();
      v[fd.name] = fd.type === 'checkbox' ? (el.checked ? 1 : 0)
        : raw === '' ? undefined
        : fd.type === 'money' ? toPaise(raw)
        : fd.type === 'number' ? Number(raw) : raw;
    }
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSubmit(v, f);
      if (opts.reset) f.reset();
    } catch (er) { flash(er.message, true); } finally { btn.disabled = false; }
  });
  return f;
}

// cols: [label, key | fn(row), {num}]
function table(cols, rows, empty = 'Nothing here yet.', foot) {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map(([l, , o]) => h('th', { class: o?.num ? 'num' : '' }, l)))),
    h('tbody', {}, rows.map(r => h('tr', {}, cols.map(([, k, o]) => h('td', { class: o?.num ? 'num' : '' }, typeof k === 'function' ? k(r) : r[k] ?? ''))))),
    foot && h('tfoot', {}, h('tr', {}, foot.map(x => h('td', { class: 'num' }, x))))));
}

function modal(title, body) {
  const d = h('dialog', {}, h('div', { class: 'row' }, h('h2', { style: 'margin:0' }, title), h('span', { class: 'spacer' }),
    h('button', { class: 'ghost small', type: 'button', onclick: () => d.close() }, 'Close')), h('div', { style: 'margin-top:12px' }, body));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// Retries an action with a manager's credentials when the server says approval is needed.
async function withApproval(fn) {
  try { return await fn(undefined); } catch (e) {
    if (!/needs manager approval/.test(e.message)) throw e;
    const cred = await new Promise(resolve => {
      let done = false;
      const d = modal('Manager approval', [h('p', {}, e.message + '. A GM or duty manager can approve here.'),
        form([{ name: 'username', label: 'Manager username', required: true, autocomplete: 'off' },
          { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'off' }], 'Approve', v => { done = true; d.close(); resolve(v); })]);
      d.addEventListener('close', () => done || resolve(null));
    });
    if (!cred) throw new Error('Approval cancelled');
    return fn(cred);
  }
}
const act = fn => async () => { try { await fn(); } catch (e) { flash(e.message, true); } };
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };

// ---------- shell ----------
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  bell: '<path d="M3 18h18M5 18a7 7 0 0 1 14 0M12 8V6M10 6h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M16 4a4 4 0 0 1 0 8M22 21v-1a5 5 0 0 0-3-4.6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  utensils: '<path d="M3 2v7a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6a2 2 0 0 0 2 2h3zm0 0v7"/>',
  box: '<path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.6L22 7H6"/>',
  rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  menu: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  bars: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  bed: '<path d="M2 4v16M2 8h17a3 3 0 0 1 3 3v9M2 17h20M6 8v9"/>',
  trend: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  building: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M11 21v-3h2v3"/>',
};
const icon = n => { const s = h('span', { class: 'ic', 'aria-hidden': 'true' }); s.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`; return s; };
const svg = markup => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstChild; };
const ROLE = { admin: 'Owner · admin', central_revenue: 'Central revenue', central_purchasing: 'Central purchasing', accountant: 'Accountant', gm: 'General manager',
  duty_manager: 'Duty manager', front_desk: 'Front desk', hk_supervisor: 'Housekeeping supervisor', housekeeper: 'Housekeeper', maintenance: 'Maintenance',
  restaurant: 'Restaurant cashier', storekeeper: 'Storekeeper' };
const roleName = r => ROLE[r] || r.replace(/_/g, ' ');
const initials = name => name.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const short = p => { const r = (p || 0) / 100, a = Math.abs(r); return '₹' + (a >= 1e7 ? (r / 1e7).toFixed(2) + 'Cr' : a >= 1e5 ? (r / 1e5).toFixed(1) + 'L' : a >= 1e3 ? (r / 1e3).toFixed(1) + 'K' : r.toFixed(0)); };
const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

const setTheme = t => { document.documentElement.dataset.theme = t; store.set('erp.theme', t); };
setTheme(store.get('erp.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// [key, label, permission(s), icon]
const NAV = [
  ['Overview', [['dashboard', 'Dashboard', 'reports', 'dashboard']]],
  ['Front office', [['frontdesk', 'Front desk', 'res', 'bell'], ['reservations', 'Reservations', 'res', 'calendar'], ['guests', 'Guests', 'res', 'users']]],
  ['Operations', [['housekeeping', 'Housekeeping', ['hk', 'rack'], 'sparkle'], ['maintenance', 'Maintenance', ['mt', 'hk', 'rack'], 'wrench'], ['pos', 'Restaurant POS', 'pos', 'utensils']]],
  ['Back office', [['inventory', 'Inventory', ['inv', 'po'], 'box'], ['purchasing', 'Purchasing', ['po', 'inv', 'acc'], 'cart'], ['accounts', 'Accounts & GST', ['acc', 'books'], 'rupee']]],
  ['Admin', [['night-audit', 'Night audit', 'audit', 'moon'], ['setup', 'Setup', ['admin', 'rates', 'menu'], 'gear'], ['audit-log', 'Audit log', 'admin', 'shield']]],
];
const NAV_ITEMS = NAV.flatMap(([, items]) => items);
const SUB = { res: ['Reservation', 'reservations'], booking: ['New booking', 'reservations'], guest: ['Guest profile', 'guests'], order: ['Order', 'pos'], invoice: ['Tax invoice', 'accounts'] };
const SUB_PERM = { res: 'res', booking: 'res', guest: 'res', order: 'pos', invoice: ['res', 'pos', 'acc', 'books'] };
const TAB_LABEL = { 'Restaurant POS': 'POS', 'Accounts & GST': 'Accounts', Reservations: 'Bookings', Housekeeping: 'Rooms', 'Night audit': 'Audit', Maintenance: 'Repairs' };
const brand = () => h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('building')), h('span', {}, 'Grand Residency', h('small', {}, 'Hotel ERP')));

document.addEventListener('click', () => document.querySelectorAll('.menu-wrap.open, .search.open').forEach(x => x.classList.remove('open')));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && document.getElementById('q')) { e.preventDefault(); document.getElementById('q').focus(); }
});

function searchBox() {
  const items = NAV_ITEMS.filter(i => can(i[2]));
  const res = h('div', { class: 'results', role: 'listbox' });
  const input = h('input', { type: 'search', id: 'q', placeholder: 'Search modules', 'aria-label': 'Search modules', autocomplete: 'off' });
  const wrap = h('div', { class: 'search', onclick: e => e.stopPropagation() }, icon('search'), input, h('kbd', {}, 'Ctrl K'), res);
  const close = () => { wrap.classList.remove('open'); input.value = ''; input.blur(); };
  const show = () => {
    const m = items.filter(i => i[1].toLowerCase().includes(input.value.trim().toLowerCase()));
    res.replaceChildren(...m.map((i, n) => h('a', { href: '#/' + i[0], class: n ? '' : 'hi', onclick: close }, icon(i[3]), i[1])));
    wrap.classList.toggle('open', m.length > 0);
  };
  input.addEventListener('focus', show);
  input.addEventListener('input', show);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const a = res.querySelector('a'); if (a) { location.hash = a.getAttribute('href'); close(); } }
    if (e.key === 'Escape') close();
  });
  return wrap;
}

async function boot() {
  const app = document.getElementById('app');
  if (!S.token) return app.replaceChildren(loginView());
  try { S.me = await api('GET', '/me'); } catch { return app.replaceChildren(loginView()); }
  if (!S.me.properties.some(p => p.id === S.pid)) S.pid = S.me.properties[0]?.id;
  if (S.me.user.property_id) S.all = false;
  else if (store.get('erp.pid') == null) S.all = true;
  const u = S.me.user, role = roleName(u.role);
  const nav = h('nav', {}, NAV.map(([group, items]) => {
    const ok = items.filter(i => can(i[2]));
    return ok.length ? [h('div', { class: 'group' }, group), ok.map(([k, l, , ic]) => h('a', { href: '#/' + k, 'data-k': k, title: l }, icon(ic), h('span', {}, l)))] : null;
  }));
  const hotel = u.property_id ? h('span', { class: 'hotel' }, curProp().name)
    : h('select', { class: 'hotel', 'aria-label': 'Hotel', style: 'width:auto;padding:5px 9px', onchange: e => { const v = e.target.value; S.all = v === 'all'; if (!S.all) S.pid = Number(v); store.set('erp.pid', v); render(); } },
      h('option', { value: 'all', selected: S.all }, 'All hotels'), S.me.properties.map(p => h('option', { value: p.id, selected: !S.all && p.id === S.pid }, p.name)));
  const tabbar = () => h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    NAV_ITEMS.filter(i => can(i[2])).slice(0, 4).map(([k, l, , ic]) => h('a', { href: '#/' + k, 'data-k': k }, icon(ic), h('span', {}, TAB_LABEL[l] || l))),
    h('button', { type: 'button', onclick: () => document.querySelector('.shell').classList.add('nav-open') }, icon('bars'), h('span', {}, 'Menu')));
  const signOut = async () => { await api('POST', '/logout').catch(() => {}); S.token = null; store.set('erp.token', null); location.hash = ''; boot(); };
  const menu = h('div', { class: 'menu-wrap' },
    h('button', { class: 'iconbtn', 'aria-label': 'Account menu', onclick: e => { e.stopPropagation(); menu.classList.toggle('open'); } }, h('span', { class: 'avatar' }, initials(u.name))),
    h('div', { class: 'dropdown', onclick: e => e.stopPropagation() },
      h('div', { class: 'who' }, h('strong', {}, u.name), h('div', { class: 'muted', style: 'text-transform:capitalize' }, role)),
      h('button', { onclick: () => window.open('/book', '_blank') }, icon('globe'), 'Booking website'),
      h('button', { onclick: act(signOut) }, icon('logout'), 'Sign out')));
  app.replaceChildren(h('div', { class: `shell ${store.get('erp.collapsed') ? 'collapsed' : ''}` },
    h('aside', { class: 'side' }, brand(), nav,
      h('div', { class: 'drawer-extra' }, h('div', { class: 'group' }, 'More'),
        h('a', { href: '/book', target: '_blank' }, icon('globe'), h('span', {}, 'Booking website')),
        h('a', { href: '#', onclick: e => { e.preventDefault(); setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); } }, icon('contrast'), h('span', {}, 'Light / dark mode')),
        h('a', { href: '#', onclick: e => { e.preventDefault(); act(signOut)(); } }, icon('logout'), h('span', {}, 'Sign out'))),
      h('div', { class: 'foot' }, h('span', { class: 'avatar' }, initials(u.name)), h('div', { class: 'who' }, h('strong', {}, u.name), h('span', { class: 'muted', style: 'text-transform:capitalize' }, role)))),
    h('div', { class: 'scrim', onclick: () => document.querySelector('.shell').classList.remove('nav-open') }),
    tabbar(),
    h('div', {},
      h('header', { class: 'top' },
        h('button', { class: 'iconbtn', id: 'collapse', 'aria-label': 'Menu', onclick: () => {
          const shell = document.querySelector('.shell');
          if (matchMedia('(max-width: 760px)').matches) return shell.classList.toggle('nav-open'); // phone: slide-in drawer
          store.set('erp.collapsed', shell.classList.toggle('collapsed') ? '1' : null);
        } }, h('span', { class: 'only-desktop' }, icon('menu')), h('span', { class: 'only-mobile' }, icon('bars'))),
        h('div', { class: 'crumb' }, hotel, h('span', { class: 'sep' }, '/'), h('strong', { id: 'crumb' })),
        h('span', { class: 'pill-date', id: 'bd' }), h('span', { class: 'spacer' }), searchBox(),
        h('button', { class: 'iconbtn', 'aria-label': 'Switch light or dark mode', title: 'Light / dark', onclick: () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark') }, icon('contrast')),
        menu),
      h('main', { id: 'main' }))));
  render();
}

function loginView() {
  return h('div', { class: 'login-page' },
    h('section', { class: 'login-hero' },
      h('div', { class: 'bars', 'aria-hidden': 'true' }, [110, 180, 140, 230].map(x => h('i', { style: `height:${x}px` }))),
      brand(),
      h('div', {}, h('h1', {}, 'Run every hotel in the group from one screen.'),
        h('p', {}, 'Bookings, rooms, restaurant, stores, purchasing and GST books — always up to date.'),
        h('div', { class: 'feat' }, h('div', {}, icon('dashboard'), 'Live dashboard of occupancy, ADR and revenue'),
          h('div', {}, icon('bell'), 'Front desk, housekeeping and restaurant in sync'), h('div', {}, icon('rupee'), 'GST invoices and double-entry books, automatically')))),
    h('section', { class: 'login-box' },
      h('div', { class: 'login' }, h('h1', {}, 'Welcome back'), h('p', { class: 'muted', style: 'margin:0' }, 'Sign in to continue to Grand Residency ERP.'),
        form([{ name: 'username', label: 'Username', required: true, autocomplete: 'username' },
          { name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' }], [icon('login'), 'Sign in'], signIn)),
      quickLogins()));
}
async function signIn(v) {
  const r = await api('POST', '/login', { username: v.username, password: v.password });
  S.token = r.token;
  store.set('erp.token', r.token);
  location.hash = '';
  boot();
}
// One-click sign-in for every account still on its initial password (server hides it when HIDE_QUICK_LOGIN is set).
function quickLogins() {
  const box = h('div', { class: 'quick' });
  api('GET', '/public/quick-logins').then(list => {
    if (!list.length) return box.remove();
    const groups = [...new Set(list.map(u => u.property_code || ''))];
    box.replaceChildren(
      h('div', { class: 'quick-head' }, h('h3', { style: 'margin:0' }, 'Quick sign-in by role'), h('span', { class: 'muted' }, 'Click a person to open the ERP as them')),
      ...groups.flatMap(g => [
        h('div', { class: 'quick-group' }, g ? list.find(u => u.property_code === g).property_name : 'Group team · all hotels'),
        h('div', { class: 'quick-grid' }, list.filter(u => (u.property_code || '') === g).map(u => h('button', { class: 'qcard', type: 'button', title: `Sign in as ${u.name}`, onclick: act(() => signIn(u)) },
          h('span', { class: 'avatar' }, initials(u.name)),
          h('span', { class: 'who' }, h('strong', {}, u.name), h('span', { class: 'role' }, roleName(u.role)), h('span', { class: 'cred' }, `${u.username} · ${u.password}`)),
          h('span', { class: 'go' }, icon('arrow'))))),
      ]));
  }).catch(() => box.remove());
  return box;
}

async function refreshMe() { S.me = await api('GET', '/me'); }

async function render() {
  const main = document.getElementById('main');
  if (!main) return;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  const allowed = NAV_ITEMS.filter(n => can(n[2]));
  const ok = name && VIEWS[name] && (allowed.some(n => n[0] === name) || (SUB_PERM[name] && can(SUB_PERM[name])));
  const view = ok ? name : allowed[0]?.[0]; // anything the role can't use falls back to its home screen
  const navKey = SUB[view]?.[1] || view;
  document.querySelector('.shell')?.classList.remove('nav-open');
  document.querySelectorAll('.side nav a, .tabbar a').forEach(a => a.classList.toggle('active', a.dataset.k === navKey));
  document.getElementById('crumb').textContent = NAV_ITEMS.find(n => n[0] === view)?.[1] || SUB[view]?.[0] || '';
  const p = curProp();
  document.getElementById('bd').textContent = S.all ? `${S.me.properties.length} hotels` : p ? `Business date · ${dayLabel(p.business_date)}` : '';
  if (S.all && ONE_HOTEL.has(view)) return main.replaceChildren(pickHotel(NAV_ITEMS.find(n => n[0] === view)?.[1] || SUB[view]?.[0] || ''));
  if (!view) return main.replaceChildren(h('p', {}, 'Your role has no screens.'));
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try { main.replaceChildren(await VIEWS[view](arg && decodeURIComponent(arg))); } catch (e) { main.replaceChildren(h('p', { class: 'error' }, e.message)); }
}
window.addEventListener('hashchange', render);
const ONE_HOTEL = new Set(['frontdesk', 'booking', 'housekeeping', 'pos', 'inventory', 'night-audit']);
function useHotel(id) {
  S.all = false; S.pid = id; store.set('erp.pid', id);
  const sel = document.querySelector('select.hotel'); if (sel) sel.value = id;
  render();
}
const pickHotel = label => h('div', {}, pageHead(label, 'This screen works one hotel at a time — choose a hotel'),
  h('div', { class: 'stats-strip' }, S.me.properties.map(p => h('a', { class: 'stat', href: location.hash, onclick: e => { e.preventDefault(); useHotel(p.id); } },
    h('span', { class: 'chip indigo' }, icon('building')), h('div', {}, h('small', {}, p.code), h('b', {}, p.name), h('span', { class: 'muted' }, `Business date ${dayLabel(p.business_date)}`))))));

// ---------- dashboard ----------
const SERIES = [['Rooms', 'room_revenue', 'var(--c1)'], ['F&B', 'fnb_revenue', 'var(--c2)']];
const MODES = [['card', 'Card'], ['upi', 'UPI'], ['cash', 'Cash'], ['online', 'Online']]; // fixed order = fixed colour per mode

function sparkline(values, color) {
  const max = Math.max(...values), min = Math.min(...values), n = values.length;
  const pts = values.map((v, i) => `${n > 1 ? (i / (n - 1)) * 100 : 50},${27 - ((v - min) / (max - min || 1)) * 24}`).join(' ');
  return svg(`<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`);
}

function barChart(daily) {
  const W = 640, H = 240, L = 52, R = 6, T = 10, B = 26;
  const top = Math.max(1, ...daily.flatMap(d => SERIES.map(s => d[s[1]])));
  const step = 10 ** Math.floor(Math.log10(top / 4)), max = Math.ceil(top / 4 / step) * step * 4;
  const y = v => T + (H - T - B) * (1 - v / max);
  const n = daily.length, slot = (W - L - R) / n, bw = Math.max(2, Math.min(16, slot / 2 - 4));
  const bar = (x, v, c) => {
    if (v <= 0) return '';
    const yy = y(v), r = Math.min(4, bw / 2, H - B - yy);
    return `<path d="M${x},${H - B}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${H - B}Z" fill="${c}"/>`;
  };
  let s = '';
  for (let i = 0; i <= 4; i++) s += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(max * i / 4)}" y2="${y(max * i / 4)}"/><text class="axis" x="${L - 8}" y="${y(max * i / 4) + 4}" text-anchor="end">${short(max * i / 4)}</text>`;
  daily.forEach((d, i) => {
    const mid = L + slot * i + slot / 2;
    s += bar(mid - bw - 1, d.room_revenue, SERIES[0][2]) + bar(mid + 1, d.fnb_revenue, SERIES[1][2]);
    if (n <= 10 || i % Math.ceil(n / 8) === 0) s += `<text class="axis" x="${mid}" y="${H - 7}" text-anchor="middle">${dayLabel(d.date)}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}"/>`;
  });
  const tip = h('div', { class: 'tip' });
  const wrap = h('div', { class: 'chart', style: 'position:relative' }, svg(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Room and F&B revenue by day">${s}</svg>`), tip);
  wrap.addEventListener('mousemove', e => {
    const t = e.target.closest('.hit');
    if (!t) return (tip.style.display = 'none');
    const d = daily[t.dataset.i], r = wrap.getBoundingClientRect();
    tip.replaceChildren(h('b', {}, dayLabel(d.date)), ...SERIES.map(([l, k, c]) => h('div', {}, h('span', { style: `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px;background:${c}` }), `${l} ${rs(d[k])}`)),
      h('div', {}, `${d.room_nights} room nights · ${pct(d.occupancy)}`));
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 4) + 'px';
    tip.style.top = Math.max(0, e.clientY - r.top - tip.offsetHeight - 8) + 'px';
  });
  wrap.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  return wrap;
}

function donut(rows) {
  const data = MODES.map(([m, label], i) => ({ label, v: rows.find(r => r.mode === m)?.amount || 0, c: `var(--c${i + 1})` }));
  const total = data.reduce((s, d) => s + d.v, 0), shown = data.filter(d => d.v > 0);
  const r = 52, C = 2 * Math.PI * r, gap = shown.length > 1 ? 2 : 0;
  let off = 0, segs = '';
  for (const d of shown) {
    const len = (d.v / total) * C;
    segs += `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${d.c}" stroke-width="16" stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${d.label}: ${rs(d.v)}</title></circle>`;
    off += len;
  }
  return h('div', {},
    h('div', { class: 'donut-wrap' }, svg(`<svg viewBox="0 0 140 140" width="170" height="170" role="img" aria-label="Payments by mode"><circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--line-2)" stroke-width="16"/>${segs}</svg>`),
      h('div', { class: 'center' }, h('small', {}, 'Collected'), h('b', {}, short(total)))),
    h('div', { class: 'donut-legend' }, (shown.length ? shown : data).map(d => h('div', {}, h('i', { style: `background:${d.c}` }), h('span', {}, d.label), h('span', { class: 'muted' }, total ? pct(d.v / total) : '0%'), h('span', {}, short(d.v))))));
}

async function dashboard() {
  const days = S.dash.days || 7;
  const to = addDays(curProp().business_date, -1); // last closed day
  const d = await api('GET', `/reports/dashboard?from=${addDays(to, -(days - 1))}&to=${to}&${pq()}`);
  const g = d.group, daily = d.daily;
  const now = new Date(), hr = now.getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  const scope = d.properties.length > 1 ? 'the Grand Residency group' : d.properties[0].name;
  const link = (perm, href) => (can(perm) ? href : null);
  const actions = [['res', '#/booking', 'plus', 'New booking'], ['res', '#/frontdesk', 'bell', 'Front desk'], ['pos', '#/pos', 'utensils', 'Restaurant order'],
    ['hk', '#/housekeeping', 'sparkle', 'Housekeeping'], ['audit', '#/night-audit', 'moon', 'Night audit'], [['acc', 'reports'], '#/accounts', 'rupee', 'Accounts']]
    .filter(a => can(a[0])).slice(0, 5);
  const step = (label, ic, color, value, sub, href) => h('a', { class: 'step', href },
    h('div', { class: 'lbl' }, h('span', { class: `chip ${color}` }, icon(ic)), label), h('b', {}, value), h('small', {}, sub));
  const kpi = (label, ic, color, value, sub, series, stroke) => h('div', { class: 'kpi' },
    h('div', { class: 'top-row' }, h('span', {}, label), h('span', { class: `chip ${color}` }, icon(ic))), h('b', {}, value), h('small', {}, sub), sparkline(series, stroke));
  const occTonight = g.rooms ? g.in_house / g.rooms : 0;

  return h('div', {},
    h('section', { class: 'hero' },
      h('div', { style: 'position:relative;z-index:1' },
        h('span', { class: 'live' }, h('i'), `Live · ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · ${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`),
        h('h1', {}, `${greet}, ${S.me.user.name.split(' ')[0]} — here's ${scope} today`),
        h('p', {}, `${g.arrivals} arrival${g.arrivals === 1 ? '' : 's'}, ${g.departures} departure${g.departures === 1 ? '' : 's'} and ${g.dirty} room${g.dirty === 1 ? '' : 's'} to clean.`),
        h('div', { class: 'actions' }, actions.map(([, href, ic, l]) => h('a', { href }, icon(ic), l)))),
      h('div', { class: 'stats' },
        h('div', {}, h('small', {}, 'In house'), h('b', {}, g.in_house)), h('div', {}, h('small', {}, 'Occupancy tonight'), h('b', {}, pct(occTonight))),
        h('div', {}, h('small', {}, `Revenue · ${days} days`), h('b', {}, short(g.room_revenue + g.fnb_revenue + g.other_revenue))))),

    h('div', { class: 'section-title' }, 'From booking to check-out', h('span', { class: 'dot' })),
    h('div', { class: 'flow' },
      step('Arrivals today', 'calendar', 'indigo', g.arrivals, 'to check in', link('res', '#/frontdesk')),
      step('In house', 'bed', 'teal', g.in_house, `${pct(occTonight)} occupied`, link('res', '#/frontdesk')),
      step('Departures due', 'logout', 'amber', g.departures, 'to check out', link('res', '#/frontdesk')),
      step('Rooms to clean', 'sparkle', 'pink', g.dirty, 'dirty right now', link(['hk', 'res', 'mt'], '#/housekeeping')),
      step('Open tickets', 'wrench', 'red', g.open_tickets, `${g.out_of_order} room(s) blocked`, link(['mt', 'hk', 'res'], '#/maintenance')),
      step('POs to approve', 'cart', 'violet', g.pending_pos, 'awaiting approval', link(['po', 'inv', 'acc'], '#/purchasing'))),

    h('div', { class: 'row', style: 'margin:22px 0 10px' }, h('div', { class: 'section-title', style: 'margin:0' }, `Performance · last ${days} days`), h('span', { class: 'spacer' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period' }, [7, 14, 30].map(n => h('button', { class: n === days ? 'on' : '', onclick: () => { S.dash.days = n; render(); } }, `${n} days`)))),
    h('div', { class: 'kpis' },
      kpi('Occupancy', 'bed', 'indigo', pct(g.occupancy), `${g.room_nights} room nights sold`, daily.map(x => x.occupancy), 'var(--c1)'),
      kpi('ADR', 'trend', 'teal', rs(g.adr), 'average daily rate', daily.map(x => (x.room_nights ? x.room_revenue / x.room_nights : 0)), 'var(--c2)'),
      kpi('RevPAR', 'trend', 'violet', rs(g.revpar), 'revenue per available room', daily.map(x => x.room_revenue), 'var(--c1)'),
      kpi('Room revenue', 'rupee', 'indigo', short(g.room_revenue), 'before GST', daily.map(x => x.room_revenue), 'var(--c1)'),
      kpi('F&B revenue', 'utensils', 'amber', short(g.fnb_revenue), 'restaurant & room service', daily.map(x => x.fnb_revenue), 'var(--c2)'),
      kpi('Collected', 'wallet', 'green', short(g.collected), 'cash, card & UPI', daily.map(x => x.collected), 'var(--c2)')),

    h('div', { class: 'charts' },
      h('div', { class: 'chart-card' },
        h('div', { class: 'head' }, h('h3', {}, 'Revenue by day'), h('span', { class: 'spacer' }),
          h('div', { class: 'legend' }, SERIES.map(([l, , c]) => h('span', {}, h('i', { style: `background:${c}` }), l)))),
        barChart(daily),
        h('details', { style: 'margin-top:8px' }, h('summary', {}, 'View as table'),
          table([['Date', x => dayLabel(x.date)], ['Room nights', 'room_nights', { num: 1 }], ['Occupancy', x => pct(x.occupancy), { num: 1 }], ['Rooms', x => rs(x.room_revenue), { num: 1 }],
            ['F&B', x => rs(x.fnb_revenue), { num: 1 }], ['Collected', x => rs(x.collected), { num: 1 }]], daily))),
      h('div', { class: 'chart-card' }, h('div', { class: 'head' }, h('h3', {}, 'Payments received'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${days} days`)),
        donut(d.payments_by_mode))),

    h('div', { class: 'section-title' }, 'By hotel'),
    table([['Hotel', r => h('strong', {}, r.name)], ['Rooms', 'rooms', { num: 1 }], ['Room nights', 'room_nights', { num: 1 }],
      ['Occupancy', r => pct(r.occupancy), { num: 1 }], ['ADR', r => rs(r.adr), { num: 1 }], ['RevPAR', r => rs(r.revpar), { num: 1 }],
      ['Room rev', r => short(r.room_revenue), { num: 1 }], ['F&B rev', r => short(r.fnb_revenue), { num: 1 }], ['Collected', r => short(r.collected), { num: 1 }],
      ['In house', 'in_house', { num: 1 }], ['Dirty', 'dirty', { num: 1 }], ['Tickets', 'open_tickets', { num: 1 }]], d.properties),
    h('p', { class: 'muted', style: 'margin-top:10px' }, `${dayLabel(d.from)} – ${dayLabel(d.to)} (closed days). Revenue before GST; room nights are posted by the night audit.`));
}

// ---------- shared page pieces ----------
const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub && h('p', {}, sub)), h('span', { class: 'spacer' }), ...actions);
// items: [label, value, sub, icon, chip colour, href?, active?]
const statStrip = items => h('div', { class: 'stats-strip' }, items.filter(Boolean).map(([label, value, sub, ic, color, href, on]) =>
  h(href ? 'a' : 'div', { class: `stat${on ? ' on' : ''}`, href }, h('span', { class: `chip ${color}` }, icon(ic)),
    h('div', {}, h('small', {}, label), h('b', {}, value), sub && h('span', { class: 'muted' }, sub)))));
// A card with a header bar; tables sit flush, everything else is padded.
const panel = (title, right, ...body) => h('section', { class: 'panel' },
  h('div', { class: 'panel-head' }, h('h3', {}, title), h('span', { class: 'spacer' }), right),
  body.flat(Infinity).filter(Boolean).map(b => (b.classList?.contains('table-wrap') ? b : h('div', { class: 'pad' }, b))));
const pills = (items, active, onPick) => h('div', { class: 'pills' }, items.map(([k, label, n]) =>
  h('button', { class: k === active ? 'on' : '', onclick: () => onPick(k) }, label, n != null && h('span', { class: 'n' }, n))));
const person = (name, sub, href) => h('div', { class: 'person' }, h('span', { class: 'avatar sm' }, initials(name || '?')),
  h('div', {}, href ? h('a', { href }, name) : h('strong', {}, name), sub && h('small', {}, sub)));
const stayText = r => `${dayLabel(r.arrival)} → ${dayLabel(r.departure)} · ${nights(r.arrival, r.departure)}n`;
const qs = () => new URLSearchParams(location.hash.split('?')[1] || '');
const setQs = (base, params) => { location.hash = `${base}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''))}`; };
function searchInput(value, placeholder, onSearch) {
  const i = h('input', { type: 'search', value, placeholder, 'aria-label': placeholder });
  i.addEventListener('keydown', e => { if (e.key === 'Enter') onSearch(i.value.trim()); });
  return h('div', { class: 'search inline' }, icon('search'), i);
}
const money = (p, cls) => h('span', { class: cls }, rs(p));
const balanceCell = r => money(r.balance, r.balance > 0 ? 'due' : r.balance < 0 ? 'gain' : 'muted');
const STATUS = { booked: 'Booked', checked_in: 'In house', checked_out: 'Checked out', cancelled: 'Cancelled', no_show: 'No-show' };
const tableLabel = t => (!t ? '' : /^\d+$/.test(t) ? `Table ${t}` : t);

// ---------- front desk ----------
const resLink = r => h('a', { href: '#/res/' + r.id }, r.code);
const roomLegend = () => h('div', { class: 'legend' }, [['var(--ok)', 'Vacant'], ['var(--accent)', 'Occupied'], ['var(--bad)', 'Out of order'], ['var(--warn)', 'Dirty']]
  .map(([c, l]) => h('span', {}, h('i', { style: `background:${c}` }), l)));
async function frontdesk() {
  const p = curProp(), bd = p.business_date;
  const [arr, inh, rooms] = await Promise.all([api('GET', `/reservations?${pq()}&status=booked&arrival=${bd}`),
    api('GET', `/reservations?${pq()}&status=checked_in`), api('GET', `/housekeeping?${pq()}`)]);
  const deps = inh.filter(r => r.departure <= bd);
  const tab = qs().get('t') || 'arrivals';
  const lists = { arrivals: [arr, 'No arrivals left today.', 'Check in'], inhouse: [inh, 'Nobody in house.', 'Open'], departures: [deps, 'No departures due.', 'Check out'] };
  const [rows, empty, cta] = lists[tab] || lists.arrivals;
  const count = f => rooms.filter(f).length;
  return h('div', {},
    pageHead('Front desk', `${p.name} · business date ${dayLabel(bd)}`, h('a', { class: 'btn', href: '#/booking' }, icon('plus'), 'New booking')),
    statStrip([['Arrivals today', arr.length, 'to check in', 'calendar', 'indigo', '#/frontdesk?t=arrivals', tab === 'arrivals'],
      ['In house', inh.length, `${pct(rooms.length ? inh.length / rooms.length : 0)} occupied`, 'bed', 'teal', '#/frontdesk?t=inhouse', tab === 'inhouse'],
      ['Departures due', deps.length, 'to check out', 'logout', 'amber', '#/frontdesk?t=departures', tab === 'departures'],
      ['Ready rooms', count(r => r.status === 'available' && r.hk_status !== 'dirty'), 'clean & vacant', 'sparkle', 'green'],
      ['Dirty', count(r => r.hk_status === 'dirty'), 'need cleaning', 'sparkle', 'pink', can('hk') ? '#/housekeeping?f=dirty' : null],
      ['Out of order', count(r => r.status === 'out_of_order'), 'blocked', 'wrench', 'red']]),
    panel('Guest movements', pills([['arrivals', 'Arrivals', arr.length], ['inhouse', 'In house', inh.length], ['departures', 'Departures', deps.length]], tab, k => setQs('#/frontdesk', { t: k })),
      table([['Booking', resLink], ['Guest', r => person(r.guest_name, r.guest_phone)], ['Room', r => (r.room_number ? h('strong', {}, r.room_number) : h('span', { class: 'muted' }, '—'))],
        ['Type', 'room_type'], ['Stay', stayText], ['Source', r => h('span', { class: 'tag' }, r.source.replace('_', ' '))], ['Balance', balanceCell, { num: 1 }],
        ['', r => h('a', { class: 'btn small ghost', href: '#/res/' + r.id }, cta, icon('arrow'))]], rows, empty)),
    panel('Room rack', roomLegend(), roomGrid(rooms, false)));
}

function roomGrid(rooms, actions) {
  return h('div', { class: 'rooms' }, rooms.map(r => h('div', { class: `room ${r.status} ${r.hk_status === 'dirty' ? 'is-dirty' : ''}` },
    h('div', { class: 'row' }, h('span', { class: 'n' }, r.number), h('span', { class: 'spacer' }), badge(r.hk_status)),
    h('div', { class: 'muted small' }, r.room_type, ' · ', r.status.replace(/_/g, ' ')),
    r.guest_name && h('div', { class: 'guest' }, icon('users'), r.reservation_id && can('res') ? h('a', { href: '#/res/' + r.reservation_id }, r.guest_name) : r.guest_name,
      r.departing ? h('span', { class: 'tag warn' }, 'Departing') : null),
    r.open_tickets ? h('div', { class: 'error small' }, icon('wrench'), `${r.open_tickets} open ticket(s)`) : null,
    actions && h('div', { class: 'row' },
      r.hk_status !== 'dirty' && h('button', { class: 'small ghost', onclick: act(() => setHk(r, 'dirty')) }, 'Dirty'),
      r.hk_status === 'dirty' && h('button', { class: 'small', onclick: act(() => setHk(r, 'clean')) }, 'Cleaned'),
      can('hk_inspect') && r.hk_status === 'clean' && h('button', { class: 'small', onclick: act(() => setHk(r, 'inspected')) }, 'Inspected'),
      h('button', { class: 'small ghost', onclick: () => ticketDialog(r) }, 'Report issue')))));
}
async function setHk(r, s) { await api('POST', `/rooms/${r.id}/hk`, { hk_status: s }); flash(`Room ${r.number}: ${s}`); render(); }

async function reservations() {
  const q = qs(), text = q.get('q') || '', st = q.get('status') || '';
  const all = await api('GET', `/reservations?${pq()}&q=${encodeURIComponent(text)}`);
  const list = st ? all.filter(r => r.status === st) : all;
  return h('div', {},
    pageHead('Reservations', `${scopeName()} · latest ${all.length} bookings`, h('a', { class: 'btn', href: '#/booking' }, icon('plus'), 'New booking')),
    h('div', { class: 'toolbar' }, searchInput(text, 'Search guest, phone or booking no.', v => setQs('#/reservations', { q: v, status: st })),
      pills([['', 'All', all.length], ...Object.entries(STATUS).map(([s, l]) => [s, l, all.filter(r => r.status === s).length])], st, k => setQs('#/reservations', { q: text, status: k }))),
    panel(`${list.length} reservation${list.length === 1 ? '' : 's'}`, null,
      table([['Booking', resLink], ...(S.all ? [['Hotel', r => h('span', { class: 'tag' }, r.property_code)]] : []), ['Guest', r => person(r.guest_name, r.guest_phone)], ['Room', r => r.room_number || h('span', { class: 'muted' }, '—')], ['Type', 'room_type'],
        ['Stay', stayText], ['Source', r => h('span', { class: 'tag' }, r.source.replace('_', ' '))], ['Status', r => badge(r.status)], ['Balance', balanceCell, { num: 1 }]], list, 'No reservations found.')));
}

async function booking() {
  const p = curProp();
  const results = h('div');
  const steps = n => h('div', { class: 'stepper' }, ['Dates', 'Room & rate', 'Guest details'].map((l, i) => h('div', { class: i < n ? 'done' : i === n ? 'on' : '' }, h('span', {}, i < n ? '✓' : i + 1), l)));
  const stepBox = h('div', {}, steps(0));
  const search = async v => {
    const av = await api('GET', `/availability?${pq()}&arrival=${v.arrival}&departure=${v.departure}`);
    const n = nights(v.arrival, v.departure);
    stepBox.replaceChildren(steps(1));
    results.replaceChildren(h('div', { class: 'section-title' }, `${n} night${n === 1 ? '' : 's'} · ${dayLabel(v.arrival)} → ${dayLabel(v.departure)}`),
      h('div', { class: 'type-grid' }, av.map(t => h('div', { class: 'type-card' },
        h('div', { class: 'row' }, h('h3', { style: 'margin:0' }, t.room_type), h('span', { class: 'spacer' }), t.available > 0 ? h('span', { class: 'tag ok' }, `${t.available} free`) : badge('sold_out')),
        h('small', { class: 'muted' }, `Up to ${t.max_occupancy} adults`),
        t.plans.map(pl => h('div', { class: 'plan' },
          h('div', {}, h('strong', {}, pl.name), h('small', { class: 'muted', style: 'display:block' }, `${rs(Math.round(pl.total / n))} / night + GST`)), h('span', { class: 'spacer' }),
          h('div', { class: 'num' }, h('b', {}, rs(pl.total + pl.tax)), h('small', { class: 'muted', style: 'display:block' }, 'incl. GST')),
          t.available > 0 && h('button', { class: 'small', onclick: () => guestStep(v, t, pl) }, 'Select')))))));
  };
  const guestStep = (v, t, pl, found = null) => {
    stepBox.replaceChildren(steps(2));
    const n = nights(v.arrival, v.departure);
    const lookup = searchInput(found?.phone || '', 'Returning guest? Search phone or name', async val => {
      if (!val) return;
      const [g] = await api('GET', `/guests?q=${encodeURIComponent(val)}`);
      if (g) { flash(`Returning guest: ${g.name}`); guestStep(v, t, pl, g); } else flash('No guest found — enter the details below', true);
    });
    const summary = panel('Stay summary', null, h('div', { class: 'totals' },
      ...[['Hotel', p.name], ['Dates', `${dayLabel(v.arrival)} → ${dayLabel(v.departure)}`], ['Nights', n], ['Room', t.room_type], ['Rate plan', pl.name]]
        .map(([k, val]) => h('div', {}, h('span', { class: 'muted' }, k), h('span', {}, val))),
      ...pl.nightly.map((x, i) => h('div', { class: 'small' }, h('span', { class: 'muted' }, dayLabel(addDays(v.arrival, i))), h('span', {}, rs(x)))),
      h('div', {}, h('span', { class: 'muted' }, 'GST'), h('span', {}, rs(pl.tax))),
      h('div', { class: 'grand' }, h('span', {}, 'Total'), h('span', {}, rs(pl.total + pl.tax)))));
    results.replaceChildren(h('div', { class: 'split' }, panel('Guest details', found ? h('span', { class: 'tag ok' }, icon('users'), 'Returning guest') : null,
      h('div', { class: 'toolbar', style: 'margin:0' }, lookup),
      found ? h('div', { class: 'note', style: 'margin:0' }, icon('users'), `Booking goes on ${found.name}'s existing profile, shared across all hotels.`)
        : h('p', { class: 'muted', style: 'margin:0' }, 'A new phone number creates a new guest profile; a known one joins the existing profile.'),
      form([{ name: 'name', label: 'Guest name', required: true, value: found?.name }, { name: 'phone', label: 'Phone', required: true, type: 'tel', value: found?.phone },
        { name: 'email', label: 'Email', type: 'email', value: found?.email }, { name: 'nationality', label: 'Nationality', value: found?.nationality || 'Indian' },
        { name: 'adults', label: 'Adults', type: 'number', value: v.adults || 1, min: 1 },
        { name: 'source', label: 'Source', options: [['walk_in', 'Walk-in'], ['phone', 'Phone'], ['ota', 'OTA (typed in)'], ['central', 'Central reservations']] },
        { name: 'ota_ref', label: 'OTA reference' }, { name: 'notes', label: 'Notes' },
        { name: 'advance', label: 'Advance received (₹)', type: 'money' }, { name: 'mode', label: 'Advance mode', options: [['cash', 'Cash'], ['card', 'Card'], ['upi', 'UPI']] }],
      [icon('plus'), 'Create booking'], async g => {
        const r = await api('POST', '/reservations', {
          property_id: p.id, rate_plan_id: pl.rate_plan_id, arrival: v.arrival, departure: v.departure, adults: g.adults, source: g.source,
          ota_ref: g.ota_ref, notes: g.notes, guest_id: found?.id, guest: { name: g.name, phone: g.phone, email: g.email, nationality: g.nationality },
          advance: g.advance ? { amount: g.advance, mode: g.mode } : undefined,
        });
        flash(`Booked ${r.code}`);
        go('#/res/' + r.id);
      })), summary));
  };
  return h('div', {}, pageHead('New booking', p.name, h('a', { class: 'btn ghost', href: '#/reservations' }, 'All reservations')), stepBox,
    panel('Stay dates', null, form([{ name: 'arrival', label: 'Arrival', type: 'date', value: p.business_date, required: true },
      { name: 'departure', label: 'Departure', type: 'date', value: addDays(p.business_date, 1), required: true },
      { name: 'adults', label: 'Adults', type: 'number', value: 2, min: 1 }], [icon('search'), 'Check availability'], search)), results);
}

async function res(id) {
  const r = await api('GET', '/reservations/' + id);
  const open = ['booked', 'checked_in'].includes(r.status);
  const reload = () => go('#/res/' + id);
  const discount = l => {
    const d = modal('Discount', form([{ name: 'amount', label: `Discount amount (₹, max ${rs(l.amount)})`, type: 'money', required: true },
      { name: 'reason', label: 'Reason', required: true }], 'Apply discount', async v => {
      await withApproval(o => api('POST', `/reservations/${id}/discount`, { line_id: l.id, ...v, override: o }));
      d.close(); flash('Discount applied'); reload();
    }));
  };
  const voidLine = l => {
    const d = modal('Void charge', [h('p', {}, l.description, ' · ', rs(l.amount + l.cgst + l.sgst)),
      form([{ name: 'reason', label: 'Reason', required: true }], 'Void', async v => {
        await withApproval(o => api('POST', `/folio-lines/${l.id}/void`, { ...v, override: o }));
        d.close(); flash('Charge voided'); reload();
      })]);
  };
  const lineCols = [['Date', l => dayLabel(l.business_date)], ['Description', l => [l.description, l.voided ? [' ', badge('void')] : null]], ['Type', l => h('span', { class: 'tag' }, l.category)],
    ['Amount', l => rs(l.amount), { num: 1 }], ['GST', l => `${l.tax_rate}%`, { num: 1 }], ['Tax', l => rs(l.cgst + l.sgst), { num: 1 }],
    ['Total', l => h('strong', {}, rs(l.amount + l.cgst + l.sgst)), { num: 1 }],
    ['', l => open && !l.voided && l.amount > 0 && !l.discount_of ? h('div', { class: 'row' },
      h('button', { class: 'small ghost', onclick: () => discount(l) }, 'Discount'), h('button', { class: 'small ghost', onclick: () => voidLine(l) }, 'Void')) : null]];
  const charges = r.lines.reduce((s, l) => s + l.amount + l.cgst + l.sgst, 0), paid = r.payments.reduce((s, x) => s + x.amount, 0);

  const actions = [];
  if (r.status === 'booked') {
    const rooms = (await api('GET', `/housekeeping?property_id=${r.property_id}`)).filter(x => x.room_type === r.room_type && x.status === 'available' && x.hk_status !== 'dirty');
    actions.push(panel('Check in', h('span', { class: 'muted' }, `${rooms.length} ready ${r.room_type}`),
      r.arrival > r.business_date ? h('p', { class: 'muted', style: 'margin:0' }, `Arrival is ${dayLabel(r.arrival)}; check-in opens on that business date.`) :
        form([{ name: 'room_id', label: 'Room', required: true, options: [['', 'Choose…'], ...rooms.map(x => [x.id, `${x.number} (${x.hk_status})`])] },
          { name: 'id_type', label: 'ID type', options: [['Aadhaar', 'Aadhaar'], ['Passport', 'Passport'], ['Driving licence', 'Driving licence'], ['Voter ID', 'Voter ID']], value: r.guest.id_type },
          { name: 'id_number', label: 'ID number', required: true, value: r.guest.id_number }, { name: 'nationality', label: 'Nationality', value: r.guest.nationality },
          { name: 'form_c_no', label: 'Form C no. (foreign nationals)' }], [icon('login'), 'Check in'], async v => {
          await api('POST', `/reservations/${id}/check-in`, v); flash('Checked in'); reload();
        }),
      h('button', { class: 'danger small', onclick: act(async () => {
        if (!confirm('Cancel this booking?')) return;
        await api('POST', `/reservations/${id}/cancel`, { reason: 'Cancelled at desk' }); flash('Cancelled'); reload();
      }) }, 'Cancel booking')));
  }
  if (r.status === 'checked_in') {
    actions.push(panel('Check out', null,
      r.balance !== 0 ? h('div', { class: 'note', style: 'margin:0' }, `Settle the balance of ${rs(r.balance)} first.`) : null,
      form([{ name: 'bill_to', label: 'Bill to (name / company)', value: r.guest.name }, { name: 'bill_to_gstin', label: 'Company GSTIN (B2B invoice)', value: r.guest.gstin }],
        [icon('logout'), 'Check out & invoice'], async v => {
          const out = await api('POST', `/reservations/${id}/check-out`, v); flash('Checked out'); go('#/invoice/' + out.invoice_id);
        })));
    actions.push(panel('Post a charge', null,
      form([{ name: 'category', label: 'Type', options: [['extra', 'Extra (laundry, transfer…)'], ['fnb', 'Food & beverage'], ['room', 'Room']] },
        { name: 'description', label: 'Description', required: true }, { name: 'amount', label: 'Amount before GST (₹)', type: 'money', required: true },
        { name: 'tax_rate', label: 'GST % (extras only)', type: 'number', value: 18 }], 'Post charge', async v => {
        await api('POST', `/reservations/${id}/charges`, v); flash('Charge posted'); reload();
      })));
  }
  if (open) {
    actions.push(panel('Take payment', null,
      form([{ name: 'amount', label: 'Amount (₹)', type: 'money', value: r.balance > 0 ? r.balance : null, required: true },
        { name: 'mode', label: 'Mode', options: [['cash', 'Cash'], ['card', 'Card'], ['upi', 'UPI']] }, { name: 'reference', label: 'Reference' }], [icon('wallet'), 'Record payment'], async v => {
        await api('POST', `/reservations/${id}/payments`, v); flash('Payment recorded'); reload();
      })));
  }
  if (r.balance < 0 && r.status !== 'checked_out') {
    actions.push(panel('Refund credit', h('span', { class: 'tag warn' }, 'Manager approval'),
      form([{ name: 'amount', label: 'Refund amount (₹)', type: 'money', value: -r.balance, required: true },
        { name: 'mode', label: 'Mode', options: [['cash', 'Cash'], ['card', 'Card'], ['upi', 'UPI'], ['online', 'Online']] }, { name: 'reference', label: 'Reference' }], 'Refund', async v => {
        await withApproval(o => api('POST', `/reservations/${id}/payments`, { ...v, amount: -v.amount, override: o })); flash('Refund recorded'); reload();
      })));
  }

  return h('div', {},
    pageHead([`Booking ${r.code} `, badge(r.status)], `${r.property_code} · ${r.source.replace('_', ' ')}${r.ota_ref ? ' · ' + r.ota_ref : ''} · booked ${String(r.created_at).slice(0, 10)}`,
      r.invoice && h('a', { class: 'btn', href: '#/invoice/' + r.invoice.id }, icon('rupee'), `Invoice ${r.invoice.number}`), h('a', { class: 'btn ghost', href: '#/reservations' }, 'All reservations')),
    h('div', { class: 'info-grid' },
      h('div', { class: 'card info' }, h('small', {}, 'Guest'), person(r.guest.name, `${r.guest.phone || ''} · ${r.guest.nationality}`, '#/guest/' + r.guest.id),
        r.guest.id_type && h('span', { class: 'muted small' }, `${r.guest.id_type} ${r.guest.id_number || ''}`)),
      h('div', { class: 'card info' }, h('small', {}, 'Stay'), h('b', {}, `${dayLabel(r.arrival)} → ${dayLabel(r.departure)}`),
        h('span', { class: 'muted small' }, `${nights(r.arrival, r.departure)} nights · ${r.adults} adult(s)`)),
      h('div', { class: 'card info' }, h('small', {}, 'Room'), h('b', {}, r.room_number ? `Room ${r.room_number}` : 'Not assigned'),
        h('span', { class: 'muted small' }, `${r.room_type} · ${[...new Set(r.rates)].map(rs).join(' / ')} per night`)),
      h('div', { class: 'card info' }, h('small', {}, 'Balance'), h('b', { class: `balance ${r.balance > 0 ? 'due' : ''}` }, rs(r.balance)),
        h('span', { class: 'muted small' }, r.balance > 0 ? 'due from guest' : r.balance < 0 ? 'guest in credit' : 'settled'))),
    r.notes && h('div', { class: 'note' }, icon('bell'), r.notes),
    h('div', { class: 'split' },
      h('div', {},
        panel('Folio', h('span', { class: 'muted' }, `Charges ${rs(charges)}`), table(lineCols, r.lines, 'No charges yet. Room nights are posted by the night audit.')),
        panel('Payments', h('span', { class: 'muted' }, `Received ${rs(paid)}`),
          table([['Date', x => dayLabel(x.business_date)], ['Mode', x => h('span', { class: 'tag' }, x.mode)], ['Reference', 'reference'], ['Amount', x => money(x.amount, x.amount < 0 ? 'due' : ''), { num: 1 }]], r.payments, 'No payments yet.'))),
      h('div', {}, actions.length ? actions : panel('Status', null, h('p', { class: 'muted', style: 'margin:0' }, `This booking is ${STATUS[r.status].toLowerCase()}.`)))));
}

async function invoice(id) {
  const inv = await api('GET', '/invoices/' + id), p = inv.property;
  return h('div', {},
    h('div', { class: 'noprint' }, pageHead('Tax invoice', `${inv.number} · ${p.name}`, h('button', { onclick: () => print() }, 'Print'),
      inv.reservation && h('a', { class: 'btn ghost', href: '#/res/' + inv.reservation_id }, 'Back to booking'))),
    h('div', { class: 'invoice' },
      h('div', { class: 'row' }, h('div', {}, h('h1', { style: 'margin:0' }, p.name), h('div', {}, p.address), h('div', {}, `GSTIN ${p.gstin || '-'} · ${p.state || ''} · ${p.phone || ''}`)),
        h('span', { class: 'spacer' }), h('div', { style: 'text-align:right' }, h('strong', {}, 'TAX INVOICE'), h('div', {}, inv.number), h('div', {}, `Date ${inv.business_date}`))),
      h('hr'),
      h('div', {}, h('strong', {}, 'Bill to: '), inv.bill_to, inv.bill_to_gstin ? ` · GSTIN ${inv.bill_to_gstin}` : ''),
      inv.reservation && h('div', {}, `Booking ${inv.reservation.code} · Room ${inv.reservation.room_number || '-'} · ${inv.reservation.arrival} to ${inv.reservation.departure}`),
      h('p', {}, `Place of supply: ${p.state || '-'} · SAC 9963 (accommodation / food services)`),
      table([['Date', 'business_date'], ['Description', 'description'], ['Taxable', l => rs(l.amount), { num: 1 }], ['GST %', 'tax_rate', { num: 1 }],
        ['CGST', l => rs(l.cgst), { num: 1 }], ['SGST', l => rs(l.sgst), { num: 1 }], ['Total', l => rs(l.amount + l.cgst + l.sgst), { num: 1 }]], inv.lines, '',
      ['', 'Totals', rs(inv.taxable), '', rs(inv.cgst), rs(inv.sgst), rs(inv.total)]),
      h('p', { style: 'text-align:right' }, h('strong', {}, `Paid ${rs(inv.paid)} · Balance ${rs(inv.total - inv.paid)}`)),
      h('p', { class: 'muted' }, 'This is a computer generated invoice.')));
}

async function guests() {
  const text = qs().get('q') || '';
  const list = await api('GET', `/guests?q=${encodeURIComponent(text)}`);
  return h('div', {}, pageHead('Guests', 'One shared profile per guest across all hotels in the group'),
    h('div', { class: 'toolbar' }, searchInput(text, 'Search name, phone or email', v => setQs('#/guests', { q: v }))),
    panel(`${list.length} guest${list.length === 1 ? '' : 's'}`, list.length >= 500 ? h('span', { class: 'muted' }, 'showing first 500') : null,
      table([['Guest', g => person(g.name, g.email, '#/guest/' + g.id)], ['Phone', 'phone'], ['Nationality', g => h('span', { class: 'tag' }, g.nationality)],
        ['Company GSTIN', g => g.gstin || h('span', { class: 'muted' }, '—')], ['', g => h('a', { class: 'btn small ghost', href: '#/guest/' + g.id }, 'Profile', icon('arrow'))]], list, 'No guests found.')));
}
async function guest(id) {
  const { guest: g, stays } = await api('GET', `/guests/${id}/history`);
  const done = stays.filter(s => ['checked_in', 'checked_out'].includes(s.status));
  return h('div', {},
    h('div', { class: 'card profile-head' }, h('span', { class: 'avatar lg' }, initials(g.name)),
      h('div', {}, h('h1', {}, g.name), h('p', { class: 'muted', style: 'margin:0' }, [g.phone, g.email, g.nationality].filter(Boolean).join(' · '))),
      h('span', { class: 'spacer' }), h('a', { class: 'btn ghost', href: '#/guests' }, 'All guests')),
    statStrip([['Stays', done.length, `${stays.length} bookings in total`, 'calendar', 'indigo'],
      ['Nights', done.reduce((s, r) => s + nights(r.arrival, r.departure), 0), 'stayed with us', 'bed', 'teal'],
      ['Hotels', new Set(done.map(s => s.property_code)).size, 'in the group', 'building', 'violet'],
      ['Last booking', stays[0] ? dayLabel(stays[0].arrival) : '—', stays[0]?.property_code || '', 'trend', 'amber']]),
    h('div', { class: 'split' },
      panel('Stay history', null, table([['Booking', r => h('a', { href: '#/res/' + r.id }, r.code)], ['Hotel', r => h('span', { class: 'tag' }, r.property_code)], ['Stay', stayText],
        ['Type', 'room_type'], ['Status', r => badge(r.status)]], stays, 'No stays yet.')),
      panel('Profile', null, form([{ name: 'name', label: 'Name', value: g.name, required: true }, { name: 'phone', label: 'Phone', value: g.phone, required: true },
        { name: 'email', label: 'Email', value: g.email }, { name: 'nationality', label: 'Nationality', value: g.nationality }, { name: 'address', label: 'Address', value: g.address },
        { name: 'gstin', label: 'GSTIN (company billing)', value: g.gstin }], 'Save guest', async v => { await api('PUT', '/guests/' + id, v); flash('Saved'); }))));
}

// ---------- housekeeping & maintenance ----------
async function housekeeping() {
  const f = qs().get('f') || '';
  const rooms = await api('GET', `/housekeeping?${pq()}`);
  const match = (r, s) => r.hk_status === s || r.status === s;
  const shown = f ? rooms.filter(r => match(r, f)) : rooms;
  const stat = (k, label, sub, ic, color) => [label, rooms.filter(r => match(r, k)).length, sub, ic, color, k === f ? '#/housekeeping' : `#/housekeeping?f=${k}`, k === f];
  const floors = [...new Set(shown.map(r => r.floor || '—'))];
  return h('div', {},
    pageHead('Housekeeping', `${curProp().name} · ${rooms.length} rooms${f ? ` · showing ${f.replace('_', ' ')}` : ''}`, f && h('a', { class: 'btn ghost', href: '#/housekeeping' }, 'Show all rooms')),
    statStrip([stat('dirty', 'Dirty', 'to clean', 'sparkle', 'pink'), stat('clean', 'Clean', 'awaiting inspection', 'sparkle', 'teal'),
      stat('inspected', 'Inspected', 'ready to sell', 'shield', 'green'), stat('occupied', 'Occupied', 'guest in room', 'bed', 'indigo'),
      stat('out_of_order', 'Out of order', 'blocked for repair', 'wrench', 'red')]),
    shown.length ? floors.map(fl => panel(`Floor ${fl}`, h('span', { class: 'muted' }, `${shown.filter(r => (r.floor || '—') === fl).length} rooms`),
      roomGrid(shown.filter(r => (r.floor || '—') === fl), can('hk') || can('mt')))) : panel('Rooms', null, h('p', { class: 'muted', style: 'margin:0' }, 'No rooms match this filter.')));
}

function ticketDialog(room, rooms = []) {
  const d = modal(`Report an issue${room ? ' · Room ' + room.number : ''}`, form([
    ...(room ? [] : [{ name: 'room_id', label: 'Room', options: [['', 'Public area / none'], ...rooms.map(r => [r.id, r.number])] }]),
    { name: 'title', label: 'What is wrong?', required: true }, { name: 'priority', label: 'Priority', options: [['normal', 'Normal'], ['high', 'High'], ['low', 'Low']] },
    { name: 'blocks_room', label: 'Room cannot be sold until fixed', type: 'checkbox' }], [icon('plus'), 'Create ticket'], async v => {
    await api('POST', '/tickets', { ...v, room_id: room ? room.id : v.room_id, property_id: curProp().id }); d.close(); flash('Ticket created'); render();
  }));
}

async function maintenance() {
  const st = qs().get('s') || 'open';
  const [list, rooms] = await Promise.all([api('GET', `/tickets?${pq()}`), S.all ? [] : api('GET', `/housekeeping?${pq()}`)]);
  const open = list.filter(t => t.status === 'open');
  const shown = st === 'all' ? list : list.filter(t => t.status === st);
  return h('div', {},
    pageHead('Maintenance', `${scopeName()} · repair tickets`, !S.all && h('button', { onclick: () => ticketDialog(null, rooms) }, icon('plus'), 'New ticket')),
    statStrip([['Open tickets', open.length, 'waiting for repair', 'wrench', 'amber'], ['High priority', open.filter(t => t.priority === 'high').length, 'fix these first', 'wrench', 'red'],
      ['Rooms blocked', open.filter(t => t.blocks_room).length, 'cannot be sold', 'bed', 'pink'], ['Resolved', list.length - open.length, 'all time', 'shield', 'green']]),
    panel('Tickets', pills([['open', 'Open', open.length], ['resolved', 'Resolved', list.length - open.length], ['all', 'All', list.length]], st, k => setQs('#/maintenance', { s: k })),
      table([['Issue', t => h('div', {}, h('strong', {}, t.title), h('small', { class: 'muted', style: 'display:block' }, `#${t.id} · reported by ${t.created_by_name || '—'} · ${String(t.created_at).slice(0, 16)}`))],
        ...(S.all ? [['Hotel', t => h('span', { class: 'tag' }, S.me.properties.find(p => p.id === t.property_id)?.code)]] : []),
        ['Room', t => (t.room_number ? h('strong', {}, t.room_number) : h('span', { class: 'muted' }, 'Public area'))], ['Priority', t => badge(t.priority)],
        ['Blocks room', t => (t.blocks_room ? h('span', { class: 'tag bad' }, 'Blocked') : h('span', { class: 'muted' }, '—'))], ['Status', t => badge(t.status)],
        ['Resolution', t => t.resolution || h('span', { class: 'muted' }, '—')],
        ['', t => t.status === 'open' && can('mt') ? h('button', { class: 'small', onclick: () => {
          const d = modal('Resolve ticket', form([{ name: 'resolution', label: 'What was done?', required: true }], 'Resolve', async v => {
            await api('POST', `/tickets/${t.id}/resolve`, v); d.close(); flash('Resolved'); render();
          }));
        } }, 'Resolve') : null]], shown, 'No tickets here.')));
}

// ---------- restaurant POS ----------
const minutesAgo = ts => Math.max(0, Math.round((Date.now() - Date.parse(String(ts).replace(' ', 'T') + 'Z')) / 60000));
const ago = ts => { const m = minutesAgo(ts); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`; };
async function openOrder(table) {
  const o = await api('POST', '/pos/orders', { table_no: table, property_id: curProp().id });
  go('#/order/' + o.id);
}
async function pos() {
  const p = curProp();
  const orders = await api('GET', `/pos/orders?${pq()}`);
  const open = orders.filter(o => o.status === 'open');
  const today = orders.filter(o => o.business_date === p.business_date && o.status.startsWith('settled'));
  const byTable = Object.fromEntries(open.filter(o => /^\d+$/.test(o.table_no || '')).map(o => [o.table_no, o]));
  const others = open.filter(o => !/^\d+$/.test(o.table_no || ''));
  const items = o => o.lines.reduce((s, l) => s + l.qty, 0);
  const tile = n => {
    const o = byTable[n];
    return o ? h('a', { class: 'table-tile busy', href: '#/order/' + o.id }, h('span', { class: 'tn' }, n), h('b', {}, rs(o.total)), h('small', {}, `${items(o)} items · ${ago(o.created_at)}`))
      : h('button', { class: 'table-tile', onclick: act(() => openOrder(String(n))) }, h('span', { class: 'tn' }, n), h('small', {}, 'Free'));
  };
  const named = label => h('button', { class: 'table-tile special', onclick: act(() => openOrder(label)) }, icon(label === 'Room service' ? 'bed' : 'utensils'), h('b', {}, label), h('small', {}, 'New order'));
  return h('div', {},
    pageHead('Restaurant POS', `${p.name} · F&B GST ${p.fnb_gst_rate}%`),
    statStrip([['Open tables', open.length, `${others.length} room service / takeaway`, 'utensils', 'amber'], ['Bills today', today.length, 'settled', 'rupee', 'indigo'],
      ['Sales today', short(today.reduce((s, o) => s + o.total, 0)), 'before GST', 'trend', 'green'],
      ['To rooms today', today.filter(o => o.status === 'settled_room').length, 'posted to folios', 'bed', 'teal']]),
    panel('Floor', h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--line)' }), 'Free'), h('span', {}, h('i', { style: 'background:var(--warn)' }), 'Occupied')),
      h('div', { class: 'tables' }, Array.from({ length: Math.max(p.restaurant_tables || 18, ...Object.keys(byTable).map(Number)) }, (_, i) => tile(String(i + 1))), named('Room service'), named('Takeaway'))),
    others.length > 0 && panel('Room service & takeaway', h('span', { class: 'muted' }, `${others.length} open`), h('div', { class: 'order-grid' }, others.map(o => h('a', { class: 'order-card', href: '#/order/' + o.id },
      h('div', { class: 'row' }, h('span', { class: 'chip amber' }, icon(o.table_no === 'Room service' ? 'bed' : 'utensils')), h('strong', {}, tableLabel(o.table_no) || `Order #${o.id}`),
        h('span', { class: 'spacer' }), h('span', { class: 'muted' }, ago(o.created_at))),
      h('span', { class: 'muted' }, `${items(o)} items · #${o.id}`), h('b', {}, rs(o.total)))))),
    panel('Recent bills', null, table([['Order', o => h('a', { href: '#/order/' + o.id }, '#' + o.id)], ['Date', o => dayLabel(o.business_date)], ['Table', o => tableLabel(o.table_no)],
      ['Status', o => badge(o.status)], ['Room', o => (o.room_number ? `${o.room_number} · ${o.guest_name}` : h('span', { class: 'muted' }, '—'))], ['Total', o => rs(o.total), { num: 1 }],
      ['Invoice', o => (o.invoice ? h('a', { href: '#/invoice/' + o.invoice.id }, o.invoice.number) : '')]], orders.filter(o => o.status !== 'open').slice(0, 40), 'No bills yet.')));
}

async function order(id) {
  const o = await api('GET', '/pos/orders/' + id);
  const reload = () => go('#/order/' + id);
  const p = S.me.properties.find(x => x.id === o.property_id) || curProp();
  const gst = 2 * Math.round((o.total * p.fnb_gst_rate) / 200), grand = o.total + gst;
  const count = o.lines.reduce((s, l) => s + l.qty, 0);
  const editable = o.status === 'open';
  const setQty = (l, q) => act(async () => { await api('POST', `/pos/orders/${id}/lines/${l.id}/qty`, { qty: q }); reload(); });
  const bill = h('section', { class: 'panel', id: 'bill' },
    h('div', { class: 'panel-head' }, h('h3', {}, 'Bill'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `${count} item${count === 1 ? '' : 's'}`)),
    o.lines.length ? h('div', { class: 'bill-lines' }, o.lines.map(l => h('div', { class: 'bill-line' },
      h('div', { class: 'grow' }, h('strong', {}, l.name), h('small', { class: 'muted' }, `${rs(l.price)} each`)),
      editable ? h('div', { class: 'stepper-qty' }, h('button', { class: 'ghost', 'aria-label': `One less ${l.name}`, onclick: setQty(l, l.qty - 1) }, '−'),
        h('span', {}, l.qty), h('button', { class: 'ghost', 'aria-label': `One more ${l.name}`, onclick: setQty(l, l.qty + 1) }, '+')) : h('span', { class: 'muted' }, `× ${l.qty}`),
      h('b', { class: 'num' }, rs(l.qty * l.price)))))
      : h('div', { class: 'pad' }, h('p', { class: 'muted', style: 'margin:0' }, 'No items yet. Tap dishes on the menu to add them.')),
    h('div', { class: 'pad' }, h('div', { class: 'totals' }, h('div', {}, h('span', {}, 'Subtotal'), h('span', {}, rs(o.total))), h('div', {}, h('span', {}, `GST ${p.fnb_gst_rate}%`), h('span', {}, rs(gst))),
      h('div', { class: 'grand' }, h('span', {}, 'Total'), h('span', {}, rs(grand))))));
  const head = pageHead([`${tableLabel(o.table_no) || 'Order'} · #${o.id} `, badge(o.status)], `${p.name} · opened ${ago(o.created_at)} ago`,
    o.invoice && h('a', { class: 'btn', href: '#/invoice/' + o.invoice.id }, icon('rupee'), `Invoice ${o.invoice.number}`), h('a', { class: 'btn ghost', href: '#/pos' }, 'All tables'));
  if (!editable) {
    return h('div', {}, head, o.room_number && h('div', { class: 'note' }, icon('bed'), `Charged to room ${o.room_number} (${o.guest_name}).`), h('div', { style: 'max-width:640px' }, bill));
  }

  const [menu, inhouse] = await Promise.all([api('GET', `/menu_items?property_id=${p.id}`), api('GET', `/pos/inhouse?property_id=${p.id}`)]);
  const live = menu.filter(m => m.active), cats = [...new Set(live.map(m => m.category || 'Other'))];
  const inOrder = Object.fromEntries(o.lines.map(l => [l.menu_item_id, l.qty]));
  // search and category filter work in place, without reloading
  let cat = '', text = '';
  const tiles = live.map(m => {
    const el = h('button', { class: `dish${inOrder[m.id] ? ' in' : ''}`, 'data-cat': m.category || 'Other', 'data-name': m.name.toLowerCase(),
      onclick: act(async () => { await api('POST', `/pos/orders/${id}/lines`, { menu_item_id: m.id, qty: 1 }); reload(); }) },
    inOrder[m.id] ? h('span', { class: 'qty-badge' }, inOrder[m.id]) : null, h('span', { class: 'dname' }, m.name), h('small', {}, rs(m.price)));
    return el;
  });
  const filter = () => tiles.forEach(t => { t.hidden = (cat && t.dataset.cat !== cat) || (text && !t.dataset.name.includes(text)); });
  const catPills = h('div', { class: 'pills' }, [['', 'All'], ...cats.map(c => [c, c])].map(([k, l]) => h('button', { class: k ? '' : 'on', onclick: e => {
    cat = k; catPills.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); filter();
  } }, l)));
  const search = h('input', { type: 'search', placeholder: 'Search dishes', 'aria-label': 'Search dishes', oninput: e => { text = e.target.value.trim().toLowerCase(); filter(); } });

  let mode = 'upi';
  const modeSeg = h('div', { class: 'seg pay-modes', role: 'group', 'aria-label': 'Payment mode' }, [['upi', 'UPI'], ['card', 'Card'], ['cash', 'Cash']].map(([k, l]) =>
    h('button', { class: k === mode ? 'on' : '', onclick: e => { mode = k; modeSeg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); } }, l)));
  const ref = h('input', { placeholder: 'Reference (UTR / card slip)', 'aria-label': 'Payment reference' });
  const billTo = h('input', { placeholder: 'Bill to (company name)', 'aria-label': 'Bill to' }), gstin = h('input', { placeholder: 'Company GSTIN', 'aria-label': 'Company GSTIN' });
  const settle = act(async () => {
    if (!o.lines.length) throw new Error('Add at least one item first');
    const r = await api('POST', `/pos/orders/${id}/settle`, { to: 'direct', mode, reference: ref.value.trim() || undefined, bill_to: billTo.value.trim() || undefined, bill_to_gstin: gstin.value.trim() || undefined });
    flash('Bill settled'); go('#/invoice/' + r.invoice.id);
  });
  const room = h('select', { 'aria-label': 'In-house guest' }, h('option', { value: '' }, `Choose in-house guest (${inhouse.length})`), inhouse.map(r => h('option', { value: r.id }, `Room ${r.room_number} · ${r.guest_name}`)));

  return h('div', {}, head,
    h('div', { class: 'split pos-split' },
      h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h3', {}, 'Menu'), h('span', { class: 'spacer' }), h('div', { class: 'search inline', style: 'width:min(240px,100%)' }, icon('search'), search)),
        h('div', { class: 'pad' }, catPills), h('div', { class: 'pad' }, h('div', { class: 'dish-grid' }, tiles))),
      h('div', { class: 'sticky' }, bill,
        panel('Take payment', null, modeSeg, ref, h('details', {}, h('summary', {}, 'Company bill (GST invoice to a business)'), h('div', { class: 'form' }, billTo, gstin)),
          h('button', { class: 'big', onclick: settle, disabled: !o.lines.length }, icon('wallet'), `Collect ${rs(grand)}`)),
        panel('Charge to a room', null, room, h('button', { class: 'ghost', style: 'width:100%', disabled: !o.lines.length, onclick: act(async () => {
          if (!room.value) throw new Error('Choose an in-house guest');
          await api('POST', `/pos/orders/${id}/settle`, { to: 'room', reservation_id: room.value }); flash('Posted to room folio'); go('#/pos');
        }) }, icon('bed'), 'Post to room folio')),
        h('button', { class: 'ghost danger-text', style: 'width:100%', onclick: () => {
          const d = modal('Void order', form([{ name: 'reason', label: 'Reason', required: true }], 'Void order', async v => {
            await withApproval(ov => api('POST', `/pos/orders/${id}/void`, { ...v, override: ov })); d.close(); flash('Order voided'); go('#/pos');
          }));
        } }, 'Void order'))),
    h('a', { class: 'billbar', href: '#bill', onclick: e => { e.preventDefault(); document.getElementById('bill').scrollIntoView({ behavior: 'smooth' }); } },
      h('span', {}, `${count} item${count === 1 ? '' : 's'}`), h('b', {}, rs(grand)), h('span', {}, 'View bill ↓')));
}

// ---------- inventory & purchasing ----------
const CAT = { fnb: 'F&B', housekeeping: 'Housekeeping', maintenance: 'Maintenance' };
async function inventory() {
  const cat = qs().get('c') || '';
  const p = curProp();
  const [stock, moves] = await Promise.all([api('GET', `/stock?${pq()}`), api('GET', `/stock/moves?${pq()}`)]);
  const shown = cat ? stock.filter(i => i.category === cat) : stock;
  const addItem = () => {
    const d = modal('Add stock item', form([{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'unit', label: 'Unit', required: true, placeholder: 'kg, litre, pcs' },
      { name: 'category', label: 'Category', options: Object.entries(CAT) }, { name: 'tax_rate', label: 'GST %', type: 'number', value: 18 }], 'Add item', async v => {
      await api('POST', '/items', v); d.close(); flash('Item added'); render();
    }));
  };
  return h('div', {},
    pageHead('Inventory', `${p.name} · stores`, can(['po', 'inv']) && h('button', { class: 'ghost', onclick: addItem }, icon('plus'), 'Add item'),
      can(['po', 'inv', 'acc']) && h('a', { class: 'btn', href: '#/purchasing' }, icon('cart'), 'Purchase orders')),
    statStrip([['Stock value', short(stock.reduce((s, i) => s + i.value, 0)), 'at average cost', 'box', 'indigo'], ['Items', stock.length, 'shared catalogue', 'box', 'teal'],
      ['Out of stock', stock.filter(i => i.qty <= 0).length, 'need ordering', 'cart', 'red'],
      ['Issues today', moves.filter(m => m.kind === 'issue' && m.business_date === p.business_date).length, 'to departments', 'trend', 'amber']]),
    h('div', { class: 'split' },
      panel('Stock on hand', pills([['', 'All', stock.length], ...Object.entries(CAT).map(([k, l]) => [k, l, stock.filter(i => i.category === k).length])], cat, k => setQs('#/inventory', { c: k })),
        table([['Item', i => h('div', {}, h('strong', {}, i.name), h('small', { class: 'muted', style: 'display:block' }, i.code))], ['Category', i => h('span', { class: 'tag' }, CAT[i.category])],
          ['On hand', i => (i.qty <= 0 ? h('span', { class: 'tag bad' }, 'Out of stock') : `${+i.qty.toFixed(2)} ${i.unit}`), { num: 1 }],
          ['Avg cost', i => rs(i.avg_cost), { num: 1 }], ['Value', i => h('strong', {}, rs(i.value)), { num: 1 }]], shown)),
      h('div', {},
        can('inv') && panel('Issue stock', null, form([{ name: 'item_id', label: 'Item', required: true, options: [['', 'Choose…'], ...stock.filter(i => i.qty > 0).map(i => [i.id, `${i.name} (${+i.qty.toFixed(2)} ${i.unit})`])] },
          { name: 'qty', label: 'Quantity', type: 'number', step: 'any', required: true },
          { name: 'department', label: 'Department', options: [['Kitchen', 'Kitchen'], ['Housekeeping', 'Housekeeping'], ['Maintenance', 'Maintenance'], ['Front office', 'Front office']] }],
        [icon('box'), 'Issue'], async v => { const r = await api('POST', '/stock/issue', { ...v, property_id: p.id }); flash(`Issued, cost ${rs(r.cost)}`); render(); })),
        panel('Recent movements', null, table([['Item', m => h('div', {}, h('strong', {}, m.item_name), h('small', { class: 'muted', style: 'display:block' }, `${dayLabel(m.business_date)} · ${m.department || m.ref}`))],
          ['Qty', m => h('span', { class: m.qty < 0 ? 'due' : 'gain' }, `${m.qty > 0 ? '+' : ''}${+m.qty.toFixed(2)} ${m.unit}`), { num: 1 }]], moves.slice(0, 12), 'No movements yet.')))));
}

async function purchasing() {
  const st = qs().get('s') || '';
  const [pos, suppliers, items] = await Promise.all([api('GET', `/purchase-orders?${pq()}`), api('GET', '/suppliers'), api('GET', '/items')]);
  const count = s => pos.filter(x => x.status === s).length, total = s => short(pos.filter(x => x.status === s).reduce((a, x) => a + x.total, 0));
  const shown = st ? pos.filter(x => x.status === st) : pos;
  const p = curProp();
  const newPo = () => {
    const lineBox = h('div');
    const addLine = () => lineBox.append(h('div', { class: 'form', style: 'margin-bottom:8px' },
      h('label', {}, 'Item', h('select', { name: 'item_id' }, items.map(i => h('option', { value: i.id }, `${i.name} (${i.unit}, GST ${i.tax_rate}%)`)))),
      h('label', {}, 'Qty', h('input', { name: 'qty', type: 'number', step: 'any', min: '0' })),
      h('label', {}, 'Rate before GST (₹)', h('input', { name: 'rate', type: 'number', step: '0.01', min: '0' }))));
    addLine();
    const sup = h('select', {}, suppliers.map(s => h('option', { value: s.id }, s.name)));
    const d = modal('New purchase order', [h('p', { class: 'muted', style: 'margin-top:0' }, `Up to ${rs(p.po_auto_limit)} auto-approved · up to ${rs(p.po_gm_limit)} needs GM · above needs central purchasing.`),
      h('div', { class: 'form', style: 'margin-bottom:10px' }, h('label', {}, 'Supplier', sup)), lineBox,
      h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: addLine }, icon('plus'), 'Add line'), h('span', { class: 'spacer' }), h('button', { onclick: act(async () => {
        const lines = [...lineBox.children].map(row => ({ item_id: Number(row.querySelector('[name=item_id]').value), qty: Number(row.querySelector('[name=qty]').value),
          rate: toPaise(row.querySelector('[name=rate]').value || 0) })).filter(l => l.qty > 0);
        const po = await api('POST', '/purchase-orders', { property_id: p.id, supplier_id: Number(sup.value), lines });
        d.close(); flash(`${po.number} ${po.status}`); render();
      }) }, 'Create PO'))]);
  };
  const addSupplier = () => {
    const d = modal('Add supplier', form([{ name: 'name', label: 'Name', required: true }, { name: 'gstin', label: 'GSTIN' }, { name: 'phone', label: 'Phone' }], 'Add supplier', async v => {
      await api('POST', '/suppliers', v); d.close(); flash('Supplier added'); render();
    }));
  };
  const poAction = (po, a, label, body, cls = 'small') => h('button', { class: cls, onclick: act(async () => { await api('POST', `/purchase-orders/${po.id}/${a}`, body); flash(`PO ${po.number}: ${a}`); render(); }) }, label);
  const poRow = po => h('div', { class: `list-row${po.status === 'requested' ? ' attn' : ''}` },
    h('div', { class: 'grow' },
      h('div', { class: 'row' }, h('span', { class: 'tag violet' }, 'Purchase order'), S.all && h('span', { class: 'tag' }, po.property_code), h('strong', {}, po.number), badge(po.status),
        po.status === 'requested' && h('span', { class: 'tag warn' }, icon('shield'), `Needs ${po.needs === 'central' ? 'central purchasing' : 'GM'} approval`)),
      h('div', { class: 'muted small' }, `${po.supplier_name} · ${String(po.created_at).slice(0, 10)} · ${po.lines.map(l => `${+l.qty} ${l.unit} ${l.item_name}`).join(', ')}`)),
    h('div', { class: 'amt' }, h('b', {}, rs(po.total)), h('small', { class: 'muted' }, `incl. GST ${rs(po.tax)}`)),
    h('div', { class: 'row' },
      po.status === 'requested' && can(po.needs === 'central' ? 'po_central' : ['po_gm', 'po_central']) && [poAction(po, 'approve', 'Approve'), poAction(po, 'reject', 'Reject', undefined, 'small ghost')],
      po.status === 'approved' && can(['inv', 'po']) && poAction(po, 'receive', 'Receive goods'),
      po.status === 'received' && can('acc') && [poAction(po, 'pay', 'Pay by bank', { mode: 'bank' }), poAction(po, 'pay', 'Cash', { mode: 'cash' }, 'small ghost')]));
  return h('div', {},
    pageHead('Purchasing', `${scopeName()} · purchase orders and approvals`, can('po') && h('button', { class: 'ghost', onclick: addSupplier }, icon('plus'), 'Supplier'),
      can('po') && !S.all && h('button', { onclick: newPo }, icon('plus'), 'New purchase order')),
    statStrip([['Awaiting approval', count('requested'), total('requested'), 'shield', 'amber', '#/purchasing?s=requested', st === 'requested'],
      ['To receive', count('approved'), total('approved'), 'box', 'indigo', '#/purchasing?s=approved', st === 'approved'],
      ['To pay', count('received'), total('received'), 'wallet', 'pink', '#/purchasing?s=received', st === 'received'],
      ['Paid', count('paid'), total('paid'), 'rupee', 'green', '#/purchasing?s=paid', st === 'paid']]),
    h('div', { class: 'toolbar' }, pills([['', 'All', pos.length], ['requested', 'Awaiting approval', count('requested')], ['approved', 'To receive', count('approved')],
      ['received', 'To pay', count('received')], ['paid', 'Paid', count('paid')], ['rejected', 'Rejected', count('rejected')]], st, k => setQs('#/purchasing', { s: k }))),
    shown.length ? h('div', { class: 'list' }, shown.map(poRow)) : h('p', { class: 'muted' }, 'No purchase orders here.'),
    panel('Suppliers', h('span', { class: 'muted' }, `${suppliers.length} shared by all hotels`),
      table([['Supplier', s => person(s.name, s.phone)], ['GSTIN', s => s.gstin || h('span', { class: 'muted' }, '—')]], suppliers)));
}

// ---------- accounts ----------
async function accounts(tab = 'pnl') {
  const q = qs();
  const scope = q.get('scope') || 'hotel';
  const bd = curProp().business_date;
  const from = q.get('from') || bd.slice(0, 8) + '01', to = q.get('to') || bd;
  const all = S.all;
  const pidq = all ? '' : pq();
  const nav = t => `#/accounts/${t}?${new URLSearchParams({ scope, from, to })}`;
  const newJournal = async () => {
    const accts = await api('GET', '/accounts');
    const lineBox = h('div');
    const addLine = () => lineBox.append(h('div', { class: 'form', style: 'margin-bottom:8px' },
      h('label', {}, 'Account', h('select', { name: 'acct' }, accts.map(a => h('option', { value: a.code }, `${a.code} ${a.name}`)))),
      h('label', {}, 'Debit (₹)', h('input', { name: 'dr', type: 'number', step: '0.01', min: '0' })), h('label', {}, 'Credit (₹)', h('input', { name: 'cr', type: 'number', step: '0.01', min: '0' }))));
    addLine(); addLine();
    const d = modal(`Manual journal · ${curProp().name}`, [h('p', { class: 'muted', style: 'margin-top:0' }, 'Salaries, utilities, owner drawings, corrections… Debits must equal credits.'),
      form([{ name: 'date', label: 'Date', type: 'date', value: bd, required: true }, { name: 'memo', label: 'Narration', required: true }], 'Post journal', async v => {
        const lines = [...lineBox.children].map(r => ({ account_code: r.querySelector('[name=acct]').value, debit: toPaise(r.querySelector('[name=dr]').value || 0), credit: toPaise(r.querySelector('[name=cr]').value || 0) }))
          .filter(l => l.debit || l.credit);
        await api('POST', '/journals', { property_id: curProp().id, ...v, lines }); d.close(); flash('Journal posted'); render();
      }), h('h3', { style: 'margin-top:14px' }, 'Lines'), lineBox, h('button', { class: 'ghost', onclick: addLine }, icon('plus'), 'Add line')]);
  };
  const head = [
    pageHead('Accounts & GST', `${all ? 'All hotels (consolidated)' : curProp().name} · ${dayLabel(from)} – ${dayLabel(to)}`,
      tab === 'journals' && can('acc') && !all && h('button', { onclick: act(newJournal) }, icon('plus'), 'New journal')),
    h('div', { class: 'tabs' }, [['pnl', 'Profit & loss'], ['bs', 'Balance sheet'], ['tb', 'Trial balance'], ['gst', 'GST'], ['journals', 'Journals'], ['invoices', 'Invoices']]
      .map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { location.hash = nav(k); } }, l))),
    h('div', { class: 'toolbar' }, form([{ name: 'from', label: 'From', type: 'date', value: from }, { name: 'to', label: 'To', type: 'date', value: to }], 'Apply',
    v => { location.hash = `#/accounts/${tab}?${new URLSearchParams({ scope: v.scope || 'hotel', from: v.from, to: v.to })}`; })),
  ];
  const amtRows = (rows, total, label) => table([['Code', r => h('span', { class: 'muted' }, r.code)], ['Account', 'name'], ['Amount', r => rs(r.amount), { num: 1 }]],
    rows.filter(r => r.amount), 'None.', ['', label, rs(total)]);
  let body;
  if (tab === 'pnl') {
    const d = await api('GET', `/reports/pnl?${pidq}&from=${from}&to=${to}`);
    body = [statStrip([['Income', short(d.total_income), 'before GST', 'trend', 'green'], ['Expenses', short(d.total_expense), 'all costs', 'wallet', 'pink'],
      ['Net profit', short(d.net_profit), `${d.total_income ? pct(d.net_profit / d.total_income) : '0%'} margin`, 'rupee', d.net_profit >= 0 ? 'indigo' : 'red']]),
    h('div', { class: 'split even' }, panel('Income', null, amtRows(d.income, d.total_income, 'Total income')), panel('Expenses', null, amtRows(d.expense, d.total_expense, 'Total expenses')))];
  } else if (tab === 'bs') {
    const d = await api('GET', `/reports/balance-sheet?${pidq}&to=${to}`);
    const ok = d.total_assets === d.total_liabilities_equity;
    body = [statStrip([['Assets', short(d.total_assets), `as at ${dayLabel(to)}`, 'box', 'indigo'], ['Liabilities & equity', short(d.total_liabilities_equity), 'incl. profit to date', 'building', 'violet'],
      ['Check', ok ? 'Balanced' : 'Not balanced', 'assets = liabilities + equity', 'shield', ok ? 'green' : 'red']]),
    h('div', { class: 'split even' }, panel('Assets', null, amtRows(d.assets, d.total_assets, 'Total assets')),
      panel('Liabilities & equity', null, amtRows([...d.liabilities, ...d.equity, { code: '', name: 'Retained earnings (profit to date)', amount: d.retained_earnings }], d.total_liabilities_equity, 'Total')))];
  } else if (tab === 'tb') {
    const d = await api('GET', `/reports/trial-balance?${pidq}&to=${to}`);
    body = [panel('Trial balance', h('span', { class: d.total_dr === d.total_cr ? 'tag ok' : 'tag bad' }, d.total_dr === d.total_cr ? 'Debits = credits' : 'Out of balance'),
      table([['Code', r => h('span', { class: 'muted' }, r.code)], ['Account', 'name'], ['Type', r => h('span', { class: 'tag' }, r.type)], ['Debit', r => (r.dr ? rs(r.dr) : ''), { num: 1 }], ['Credit', r => (r.cr ? rs(r.cr) : ''), { num: 1 }]],
        d.rows.filter(r => r.dr || r.cr), 'No postings.', ['', '', 'Totals', rs(d.total_dr), rs(d.total_cr)]))];
  } else if (tab === 'gst') {
    const d = await api('GET', `/reports/gst?${pidq}&from=${from}&to=${to}`);
    body = [statStrip([['Output GST', short(d.output_tax), 'CGST + SGST on sales', 'rupee', 'indigo'], ['Input GST', short(d.input_tax), 'on purchases received', 'cart', 'teal'],
      ['Net payable', short(d.output_tax - d.input_tax), 'before ITC eligibility check', 'wallet', 'amber'], ['B2B invoices', d.b2b.length, 'for GSTR-1', 'shield', 'violet']]),
    panel('Output tax by category and rate', null, table([['Category', r => h('span', { class: 'tag' }, r.category)], ['GST %', r => `${r.tax_rate}%`, { num: 1 }], ['Taxable', r => rs(r.taxable), { num: 1 }],
      ['CGST', r => rs(r.cgst), { num: 1 }], ['SGST', r => rs(r.sgst), { num: 1 }]], d.output, 'No sales in this period.')),
    panel('B2B invoices', h('span', { class: 'muted' }, 'accountant to confirm ITC eligibility'), table([['Invoice', 'number'], ['Date', r => dayLabel(r.business_date)], ['Customer', r => person(r.bill_to, r.bill_to_gstin)],
      ['Taxable', r => rs(r.taxable), { num: 1 }], ['CGST', r => rs(r.cgst), { num: 1 }], ['SGST', r => rs(r.sgst), { num: 1 }]], d.b2b, 'No B2B invoices.'))];
  } else if (tab === 'journals') {
    const js = await api('GET', `/journals?${pidq}&from=${from}&to=${to}`);
    body = [panel('Journal entries', h('span', { class: 'muted' }, `${js.length} shown · latest 300`),
      table([['#', j => h('span', { class: 'muted' }, j.id)], ['Date', j => dayLabel(j.date)], ['Narration', 'memo'], ['Source', j => h('span', { class: 'tag' }, j.source)],
        ['Lines', j => j.lines.map(l => h('div', { class: 'small' }, `${l.account_code} ${l.account_name}: `, h('strong', {}, l.debit ? 'Dr ' + rs(l.debit) : 'Cr ' + rs(l.credit))))]], js))];
  } else {
    const inv = await api('GET', `/invoices?${pidq}&from=${from}&to=${to}`);
    body = [panel('Tax invoices', h('span', { class: 'muted' }, `${inv.length} in period`), table([['Invoice', i => h('a', { href: '#/invoice/' + i.id }, i.number)], ['Date', i => dayLabel(i.business_date)],
      ['Bill to', i => person(i.bill_to, i.bill_to_gstin)], ['Taxable', i => rs(i.taxable), { num: 1 }], ['GST', i => rs(i.cgst + i.sgst), { num: 1 }], ['Total', i => h('strong', {}, rs(i.total)), { num: 1 }]],
    inv, 'No invoices in this period.'))];
  }
  return h('div', {}, head, body);
}

// ---------- night audit ----------
async function nightAudit() {
  const d = await api('GET', `/night-audit?${pq()}`);
  const p = curProp();
  const resCols = [['Booking', resLink], ['Guest', r => person(r.guest_name, r.guest_phone)], ['Stay', stayText]];
  const run = act(async () => {
    if (!confirm(`Close business date ${d.business_date}? This cannot be undone.`)) return;
    const r = await api('POST', '/night-audit', { property_id: p.id });
    await refreshMe(); flash(`Day closed. Posted ${r.summary.posted_room_nights} room nights, ${r.summary.no_shows} no-shows.`); boot();
  });
  const check = (ok, text) => h('div', { class: 'check' }, h('span', { class: `chip ${ok ? 'green' : 'amber'}` }, icon(ok ? 'shield' : 'bell')), text);
  return h('div', {},
    pageHead('Night audit', `${p.name} · closes one business day at a time`),
    h('section', { class: 'hero slim', style: 'margin-bottom:18px' },
      h('div', { style: 'position:relative;z-index:1' },
        h('span', { class: 'live' }, h('i'), `Business date · ${new Date(d.business_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`),
        h('h1', {}, `Close the day for ${p.name}`),
        h('p', {}, 'Posts tonight\'s room charges, marks unarrived bookings as no-shows, saves the day report and moves to the next business date.'),
        h('div', { class: 'actions' }, h('button', { class: 'solid', onclick: run }, icon('moon'), `Run night audit for ${dayLabel(d.business_date)}`))),
      h('div', { class: 'stats' }, h('div', {}, h('small', {}, 'Rooms to charge'), h('b', {}, d.in_house)), h('div', {}, h('small', {}, 'Will be no-shows'), h('b', {}, d.pending_arrivals.length)),
        h('div', {}, h('small', {}, 'Open POS orders'), h('b', {}, d.open_pos_orders)))),
    h('div', { class: 'section-title' }, 'Pre-audit checklist'),
    h('div', { class: 'checks' },
      check(!d.pending_arrivals.length, d.pending_arrivals.length ? `${d.pending_arrivals.length} arrival(s) not checked in → no-show` : 'All of today\'s arrivals are checked in'),
      check(!d.overdue_departures.length, d.overdue_departures.length ? `${d.overdue_departures.length} departure(s) not checked out` : 'All departures are checked out'),
      check(!d.open_pos_orders, d.open_pos_orders ? `${d.open_pos_orders} restaurant order(s) still open` : 'No open restaurant orders'),
      check(true, `${d.in_house} room night(s) will be charged`)),
    h('div', { class: 'split even' },
      panel('Will become no-shows', h('span', { class: 'muted' }, d.pending_arrivals.length), table(resCols, d.pending_arrivals, 'None.')),
      panel('Departures not checked out', h('span', { class: 'muted' }, d.overdue_departures.length), table(resCols, d.overdue_departures, 'None.'))),
    panel('Audit history', h('span', { class: 'muted' }, 'last 30 days'),
      table([['Date', a => h('strong', {}, dayLabel(a.business_date))], ['Room nights', a => a.summary.posted_room_nights, { num: 1 }], ['No-shows', a => a.summary.no_shows, { num: 1 }],
        ['Occupancy', a => pct(a.summary.occupancy), { num: 1 }], ['ADR', a => rs(a.summary.adr), { num: 1 }], ['Room rev', a => short(a.summary.room_revenue), { num: 1 }],
        ['F&B rev', a => short(a.summary.fnb_revenue), { num: 1 }], ['Collected', a => short(a.summary.collected), { num: 1 }],
        ['By mode', a => a.summary.payments_by_mode.map(m => h('span', { class: 'tag', style: 'margin-right:4px' }, `${m.mode} ${short(m.amount)}`))]], d.history, 'No audits yet.')));
}

// ---------- setup ----------
function crudSection(title, path, fields, cols, opts = {}) {
  const box = h('div', {}, panel(title, null, h('p', { class: 'muted', style: 'margin:0' }, 'Loading…')));
  const singular = opts.singular || title;
  const load = async () => {
    const rows = await api('GET', path + (opts.scoped ? `?property_id=${curProp().id}` : ''));
    const save = async (v, d, method, url) => {
      if (opts.beforeSave) opts.beforeSave(v);
      await api(method, url, method === 'POST' ? { ...v, ...(opts.scoped && { property_id: curProp().id }) } : v);
      d.close(); flash('Saved'); load(); if (opts.after) opts.after();
    };
    const edit = row => {
      const d = modal(`Edit ${singular.toLowerCase()}`, form(fields.map(f => ({ ...f, value: row[f.name], required: f.required && f.type !== 'password' })), 'Save', v => save(v, d, 'PUT', `${path}/${row.id}`)));
    };
    const add = () => { const d = modal(`Add ${singular.toLowerCase()}`, form(fields, [icon('plus'), 'Add'], v => save(v, d, 'POST', path))); };
    box.replaceChildren(panel(title, h('div', { class: 'row' }, h('span', { class: 'muted' }, `${rows.length} records`), h('button', { class: 'small', onclick: add }, icon('plus'), 'Add')),
      table([...cols, ['', r => h('button', { class: 'small ghost', onclick: () => edit(r) }, 'Edit')]], rows)));
  };
  load().catch(e => box.replaceChildren(h('p', { class: 'error' }, e.message)));
  return box;
}

async function setup() {
  const [types, plans] = await Promise.all([api('GET', '/room_types'), can('rates') || can('admin') ? api('GET', '/rate_plans') : []]);
  const typeOpts = types.map(t => [t.id, t.name]);
  const typeName = id => types.find(t => t.id === id)?.name;
  const yes = [[1, 'Yes'], [0, 'No']];
  const yn = v => h('span', { class: v ? 'tag ok' : 'tag' }, v ? 'Yes' : 'No');
  const sections = [];
  if (can('admin')) {
    sections.push(['hotels', 'Hotels', 'building', () => crudSection('Hotels', '/properties', [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
      { name: 'gstin', label: 'GSTIN' }, { name: 'state', label: 'State' }, { name: 'address', label: 'Address' }, { name: 'phone', label: 'Phone' },
      { name: 'business_date', label: 'Business date', type: 'date', required: true }, { name: 'fnb_gst_rate', label: 'F&B GST %', type: 'number', value: 5 },
      { name: 'discount_limit_pct', label: 'Desk discount limit %', type: 'number', value: 10 },
      { name: 'po_auto_limit', label: 'PO auto-approve up to (₹)', type: 'money', value: 2500000 }, { name: 'po_gm_limit', label: 'PO GM limit (₹)', type: 'money', value: 10000000 },
      { name: 'restaurant_tables', label: 'Restaurant tables', type: 'number', value: 18, min: 1 }],
    [['Hotel', r => person(r.name, r.code)], ['GSTIN', 'gstin'], ['Business date', r => dayLabel(r.business_date)], ['F&B GST', r => `${r.fnb_gst_rate}%`, { num: 1 }], ['Discount limit', r => `${r.discount_limit_pct}%`, { num: 1 }], ['Restaurant tables', 'restaurant_tables', { num: 1 }]],
    { after: refreshMe, singular: 'Hotel' })]);
    sections.push(['types', 'Room types', 'bed', () => crudSection('Room types', '/room_types', [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
      { name: 'max_occupancy', label: 'Max adults', type: 'number', value: 2 }], [['Code', r => h('span', { class: 'tag' }, r.code)], ['Name', 'name'], ['Max adults', 'max_occupancy', { num: 1 }]], { singular: 'Room type' })]);
    sections.push(['rooms', 'Rooms', 'box', () => crudSection(`Rooms · ${curProp().name}`, '/rooms', [{ name: 'number', label: 'Room no.', required: true }, { name: 'room_type_id', label: 'Type', options: typeOpts, required: true },
      { name: 'floor', label: 'Floor' }], [['Room', r => h('strong', {}, r.number)], ['Type', r => typeName(r.room_type_id)], ['Floor', 'floor'], ['Status', r => badge(r.status)]], { scoped: true, singular: 'Room' })]);
  }
  if (can('rates')) {
    sections.push(['rates', 'Rate plans', 'rupee', () => crudSection('Rate plans (group-wide)', '/rate_plans', [{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true },
      { name: 'room_type_id', label: 'Room type', options: typeOpts }, { name: 'base_price', label: 'Base price / night (₹)', type: 'money', required: true },
      { name: 'public', label: 'On booking website', options: yes }, { name: 'active', label: 'Active', options: yes }],
    [['Code', r => h('span', { class: 'tag' }, r.code)], ['Name', 'name'], ['Type', r => typeName(r.room_type_id)], ['Base', r => rs(r.base_price), { num: 1 }], ['Website', r => yn(r.public)], ['Active', r => yn(r.active)]], { singular: 'Rate plan' })]);
    sections.push(['prices', 'Seasonal prices', 'calendar', () => crudSection('Seasonal & hotel price overrides', '/rate_prices', [{ name: 'rate_plan_id', label: 'Rate plan', options: plans.map(p => [p.id, p.code]) },
      { name: 'property_id', label: 'Hotel', options: [['', 'All hotels'], ...S.me.properties.map(p => [p.id, p.name])] },
      { name: 'date_from', label: 'From', type: 'date', required: true }, { name: 'date_to', label: 'To', type: 'date', required: true },
      { name: 'price', label: 'Price / night (₹)', type: 'money', required: true }],
    [['Plan', r => h('span', { class: 'tag' }, plans.find(p => p.id === r.rate_plan_id)?.code)], ['Hotel', r => S.me.properties.find(p => p.id === r.property_id)?.name || 'All hotels'],
      ['From', r => dayLabel(r.date_from)], ['To', r => dayLabel(r.date_to)], ['Price', r => rs(r.price), { num: 1 }]], { beforeSave: v => { if (!v.property_id) v.property_id = null; }, singular: 'Price override' })]);
  }
  if (can('menu')) {
    sections.push(['menu', 'Restaurant menu', 'utensils', () => crudSection(`Restaurant menu · ${curProp().name}`, '/menu_items', [{ name: 'name', label: 'Item', required: true }, { name: 'category', label: 'Category' },
      { name: 'price', label: 'Price before GST (₹)', type: 'money', required: true }, { name: 'active', label: 'Active', options: yes }],
    [['Item', r => h('strong', {}, r.name)], ['Category', r => h('span', { class: 'tag' }, r.category || '—')], ['Price', r => rs(r.price), { num: 1 }], ['Active', r => yn(r.active)]], { scoped: true, singular: 'Menu item' })]);
  }
  if (can('admin')) {
    sections.push(['users', 'Users', 'users', () => crudSection('Users', '/users', [{ name: 'username', label: 'Username', required: true }, { name: 'name', label: 'Full name', required: true },
      { name: 'role', label: 'Role', options: S.me.roles.map(r => [r, roleName(r)]) },
      { name: 'property_id', label: 'Hotel', options: [['', 'Group level (all hotels)'], ...S.me.properties.map(p => [p.id, p.name])] },
      { name: 'password', label: 'Password (min 8; blank = keep)', type: 'password', required: true, autocomplete: 'new-password' },
      { name: 'active', label: 'Active', options: yes }],
    [['User', r => person(r.name, r.username)], ['Role', r => roleName(r.role)], ['Hotel', r => h('span', { class: 'tag' }, S.me.properties.find(p => p.id === r.property_id)?.code || 'Group')], ['Active', r => yn(r.active)]],
    { beforeSave: v => { if (!v.property_id) v.property_id = null; }, singular: 'User' })]);
  }
  const key = qs().get('s');
  const cur = sections.find(s => s[0] === key) || sections[0];
  return h('div', {}, pageHead('Setup', 'Hotels, rooms, rates, menus and users'),
    h('div', { class: 'setup' }, h('nav', { class: 'subnav' }, sections.map(([k, l, ic]) => h('a', { href: `#/setup?s=${k}`, class: k === cur[0] ? 'active' : '' }, icon(ic), l))),
      h('div', {}, cur[3]())));
}

// ---------- audit log: stored as JSON, shown as plain sentences ----------
const MODE_NAME = { cash: 'cash', card: 'card', upi: 'UPI', online: 'online', bank: 'bank transfer' };
const CAT_NAME = { room: 'room', fnb: 'food & beverage', extra: 'extra' };
const TABLE_NAME = { properties: 'hotel', room_types: 'room type', rooms: 'room', rate_plans: 'rate plan', rate_prices: 'price override', menu_items: 'menu item',
  suppliers: 'supplier', items: 'stock item', guests: 'guest profile' };
const FIELD_NAME = { base_price: 'base price', fnb_gst_rate: 'F&B GST %', discount_limit_pct: 'discount limit %', po_auto_limit: 'PO auto-approve limit', po_gm_limit: 'PO GM limit',
  restaurant_tables: 'restaurant tables', room_type_id: 'room type', rate_plan_id: 'rate plan', max_occupancy: 'max adults', date_from: 'from', date_to: 'to', business_date: 'business date',
  public: 'on website', id_number: 'ID number', id_type: 'ID type' };
const MONEY_KEYS = new Set(['amount', 'total', 'cost', 'price', 'base_price', 'po_auto_limit', 'po_gm_limit']);
const HIDDEN_KEYS = new Set(['property_id', 'override', 'password', 'lines', 'id']);
const fieldValue = (k, v) => (MONEY_KEYS.has(k) ? rs(v) : ['active', 'public'].includes(k) ? (v ? 'yes' : 'no') : isDateStr(v) ? dayLabel(v) : String(v));
const isDateStr = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const fieldList = d => Object.entries(d).filter(([k, v]) => !HIDDEN_KEYS.has(k) && v != null && v !== '' && typeof v !== 'object')
  .map(([k, v]) => `${FIELD_NAME[k] || k.replace(/_/g, ' ')} ${fieldValue(k, v)}`).join(' · ');
const approval = d => (d.approved_by ? ` · approved by ${d.approved_by}` : '');
const reason = d => (d.reason ? ` · “${d.reason}”` : '');
// action -> [area, sentence]
const AUDIT = {
  login: ['Sign-in', () => 'Signed in'],
  'reservation.create': ['Booking', d => `Created a booking (${String(d.source || '').replace('_', ' ')}) for ${dayLabel(d.arrival)} → ${dayLabel(d.departure)}`],
  'reservation.check_in': ['Booking', d => `Checked the guest in to room ${d.room}`],
  'reservation.check_out': ['Booking', () => 'Checked the guest out and issued the GST invoice'],
  'reservation.cancel': ['Booking', d => `Cancelled the booking${reason(d)}`],
  'folio.charge': ['Money', d => `Posted a ${CAT_NAME[d.category] || d.category} charge of ${rs(d.amount)}`],
  'folio.discount': ['Money', d => `Gave a discount of ${rs(d.amount)} (${d.pct}%)${approval(d)}${reason(d)}`],
  'folio.void': ['Money', d => `Voided a charge of ${rs(d.amount)}${approval(d)}${reason(d)}`],
  'payment.receive': ['Money', d => `Received ${rs(d.amount)} by ${MODE_NAME[d.mode] || d.mode}`],
  'payment.refund': ['Money', d => `Refunded ${rs(Math.abs(d.amount))} by ${MODE_NAME[d.mode] || d.mode}${approval(d)}`],
  'pos.settle': ['Restaurant', d => `Restaurant bill of ${rs(d.total)} ${d.to === 'room' ? 'charged to the guest\'s room' : 'paid at the table'}`],
  'pos.void': ['Restaurant', d => `Voided an open restaurant order${approval(d)}${reason(d)}`],
  'po.create': ['Purchasing', d => `Raised a purchase order of ${rs(d.total)} · ${d.auto ? 'approved automatically' : `needs ${d.needs === 'central' ? 'central purchasing' : 'GM'} approval`}`],
  'po.approve': ['Purchasing', d => `Approved a purchase order of ${rs(d.total)}`],
  'po.reject': ['Purchasing', d => `Rejected a purchase order of ${rs(d.total)}`],
  'po.receive': ['Purchasing', d => `Received goods worth ${rs(d.total)} into stock`],
  'po.pay': ['Purchasing', d => `Paid the supplier ${rs(d.total)} by ${MODE_NAME[d.mode] || d.mode}`],
  'stock.issue': ['Stock', d => `Issued ${d.qty} units to ${d.department} (cost ${rs(d.cost)})`],
  'ticket.create': ['Maintenance', d => `Reported an issue${d.room ? ` in room ${d.room}` : ''}${d.blocks ? ' and blocked the room' : ''}`],
  'ticket.resolve': ['Maintenance', d => `Resolved the issue${d.resolution ? ` · “${d.resolution}”` : ''}`],
  'room.hk': ['Housekeeping', d => `Changed room status from ${d.from} to ${d.to}`],
  night_audit: ['Night audit', d => `Closed ${dayLabel(d.business_date)} · ${d.posted_room_nights} room nights charged · ${d.no_shows} no-shows · ${rs(d.collected)} collected`],
  'journal.manual': ['Accounts', d => `Posted a manual journal “${d.memo}” for ${dayLabel(d.date)}`],
  'user.create': ['Setup', d => `Created user ${d.username} as ${roleName(d.role)}`],
  'user.update': ['Setup', d => `Updated a user${d.password ? ' (password changed)' : ''}${fieldList(d) ? ' · ' + fieldList(d) : ''}`],
};
function describe(r) {
  let d = {};
  try { d = r.detail ? JSON.parse(r.detail) : {}; } catch { return ['Other', r.detail || r.action]; }
  if (AUDIT[r.action]) return [AUDIT[r.action][0], AUDIT[r.action][1](d)];
  const [table, verb] = r.action.split('.');
  if (TABLE_NAME[table]) return ['Setup', `${verb === 'create' ? 'Added' : 'Updated'} ${TABLE_NAME[table]}${fieldList(d) ? ' · ' + fieldList(d) : ''}`];
  return ['Other', `${r.action.replace(/[._]/g, ' ')}${fieldList(d) ? ' · ' + fieldList(d) : ''}`];
}
const AREA_COLOR = { Booking: 'indigo', Money: 'green', Restaurant: 'amber', Purchasing: 'violet', Stock: 'teal', Maintenance: 'red', Housekeeping: 'pink', 'Night audit': 'indigo', Accounts: 'green', Setup: 'violet', 'Sign-in': '', Other: '' };
const recordLink = r => {
  if (!r.entity) return h('span', { class: 'muted' }, '—');
  const links = { reservation: [`#/res/${r.entity_id}`, 'Booking'], pos_order: [`#/order/${r.entity_id}`, 'Order'], guests: [`#/guest/${r.entity_id}`, 'Guest'],
    purchase_order: ['#/purchasing', 'Purchase order'] };
  const [href, label] = links[r.entity] || [null, (TABLE_NAME[r.entity] || r.entity.replace(/_/g, ' ')).replace(/^./, c => c.toUpperCase())];
  return href ? h('a', { href }, `${label} #${r.entity_id}`) : h('span', { class: 'muted' }, `${label} #${r.entity_id}`);
};
const localTime = at => new Date(String(at).replace(' ', 'T') + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function auditLog() {
  const q = qs(), text = q.get('q') || '', area = q.get('area') || '', all = S.all;
  const rows = (await api('GET', `/audit-log${S.me.user.property_id || all ? '' : '?' + pq()}`)).map(r => { const [a, what] = describe(r); return { ...r, area: a, what }; });
  const areas = [...new Set(rows.map(r => r.area))];
  const shown = rows.filter(r => (!area || r.area === area) &&
    (!text || `${r.user_name} ${r.what} ${r.area} ${r.property_code}`.toLowerCase().includes(text.toLowerCase())));
  const nav = extra => setQs('#/audit-log', { q: text, area, scope: all ? 'all' : '', ...extra });
  return h('div', {}, pageHead('Audit log', 'Who did what and when — visible to the owner only', h('span', { class: 'tag violet' }, icon('shield'), 'Owner only')),
    h('div', { class: 'toolbar' }, searchInput(text, 'Search person, action or amount', v => nav({ q: v })),
      null),
    panel(`${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}`, pills([['', 'All', rows.length], ...areas.map(a => [a, a, rows.filter(r => r.area === a).length])], area, k => nav({ area: k })),
      table([['When', r => h('span', { class: 'muted', style: 'white-space:nowrap' }, localTime(r.at))],
        ['Who', r => (r.user_name ? person(r.user_name, roleName(r.user_role || '')) : person('Website', 'guest booking'))],
        ['Area', r => h('span', { class: `chip-tag ${AREA_COLOR[r.area] || ''}` }, r.area)],
        ['What happened', r => h('span', { class: 'what' }, r.what)],
        ...(all ? [['Hotel', r => h('span', { class: 'tag' }, r.property_code || 'Group')]] : []),
        ['Record', recordLink]], shown, 'Nothing matches.')));
}

const VIEWS = {
  dashboard, frontdesk, reservations, booking, res, invoice, guests, guest, housekeeping, maintenance, pos, order, inventory, purchasing,
  accounts, 'night-audit': nightAudit, setup, 'audit-log': auditLog,
};
boot();
