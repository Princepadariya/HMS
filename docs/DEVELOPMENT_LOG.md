# Development log

## 2026-11-17 / 18 - v1 built end to end
- Discovery: 3 question rounds; owner then said "build the whole system, don't ask". Recommended defaults in REQUIREMENTS.md taken as approved.
- Stack: Node 24 + built-in SQLite + vanilla JS, zero npm dependencies (no installs needed).
- Money in integer paise; one `post()` path writes balanced journals for every financial event.
- Corrections are reversing lines, never deletes; discounts are negative lines tied to their charge.
- Fixed during testing: property users could pass another hotel's `property_id` to list endpoints and silently get their own data - now a 403.
- Tests: `npm test` -> 4/4 pass (full hotel day, purchasing, maintenance blocking, booking website).
- Browser check: sign-in, dashboard, front desk, reservation page, booking site search - render correctly, no console errors.
- Not verified: printing an invoice on paper, behaviour with many concurrent users, mobile devices other than the emulated width.
- Verified with: `npm test` (final run: tests 4, pass 4, fail 0); app run via `.claude/launch.json` (`node server/main.js`).
- Left: see "Next" in TASKS.md. Blockers: payment gateway account and accountant sign-off on GST rates are owner decisions.
- Not a git repo yet (`git init` not run); nothing committed.
- **Exact next action** (superseded below).

## 2026-11-18 - from demo to product-grade data
- Owner: "make it look like a real working product, no Razorpay". Booking site is now reserve-now, pay-at-hotel; all "demo" wording removed.
- Seed rebuilt: 2 hotels (AMD 60 rooms, BRC 48), named staff for 18 accounts, 20-item menus, 3 suppliers, 10 stock items.
- `simulate()` replays 30 days through the real route handlers: ~25% of rooms booked daily across website/phone/OTA/central/walk-in,
  5% no-shows, check-ins with ID/Form C, room service and walk-in POS, extras, B2B invoices, weekly POs (GM/central approval), daily
  store issues, supplier payments, maintenance tickets, nightly audits, month-end salaries/utilities/rent. Result: ~₹94 lakh income, ~42% margin.
- Tests rewritten to create their own bookings/items so they don't depend on the generated history.
- Verified: `npm test` -> 5/5 pass (~7.5 s, mostly seeding). Browser: dashboard KPIs, front desk (14 arrivals, 8 departures at AMD), P&L consolidated.
- The old small database was moved to `data/backup/*.before-history` (not deleted). The user's own `npm start` process (PID 2352) was stopped to release the file; the app now runs on port 3000 from the preview.
- **Exact next action**: owner walks through README "A day in the system" and lists changes; then accountant review of GST rates.

## 2026-11-18 - quick sign-in by role
- Login page lists every active account still on the initial password with a one-click Open (`GET /api/public/quick-logins`).
- Off switch: `HIDE_QUICK_LOGIN=1`. Changed passwords never appear in the list.
- Verified: `npm test` 6/6 (new test logs in as all 18 listed users); browser: Open on desk.amd lands as Riya Patel with the front-desk menu only.

## 2026-11-18 - redesign in the style of the owner's 4bitx ERP (codelixerp.vercel.app)
- Reference studied from the live login page, the dashboard (owner signed in themselves in the pane; only viewed) and product screenshots in the Codelix site repo.
- New look: Inter font, light theme by default + dark toggle (saved per browser), white grouped sidebar with icons and collapse, top bar with breadcrumb,
  business-date pill, module search (Ctrl K), avatar menu. Indigo login page with grouped one-click role cards.
- Dashboard rebuilt: hero (live time, greeting, quick actions, in-house/occupancy/revenue), booking-to-checkout pipeline, 6 KPI cards with sparklines,
  revenue-by-day bar chart (hover tooltip, table view) and payments-by-mode donut, 7/14/30-day switch, by-hotel table.
