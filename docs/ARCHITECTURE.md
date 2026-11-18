# Hotel ERP - Architecture

Owner instruction (2026-11-17): build the whole system end to end without further questions.
So the recommendations in REQUIREMENTS.md are treated as approved defaults; all limits are configurable.

## Stack (zero third-party dependencies)
- **Runtime**: Node.js 24 (`node:http`, `node:sqlite`, `node:crypto`, `node:test`).
- **Database**: SQLite file (`data/hotel.db`), WAL mode, foreign keys on. One central DB for all properties (cloud hosting).
- **Frontend**: plain HTML/CSS/JS single-page app (`public/index.html`, `public/app.js`), plus a public booking site (`public/book.html`).
- Why: no build step, no package installs, one process to deploy. Upgrade path: swap SQLite for PostgreSQL when the group passes ~20 hotels or needs several app servers.

## Layout
```
server/db.js      schema (all tables)
server/core.js    router registry, roles/permissions, validation, dates, GST, ledger posting, folio, rates, availability, reservations
server/api.js     every HTTP endpoint (see docs/API_CONTRACTS.md)
server/seed.js    demo group: 2 hotels, rooms, rates, menu, stock items, users, sample bookings
server/index.js   HTTP server: static files, JSON body, auth, dispatch, errors
public/           staff web app + booking website
test/e2e.test.js  end-to-end business flow test
```

## Key design rules
- **Money** is stored and sent as integer **paise** (no floating-point rounding errors). The UI converts to rupees.
- **One posting path**: every folio charge, payment, purchase receipt, stock issue and supplier payment writes a balanced double-entry journal through `post()`. Unbalanced postings throw and roll back the transaction.
- **GST**: room rate slab comes from the `room_gst_slabs` setting (by nightly tariff); F&B rate per property; extras default 18%. Intra-state supply, so tax is split 50/50 CGST/SGST. Seeded rates must be confirmed by the group's accountant.
- **Corrections never delete**: a void adds a reversing line; discounts are negative lines tied to the charge they reduce.
- **Multi-property**: every operational row carries `property_id`. A user with `property_id = NULL` is group-level (owner, central revenue/purchasing, accountant) and can work on any hotel; other users are locked to their hotel on the server.
- **Shared**: guests, room types, rate plans (with per-property / seasonal price overrides), suppliers and stock items.
- **Approvals**: discount above limit, void, refund and POS void need the `override` permission (GM/duty manager), either by being logged in as one or by entering manager credentials in the same request. POs: up to `po_auto_limit` auto-approved, up to `po_gm_limit` need GM, above need central purchasing.
- **Audit trail**: money-changing and setup actions go to `audit_log` (who, when, what, detail).
- **Night audit**: posts each in-house room night (idempotent), marks no-shows, stores a day summary, advances the business date.

## Data model (main tables)
properties, users, sessions, settings, room_types, rooms, rate_plans, rate_prices, guests, reservations,
folio_lines, payments, invoices, menu_items, pos_orders, pos_order_lines, suppliers, items, stock, stock_moves,
purchase_orders, po_lines, tickets, accounts, journals, journal_lines, night_audits, audit_log.
See `server/db.js` for columns and constraints.

## Chart of accounts (seeded)
1000 Cash · 1010 Bank (card/UPI/online) · 1100 Guest ledger · 1200 Inventory · 1300 GST input credit ·
2000 Accounts payable · 2100 CGST output · 2110 SGST output · 3000 Owner's capital ·
4000 Room revenue · 4100 F&B revenue · 4200 Other revenue ·
5000 F&B cost · 5100 Housekeeping supplies · 5200 Maintenance supplies · 5300 Salaries · 5400 Utilities · 5500 Other expenses

## Known shortcuts (v1)
- Booking site is reserve-now, pay-at-hotel (owner decision 2026-11-18: no payment gateway). Desk staff can still record advances.
- `server/seed.js` builds starter data and replays 30 days of operations through the real route handlers (in-process), so the history obeys every rule and the books balance.
- No GST e-invoice (IRN) API, no channel manager, no KOT printing, no guest-ID image upload.
- POS sales don't consume stock directly; the kitchen's consumption is booked through store issues.
- Sessions live in SQLite; one app server. Fine for 2-5 hotels.
