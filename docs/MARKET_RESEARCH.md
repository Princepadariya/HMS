# Hotel ERP - Market research and problem list

Date: 2026-11-17. Based on two web searches plus general product knowledge.
Most sources found are vendor blogs, so treat rankings as marketing, not independent data.
Prices and feature lists must be confirmed by vendor demos and quotes before any decision.

## Existing products (India-relevant)

| Product | Typical fit | Notes |
|---|---|---|
| eZee Absolute (Yanolja) | Independent, budget, mid-size hotels | Cloud PMS + POS; own channel manager (eZee Centrix) and booking engine. Source: codingclave guide. |
| Hotelogix | Independents, growing groups, multi-property | Cloud PMS; marketplace integrations for accounting (e.g. HostBooks, Tally). Source: Hotelogix's own site. |
| IDS Next (FortuneNext) | Mid-size and large Indian hotels | Long-standing Indian PMS/POS/inventory/back office. Not covered by the searches - unverified. |
| Oracle OPERA Cloud | Luxury and international chains | Most complete; quote-based pricing, heavy implementation. Source: codingclave guide. |
| Cloudbeds, Mews, others | International independents/groups | Strong PMS + marketplace; Indian GST/Tally fit must be checked. |

Pricing seen: one Indian guide lists one-time licences of Rs 50,000 - 2,00,000 for a basic 10-30 room plan; enterprise products are quote-only, and subscriptions often exclude implementation, migration, payments, integrations and add-on modules.

## Problems hotels report (what a good ERP must fix)

| # | Problem | Cause | How this ERP solves it |
|---|---|---|---|
| 1 | Same data typed several times | PMS, POS, store and accounting are separate products | One database: a folio posting, POS bill or goods receipt posts to the ledger automatically |
| 2 | Billing and GST errors, revenue leakage | Manual tax calculation, charges missed, voids unchecked | Tax table drives every invoice; restaurant bills post straight to room; voids/refunds need approval and are logged |
| 3 | Slow room turnover, wrong room status | Housekeeping on paper or calls | Mobile room-status board; front desk sees "clean/dirty/inspected/out of order" live |
| 4 | Double bookings | Website, phone and OTA bookings tracked in different places | One availability engine shared by the website, central desk and property desk |
| 5 | Night audit takes hours | Manual reconciliation of cash, rooms, POS | Automated day close: post room charges, flag no-shows, reconcile payments, lock the date |
| 6 | Owner has no group view | Each hotel on its own system or spreadsheet | Group dashboard: occupancy, ADR, RevPAR, revenue, cash, stock per property |
| 7 | Stock pilferage and over-buying | No link between purchases, issues and consumption | Central purchasing, stock issues per department, variance reports |
| 8 | Guest history lost between properties | Separate guest records per hotel | Shared guest profile and stay history across the group |
| 9 | Integration claims don't hold up | Tally/GST/OTA connectors vary by plan | Built-in books and GST reports; no connector to break (OTA sync deferred to v2) |

## Build vs buy - honest view
- **Buying** (e.g. Hotelogix or eZee, plus Tally) is faster and cheaper for 2-5 hotels and covers most of the table above today.
- **Building** makes sense if the group wants: one system with full books (no Tally), its own booking website, central purchasing and reporting exactly to its rules, no per-room subscription, and ownership of the software (possibly to resell later).
- **Risk**: PMS + POS + inventory + purchasing + full double-entry accounting + booking website in 3 months is very tight. A phased go-live is recommended (see REQUIREMENTS.md approval question).

## Sources
- https://codingclave.com/blog/best-hotel-management-software-india-2026
- https://codingclave.com/blog/hotel-management-software-guide-india
- https://www.hotelogix.com/blog/hotel-management-software-india
- https://blog.hotelogix.com/compare-hotel-pms-systems/
- https://blog.hotelogix.com/common-hotel-billing-errors/
- https://www.ecybertech.com/blog-hotel-management-software-guide
- https://dev.to/harikrishnan_ortezinfote/the-backend-problem-most-indian-hotels-dont-talk-about-1hhf
- https://www.hotelogix.com/marketplace/product/hostbooks
