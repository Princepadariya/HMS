# Tasks

## Done (v1) - each checked by `npm test` (4/4 passing, 2026-11-18) and in the browser
- [x] Requirements discovery, market research, architecture, API contract
- [x] Auth, 12 roles, per-hotel scoping (server-enforced), login lockout after 5 failures, audit log
- [x] Setup: hotels, room types, rooms, group rate plans + seasonal/hotel overrides, menu, users
- [x] Reservations: availability, overbooking guard, shared guest profiles, central reservations, advances
- [x] Check-in (clean room, ID, Form C), charges, discounts (approval over limit), voids & refunds (manager approval)
- [x] Check-out with numbered GST invoice (CGST/SGST, B2B GSTIN)
- [x] Housekeeping board (dirty/clean/inspected), maintenance tickets that block rooms
- [x] Restaurant POS: orders, charge to room or settle directly with POS invoice, void with approval
- [x] Inventory: stock, weighted average cost, issues to departments
- [x] Purchasing: PO approval by amount (auto / GM / central), goods receipt, supplier payment
- [x] Accounting: auto double-entry postings, manual journals, trial balance, P&L, balance sheet, GST report
- [x] Night audit with day summary; group dashboard (occupancy, ADR, RevPAR, revenue)
- [x] Public booking website: reserve now, pay at hotel (no payment gateway, owner decision)
- [x] Polished UI (staff app, sign-in page, booking site), responsive, light/dark
- [x] Product-grade starter data: 2 hotels (60 + 48 rooms), named staff, 20-item menus, 30 days of simulated operations
  (checked: `npm test` 5/5 on 2026-11-18; dashboard, front desk and P&L show real figures in the browser)

## Next (not started)
- [ ] Accountant review of GST slabs, chart of accounts, invoice format
- [ ] Deployment: HTTPS, daily DB backups, process manager
- [ ] GST e-invoice (IRN) if turnover requires
- [ ] Channel manager / OTA sync (v2)
- [ ] KOT printing, guest ID image upload, booking amendments (change dates/room type)
- [ ] Data migration from current systems