- API: dashboard now returns `daily` and `payments_by_mode`; quick-logins returns `property_name`. CSP allows Google Fonts.
- Chart palette validated with the dataviz validator (light and dark both pass).
- Verified: `npm test` 6/6; DOM checks in browser (7 days of paired bars, 3-segment donut, 6 KPI columns, Inter loaded, no new console errors).
  Not verified: a clean full-page screenshot (the pane's capture timed out while hidden).

## 2026-11-18 - all inner screens in the same design
- Shared building blocks in public/app.js: pageHead, statStrip (clickable KPI chips), panel (card with header; tables flush), pills (filters with counts),
  person (avatar + name), searchInput, tags. Presentation only; API calls and business rules unchanged.
- Front desk, reservations, new booking (3-step stepper + room-type cards), reservation detail (info cards + folio + action panels), guests, guest profile,
  housekeeping (stat filters, rooms by floor), maintenance (modal ticket), POS + order (menu by category, sticky bill), inventory, purchasing (approvals-style list,
  PO and supplier in modals), accounts (stat strips, side-by-side panels, journal modal), night audit (hero + checklist), setup (sub-menu, add/edit in modals), audit log (filter).
- Verified in the browser: 28 routes plus in-house booking, open order and booking search all render with no errors; `npm test` 6/6.
  A test order (#1134) opened during the check was voided with a reason in the audit log.

## 2026-11-18 - mobile, room booking and restaurant upgrades
- Mobile: fixed page overflow (`.shell > div { min-width: 0 }`); sidebar is a slide-in drawer on phones (menu button, tap outside or pick a page to close);
  2-column KPI/stat grids, tables scroll sideways, pills scroll, 16px inputs (no iOS zoom), full-width dialogs.
- Booking website rebuilt: trust badges, step tracker, room cards (bed, size, guests, amenities, Most popular, breakfast plans), sticky "Your stay"
  price breakdown, Our hotels cards, ticket-style confirmation with print. Room facts are marketing copy in public/book.js (`ROOM`), not ERP data.
- Staff new booking: returning-guest lookup (search phone/name, prefill, books onto the existing profile via guest_id) and a stay summary with per-night prices.
- Restaurant: table floor (tables 1-18 + Room service + Takeaway; occupied tiles show total and time open), order screen with dish search, category filters,
  quantity badges, −/+ quantity, UPI/Card/Cash with "Collect ₹X", company bill option, charge to room, sticky bottom bill bar on phones.
- API: adding the same dish merges into one line; new `POST /api/pos/orders/:id/lines/:lineId/qty` (0 removes). Test added.
- Verified: `npm test` 6/6; 18 staff screens at 375px wide with no overflow or errors; drawer; full phone order (#1135, then voided); booking site on phone and desktop;
  returning-guest lookup. Shortcut: 18 tables per restaurant are hard-coded (`TABLES` in public/app.js).

## 2026-11-18 - tables per hotel, owner-only readable audit log, fixes
- `properties.restaurant_tables` (1-200, default 18) with an in-place migration for existing databases (data kept). Editable in Setup → Hotels;
  the POS floor uses it and still shows any higher-numbered table that has an open order. Fresh seed: Ahmedabad 18, Vadodara 12.
- Bug fixed: the owner's screen never received the `admin` permission, so Setup hid Hotels / Room types / Rooms / Users. `permsOf` now includes it.
- Audit log is owner/admin only (server route and menu); GMs lost access. Rows show plain sentences instead of JSON, the person's role,
  a coloured area with filter pills, local time, links to bookings/orders, and an "All hotels" view.
- Bug fixed: "all hotels" filters on the audit log and maintenance list produced invalid SQL (`l.1=1`).
- Accounts filter bar (scope/from/to/apply) now sits in one row instead of stacking.
- Verified: `npm test` 9/9 (new: tables setting, migration on an old DB, owner-only audit log). Browser: owner sees all Setup sections,
  Vadodara set to 12 tables via Setup → POS floor showed 12 (Ahmedabad 18), then restored to 18; audit log has no JSON left.

## 2026-11-18 - role scoping and the "All hotels" switch
- New permissions: `books` (financial statements: owner, GM, accountant) and `rack` (room-status view for front desk / duty manager / GM).
  Accounts & GST is hidden from central revenue and duty managers; Housekeeping is hidden from maintenance and central revenue.
- POS order screen uses `GET /api/pos/inhouse` (room + guest name only) so restaurant cashiers don't need front-desk access.
- Top hotel selector has "All hotels" for group users (default on first visit). Dashboard, reservations (Hotel column), maintenance, purchasing (hotel tag),
  accounts and audit log follow it; front desk, new booking, housekeeping, POS, inventory and night audit ask to pick a hotel. Accounts and audit log no longer
  have their own scope control.
- Verified: `npm test` 9/9; browser as owner: dashboard group vs Ahmedabad (60 vs 30 in house), reservations Hotel column, picker on one-hotel screens.
- Mobile: bottom tab bar (role's first 4 screens + Menu), drawer lists every feature for the role plus Booking website, Light/dark, Sign out;
  hamburger icon on phones; iPhone safe-area padding; POS bill bar sits above the tab bar.
- Pages a role can't use (including sub-pages like a booking or order opened by address) now fall back to the role's home screen.
- Verified in the browser at 375px for all 12 starter roles: menus match their role, only the owner reaches the audit log, housekeeper / cashier /
  storekeeper / purchasing / accountant are sent home from /res/1.

## 2026-11-18 - Turso + Vercel ready
- Owner chose Turso. Added `@libsql/client@0.18.0` (approved). `server/db.js` wraps it as async `db.prepare().get/all/run` + `db.tx`;
  transactions follow each request via AsyncLocalStorage and run their statements strictly in order.
- Converted core, API, seed/simulation and server to async. Round-trip savings for a remote DB: availability 2 queries instead of one per night,
  POS/PO/journal lists batch-loaded, dashboard KPIs in parallel, journal lines in one INSERT, GST slabs cached 60 s.
- Vercel: `api/[...path].js` (reuses `createHandler`), `vercel.json` (static `public/`, `/book`, headers), `scripts/upload-to-turso.js` (`npm run upload`),
  `.env.example`. Mobile tab bar + role gating also done (see entry above).
- Verified: `npm test` 9/9 (tests use a temp DB file); local app works on the existing data; upload rehearsed against a local stand-in (37,231 rows,
  second run refuses); the Vercel function file served login, dashboard and trial balance from the uploaded copy.
- Live on Vercel (hms-psi-seven.vercel.app) with Turso; routing fixed to one `api/index.js` + rewrite; `/api/health` added.

## 2026-11-18 - light theme only + Group performance
- Dark mode and its switch removed.
- New **Performance** screen (`GET /api/reports/group`): headline KPIs vs the previous period, hotel league table ranked by RevPAR, 30-night
  on-the-books forecast per hotel, channel mix (website / phone+central / walk-in / OTA) with direct share and estimated OTA commission saved
  (18% assumption, `OTA_COMMISSION` in server/api.js). Defaults to 7 days so comparisons have data; "no earlier data" when the previous period is empty.
- Verified: `npm test` 10/10 (new test checks ranking, forecast bounds, shares = 100%, commission maths, GM scoping, front-desk 403);
  browser desktop + 375px phone.
- Earlier note "Not verified: a real Turso database or a real Vercel deploy" no longer applies.

## 2026-11-18 - Room calendar (tape chart)
- `GET /api/calendar` + **Room calendar** screen (front office; one hotel at a time): rooms grouped by type, a free-rooms line per type per night
  (counts bookings not yet given a room), stays as bars (in house / checked out), today highlighted, weekends shaded, out-of-order rooms striped,
  housekeeping dot per room. Starts 2 days back; ←/Today/→ and 7/14/30 days. Clicking a free night opens New booking with that arrival date.
- Bookings only get a room at check-in, so future stays show in the free counts, not as bars (pre-assigning rooms would be a separate feature).
- Verified: `npm test` 11/11; browser desktop (60 rooms, 30 in-house bars, click-to-book prefill) and phone (no page overflow, chart scrolls sideways). Foreign-key enforcement on Turso connections is not guaranteed;
  the app validates references itself.
