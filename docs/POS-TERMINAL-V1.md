# NMK Opticals POS Terminal — v1

## Included

The cashier terminal is available at `/admin/pos` after an admin signs in.

- Select an active inventory location.
- Create sellable product variants with SKU, optional barcode, attributes and optional price override.
- Receive stock against a selected variant/location with an idempotency key and audit reason.
- View on-hand, reserved and available stock by variant.
- Search the server catalogue by product name, category, SKU or barcode.
- Select the exact sellable variant and add it to the bill.
- See current location stock and prevent adding more than the displayed available quantity.
- Capture optional walk-in customer name and phone.
- Apply a direct rupee discount.
- Accept cash, UPI or card, including split tender across up to three methods.
- Calculate cash change.
- Submit the sale through the authenticated POS checkout API.
- View paginated sales history, inspect a transaction and print/reprint an invoice.
- Retry uncertain checkout requests with the same idempotency key and unchanged payload to reduce duplicate-sale risk.

## Backend contract

The terminal uses the existing backend endpoints:

- `GET /api/admin/pos/locations`
- `GET /api/admin/pos/catalog?locationId={id}`
- `POST /api/admin/pos/checkout`
- `GET /api/admin/pos/sales?page={page}&size=20&locationId={id}`
- `GET /api/admin/pos/sales/{saleId}`

Prices, variant ownership, payment totals and stock deductions are validated by the backend. The browser does not submit a trusted price or stock count. A successful checkout records the sale, item/payment snapshots and stock movements in the backend transaction.

Stock receipts are handled separately through the authenticated inventory receipt endpoint; a cashier sale must never be used to create opening stock.

## Deliberate v1 exclusions

This terminal does not claim to implement the complete retail operations suite. These features remain separate work:

- Cash registers, cashier shifts, opening floats, cash-in/out and shift closing/reconciliation.
- Returns, exchanges, refunds, voids and credit notes.
- GST/tax calculation and accountant-approved invoice numbering/wording.
- Supplier purchasing, goods receipt, purchase returns and stock counts.
- Fine-grained OWNER/MANAGER/CASHIER role and approval matrix.

These require approved shop/accounting policies and additive schema migrations. Completed sales must not be edited or deleted to simulate a return or refund.

## Deployment gate

No live/client database migration is performed by the frontend terminal. Before production POS use, the backend's manual variant/inventory/POS migrations must be reviewed, tested on a restorable staging copy, and explicitly approved for the client database. Set `VITE_API_BASE_URL` consistently for the storefront, admin login/dashboard and POS terminal. The default is `http://localhost:8080/api`; for the isolated local E2E backend use `http://localhost:8082/api`. Configure the production API URL and backend CORS allowlist separately; do not deploy the local development API URL.


## Stock adjustment capability (operations branch)

The Inventory tab now also supports an authenticated stock adjustment for verified physical count differences, damage/write-offs and documented discrepancies.

- Positive quantity change adds stock; negative quantity change removes stock.
- A non-zero adjustment reason and a fresh idempotency key are required.
- The exact same request must be retried after an uncertain network response.
- The backend prevents adjustments from reducing on-hand below stock reserved for online orders and writes an append-only stock movement.
- Supplier deliveries must still use stock receipt. This adjustment form is not a full stock-count session with frozen snapshots or approval workflow.
