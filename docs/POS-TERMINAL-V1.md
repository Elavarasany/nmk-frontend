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
- Open a cashier shift with an opening cash float before the first sale.
- Record audited cash-in and cash-out drawer movements with reasons.
- Calculate expected drawer cash from opening float, cash tenders and cash movements.
- Close a shift with an actual cash count and a mandatory explanation for any variance.
- Link each new POS sale and cash tender to the active cashier shift.
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

- Multi-register assignment policies, shift reopening, supervisor override thresholds and cross-register cash transfers. Basic register, shift, opening-float, cash-in/out and closing-reconciliation workflows are implemented.
- Exchanges, sale voids, credit notes and automated provider refund execution. Manager/admin customer returns with audited refund records and stock disposition are now implemented; provider refunds still require external completion and reference capture.
- GST/tax calculation and accountant-approved invoice numbering/wording.
- Supplier purchasing, goods receipt, purchase returns and stock counts.
- Full permission-code matrix, per-register restrictions and approval workflows. The first ADMIN/MANAGER/CASHIER role layer is now available; see the staff management notes below.

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


## Staff roles (operations branch)

Administrators can create and manage staff accounts from Admin → Staff. Staff passwords must be at least 12 characters and are BCrypt-hashed by the backend. Existing admin accounts retain the ADMIN role by default after the additive migration.

- ADMIN: full admin portal, POS, staff management and inventory operations.
- MANAGER: POS checkout, sales history and inventory receipt/adjustment APIs.
- CASHIER: POS checkout and product/location lookup only; no all-sales history, inventory adjustments or admin portal.

Disabled staff accounts are rejected at login and their previously issued tokens are rejected on subsequent API requests. A staff member cannot disable their own account, and the final active administrator cannot be disabled or demoted.

Backend migration: `nmk-backend/src/main/resources/db/manual/006-add-staff-roles.sql`. This migration is manual and additive. It must be reviewed and tested on a disposable staging copy before use; it has not been run against any live/client database.


## Register and shift operation

The backend migration `007-create-register-shifts-cash.sql` creates a MAIN register for each active location and the append-only cash movement ledger. A cashier must open a shift before checkout; a new sale must reference that shift. Cash sales add the payment allocation (not the tendered amount) to expected drawer cash. Change returned to the customer is excluded from drawer income.

The POS page shows register selection, opening float, expected drawer cash, cash-in/out and shift closing. A cash variance requires an explanation. Cashier access is limited to their own shift; managers and administrators can review and close shifts. The checkout, cash tender ledger and stock deduction commit in one backend transaction.

Migration 007 is manual and has not been executed against any live/client database.


## Customer returns

Managers and administrators can open a completed sale from Sales history and process a partial or full return. The POS calculates the refund from the original sale line snapshot and allocates the original sale discount proportionally. Previously returned quantities are shown as remaining quantities; the backend enforces the same limit under a sale-row lock.

Each returned line must be classified as RESTOCK, DAMAGED or DISCARD. Only RESTOCK adds inventory, and it writes a dedicated append-only stock movement. DAMAGED and DISCARD require a reason and do not increase stock. Cash refunds reduce the active shift's expected drawer cash. UPI/card refunds require a provider transaction reference; the POS records that reference but does not itself execute the provider refund.

Backend migration: `008-create-customer-returns.sql`. It is manual and has not been run against any live/client database.


## Physical stock count sessions

Managers and administrators can start a physical stock count from the Inventory tab. The backend snapshots every variant at the location and freezes stock-changing operations until the count is posted or cancelled. Enter and save the physical quantity for each line, submit the completed count for review, then post the variances. Each non-zero difference becomes a `COUNT_VARIANCE` stock movement linked to the session.

The POS catalogue exposes the location freeze state so the cashier terminal warns and disables checkout while a count is active. A failed post leaves the location frozen; retry the post or cancel the session after reviewing it. Do not manually clear the location lock in the database.

Backend migration: `009-create-stock-count-sessions.sql`. It is manual and has not been run against any live/client database.


## Supplier procurement (backend API foundation)

The backend now supports supplier records, DRAFT purchase orders, order submission, partial/full goods receipts and supplier returns. Goods receipt creates stock only after the receipt is recorded; supplier returns reduce stock and cannot remove reserved units. Both flows use idempotency keys and append-only stock movements. The current POS screen does not yet expose the procurement workflow as a dedicated user interface.

Supplier credit notes, accounts payable, GST/landed-cost accounting and automatic supplier payments are not included. These require the client's accounting policies and accountant-approved tax rules.

Backend migration: `010-create-procurement.sql`. It is manual and has not been run against any live/client database.
