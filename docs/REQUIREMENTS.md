# Hotel ERP - Requirements

Status: discovery complete (3 rounds). Owner instructed (2026-11-17) to build without further questions; the recommendations below were applied as defaults. v1 built - see README.md.
Market background and the problems this ERP targets: [MARKET_RESEARCH.md](MARKET_RESEARCH.md).

## Confirmed
- Customer: one hotel group, 2-5 hotels now, central reporting across properties.
- Property type: mid-size hotels, 50-200 rooms, each with a restaurant (rooms + F&B).
- Current process at the hotels: mixed / not yet known.
- Country: India. Billing must follow GST rules.
- Hosting: cloud, one central system for all properties.
- Timeline: v1 live in about 3 months, phased per property.
- Online bookings: the group's own booking website (direct booking engine). OTA bookings are entered manually; no channel manager in v1.
- Accounting: full books inside the ERP (general ledger, P&L, balance sheet), not an export to Tally.
- No credit to companies or travel agents: every folio is settled at checkout or in advance.
- Shared across properties: guest database, central reservations, central purchasing, shared rate plans (overridable per property).
- Version 1 covers: front desk, billing & accounts, housekeeping & maintenance, restaurant & inventory.

## Core workflow (end to end)
1. **Rates**: central team sets room types, rate plans and seasons; a property may override.
2. **Booking**: guest books on the website (pays advance online), or staff create the booking (walk-in, phone, OTA typed in, central desk for any property). Availability is checked across the chosen property.
3. **Arrival**: front desk finds or creates the shared guest profile, captures ID (Form C for foreign nationals), assigns a clean room, opens the folio.
4. **Stay**: room charges post nightly; restaurant / room-service bills post to the room folio; extras and advances are recorded. Housekeeping updates room status from phones; maintenance tickets can block a room.
5. **Checkout**: folio reviewed, discounts (within limits) applied, GST invoice issued, payment taken; room goes to "dirty" for housekeeping.
6. **Night audit / day close**: posts room charges, flags no-shows, locks the business date, produces daily revenue, occupancy and cash reports.
7. **Back office**: stores issue items to kitchen/housekeeping; property raises purchase requests, central purchasing raises POs, goods are received into stock; every sale, payment, purchase and stock movement posts to the ledger per property.
8. **Group view**: owner sees occupancy, ADR, RevPAR, revenue, cash and stock across all properties.

## Recommendations (owner asked me to decide; change any you disagree with)
- **Approval rules** (all limits configurable per property):
  - Discount above 10% of the bill needs the duty manager.
  - Voiding a posted charge or any refund needs the duty manager, with a reason; logged.
  - Purchase orders above Rs 25,000 need the GM; above Rs 1,00,000 need central purchasing.
  - Only the central revenue role edits rate plans; properties can apply approved overrides.
  - Night audit cannot be reopened except by the GM; logged.
- **Roles**: Owner/Group admin, Central revenue & reservations, Central purchasing, Accountant, General Manager, Duty manager, Front desk, Housekeeping supervisor, Housekeeper, Maintenance, Restaurant cashier/captain, Storekeeper.
- **Audit trail** on every money-changing action (who, when, before/after).

## Assumptions (need confirmation)
- Front desk and back office use a desktop browser; housekeeping and maintenance use phones.
- Each property is a separate GSTIN and a separate cost centre / branch in the books.
- GST rates (room slab by tariff, F&B by outlet type) come from a configurable tax table; current rates confirmed with the group's accountant, not hard-coded.
- Payment gateway for website advances: Razorpay or PayU (choice open). Desk payment modes: cash, card, UPI.
- Guest ID storage follows Indian data-protection law (DPDP Act): ID images access-restricted and kept only as long as required.
- English-only UI in v1.

## Open questions
- GST e-invoicing (IRN) needed? Only applies to B2B invoices above the turnover threshold; ask the accountant.
- Payment gateway choice.
- Who runs the night audit at each property, and at what time?
- Data to migrate on go-live (existing guests, advance bookings, opening stock, opening balances)?
- Restaurant: KOT printing to kitchen printers needed? Walk-in (non-guest) diners too?
- Budget for hosting and third-party fees (gateway, SMS/WhatsApp, e-invoice API).

## Out of scope (v1)
- Channel manager / live OTA sync (planned for v2).
- Corporate and travel-agent credit accounts.
- HR / payroll.
- Spa, banquets/events, loyalty programme.
- Multi-language UI, offline mode.
