import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Search, RefreshCw, Plus, Minus, Trash2, Receipt,
  History, ShoppingCart, Store, Printer, X, CheckCircle2,
  AlertCircle, UserRound, CreditCard,
  ChevronLeft, ChevronRight, Package, ScanLine
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./PosTerminal.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080/api";
const money = (value) => Number(value || 0).toLocaleString("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2
});
const amount = (value) => Number(value || 0).toFixed(2);
const newIdempotencyKey = () => globalThis.crypto?.randomUUID?.() ||
  `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function apiRequest(path, options = {}) {
  const token = sessionStorage.getItem("adminToken");
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (response.status === 401 || response.status === 403) {
    const error = new Error("Your admin session is invalid or expired. Sign in again.");
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function ProductImage({ src, name }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="pos-product-placeholder"><Package size={28} /></div>;
  return <img src={src} alt={name} onError={() => setFailed(true)} loading="lazy" />;
}

function ReceiptView({ sale, onClose }) {
  if (!sale) return null;
  const print = () => window.print();
  return (
    <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="pos-receipt-modal" role="dialog" aria-modal="true" aria-labelledby="pos-receipt-title">
        <div className="pos-modal-toolbar">
          <div><span className="pos-eyebrow">SALE COMPLETED</span><h2 id="pos-receipt-title">Invoice preview</h2></div>
          <button className="pos-icon-button" type="button" onClick={onClose} aria-label="Close receipt"><X /></button>
        </div>
        <div className="pos-receipt-print">
          <div className="pos-receipt-brand">
            <strong>NMK OPTICALS</strong>
            <span>SALES INVOICE</span>
          </div>
          <div className="pos-receipt-meta">
            <div><span>Invoice</span><strong>{sale.invoiceNumber}</strong></div>
            <div><span>Date</span><strong>{sale.createdAt ? new Date(sale.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</strong></div>
            <div><span>Cashier</span><strong>{sale.cashierUsername || "—"}</strong></div>
            <div><span>Customer</span><strong>{sale.customerName || "Walk-in customer"}</strong></div>
            {sale.customerPhone && <div><span>Phone</span><strong>{sale.customerPhone}</strong></div>}
          </div>
          <table className="pos-receipt-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
            <tbody>{(sale.items || []).map((item, index) => (
              <tr key={`${item.variantId}-${index}`}>
                <td><strong>{item.productName}</strong><small>{item.variantName || item.sku}</small></td>
                <td>{item.quantity}</td><td>{money(item.unitPrice)}</td><td>{money(item.lineTotal)}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="pos-receipt-totals">
            <div><span>Subtotal</span><strong>{money(sale.subtotal)}</strong></div>
            <div><span>Discount</span><strong>− {money(sale.discountAmount)}</strong></div>
            <div className="grand"><span>Grand total</span><strong>{money(sale.grandTotal)}</strong></div>
          </div>
          <div className="pos-receipt-payments">
            <strong>Payment details</strong>
            {(sale.payments || []).map((payment, index) => (
              <div key={index}><span>{payment.paymentMethod}</span><span>{money(payment.amount)}</span></div>
            ))}
            {(sale.payments || []).filter((p) => p.paymentMethod === "CASH" && Number(p.changeAmount) > 0)
              .map((p, index) => <div key={`change-${index}`}><span>Change</span><span>{money(p.changeAmount)}</span></div>)}
          </div>
          <p className="pos-receipt-thanks">Thank you for shopping with NMK Opticals.</p>
          <p className="pos-receipt-footnote">Computer-generated invoice · Please retain for your records</p>
        </div>
        <div className="pos-modal-actions">
          <button type="button" className="pos-button secondary" onClick={onClose}>Close</button>
          <button type="button" className="pos-button primary" onClick={print}><Printer size={17} /> Print invoice</button>
        </div>
      </section>
    </div>
  );
}


function InventoryPanel({ locationId, catalog, onRefreshCatalog, onNotice, onError }) {
  const [products, setProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [variants, setVariants] = useState([]);
  const [variantsLoading, setVariantsLoading] = useState(false);
  const [variantSaving, setVariantSaving] = useState(false);
  const [variantForm, setVariantForm] = useState({
    sku: "", barcode: "", variantName: "", attributes: '{"color":"Black","size":"Medium"}', sellingPriceOverride: ""
  });
  const [selectedVariantId, setSelectedVariantId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("Supplier stock receipt");
  const [receiptSaving, setReceiptSaving] = useState(false);
  const [receiptRetry, setReceiptRetry] = useState(false);
  const receiptPayload = useRef(null);
  const [adjustmentDelta, setAdjustmentDelta] = useState("0");
  const [adjustmentReason, setAdjustmentReason] = useState("Physical stock count correction");
  const [adjustmentSaving, setAdjustmentSaving] = useState(false);
  const [adjustmentRetry, setAdjustmentRetry] = useState(false);
  const adjustmentPayload = useRef(null);

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    try {
      const data = await apiRequest("/admin/products");
      const list = Array.isArray(data) ? data.filter((product) => product.active !== false) : [];
      setProducts(list);
      setSelectedProductId((current) => current && list.some((p) => String(p.id) === String(current))
        ? current : (list[0]?.id ? String(list[0].id) : ""));
    } catch (err) { onError(err.message); }
    finally { setProductsLoading(false); }
  }, [onError]);

  const loadVariants = useCallback(async (productId) => {
    if (!productId) { setVariants([]); return; }
    setVariantsLoading(true);
    try {
      const data = await apiRequest(`/admin/products/${productId}/variants`);
      const list = Array.isArray(data) ? data : [];
      setVariants(list);
      setSelectedVariantId((current) => current && list.some((v) => String(v.id) === String(current) && v.active)
        ? current : (list.find((v) => v.active)?.id ? String(list.find((v) => v.active).id) : ""));
    } catch (err) { onError(err.message); }
    finally { setVariantsLoading(false); }
  }, [onError]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { if (selectedProductId) loadVariants(selectedProductId); else setVariants([]); }, [selectedProductId, loadVariants]);

  const updateVariantForm = (field, value) => setVariantForm((current) => ({ ...current, [field]: value }));

  const createVariant = async (event) => {
    event.preventDefault();
    onError("");
    if (!selectedProductId) { onError("Choose a product before creating a variant."); return; }
    let attributes;
    try {
      attributes = variantForm.attributes.trim() ? JSON.parse(variantForm.attributes) : {};
      if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
        throw new Error("Attributes must be a JSON object.");
      }
    } catch (err) { onError(err.message || "Enter valid JSON attributes."); return; }
    const body = {
      sku: variantForm.sku.trim(),
      barcode: variantForm.barcode.trim() || null,
      variantName: variantForm.variantName.trim(),
      attributes,
      ...(variantForm.sellingPriceOverride.trim()
        ? { sellingPriceOverride: Number(variantForm.sellingPriceOverride) } : {}),
    };
    setVariantSaving(true);
    try {
      const created = await apiRequest(`/admin/products/${selectedProductId}/variants`, {
        method: "POST", body: JSON.stringify(body)
      });
      setVariantForm({ sku: "", barcode: "", variantName: "", attributes: '{"color":"Black","size":"Medium"}', sellingPriceOverride: "" });
      await loadVariants(selectedProductId);
      if (created?.id) setSelectedVariantId(String(created.id));
      await onRefreshCatalog();
      onNotice(`Variant ${created?.sku || body.sku} created.`);
    } catch (err) { onError(err.message); }
    finally { setVariantSaving(false); }
  };

  const receiveStock = async (event) => {
    event.preventDefault();
    onError("");
    if (!locationId) { onError("Choose an active inventory location."); return; }
    if (!selectedVariantId) { onError("Create or select an active variant first."); return; }
    if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      onError("Stock quantity must be a positive whole number."); return;
    }
    if (!reason.trim()) { onError("A stock receipt reason is required."); return; }

    if (!receiptPayload.current) {
      receiptPayload.current = {
        locationId: Number(locationId),
        variantId: Number(selectedVariantId),
        quantity: Number(quantity),
        idempotencyKey: newIdempotencyKey(),
        reason: reason.trim(),
      };
    }
    setReceiptSaving(true);
    try {
      const result = await apiRequest("/admin/inventory/receive", {
        method: "POST", body: JSON.stringify(receiptPayload.current)
      });
      receiptPayload.current = null;
      setReceiptRetry(false);
      setQuantity("1");
      await onRefreshCatalog();
      onNotice(`Stock received. Available quantity is now ${result.availableQuantity}.`);
    } catch (err) {
      if (!err.status || err.status >= 500 || err.status === 409) {
        setReceiptRetry(true);
        onError(`${err.message} Retry this exact receipt to safely reuse its idempotency key.`);
      } else {
        receiptPayload.current = null;
        setReceiptRetry(false);
        onError(err.message);
      }
    } finally { setReceiptSaving(false); }
  };

  const adjustStock = async (event) => {
    event.preventDefault();
    onError("");
    if (!locationId) { onError("Choose an active inventory location."); return; }
    if (!selectedVariantId) { onError("Choose an active variant before adjusting stock."); return; }
    const delta = Number(adjustmentDelta);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000000) {
      onError("Adjustment must be a non-zero whole number between -1,000,000 and 1,000,000.");
      return;
    }
    if (!adjustmentReason.trim()) { onError("A stock adjustment reason is required."); return; }

    if (!adjustmentPayload.current) {
      adjustmentPayload.current = {
        locationId: Number(locationId),
        variantId: Number(selectedVariantId),
        quantityDelta: delta,
        idempotencyKey: newIdempotencyKey(),
        reason: adjustmentReason.trim(),
      };
    }
    setAdjustmentSaving(true);
    try {
      const result = await apiRequest("/admin/inventory/adjust", {
        method: "POST", body: JSON.stringify(adjustmentPayload.current)
      });
      adjustmentPayload.current = null;
      setAdjustmentRetry(false);
      setAdjustmentDelta("0");
      await onRefreshCatalog();
      onNotice(`Stock adjusted. On hand: ${result.onHandQuantity}; available: ${result.availableQuantity}.`);
    } catch (err) {
      if (!err.status || err.status >= 500 || err.status === 409) {
        setAdjustmentRetry(true);
        onError(`${err.message} Retry the exact same adjustment to safely reuse its idempotency key.`);
      } else {
        adjustmentPayload.current = null;
        setAdjustmentRetry(false);
        onError(err.message);
      }
    } finally { setAdjustmentSaving(false); }
  };

  const selectedProduct = products.find((product) => String(product.id) === String(selectedProductId));
  const stockRows = catalog.find((product) => String(product.productId) === String(selectedProductId))?.variants || [];

  return (
    <section className="pos-inventory-workspace">
      <div className="pos-inventory-intro">
        <div><span className="pos-eyebrow">CATALOGUE & STOCK CONTROL</span><h2>Inventory setup</h2><p>Create sellable variants and receive physical stock into the selected store location.</p></div>
        <button type="button" className="pos-button secondary compact" onClick={() => { loadProducts(); onRefreshCatalog(); }} disabled={productsLoading || variantsLoading}><RefreshCw size={15} /> Refresh inventory</button>
      </div>
      <div className="pos-inventory-grid">
        <section className="pos-inventory-card">
          <div className="pos-inventory-card-heading"><Package size={18} /><div><h3>Create product variant</h3><p>Each sellable colour/size combination needs its own SKU.</p></div></div>
          <form onSubmit={createVariant} className="pos-inventory-form">
            <label>Product
              <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)} disabled={productsLoading || receiptRetry} required>
                {products.length ? products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>) : <option value="">No active products</option>}
              </select>
            </label>
            <div className="pos-inventory-fields">
              <label>Variant name<input value={variantForm.variantName} onChange={(e) => updateVariantForm("variantName", e.target.value)} placeholder="Black - Medium" maxLength={255} required /></label>
              <label>SKU<input value={variantForm.sku} onChange={(e) => updateVariantForm("sku", e.target.value)} placeholder="FRAME-BLK-M" maxLength={100} required /></label>
              <label>Barcode (optional)<input value={variantForm.barcode} onChange={(e) => updateVariantForm("barcode", e.target.value)} placeholder="Scan or enter barcode" maxLength={100} /></label>
              <label>Selling price override (₹)<input type="number" min="0.01" step="0.01" value={variantForm.sellingPriceOverride} onChange={(e) => updateVariantForm("sellingPriceOverride", e.target.value)} placeholder={selectedProduct?.price ? `Default ${money(selectedProduct.price)}` : "Use product price"} /></label>
            </div>
            <label>Variant attributes (JSON)
              <textarea value={variantForm.attributes} onChange={(e) => updateVariantForm("attributes", e.target.value)} rows={3} placeholder='{"color":"Black","size":"Medium"}' spellCheck="false" />
              <small>Example: {"{\"color\":\"Black\",\"size\":\"Medium\"}"}. Attributes are saved with the SKU.</small>
            </label>
            <button type="submit" className="pos-button primary" disabled={variantSaving || productsLoading || !selectedProductId}>
              {variantSaving ? <><RefreshCw className="pos-spin" size={15} /> Creating…</> : <><Plus size={16} /> Create variant</>}
            </button>
          </form>
        </section>

        <section className="pos-inventory-card">
          <div className="pos-inventory-card-heading"><Store size={18} /><div><h3>Receive stock</h3><p>Record supplier receipts against a specific SKU and location.</p></div></div>
          <form onSubmit={receiveStock} className="pos-inventory-form">
            <label>Product
              <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)} disabled={productsLoading || receiptRetry} required>
                {products.length ? products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>) : <option value="">No active products</option>}
              </select>
            </label>
            <label>Active variant / SKU
              <select value={selectedVariantId} onChange={(e) => setSelectedVariantId(e.target.value)} disabled={variantsLoading || receiptRetry || !variants.some((v) => v.active)} required>
                {variants.filter((v) => v.active).length
                  ? variants.filter((v) => v.active).map((variant) => <option key={variant.id} value={variant.id}>{variant.variantName} · {variant.sku}</option>)
                  : <option value="">Create an active variant first</option>}
              </select>
            </label>
            <div className="pos-inventory-fields">
              <label>Quantity received<input type="number" min="1" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={receiptRetry} required /></label>
              <label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} disabled={receiptRetry} maxLength={500} required /></label>
            </div>
            {receiptRetry && <p className="pos-retry-note">A previous receipt response was uncertain. Retry without changing the product, quantity or reason.</p>}
            <button type="submit" className="pos-button primary" disabled={receiptSaving || !locationId || !selectedVariantId}>
              {receiptSaving ? <><RefreshCw className="pos-spin" size={15} /> Receiving…</> : receiptRetry ? <><RefreshCw size={15} /> Retry same receipt</> : <><Plus size={16} /> Receive stock</>}
            </button>
          </form>
        </section>

        <section className="pos-inventory-card">
          <div className="pos-inventory-card-heading"><Package size={18} /><div><h3>Stock adjustment</h3><p>Correct a physical count, damage or verified stock discrepancy. Every change is recorded.</p></div></div>
          <form onSubmit={adjustStock} className="pos-inventory-form">
            <label>Product
              <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)} disabled={productsLoading || adjustmentRetry} required>
                {products.length ? products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>) : <option value="">No active products</option>}
              </select>
            </label>
            <label>Active variant / SKU
              <select value={selectedVariantId} onChange={(e) => setSelectedVariantId(e.target.value)} disabled={variantsLoading || adjustmentRetry || !variants.some((v) => v.active)} required>
                {variants.filter((v) => v.active).length
                  ? variants.filter((v) => v.active).map((variant) => <option key={variant.id} value={variant.id}>{variant.variantName} · {variant.sku}</option>)
                  : <option value="">Create an active variant first</option>}
              </select>
            </label>
            <div className="pos-inventory-fields">
              <label>Quantity change (+ / −)<input type="number" min="-1000000" max="1000000" step="1" value={adjustmentDelta} onChange={(e) => setAdjustmentDelta(e.target.value)} disabled={adjustmentRetry} required /></label>
              <label>Reason<input value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} disabled={adjustmentRetry} maxLength={500} required /></label>
            </div>
            <small>Use a positive number to add stock and a negative number to remove stock. Adjustments cannot reduce on-hand below stock already reserved for online orders.</small>
            {adjustmentRetry && <p className="pos-retry-note">A previous adjustment response was uncertain. Retry without changing the product, quantity or reason.</p>}
            <button type="submit" className="pos-button primary" disabled={adjustmentSaving || !locationId || !selectedVariantId}>
              {adjustmentSaving ? <><RefreshCw className="pos-spin" size={15} /> Adjusting…</> : adjustmentRetry ? <><RefreshCw size={15} /> Retry same adjustment</> : <><Plus size={16} /> Apply adjustment</>}
            </button>
          </form>
        </section>
      </div>

      <section className="pos-inventory-card pos-stock-card">
        <div className="pos-inventory-card-heading"><Package size={18} /><div><h3>Current stock by variant</h3><p>{selectedProduct?.name || "Select a product"} · {stockRows.length} active variants at this location</p></div></div>
        {variantsLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading variants…</span></div>
          : stockRows.length === 0 ? <div className="pos-empty-state"><Package /><strong>No stockable variants yet</strong><span>Create a variant and receive stock to make this product available in POS.</span></div>
          : <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Variant</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Price</th></tr></thead><tbody>{stockRows.map((variant) => <tr key={variant.variantId}><td><strong>{variant.variantName}</strong></td><td>{variant.sku}</td><td>{variant.onHandQuantity}</td><td>{variant.reservedQuantity}</td><td><strong>{variant.availableQuantity}</strong></td><td>{money(variant.sellingPrice)}</td></tr>)}</tbody></table></div>}
      </section>
    </section>
  );
}

export default function PosTerminal() {
  const navigate = useNavigate();
  const staffRole = sessionStorage.getItem("adminRole") || "ADMIN";
  const canManageInventory = staffRole === "ADMIN" || staffRole === "MANAGER";
  const canViewHistory = staffRole === "ADMIN" || staffRole === "MANAGER";
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [registers, setRegisters] = useState([]);
  const [registerId, setRegisterId] = useState("");
  const [shift, setShift] = useState(null);
  const [shiftLoading, setShiftLoading] = useState(false);
  const [shiftSaving, setShiftSaving] = useState(false);
  const [openingFloat, setOpeningFloat] = useState("0.00");
  const [closingCashCount, setClosingCashCount] = useState("");
  const [closingReason, setClosingReason] = useState("");
  const [cashMovementType, setCashMovementType] = useState("CASH_IN");
  const [cashMovementAmount, setCashMovementAmount] = useState("");
  const [cashMovementReason, setCashMovementReason] = useState("");
  const [newRegisterCode, setNewRegisterCode] = useState("MAIN");
  const [newRegisterName, setNewRegisterName] = useState("Main Register");
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [locationsLoading, setLocationsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("checkout");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [selectedVariants, setSelectedVariants] = useState({});
  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [discount, setDiscount] = useState("0.00");
  const [payments, setPayments] = useState([{ paymentMethod: "CASH", amount: "0.00", tenderedAmount: "0.00", transactionReference: "" }]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [retryPending, setRetryPending] = useState(false);
  const [pendingPayload, setPendingPayload] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPages, setHistoryPages] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [selectedHistorySale, setSelectedHistorySale] = useState(null);
  const pendingKey = useRef(null);
  const searchRef = useRef(null);

  const loadLocations = useCallback(async () => {
    setLocationsLoading(true);
    setError("");
    try {
      const data = await apiRequest("/admin/pos/locations");
      const list = Array.isArray(data) ? data : [];
      setLocations(list);
      setLocationId((current) => current && list.some((item) => String(item.id) === String(current))
        ? current : (list[0]?.id ? String(list[0].id) : ""));
      if (!list.length) setError("No active store location is configured. Create and activate an inventory location before using POS.");
    } catch (err) { setError(err.message); }
    finally { setLocationsLoading(false); }
  }, []);

  const loadRegisters = useCallback(async () => {
    if (!locationId) {
      setRegisters([]);
      setRegisterId("");
      setShift(null);
      return;
    }
    try {
      const data = await apiRequest(`/admin/pos/registers?locationId=${encodeURIComponent(locationId)}`);
      const list = Array.isArray(data) ? data : [];
      setRegisters(list);
      setRegisterId((current) => current && list.some((item) => String(item.id) === String(current))
        ? current : (list[0]?.id ? String(list[0].id) : ""));
      if (!list.length) setShift(null);
    } catch (err) {
      setRegisters([]);
      setRegisterId("");
      setShift(null);
      setError(err.message);
    }
  }, [locationId]);

  const loadCurrentShift = useCallback(async () => {
    if (!registerId) {
      setShift(null);
      return;
    }
    setShiftLoading(true);
    try {
      const data = await apiRequest(`/admin/pos/shifts/current?registerId=${encodeURIComponent(registerId)}`);
      setShift(data || null);
      setClosingCashCount(data?.expectedCash != null ? amount(data.expectedCash) : "");
    } catch (err) {
      setShift(null);
      setError(err.message);
    } finally {
      setShiftLoading(false);
    }
  }, [registerId]);

  const openShift = async () => {
    if (!registerId) { setError("Select a register before opening a shift."); return; }
    const float = Number(openingFloat);
    if (!Number.isFinite(float) || float < 0) { setError("Enter a valid opening cash float."); return; }
    setShiftSaving(true);
    setError("");
    try {
      const opened = await apiRequest("/admin/pos/shifts/open", {
        method: "POST",
        body: JSON.stringify({
          registerId: Number(registerId),
          openingFloat: Number(amount(float)),
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setShift(opened);
      setClosingCashCount(amount(opened.expectedCash));
      setNotice("Cashier shift opened.");
    } catch (err) {
      setError(err.message);
    } finally {
      setShiftSaving(false);
    }
  };

  const createRegister = async () => {
    if (!locationId || !newRegisterCode.trim() || !newRegisterName.trim()) {
      setError("Register code and name are required.");
      return;
    }
    setShiftSaving(true);
    setError("");
    try {
      await apiRequest("/admin/pos/registers", {
        method: "POST",
        body: JSON.stringify({
          locationId: Number(locationId),
          registerCode: newRegisterCode.trim(),
          name: newRegisterName.trim(),
        }),
      });
      await loadRegisters();
      setNotice("Register created.");
    } catch (err) {
      setError(err.message);
    } finally {
      setShiftSaving(false);
    }
  };

  const addCashMovement = async () => {
    if (!shift?.id) { setError("Open a shift before recording drawer cash."); return; }
    const value = Number(cashMovementAmount);
    if (!Number.isFinite(value) || value <= 0 || !cashMovementReason.trim()) {
      setError("Enter a positive amount and a reason for the cash movement.");
      return;
    }
    setShiftSaving(true);
    setError("");
    try {
      const updated = await apiRequest(`/admin/pos/shifts/${shift.id}/cash-movements`, {
        method: "POST",
        body: JSON.stringify({
          movementType: cashMovementType,
          amount: Number(amount(value)),
          idempotencyKey: newIdempotencyKey(),
          reason: cashMovementReason.trim(),
        }),
      });
      setShift(updated);
      setClosingCashCount(amount(updated.expectedCash));
      setCashMovementAmount("");
      setCashMovementReason("");
      setNotice(cashMovementType === "CASH_IN" ? "Cash added to drawer." : "Cash removed from drawer.");
    } catch (err) {
      setError(err.message);
    } finally {
      setShiftSaving(false);
    }
  };

  const closeShift = async () => {
    if (!shift?.id) return;
    const counted = Number(closingCashCount);
    if (!Number.isFinite(counted) || counted < 0) {
      setError("Enter the actual cash counted in the drawer.");
      return;
    }
    const variance = Number((counted - Number(shift.expectedCash || 0)).toFixed(2));
    if (Math.abs(variance) > 0.001 && !closingReason.trim()) {
      setError("Explain the cash difference before closing the shift.");
      return;
    }
    setShiftSaving(true);
    setError("");
    try {
      const closed = await apiRequest(`/admin/pos/shifts/${shift.id}/close`, {
        method: "POST",
        body: JSON.stringify({
          closingCashCount: Number(amount(counted)),
          reason: closingReason.trim() || null,
        }),
      });
      setShift(closed);
      setNotice(`Shift closed. Cash variance: ${money(closed.cashVariance)}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setShiftSaving(false);
    }
  };

  const loadCatalog = useCallback(async () => {
    if (!locationId) { setCatalog([]); return; }
    setCatalogLoading(true);
    setError("");
    try {
      const data = await apiRequest(`/admin/pos/catalog?locationId=${encodeURIComponent(locationId)}`);
      setCatalog(Array.isArray(data?.products) ? data.products : []);
      setSelectedVariants({});
    } catch (err) { setError(err.message); }
    finally { setCatalogLoading(false); }
  }, [locationId]);

  const loadHistory = useCallback(async (page = 0) => {
    setHistoryLoading(true);
    setError("");
    try {
      const data = await apiRequest(`/admin/pos/sales?page=${page}&size=20${locationId ? `&locationId=${encodeURIComponent(locationId)}` : ""}`);
      setHistory(Array.isArray(data?.content) ? data.content : []);
      setHistoryPage(Number(data?.number || 0));
      setHistoryPages(Number(data?.totalPages || 0));
    } catch (err) { setError(err.message); }
    finally { setHistoryLoading(false); }
  }, [locationId]);

  useEffect(() => { loadLocations(); }, [loadLocations]);
  useEffect(() => { loadRegisters(); }, [loadRegisters]);
  useEffect(() => { if (registerId) loadCurrentShift(); }, [registerId, loadCurrentShift]);
  useEffect(() => { if (locationId) loadCatalog(); }, [locationId, loadCatalog]);
  useEffect(() => { if (activeTab === "history") loadHistory(0); }, [activeTab, loadHistory]);

  const categories = useMemo(() => ["All", ...new Set(catalog.map((p) => p.category).filter(Boolean))], [catalog]);
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return catalog.filter((product) => {
      if (category !== "All" && product.category !== category) return false;
      if (!term) return true;
      const variants = (product.variants || []).map((v) =>
        [v.sku, v.barcode, v.variantName, ...Object.values(v.attributes || {})].join(" ")
      ).join(" ");
      return [product.name, product.category, product.gender, variants].join(" ").toLowerCase().includes(term);
    });
  }, [catalog, category, search]);

  const subtotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discountValue = Math.max(0, Number((Number(discount) || 0).toFixed(2)));
  const grandTotal = Math.max(0, subtotal - discountValue);
  const paymentTotal = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const cashChange = payments.filter((p) => p.paymentMethod === "CASH")
    .reduce((sum, p) => sum + Math.max(0, (Number(p.tenderedAmount) || 0) - (Number(p.amount) || 0)), 0);

  useEffect(() => {
    if (payments.length === 1) {
      setPayments((current) => current.length === 1 ? [{
        ...current[0],
        amount: amount(grandTotal),
        tenderedAmount: current[0].paymentMethod === "CASH"
          ? amount(Math.max(Number(current[0].tenderedAmount) || 0, grandTotal))
          : current[0].tenderedAmount,
      }] : current);
    }
  }, [grandTotal, payments.length]);

  const addToCart = (product, variant) => {
    if (variant.availableQuantity <= 0) return;
    setCart((current) => {
      const found = current.find((item) => item.variantId === variant.variantId);
      if (found) {
        if (found.quantity >= variant.availableQuantity) return current;
        return current.map((item) => item.variantId === variant.variantId
          ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...current, {
        productId: product.productId,
        variantId: variant.variantId,
        productName: product.name,
        variantName: variant.variantName,
        sku: variant.sku,
        imageUrl: product.imageUrl,
        unitPrice: Number(variant.sellingPrice),
        quantity: 1,
        availableQuantity: variant.availableQuantity,
      }];
    });
    setNotice(`${product.name} added to cart`);
  };

  const changeQuantity = (variantId, delta) => {
    setCart((current) => current.map((item) => item.variantId === variantId
      ? { ...item, quantity: Math.min(item.availableQuantity, Math.max(1, item.quantity + delta)) }
      : item));
  };

  const removeFromCart = (variantId) => setCart((current) => current.filter((item) => item.variantId !== variantId));

  const updatePayment = (index, field, value) => setPayments((current) =>
    current.map((payment, i) => {
      if (i !== index) return payment;
      if (field === "paymentMethod") {
        return {
          ...payment,
          paymentMethod: value,
          tenderedAmount: value === "CASH" ? (payment.tenderedAmount || "0.00") : "",
        };
      }
      return { ...payment, [field]: value };
    }));

  const addSplitPayment = () => {
    if (payments.length >= 3) return;
    const used = new Set(payments.map((p) => p.paymentMethod));
    const nextMethod = ["CASH", "UPI", "CARD"].find((method) => !used.has(method)) || "UPI";
    setPayments((current) => [...current, {
      paymentMethod: nextMethod, amount: "0.00", tenderedAmount: "", transactionReference: ""
    }]);
  };

  const removePayment = (index) => setPayments((current) => current.filter((_, i) => i !== index));

  const resetSale = () => {
    setCart([]);
    setCustomerName("");
    setCustomerPhone("");
    setDiscount("0.00");
    setPayments([{ paymentMethod: "CASH", amount: "0.00", tenderedAmount: "0.00", transactionReference: "" }]);
    pendingKey.current = null;
    setPendingPayload(null);
    setRetryPending(false);
  };

  const completeSale = async () => {
    setError("");
    setNotice("");
    if (!shift?.id || shift.status !== "OPEN") { setError("Open your cashier shift before completing a sale."); return; }
    if (!cart.length) { setError("Add at least one item before checkout."); return; }
    if (discountValue > subtotal) { setError("Discount cannot exceed the subtotal."); return; }
    if (Math.abs(paymentTotal - grandTotal) > 0.001) {
      setError("Payment amounts must add up exactly to the grand total."); return;
    }
    if (payments.some((p) => p.paymentMethod === "CASH" && (Number(p.tenderedAmount) || 0) < (Number(p.amount) || 0))) {
      setError("Cash received must be at least the cash payment amount."); return;
    }
    if (payments.some((p) => p.paymentMethod !== "CASH" && p.tenderedAmount !== "" && p.tenderedAmount != null)) {
      setError("Tendered amount is only valid for cash payments."); return;
    }

    if (!pendingKey.current) pendingKey.current = newIdempotencyKey();
    const body = pendingPayload || {
      locationId: Number(locationId),
      shiftId: Number(shift.id),
      customerName: customerName.trim() || null,
      customerPhone: customerPhone.trim() || null,
      discountAmount: Number(amount(discountValue)),
      idempotencyKey: pendingKey.current,
      items: cart.map((item) => ({
        productId: item.productId, variantId: item.variantId, quantity: item.quantity
      })),
      payments: payments.map((payment) => ({
        paymentMethod: payment.paymentMethod,
        amount: Number(amount(payment.amount)),
        ...(payment.paymentMethod === "CASH" ? { tenderedAmount: Number(amount(payment.tenderedAmount)) } : {}),
        ...(payment.transactionReference.trim() ? { transactionReference: payment.transactionReference.trim() } : {}),
      })),
    };
    setPendingPayload(body);

    setCheckoutLoading(true);
    try {
      const sale = await apiRequest("/admin/pos/checkout", { method: "POST", body: JSON.stringify(body) });
      pendingKey.current = null;
      setPendingPayload(null);
      setRetryPending(false);
      setReceipt(sale);
      resetSale();
      await Promise.all([loadCatalog(), loadCurrentShift()]);
      setNotice("Sale completed. Stock and cash drawer have been updated.");
    } catch (err) {
      if (!err.status || err.status >= 500 || err.status === 409) {
        setRetryPending(true);
      } else {
        pendingKey.current = null;
        setPendingPayload(null);
        setRetryPending(false);
      }
      setError(`${err.message} Your cart is preserved.${!err.status || err.status >= 500 || err.status === 409 ? " Retry the exact same checkout; the same request key will be reused to prevent a duplicate sale." : " Correct the details and submit again."}`);
    } finally { setCheckoutLoading(false); }
  };

  const openHistorySale = async (sale) => {
    setSelectedHistorySale(sale);
    try {
      const full = await apiRequest(`/admin/pos/sales/${sale.id}`);
      setSelectedHistorySale(full);
    } catch (err) { setError(err.message); }
  };

  const openReceiptFromHistory = () => {
    if (selectedHistorySale) {
      setReceipt(selectedHistorySale);
      setSelectedHistorySale(null);
    }
  };

  const formatDate = (value) => value
    ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
    : "—";

  return (
    <main className="pos-app">
      <header className="pos-topbar">
        <div className="pos-brand">
          <button type="button" className="pos-back-button" onClick={() => navigate("/admin/dashboard")} aria-label="Back to admin dashboard"><ArrowLeft size={18} /></button>
          <div><strong>NMK <span>OPTICALS</span></strong><small>POINT OF SALE</small></div>
        </div>
        <div className="pos-topbar-right">
          <label className="pos-location-picker"><Store size={17} /><span>Store</span>
            <select value={locationId} onChange={(e) => { setLocationId(e.target.value); setRegisterId(""); setShift(null); }} disabled={locationsLoading || !locations.length || retryPending}>
              {locations.length ? locations.map((location) => <option key={location.id} value={location.id}>{location.name} · {location.code}</option>) : <option value="">No location</option>}
            </select>
          </label>
          <span className="pos-cashier"><UserRound size={16} /> {sessionStorage.getItem("adminUsername") || "Cashier"} · {staffRole}</span>
        </div>
      </header>

      <div className="pos-page">
        <div className="pos-heading-row">
          <div><span className="pos-eyebrow">STORE OPERATIONS</span><h1>Sales terminal</h1><p>Scan or search products, build the bill, collect payment and print the invoice.</p></div>
          <div className="pos-heading-actions">
            <button type="button" className={`pos-tab-button ${activeTab === "checkout" ? "active" : ""}`} onClick={() => setActiveTab("checkout")}><ShoppingCart size={17} /> New sale</button>
            {canManageInventory && <button type="button" className={`pos-tab-button ${activeTab === "inventory" ? "active" : ""}`} onClick={() => setActiveTab("inventory")}><Package size={17} /> Inventory</button>}
            {canViewHistory && <button type="button" className={`pos-tab-button ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}><History size={17} /> Sales history</button>}
          </div>
        </div>

        {error && <div className="pos-alert error" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="pos-alert success" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={16} /></button></div>}

        <section className="pos-shift-panel">
          <div className="pos-shift-heading">
            <div>
              <span className="pos-eyebrow">CASH REGISTER</span>
              <h2>{shift?.status === "OPEN" ? "Shift is open" : shift?.status === "CLOSED" ? "Shift closed" : "Open a cashier shift"}</h2>
              <p>{shift?.status === "OPEN" ? `Opened by ${shift.openedByUsername} · ${new Date(shift.openedAt).toLocaleString("en-IN")}` : "A shift is required before the terminal can complete sales."}</p>
            </div>
            <span className={shift?.status === "OPEN" ? "pos-shift-status open" : "pos-shift-status closed"}>
              {shiftLoading ? "Checking…" : shift?.status || "NO OPEN SHIFT"}
            </span>
          </div>
          <div className="pos-shift-controls">
            <label>Register
              <select value={registerId} onChange={(event) => { setRegisterId(event.target.value); setShift(null); }} disabled={shiftLoading || shiftSaving || retryPending}>
                {registers.length ? registers.map((register) => <option key={register.id} value={register.id}>{register.registerCode} · {register.name}</option>) : <option value="">No register configured</option>}
              </select>
            </label>
            {!shift?.id ? (
              <>
                <label>Opening cash float (₹)
                  <input type="number" min="0" step="0.01" value={openingFloat} onChange={(event) => setOpeningFloat(event.target.value)} disabled={shiftSaving || !registerId} />
                </label>
                <button type="button" className="pos-button primary" onClick={openShift} disabled={shiftSaving || shiftLoading || !registerId}>
                  {shiftSaving ? "Opening…" : "Open shift"}
                </button>
              </>
            ) : (
              <>
                <div className="pos-shift-expected"><span>Expected drawer cash</span><strong>{money(shift.expectedCash)}</strong></div>
                <label>Cash counted (₹)
                  <input type="number" min="0" step="0.01" value={closingCashCount} onChange={(event) => setClosingCashCount(event.target.value)} disabled={shiftSaving || shift.status !== "OPEN" || retryPending} />
                </label>
                <label>Variance reason (required if different)
                  <input value={closingReason} onChange={(event) => setClosingReason(event.target.value)} maxLength={500} placeholder="Explain any cash difference" disabled={shiftSaving || shift.status !== "OPEN" || retryPending} />
                </label>
                <button type="button" className="pos-button secondary" onClick={closeShift} disabled={shiftSaving || shift.status !== "OPEN" || retryPending}>
                  {shiftSaving ? "Saving…" : "Close shift"}
                </button>
              </>
            )}
          </div>
          {shift?.status === "OPEN" && (
            <div className="pos-cash-movement-controls">
              <label>Cash drawer action
                <select value={cashMovementType} onChange={(event) => setCashMovementType(event.target.value)} disabled={shiftSaving}>
                  <option value="CASH_IN">Cash in</option>
                  <option value="CASH_OUT">Cash out</option>
                </select>
              </label>
              <label>Amount (₹)
                <input type="number" min="0.01" step="0.01" value={cashMovementAmount} onChange={(event) => setCashMovementAmount(event.target.value)} disabled={shiftSaving} />
              </label>
              <label>Reason
                <input value={cashMovementReason} onChange={(event) => setCashMovementReason(event.target.value)} maxLength={500} placeholder="Petty cash / bank drop / change float" disabled={shiftSaving} />
              </label>
              <button type="button" className="pos-button secondary" onClick={addCashMovement} disabled={shiftSaving}>
                {cashMovementType === "CASH_IN" ? "Record cash in" : "Record cash out"}
              </button>
            </div>
          )}
          {!registers.length && staffRole === "ADMIN" && (
            <div className="pos-register-create">
              <strong>Create the first register</strong>
              <input value={newRegisterCode} onChange={(event) => setNewRegisterCode(event.target.value)} maxLength={40} aria-label="Register code" />
              <input value={newRegisterName} onChange={(event) => setNewRegisterName(event.target.value)} maxLength={120} aria-label="Register name" />
              <button type="button" className="pos-button secondary" onClick={createRegister} disabled={shiftSaving}>Create register</button>
            </div>
          )}
          {shift?.status === "CLOSED" && (
            <p className="pos-shift-closed-note">This shift is closed. Open a new shift to continue selling. Final variance: {money(shift.cashVariance)}{shift.closingReason ? ` · ${shift.closingReason}` : ""}</p>
          )}
        </section>

        {activeTab === "checkout" ? (
          <div className="pos-workspace">
            <section className="pos-catalog-panel">
              <div className="pos-panel-heading">
                <div><h2>Product catalogue</h2><p>{catalog.length} products available at this store</p></div>
                <button type="button" className="pos-icon-button" onClick={loadCatalog} disabled={catalogLoading} aria-label="Refresh catalogue"><RefreshCw size={17} className={catalogLoading ? "pos-spin" : ""} /></button>
              </div>
              <div className="pos-search-wrap"><Search size={18} /><input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(event) => {
                  if (event.key !== "Enter" || !search.trim()) return;
                  const term = search.trim().toLowerCase();
                  const match = catalog.flatMap((product) => (product.variants || []).map((variant) => ({ product, variant })))
                    .find(({ variant }) => [variant.barcode, variant.sku].some((value) => value && String(value).toLowerCase() === term));
                  if (match && match.variant.availableQuantity > 0) {
                    addToCart(match.product, match.variant);
                    setSearch("");
                  }
                }} placeholder="Search product, SKU or barcode…" aria-label="Search products or scan barcode" /><ScanLine size={17} className="pos-search-hint" /></div>
              <div className="pos-category-list">
                {categories.map((item) => <button key={item} type="button" className={category === item ? "selected" : ""} onClick={() => setCategory(item)}>{item}</button>)}
              </div>
              {catalogLoading || locationsLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading store catalogue…</span></div>
                : !locationId ? <div className="pos-empty-state"><Store /><strong>Store location required</strong><span>Configure an active inventory location to start selling.</span></div>
                : filteredProducts.length === 0 ? <div className="pos-empty-state"><Search /><strong>No matching products</strong><span>Try another search or category.</span></div>
                : <div className="pos-product-grid">
                  {filteredProducts.map((product) => {
                    const variants = product.variants || [];
                    const selectedId = selectedVariants[product.productId] ?? variants[0]?.variantId;
                    const variant = variants.find((v) => v.variantId === selectedId) || variants[0];
                    const cartQty = cart.find((item) => item.variantId === variant?.variantId)?.quantity || 0;
                    return <article className="pos-product-card" key={product.productId}>
                      <div className="pos-product-image"><ProductImage src={product.imageUrl} name={product.name} /><span className={variant?.availableQuantity > 0 ? "in-stock" : "out-stock"}>{variant?.availableQuantity > 0 ? `${variant.availableQuantity} available` : "Out of stock"}</span></div>
                      <div className="pos-product-info">
                        <span className="pos-product-category">{product.category || "Product"} · {product.gender || "Unisex"}</span>
                        <h3>{product.name}</h3>
                        <label className="pos-variant-label">Variant
                          <select value={variant?.variantId || ""} onChange={(e) => setSelectedVariants((current) => ({ ...current, [product.productId]: Number(e.target.value) }))}>
                            {variants.map((v) => <option key={v.variantId} value={v.variantId}>{v.variantName || v.sku} · {v.sku}</option>)}
                          </select>
                        </label>
                        {variant && <div className="pos-product-bottom"><strong>{money(variant.sellingPrice)}</strong><button type="button" className="pos-add-button" disabled={retryPending || variant.availableQuantity <= cartQty} onClick={() => addToCart(product, variant)}><Plus size={16} /> {cartQty ? `Add more (${cartQty})` : "Add"}</button></div>}
                      </div>
                    </article>;
                  })}
                </div>}
            </section>

            <aside className="pos-cart-panel">
              <div className="pos-panel-heading">
                <div><h2>Current bill <span className="pos-count">{cart.reduce((sum, item) => sum + item.quantity, 0)}</span></h2><p>Items in this transaction</p></div>
                {cart.length > 0 && <button type="button" className="pos-text-button" onClick={() => { setCart([]); pendingKey.current = null; setPendingPayload(null); setRetryPending(false); }} disabled={retryPending}>Clear all</button>}
              </div>
              {cart.length === 0 ? <div className="pos-cart-empty"><ShoppingCart size={34} /><strong>Your bill is empty</strong><span>Select a product and variant to add it here.</span></div> :
                <div className="pos-cart-items">{cart.map((item) => <div className="pos-cart-item" key={item.variantId}>
                  <div className="pos-cart-item-main"><div><strong>{item.productName}</strong><span>{item.variantName || item.sku}</span><small>{item.sku}</small></div><button type="button" className="pos-remove-button" onClick={() => removeFromCart(item.variantId)} disabled={retryPending} aria-label={`Remove ${item.productName}`}><Trash2 size={16} /></button></div>
                  <div className="pos-cart-item-bottom"><div className="pos-quantity-control"><button type="button" onClick={() => changeQuantity(item.variantId, -1)} disabled={retryPending || item.quantity <= 1} aria-label="Decrease quantity"><Minus size={14} /></button><span>{item.quantity}</span><button type="button" onClick={() => changeQuantity(item.variantId, 1)} disabled={retryPending || item.quantity >= item.availableQuantity} aria-label="Increase quantity"><Plus size={14} /></button></div><strong>{money(item.unitPrice * item.quantity)}</strong></div>
                </div>)}</div>}

              <div className="pos-cart-form">
                <div className="pos-form-section-title"><UserRound size={16} /> Customer details <span>Optional</span></div>
                <div className="pos-customer-fields"><input value={customerName} disabled={retryPending} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name" maxLength={150} /><input value={customerPhone} disabled={retryPending} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Phone number" maxLength={30} inputMode="tel" /></div>
                <div className="pos-discount-row"><label htmlFor="pos-discount">Discount (₹)</label><input id="pos-discount" type="number" min="0" max={subtotal} step="0.01" value={discount} disabled={retryPending} onChange={(e) => setDiscount(e.target.value)} /></div>
              </div>

              <div className="pos-totals">
                <div><span>Subtotal</span><strong>{money(subtotal)}</strong></div>
                <div><span>Discount</span><strong className="discount-value">− {money(discountValue)}</strong></div>
                <div className="pos-grand-total"><span>Amount due</span><strong>{money(grandTotal)}</strong></div>
              </div>

              <div className="pos-payment-section">
                <div className="pos-form-section-title"><CreditCard size={16} /> Payment method</div>
                {payments.map((payment, index) => <div className="pos-payment-row" key={index}>
                  <div className="pos-payment-row-heading"><select aria-label="Payment method" value={payment.paymentMethod} disabled={retryPending} onChange={(e) => updatePayment(index, "paymentMethod", e.target.value)}>
                    <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option>
                  </select>{payments.length > 1 && <button type="button" className="pos-remove-button" onClick={() => removePayment(index)} disabled={retryPending} aria-label="Remove payment method"><X size={15} /></button>}</div>
                  <div className="pos-payment-inputs">
                    <label>Amount<input type="number" min="0" step="0.01" value={payment.amount} disabled={retryPending} onChange={(e) => updatePayment(index, "amount", e.target.value)} /></label>
                    {payment.paymentMethod === "CASH" ? <label>Cash received<input type="number" min="0" step="0.01" value={payment.tenderedAmount} disabled={retryPending} onChange={(e) => updatePayment(index, "tenderedAmount", e.target.value)} /></label>
                      : <label>Reference (optional)<input value={payment.transactionReference} disabled={retryPending} onChange={(e) => updatePayment(index, "transactionReference", e.target.value)} placeholder="UPI / card reference" maxLength={150} /></label>}
                  </div>
                </div>)}
                {payments.length < 3 && <button type="button" className="pos-add-split" onClick={addSplitPayment} disabled={retryPending}><Plus size={15} /> Add split payment</button>}
                <div className={Math.abs(paymentTotal - grandTotal) < 0.001 ? "pos-payment-match" : "pos-payment-mismatch"}><span>Payment total</span><strong>{money(paymentTotal)}</strong></div>
                {cashChange > 0 && <div className="pos-change-row"><span>Change to return</span><strong>{money(cashChange)}</strong></div>}
              </div>

              <button type="button" className="pos-complete-button" onClick={completeSale} disabled={checkoutLoading || !cart.length || !locationId || !shift?.id || shift.status !== "OPEN" || Math.abs(paymentTotal - grandTotal) > 0.001}>
                {checkoutLoading ? <><RefreshCw className="pos-spin" size={18} /> Processing sale…</> : retryPending ? <><RefreshCw size={18} /> Retry same checkout · {money(grandTotal)}</> : <><Receipt size={18} /> Complete sale · {money(grandTotal)}</>}
              </button>
              <p className="pos-secure-note">Prices and stock are verified by the server. Completed sales are recorded with an audit trail.</p>
            </aside>
          </div>
        ) : activeTab === "inventory" ? (
          <InventoryPanel locationId={locationId} catalog={catalog} onRefreshCatalog={loadCatalog} onNotice={setNotice} onError={setError} />
        ) : (
          <section className="pos-history-panel">
            <div className="pos-panel-heading"><div><h2>Sales history</h2><p>Completed in-store transactions for the selected location.</p></div><button type="button" className="pos-button secondary compact" onClick={() => loadHistory(historyPage)} disabled={historyLoading}><RefreshCw size={16} className={historyLoading ? "pos-spin" : ""} /> Refresh</button></div>
            {historyLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading sales…</span></div> : history.length === 0 ? <div className="pos-empty-state"><History /><strong>No sales found</strong><span>Completed POS transactions will appear here.</span></div> :
              <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Payment</th><th>Amount</th><th></th></tr></thead><tbody>{history.map((sale) => <tr key={sale.id}>
                <td><strong>{sale.invoiceNumber}</strong><small>#{sale.id}</small></td><td>{formatDate(sale.createdAt)}</td><td>{sale.customerName || "Walk-in"}<small>{sale.customerPhone || "No phone"}</small></td><td>{(sale.payments || []).map((p) => p.paymentMethod).join(" + ") || "—"}</td><td><strong>{money(sale.grandTotal)}</strong></td><td><button type="button" className="pos-view-button" onClick={() => openHistorySale(sale)}>View invoice</button></td>
              </tr>)}</tbody></table></div>}
            <div className="pos-pagination"><span>Page {historyPages ? historyPage + 1 : 0} of {historyPages}</span><div><button type="button" disabled={historyPage <= 0 || historyLoading} onClick={() => loadHistory(historyPage - 1)} aria-label="Previous page"><ChevronLeft size={18} /></button><button type="button" disabled={historyPage + 1 >= historyPages || historyLoading} onClick={() => loadHistory(historyPage + 1)} aria-label="Next page"><ChevronRight size={18} /></button></div></div>
          </section>
        )}
      </div>

      {selectedHistorySale && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedHistorySale(null); }}>
        <section className="pos-history-modal" role="dialog" aria-modal="true" aria-labelledby="pos-history-title">
          <div className="pos-modal-toolbar"><div><span className="pos-eyebrow">TRANSACTION DETAILS</span><h2 id="pos-history-title">{selectedHistorySale.invoiceNumber}</h2></div><button type="button" className="pos-icon-button" onClick={() => setSelectedHistorySale(null)} aria-label="Close details"><X /></button></div>
          <div className="pos-history-detail-grid"><div><span>Customer</span><strong>{selectedHistorySale.customerName || "Walk-in"}</strong></div><div><span>Phone</span><strong>{selectedHistorySale.customerPhone || "—"}</strong></div><div><span>Cashier</span><strong>{selectedHistorySale.cashierUsername}</strong></div><div><span>Date</span><strong>{formatDate(selectedHistorySale.createdAt)}</strong></div><div><span>Total</span><strong>{money(selectedHistorySale.grandTotal)}</strong></div></div>
          <div className="pos-modal-actions"><button type="button" className="pos-button secondary" onClick={() => setSelectedHistorySale(null)}>Close</button><button type="button" className="pos-button primary" onClick={openReceiptFromHistory}><Printer size={17} /> Print invoice</button></div>
        </section>
      </div>}
      <ReceiptView sale={receipt} onClose={() => setReceipt(null)} />
    </main>
  );
}
