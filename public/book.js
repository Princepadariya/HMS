'use strict';
const $ = s => document.querySelector(s);
const rs = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nights = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const day = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const ICON = {
  bed: '<path d="M2 4v16M2 8h17a3 3 0 0 1 3 3v9M2 17h20M6 8v9"/>',
  size: '<path d="M3 3h7M3 3v7M21 21h-7M21 21v-7M3 3l7 7M21 21l-7-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  cal: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  pin: '<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  cup: '<path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/>',
};
const ic = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
// What each room type offers (marketing copy; the ERP holds only names and capacity)
const ROOM = {
  Standard: { bed: 'Queen bed', size: '220 sq ft', amen: ['Free Wi-Fi', 'Air conditioning', 'Smart TV', 'Tea & coffee'] },
  Deluxe: { bed: 'King bed', size: '300 sq ft', amen: ['Free Wi-Fi', 'Air conditioning', 'Smart TV', 'Mini fridge', 'Work desk'], popular: true },
  Suite: { bed: 'King bed + lounge', size: '520 sq ft', amen: ['Free Wi-Fi', 'Air conditioning', '2 Smart TVs', 'Bathtub', 'Living area'] },
};
const out = $('#out'), summary = $('#summary');
let hotels = [], state = {};

async function api(method, path, body) {
  const r = await fetch('/api/public' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const fail = e => { out.innerHTML = `<div class="card"><p class="error" style="margin:0">${esc(e.message)}</p></div>`; };
function step(n) {
  $('#steps').hidden = false;
  document.querySelectorAll('#steps li').forEach(li => { const s = +li.dataset.step; li.className = s < n ? 'done' : s === n ? 'on' : ''; });
  $('#book-layout').hidden = false;
  summary.hidden = n === 2;
}

function renderSummary() {
  const { q, hotel, type, plan } = state;
  const n = nights(q.arrival, q.departure);
  summary.innerHTML = `<h3>Your stay</h3>
    <div class="s-hotel">${esc(hotel.name)}<small>${ic('pin')}${esc(hotel.address || '')}</small></div>
    <div class="s-row">${ic('cal')}<span>${day(q.arrival)} → ${day(q.departure)}<small>${n} night${n === 1 ? '' : 's'} · check-in from 12:00</small></span></div>
    <div class="s-row">${ic('user')}<span>${esc(q.adults)} adult${q.adults === '1' ? '' : 's'}</span></div>
    ${plan ? `<div class="s-row">${ic('bed')}<span>${esc(type.room_type)} room<small>${esc(plan.name)}</small></span></div>
      <div class="s-price"><div><span>${rs(Math.round(plan.total / n))} × ${n} night${n === 1 ? '' : 's'}</span><span>${rs(plan.total)}</span></div>
        <div><span>GST</span><span>${rs(plan.tax)}</span></div>
        <div class="grand"><span>Total</span><span>${rs(plan.total + plan.tax)}</span></div></div>
      <p class="pay-note">${ic('check')} No prepayment — pay at the hotel</p>`
    : '<p class="muted">Choose a room to see the price breakdown.</p>'}`;
}

(async () => {
  hotels = await api('GET', '/properties');
  $('#hotel').innerHTML = hotels.map(h => `<option value="${h.id}">${esc(h.name)}</option>`).join('');
  $('#hotels').innerHTML = `<h2>Our hotels</h2><div class="hotel-grid">${hotels.map((h, i) => `<article class="hotel-card">
      <div class="hotel-pic t${(i % 3) + 1}" aria-hidden="true">${esc(h.name.split(' ').pop())}</div>
      <div class="body"><h3>${esc(h.name)}</h3><p>${ic('pin')}${esc(h.address || '')}</p><p>${ic('phone')}${esc(h.phone || '')}</p>
      <button type="button" class="ghost" data-hotel="${h.id}">Book this hotel</button></div></article>`).join('')}</div>`;
  $('#hotels').querySelectorAll('[data-hotel]').forEach(b => b.addEventListener('click', () => {
    $('#hotel').value = b.dataset.hotel; setDates(); $('#search').scrollIntoView({ behavior: 'smooth' });
  }));
  const f = $('#search-form');
  function setDates() {
    const h = hotels.find(x => String(x.id) === $('#hotel').value);
    f.arrival.min = h.business_date;
    if (!f.arrival.value || f.arrival.value < h.business_date) f.arrival.value = h.business_date;
    f.departure.min = new Date(Date.parse(f.arrival.value) + 864e5).toISOString().slice(0, 10);
    if (!f.departure.value || f.departure.value <= f.arrival.value) f.departure.value = f.departure.min;
    const n = nights(f.arrival.value, f.departure.value);
    $('#nights').textContent = `${n} night${n === 1 ? '' : 's'} · ${day(f.arrival.value)} → ${day(f.departure.value)}`;
  }
  $('#hotel').addEventListener('change', setDates);
  f.arrival.addEventListener('change', setDates);
  f.departure.addEventListener('change', setDates);
  setDates();
})().catch(fail);

$('#search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = Object.fromEntries(new FormData(e.target));
  const hotel = hotels.find(h => String(h.id) === q.property_id);
  const n = nights(q.arrival, q.departure);
  state = { q, hotel };
  try {
    const types = (await api('GET', `/availability?${new URLSearchParams(q)}`)).filter(t => t.max_occupancy >= Number(q.adults));
    step(0);
    renderSummary();
    if (!types.length) return (out.innerHTML = '<div class="card empty"><h3>No rooms free for these dates</h3><p class="muted">Try other dates or the other hotel, or call us — we may be able to help.</p></div>');
    out.innerHTML = `<h2 class="results-title">${types.length} room type${types.length === 1 ? '' : 's'} available</h2>` + types.map((t, i) => {
      const info = ROOM[t.room_type] || { bed: 'Comfortable bed', size: '', amen: ['Free Wi-Fi', 'Air conditioning'] };
      return `<article class="card room-card">
        <div class="pic t${(i % 3) + 1}">${ic('bed')}<span>${esc(t.room_type)}</span>${info.popular ? '<em class="ribbon">Most popular</em>' : ''}</div>
        <div class="body">
          <div class="row"><h3>${esc(t.room_type)} room</h3><span class="spacer"></span>${t.available <= 3 ? `<span class="badge warn">Only ${t.available} left</span>` : ''}</div>
          <p class="facts">${ic('bed')}${esc(info.bed)} ${info.size ? `<span>${ic('size')}${esc(info.size)}</span>` : ''} <span>${ic('user')}Up to ${t.max_occupancy} guests</span></p>
          <ul class="amen">${info.amen.map(a => `<li>${ic('check')}${esc(a)}</li>`).join('')}</ul>
          ${t.plans.map(p => `<div class="plan">
            <div><strong>${esc(p.name)}</strong>
              <small class="${p.code.startsWith('CP') ? 'gain' : 'muted'}">${p.code.startsWith('CP') ? `${ic('cup')}Breakfast included` : 'Room only'} · free cancellation</small></div>
            <span class="spacer"></span>
            <div class="price"><b>${rs(p.total + p.tax)}</b><small>${rs(Math.round(p.total / n))}/night + GST</small></div>
            <button data-type="${i}" data-plan="${p.rate_plan_id}">Select</button></div>`).join('')}
        </div></article>`;
    }).join('');
    out.querySelectorAll('button[data-plan]').forEach(b => b.addEventListener('click', () => {
      state.type = types[b.dataset.type];
      state.plan = state.type.plans.find(p => String(p.rate_plan_id) === b.dataset.plan);
      guestForm();
    }));
    $('#steps').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (er) { fail(er); }
});

function guestForm() {
  step(1);
  renderSummary();
  out.innerHTML = `<div class="card"><button type="button" class="ghost back">← Change room</button>
    <h2 style="margin-top:12px">Your details</h2>
    <p class="muted">Your room is reserved the moment you confirm. No card needed.</p>
    <form id="guest" class="form">
      <label>Full name <input name="name" required autocomplete="name"></label>
      <label>Mobile <input name="phone" type="tel" required autocomplete="tel" placeholder="+91 98xxx xxxxx"></label>
      <label>Email <input name="email" type="email" required autocomplete="email"></label>
      <label>Nationality <input name="nationality" value="Indian"></label>
      <label class="wide">Special requests <input name="notes" placeholder="Early check-in, extra pillow…"></label>
      <div class="wide"><button type="submit" class="big">Confirm booking · ${rs(state.plan.total + state.plan.tax)}</button></div>
    </form>
    <p class="muted small">By confirming you agree to pay at the hotel. Foreign nationals need a passport and visa at check-in (Form C).</p></div>`;
  out.querySelector('.back').addEventListener('click', () => $('#search-form').requestSubmit());
  $('#steps').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#guest').addEventListener('submit', async e => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const { q, plan } = state;
      const r = await api('POST', '/book', { ...Object.fromEntries(new FormData(e.target)), property_id: Number(q.property_id), rate_plan_id: plan.rate_plan_id,
        arrival: q.arrival, departure: q.departure, adults: Number(q.adults) });
      step(2);
      out.innerHTML = `<div class="card confirm"><div class="tick" aria-hidden="true">✓</div><h2 style="margin:0">Booking confirmed</h2>
        <p class="muted">Your booking number</p><div class="code">${esc(r.code)}</div>
        <div class="ticket">
          <div><small>Hotel</small><b>${esc(r.hotel)}</b></div>
          <div><small>Room</small><b>${esc(r.room_type)}</b></div>
          <div><small>Check-in</small><b>${day(r.arrival)}</b></div>
          <div><small>Check-out</small><b>${day(r.departure)}</b></div>
          <div><small>Total (pay at hotel)</small><b>${rs(r.total)}</b></div>
          <div><small>Questions?</small><b>${esc(r.hotel_phone)}</b></div>
        </div>
        <p class="muted small">Check-in from 12:00 · please carry a photo ID (Aadhaar / passport).</p>
        <div class="row" style="justify-content:center"><button type="button" class="ghost" id="print">Print confirmation</button><a class="btn" href="/book">Book another stay</a></div></div>`;
      $('#print').addEventListener('click', () => print());
      summary.hidden = true;
    } catch (er) {
      e.submitter.disabled = false;
      e.target.insertAdjacentHTML('afterend', `<p class="error">${esc(er.message)}</p>`);
    }
  });
}
