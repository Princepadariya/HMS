# Hotel ERP - API contract

JSON over HTTP. Staff calls send `Authorization: Bearer <token>` from `POST /api/login`.
Money = integer paise. Dates = `YYYY-MM-DD`. Errors: `{ "error": "message" }` with 400/401/403/404/409.
Group-level users pass `property_id` (query or body); property users are always scoped to their own hotel.
A 403 whose message contains `needs manager approval` can be retried with `override: { username, password }` of a GM/duty manager.

| Method & path | Permission | Body / query → result |
|---|---|---|
| POST /api/login | public | `{username,password}` → `{token,user}` |
| POST /api/logout | any | → `{ok}` |
| GET /api/me | any | → `{user, perms, properties}` |
| GET/POST/PUT /api/{properties,room_types,rooms,rate_plans,rate_prices,menu_items,suppliers,items,guests}[/:id] | read: varies, write: admin/rates/menu/po/res | list (`?q=` search on guests), create, update |
| GET/POST/PUT /api/users[/:id] | admin | `{username,name,role,property_id,password,active}` |
| GET /api/availability | res | `?property_id&arrival&departure&adults` → room types with plans, nightly prices, total, available |
| GET /api/guests/:id/history | res | → guest + stays at all hotels |
| GET /api/reservations | res | `?property_id&status&arrival&departure&q` → list with balance |
| POST /api/reservations | res | `{property_id,rate_plan_id,arrival,departure,adults,source,guest_id|guest{},ota_ref,notes,advance{mode,amount,reference}}` → reservation |
| GET /api/reservations/:id | res | → reservation, guest, room, lines, payments, invoice, balance |
| POST /api/reservations/:id/check-in | res | `{room_id,id_type,id_number,nationality,form_c_no}` |
| POST /api/reservations/:id/cancel | res | `{reason}` |
| POST /api/reservations/:id/charges | res | `{category: room|fnb|extra, description, amount, tax_rate?}` |
| POST /api/reservations/:id/discount | res (+approval over limit) | `{line_id, amount, reason, override?}` |
| POST /api/folio-lines/:id/void | approval | `{reason, override?}` |
| POST /api/reservations/:id/payments | res (refund = negative, needs approval) | `{mode: cash|card|upi|online, amount, reference, override?}` |
| POST /api/reservations/:id/check-out | res | `{bill_to?, bill_to_gstin?}` → invoice |
| GET /api/invoices, /api/invoices/:id | res/pos/acc | `?property_id&from&to` |
| GET /api/housekeeping | hk/res | `?property_id` → rooms with status, guest, departing flag |
| POST /api/rooms/:id/hk | hk (inspected: hk_inspect) | `{hk_status: clean|dirty|inspected}` |
| GET/POST /api/tickets, POST /api/tickets/:id/resolve | mt/hk/res | `{room_id,title,priority,blocks_room}` / `{resolution}` |
| GET/POST /api/pos/orders, GET /api/pos/orders/:id | pos | `{property_id,table_no,reservation_id?}` |
| POST /api/pos/orders/:id/lines, .../lines/:lineId/remove | pos | `{menu_item_id, qty}`; the same dish at the same price merges into one line |
| POST /api/pos/orders/:id/lines/:lineId/qty | pos | `{qty}` 0–100; 0 removes the line |
| POST /api/pos/orders/:id/settle | pos | `{to:'room', reservation_id}` or `{to:'direct', mode, reference, bill_to, bill_to_gstin}` |
| POST /api/pos/orders/:id/void | approval | `{reason, override?}` |
| GET /api/stock, GET /api/stock/moves, POST /api/stock/issue | inv | `{property_id,item_id,qty,department}` |
| GET/POST /api/purchase-orders, GET /api/purchase-orders/:id | po/inv/acc | `{property_id,supplier_id,lines:[{item_id,qty,rate}]}` |
| POST /api/purchase-orders/:id/{approve,reject} | po_gm / po_central | |
| POST /api/purchase-orders/:id/receive | inv/po | stock in, ledger |
| POST /api/purchase-orders/:id/pay | acc | `{mode: cash|bank}` |
| GET /api/accounts, GET/POST /api/journals | acc (read: reports) | manual journal `{property_id,date,memo,lines:[{account_code,debit,credit}]}` |
| GET /api/reports/{trial-balance,pnl,balance-sheet,gst,dashboard} | acc/reports | `?property_id&from&to` |
| GET/POST /api/night-audit | audit | `?property_id` preview + history / run |
| GET /api/audit-log | admin (owner only) | `?property_id`; rows include user name and role |
| GET /api/public/properties, /api/public/availability, POST /api/public/book | public | booking website (pay at hotel); book = `{property_id,rate_plan_id,arrival,departure,adults,name,phone,email,nationality,notes}` → `{code, arrival, departure, room_type, hotel, hotel_phone, total}` |
