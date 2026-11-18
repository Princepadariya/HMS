# Grand Residency Hotel ERP

Multi-property hotel ERP for a group of mid-size Indian hotels: front desk, GST billing, housekeeping,
maintenance, restaurant POS, inventory, purchasing with approvals, full double-entry accounting,
night audit, group dashboard and a public booking website (reserve now, pay at hotel).

Node.js 22+ and plain HTML/CSS/JS. One dependency: `@libsql/client` (Turso's SQLite client), which uses a local
SQLite file on your computer and a hosted Turso database on Vercel.

## Run
```bash
npm start
```
- Staff app: http://localhost:3000
- Booking website: http://localhost:3000/book
- Data: `data/hotel.db`. On first start it is created with two hotels (60 and 48 rooms), staff, menus, suppliers
  and **30 days of operating history** (bookings from every channel, stays, restaurant bills, purchases,
  maintenance, night audits, month-end expenses), all run through the system's own rules so the books balance.
  Delete `data/hotel.db*` to start again from a fresh history.
- Env: `PORT`, `HOTEL_DB`.

## Deploy to Vercel (with Turso)
Vercel keeps no files between requests, so the live database is Turso (hosted SQLite).

1. **Turso** — sign up at turso.tech, create a database (pick a location near your Vercel region, e.g. Mumbai), then from its page copy
   the **database URL** (`libsql://…`) and create a **token**.
2. **Load your data once** — copy `.env.example` to `.env.turso`, paste the URL and token into it, then run:
   ```bash
   npm run upload
   ```
   It copies everything from `data/hotel.db` and refuses to run if Turso already has data. (`.env.turso` is git-ignored — never commit it.)
3. **Vercel** — *Add New → Project*, import the GitHub repo `HMS`, framework preset **Other**, leave build settings empty.
   Under *Environment Variables* add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (same values), and `HIDE_QUICK_LOGIN=1`
   if real staff will use it. Pick the function region nearest your Turso database (Settings → Functions). Deploy.
4. Open the Vercel URL: staff app at `/`, booking site at `/book`. Change every starter password in **Setup → Users**.

How it fits together: `public/` is served as static files; `api/[...path].js` is the only serverless function and reuses
`server/` (same code as `npm start`); `vercel.json` adds the security headers and the `/book` address.

## Test
```bash
npm test
```
End-to-end tests (5) run the full business flow on an in-memory database.

## Staff logins
Every starter account uses the initial password in `server/seed.js` (`INITIAL_PASSWORD`, currently `Hotel@2026`).
Change it per user in **Setup → Users** before real use.

The sign-in page shows a **Quick sign-in by role** list: one click opens the ERP as that user. It lists only accounts
still on the initial password, so a user disappears from it once their password is changed. Start the server with
`HIDE_QUICK_LOGIN=1` to turn the list off completely before the site is reachable by anyone outside the team.

| Username | Name | Role | Hotel |
|---|---|---|---|
| owner | Rajesh Mehta | Group admin (everything) | all |
| revenue | Ananya Iyer | Central revenue & reservations | all |
| purchase | Vivek Agarwal | Central purchasing | all |
| accounts | Hemant Bhatt | Accountant | all |
| gm.amd / gm.brc | Nirav Shah / Ketan Desai | General manager | Ahmedabad / Vadodara |
| duty.amd / duty.brc | Meghna Joshi / Farhan Qureshi | Duty manager | Ahmedabad / Vadodara |
| desk.amd / desk.brc | Riya Patel / Pooja Trivedi | Front desk | Ahmedabad / Vadodara |
| hk.amd / hk.brc | Sunita Parmar / Lata Makwana | Housekeeping supervisor | Ahmedabad / Vadodara |
| maid.amd | Kanta Vaghela | Housekeeper | Ahmedabad |
| maint.amd | Ramesh Solanki | Maintenance | Ahmedabad |
| cafe.amd / cafe.brc | Imran Sheikh / Joseph D'Souza | Restaurant cashier | Ahmedabad / Vadodara |
| store.amd / store.brc | Dinesh Rathod / Mahesh Chauhan | Storekeeper | Ahmedabad / Vadodara |

## A day in the system
1. Guest books on `/book` (pay at hotel) or staff book at **Front desk → New booking** (walk-in, phone, OTA, central desk).
2. **Front desk**: open an arrival → Check in (clean room, ID, Form C for foreigners).
3. Post extras, restaurant bills to the room (**Restaurant POS**), discounts (manager approval above the limit), payments.
4. **Housekeeping** marks rooms dirty/clean/inspected; **Maintenance** tickets can block a room.
5. **Night audit** posts room nights, marks no-shows, saves the day report and moves the business date.
6. Check out → numbered GST tax invoice (B2B GSTIN supported).
7. **Purchasing**: PO → approval by amount → receive goods → stock → issue to departments → accountant pays supplier.
8. **Accounts & GST**: P&L, balance sheet, trial balance, GST output/input, B2B invoice list, manual journals — per hotel or consolidated.

## Docs
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) · [docs/MARKET_RESEARCH.md](docs/MARKET_RESEARCH.md)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md)
- [docs/TASKS.md](docs/TASKS.md) · [docs/DEVELOPMENT_LOG.md](docs/DEVELOPMENT_LOG.md)

## Before real use
Accountant sign-off on GST rates and chart of accounts, HTTPS + daily backups, change all initial passwords,
e-invoice (IRN) if turnover requires, channel manager (v2), import of real rooms/rates/guests in place of the starter data.
