import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, Search, RefreshCw, Plus, Minus, Trash2, Receipt,
  History, ShoppingCart, Store, Printer, X, CheckCircle2,
  AlertCircle, UserRound, CreditCard,
  ChevronLeft, ChevronRight, Package, ScanLine, ClipboardCheck, Truck, BarChart3
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import "./PosTerminal.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL?.trim() ||
  (import.meta.env.DEV ? "http://localhost:8080/api" : "");
const money = (value) => Number(value || 0).toLocaleString("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2
});
const amount = (value) => Number(value || 0).toFixed(2);
const newIdempotencyKey = () => globalThis.crypto?.randomUUID?.() ||
  `pos-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function apiRequest(path, options = {}) {
  if (!API_BASE) {
    throw new Error("POS API is not configured. Set VITE_API_BASE_URL to your deployed backend URL ending in /api.");
  }
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
  const [stockCount, setStockCount] = useState(null);
  const [stockCountLoading, setStockCountLoading] = useState(false);
  const [stockCountSaving, setStockCountSaving] = useState(false);
  const [stockCountReason, setStockCountReason] = useState("");
  const [stockCountDrafts, setStockCountDrafts] = useState({});
  const [reorderDrafts, setReorderDrafts] = useState({});
  const [lowStockAlerts, setLowStockAlerts] = useState([]);
  const [lowStockLoading, setLowStockLoading] = useState(false);
  const [movementRows, setMovementRows] = useState([]);
  const [movementPage, setMovementPage] = useState(0);
  const [movementPages, setMovementPages] = useState(0);
  const [movementLoading, setMovementLoading] = useState(false);
  const [movementVariantId, setMovementVariantId] = useState("");
  const stockCountActive = stockCount && ["COUNTING", "READY_FOR_REVIEW"].includes(stockCount.status);
  const currentStaffUsername = sessionStorage.getItem("adminUsername") || "";
  const currentStaffPreparedCount = Boolean(stockCount && currentStaffUsername && (
    [stockCount.startedByUsername, stockCount.submittedByUsername]
      .some((username) => username && username.toLowerCase() === currentStaffUsername.toLowerCase())
    || (stockCount.lines || []).some((line) => line.countedByUsername
      && line.countedByUsername.toLowerCase() === currentStaffUsername.toLowerCase())
  ));

  const [suppliers, setSuppliers] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [procurementLoading, setProcurementLoading] = useState(false);
  const [procurementSaving, setProcurementSaving] = useState(false);
  const [supplierName, setSupplierName] = useState("");
  const [supplierContact, setSupplierContact] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [supplierEmail, setSupplierEmail] = useState("");
  const [supplierAddress, setSupplierAddress] = useState("");
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [purchaseOrderNotes, setPurchaseOrderNotes] = useState("");
  const [purchaseOrderItems, setPurchaseOrderItems] = useState([{ variantId: "", orderedQuantity: "1", unitCost: "" }]);
  const [purchaseOrderRetry, setPurchaseOrderRetry] = useState(false);
  const [purchaseOrderPayload, setPurchaseOrderPayload] = useState(null);
  const purchaseOrderPending = useRef(null);
  const [receivingOrder, setReceivingOrder] = useState(null);
  const [goodsReceiptReason, setGoodsReceiptReason] = useState("");
  const [goodsReceiptQuantities, setGoodsReceiptQuantities] = useState({});
  const [goodsReceiptSaving, setGoodsReceiptSaving] = useState(false);
  const [goodsReceiptRetry, setGoodsReceiptRetry] = useState(false);
  const [goodsReceiptPayload, setGoodsReceiptPayload] = useState(null);
  const [procurementActionError, setProcurementActionError] = useState("");
  const goodsReceiptPending = useRef(null);
  const [supplierReturnOrder, setSupplierReturnOrder] = useState(null);
  const [supplierReturnReason, setSupplierReturnReason] = useState("");
  const [supplierReturnQuantities, setSupplierReturnQuantities] = useState({});
  const [supplierReturnSaving, setSupplierReturnSaving] = useState(false);
  const [supplierReturnRetry, setSupplierReturnRetry] = useState(false);
  const [supplierReturnPayload, setSupplierReturnPayload] = useState(null);
  const supplierReturnPending = useRef(null);

  const loadProcurement = useCallback(async () => {
    setProcurementLoading(true);
    try {
      const [supplierData, orderData] = await Promise.all([
        apiRequest("/admin/procurement/suppliers"),
        apiRequest("/admin/procurement/purchase-orders"),
      ]);
      const supplierList = Array.isArray(supplierData) ? supplierData : [];
      setSuppliers(supplierList);
      setSelectedSupplierId((current) => current && supplierList.some((supplier) => String(supplier.id) === String(current) && supplier.active)
        ? current : (supplierList.find((supplier) => supplier.active)?.id ? String(supplierList.find((supplier) => supplier.active).id) : ""));
      setPurchaseOrders(Array.isArray(orderData) ? orderData : []);
    } catch (err) { onError(err.message); }
    finally { setProcurementLoading(false); }
  }, [onError]);

  const createSupplier = async (event) => {
    event.preventDefault();
    if (!supplierName.trim()) { onError("Supplier name is required."); return; }
    setProcurementSaving(true);
    onError("");
    try {
      const created = await apiRequest("/admin/procurement/suppliers", {
        method: "POST",
        body: JSON.stringify({
          name: supplierName.trim(),
          contactName: supplierContact.trim() || null,
          phone: supplierPhone.trim() || null,
          email: supplierEmail.trim() || null,
          address: supplierAddress.trim() || null,
        }),
      });
      setSupplierName(""); setSupplierContact(""); setSupplierPhone(""); setSupplierEmail(""); setSupplierAddress("");
      await loadProcurement();
      setSelectedSupplierId(String(created.id));
      onNotice(`Supplier ${created.name} created.`);
    } catch (err) { onError(err.message); }
    finally { setProcurementSaving(false); }
  };

  const createPurchaseOrder = async (event) => {
    event.preventDefault();
    if (!selectedSupplierId || !locationId) { onError("Choose an active supplier and store location."); return; }
    if (!purchaseOrderPayload) {
      const items = purchaseOrderItems.map((item) => ({
        variantId: Number(item.variantId),
        orderedQuantity: Number(item.orderedQuantity),
        unitCost: Number(item.unitCost),
      }));
      if (!items.length || items.some((item) => !item.variantId || !Number.isInteger(item.orderedQuantity) || item.orderedQuantity <= 0 || !Number.isFinite(item.unitCost) || item.unitCost <= 0)) {
        onError("Every purchase order line needs a variant, positive whole quantity and positive unit cost.");
        return;
      }
      if (new Set(items.map((item) => item.variantId)).size !== items.length) {
        onError("Each variant can appear only once in a purchase order.");
        return;
      }
      purchaseOrderPending.current = purchaseOrderPending.current || newIdempotencyKey();
      setPurchaseOrderPayload({
        supplierId: Number(selectedSupplierId),
        locationId: Number(locationId),
        notes: purchaseOrderNotes.trim() || null,
        items,
        idempotencyKey: purchaseOrderPending.current,
      });
    }
    const payload = purchaseOrderPayload || {
      supplierId: Number(selectedSupplierId),
      locationId: Number(locationId),
      notes: purchaseOrderNotes.trim() || null,
      items: purchaseOrderItems.map((item) => ({
        variantId: Number(item.variantId),
        orderedQuantity: Number(item.orderedQuantity),
        unitCost: Number(item.unitCost),
      })),
      idempotencyKey: purchaseOrderPending.current,
    };
    setProcurementSaving(true);
    onError("");
    try {
      const created = await apiRequest("/admin/procurement/purchase-orders", {
        method: "POST", body: JSON.stringify(payload),
      });
      setPurchaseOrderNotes("");
      setPurchaseOrderItems([{ variantId: "", orderedQuantity: "1", unitCost: "" }]);
      setPurchaseOrderPayload(null);
      purchaseOrderPending.current = null;
      setPurchaseOrderRetry(false);
      await loadProcurement();
      onNotice(`Draft purchase order ${created.orderNumber} created.`);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setPurchaseOrderRetry(uncertain);
      if (!uncertain) { setPurchaseOrderPayload(null); purchaseOrderPending.current = null; }
      onError(`${err.message}${uncertain ? " Retry the exact same draft purchase order; its idempotency key is retained." : ""}`);
    } finally { setProcurementSaving(false); }
  };

  const submitPurchaseOrder = async (order) => {
    setProcurementSaving(true);
    onError("");
    try {
      await apiRequest(`/admin/procurement/purchase-orders/${order.id}/submit`, { method: "POST" });
      await loadProcurement();
      onNotice(`Purchase order ${order.orderNumber} submitted to supplier.`);
    } catch (err) { onError(err.message); }
    finally { setProcurementSaving(false); }
  };

  const openGoodsReceipt = (order) => {
    setProcurementActionError("");
    setReceivingOrder(order);
    setGoodsReceiptReason("Supplier delivery checked against purchase order");
    setGoodsReceiptQuantities({});
    setGoodsReceiptRetry(false);
    setGoodsReceiptPayload(null);
    goodsReceiptPending.current = null;
  };

  const receivePurchaseOrderGoods = async () => {
    if (!receivingOrder || !goodsReceiptReason.trim()) { setProcurementActionError("Goods receipt reason is required."); onError("Goods receipt reason is required."); return; }
    if (stockCountActive) { setProcurementActionError("Inventory is frozen during a physical stock count."); onError("Inventory is frozen during a physical stock count."); return; }
    if (!goodsReceiptPayload) {
      const items = receivingOrder.items
        .filter((item) => Number(goodsReceiptQuantities[item.id] || 0) > 0)
        .map((item) => ({ purchaseOrderItemId: item.id, quantity: Number(goodsReceiptQuantities[item.id]) }));
      if (!items.length) { onError("Enter at least one received quantity."); return; }
      if (items.some((item) => !Number.isInteger(item.quantity))) { onError("Received quantities must be whole numbers."); return; }
      goodsReceiptPending.current = goodsReceiptPending.current || newIdempotencyKey();
      setGoodsReceiptPayload({
        reason: goodsReceiptReason.trim(),
        idempotencyKey: goodsReceiptPending.current,
        items,
      });
    }
    const payload = goodsReceiptPayload || {
      reason: goodsReceiptReason.trim(),
      idempotencyKey: goodsReceiptPending.current,
      items: receivingOrder.items
        .filter((item) => Number(goodsReceiptQuantities[item.id] || 0) > 0)
        .map((item) => ({ purchaseOrderItemId: item.id, quantity: Number(goodsReceiptQuantities[item.id]) })),
    };
    setGoodsReceiptSaving(true);
    onError("");
    try {
      const receipt = await apiRequest(`/admin/procurement/purchase-orders/${receivingOrder.id}/receive`, {
        method: "POST", body: JSON.stringify(payload),
      });
      setReceivingOrder(null);
      setGoodsReceiptPayload(null);
      goodsReceiptPending.current = null;
      setGoodsReceiptRetry(false);
      setProcurementActionError("");
      await Promise.all([loadProcurement(), onRefreshCatalog()]);
      onNotice(`Goods receipt ${receipt.receiptNumber} saved and stock updated.`);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setGoodsReceiptRetry(uncertain);
      setProcurementActionError(`${err.message}${uncertain ? " Retry the exact same receipt; its idempotency key is retained." : ""}`);
      if (!uncertain) { setGoodsReceiptPayload(null); goodsReceiptPending.current = null; }
      onError(err.message);
    } finally { setGoodsReceiptSaving(false); }
  };

  const openSupplierReturn = (order) => {
    setProcurementActionError("");
    setSupplierReturnOrder(order);
    setSupplierReturnReason("Goods returned to supplier");
    setSupplierReturnQuantities({});
    setSupplierReturnRetry(false);
    setSupplierReturnPayload(null);
    supplierReturnPending.current = null;
  };

  const returnPurchaseOrderGoods = async () => {
    if (!supplierReturnOrder || !supplierReturnReason.trim()) { setProcurementActionError("Supplier return reason is required."); onError("Supplier return reason is required."); return; }
    if (stockCountActive) { setProcurementActionError("Inventory is frozen during a physical stock count."); onError("Inventory is frozen during a physical stock count."); return; }
    if (!supplierReturnPayload) {
      const items = supplierReturnOrder.items
        .filter((item) => Number(supplierReturnQuantities[item.id] || 0) > 0)
        .map((item) => ({ purchaseOrderItemId: item.id, quantity: Number(supplierReturnQuantities[item.id]) }));
      if (!items.length || items.some((item) => !Number.isInteger(item.quantity))) {
        onError("Enter at least one whole supplier return quantity.");
        return;
      }
      supplierReturnPending.current = supplierReturnPending.current || newIdempotencyKey();
      setSupplierReturnPayload({
        reason: supplierReturnReason.trim(),
        idempotencyKey: supplierReturnPending.current,
        items,
      });
    }
    const payload = supplierReturnPayload || {
      reason: supplierReturnReason.trim(),
      idempotencyKey: supplierReturnPending.current,
      items: supplierReturnOrder.items
        .filter((item) => Number(supplierReturnQuantities[item.id] || 0) > 0)
        .map((item) => ({ purchaseOrderItemId: item.id, quantity: Number(supplierReturnQuantities[item.id]) })),
    };
    setSupplierReturnSaving(true);
    onError("");
    try {
      const result = await apiRequest(`/admin/procurement/purchase-orders/${supplierReturnOrder.id}/supplier-returns`, {
        method: "POST", body: JSON.stringify(payload),
      });
      setSupplierReturnOrder(null);
      setSupplierReturnPayload(null);
      supplierReturnPending.current = null;
      setSupplierReturnRetry(false);
      setProcurementActionError("");
      await Promise.all([loadProcurement(), onRefreshCatalog()]);
      onNotice(`Supplier return ${result.returnNumber} recorded and stock reduced.`);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setSupplierReturnRetry(uncertain);
      setProcurementActionError(`${err.message}${uncertain ? " Retry the exact same supplier return; its idempotency key is retained." : ""}`);
      if (!uncertain) { setSupplierReturnPayload(null); supplierReturnPending.current = null; }
      onError(err.message);
    } finally { setSupplierReturnSaving(false); }
  };

  const loadLowStock = useCallback(async () => {
    if (!locationId) { setLowStockAlerts([]); return; }
    setLowStockLoading(true);
    try {
      const data = await apiRequest(`/admin/inventory/low-stock?locationId=${encodeURIComponent(locationId)}`);
      setLowStockAlerts(Array.isArray(data) ? data : []);
    } catch (err) { onError(err.message); }
    finally { setLowStockLoading(false); }
  }, [locationId, onError]);

  const loadMovementHistory = useCallback(async (page = 0) => {
    if (!locationId) {
      setMovementRows([]);
      setMovementPage(0);
      setMovementPages(0);
      return;
    }
    setMovementLoading(true);
    try {
      const variantFilter = movementVariantId
        ? `&variantId=${encodeURIComponent(movementVariantId)}`
        : "";
      const data = await apiRequest(
        `/admin/inventory/movements?locationId=${encodeURIComponent(locationId)}${variantFilter}&page=${page}&size=20`
      );
      setMovementRows(Array.isArray(data?.content) ? data.content : []);
      setMovementPage(Number(data?.number || 0));
      setMovementPages(Number(data?.totalPages || 0));
    } catch (err) {
      onError(err.message);
    } finally {
      setMovementLoading(false);
    }
  }, [locationId, movementVariantId, onError]);

  const updateReorderLevel = async (variantId, currentLevel) => {
    const raw = reorderDrafts[variantId] ?? currentLevel;
    const reorderLevel = Number(raw);
    if (!Number.isInteger(reorderLevel) || reorderLevel < 0 || reorderLevel > 1000000) {
      onError("Reorder level must be a whole number from 0 to 1,000,000.");
      return;
    }
    try {
      await apiRequest("/admin/inventory/reorder-level", {
        method: "PATCH",
        body: JSON.stringify({ locationId: Number(locationId), variantId: Number(variantId), reorderLevel }),
      });
      setReorderDrafts((current) => { const next = { ...current }; delete next[variantId]; return next; });
      await Promise.all([onRefreshCatalog(), loadLowStock()]);
      onNotice(reorderLevel === 0 ? "Low stock alert disabled for this variant." : `Reorder alert set to ${reorderLevel} available units.`);
    } catch (err) { onError(err.message); }
  };

  const loadStockCount = useCallback(async () => {
    if (!locationId) { setStockCount(null); return; }
    setStockCountLoading(true);
    try {
      const data = await apiRequest(`/admin/inventory/stock-counts/current?locationId=${encodeURIComponent(locationId)}`);
      setStockCount(data || null);
      setStockCountDrafts({});
    } catch (err) { onError(err.message); }
    finally { setStockCountLoading(false); }
  }, [locationId, onError]);

  const startStockCount = async () => {
    if (!locationId || !stockCountReason.trim()) {
      onError("Enter a reason before starting the physical stock count.");
      return;
    }
    setStockCountSaving(true);
    onError("");
    try {
      const data = await apiRequest("/admin/inventory/stock-counts/start", {
        method: "POST",
        body: JSON.stringify({ locationId: Number(locationId), reason: stockCountReason.trim() }),
      });
      setStockCount(data);
      setStockCountDrafts({});
      setStockCountReason("");
      await onRefreshCatalog();
      onNotice("Physical stock count started. Stock movements are frozen until it is posted or cancelled.");
    } catch (err) {
      onError(err.message);
      await loadStockCount();
    } finally { setStockCountSaving(false); }
  };

  const saveStockCountLine = async (line) => {
    const raw = stockCountDrafts[line.id] ?? line.countedQuantity;
    const countedQuantity = Number(raw);
    if (!Number.isInteger(countedQuantity) || countedQuantity < 0) {
      onError("Counted quantity must be a non-negative whole number.");
      return;
    }
    setStockCountSaving(true);
    onError("");
    try {
      const updated = await apiRequest(`/admin/inventory/stock-counts/${stockCount.id}/lines/${line.id}`, {
        method: "PATCH",
        body: JSON.stringify({ countedQuantity }),
      });
      setStockCount((current) => ({
        ...current,
        lines: current.lines.map((item) => item.id === updated.id ? updated : item),
        countedLineCount: current.lines.filter((item) => item.id === updated.id || item.countedQuantity != null).length,
      }));
      setStockCountDrafts((current) => { const next = { ...current }; delete next[line.id]; return next; });
    } catch (err) { onError(err.message); }
    finally { setStockCountSaving(false); }
  };

  const submitStockCount = async () => {
    if (!stockCount?.id) return;
    setStockCountSaving(true);
    onError("");
    try {
      const data = await apiRequest(`/admin/inventory/stock-counts/${stockCount.id}/submit`, { method: "POST" });
      setStockCount(data);
      onNotice("Stock count submitted for review.");
    } catch (err) { onError(err.message); }
    finally { setStockCountSaving(false); }
  };

  const postStockCount = async () => {
    if (!stockCount?.id) return;
    if (!window.confirm("Post all stock count variances? This will create permanent stock ledger movements.")) return;
    setStockCountSaving(true);
    onError("");
    try {
      const data = await apiRequest(`/admin/inventory/stock-counts/${stockCount.id}/post`, { method: "POST" });
      setStockCount(data);
      setStockCountDrafts({});
      await onRefreshCatalog();
      onNotice(`Stock count #${data.id} posted. ${data.varianceLineCount} stock variances were applied.`);
    } catch (err) { onError(err.message); }
    finally { setStockCountSaving(false); }
  };

  const cancelStockCount = async () => {
    if (!stockCount?.id || !window.confirm("Cancel this stock count and unfreeze inventory? No stock adjustments will be posted.")) return;
    setStockCountSaving(true);
    onError("");
    try {
      const data = await apiRequest(`/admin/inventory/stock-counts/${stockCount.id}/cancel`, { method: "POST" });
      setStockCount(data);
      setStockCountDrafts({});
      await onRefreshCatalog();
      onNotice("Stock count cancelled. Inventory operations are available again.");
    } catch (err) { onError(err.message); }
    finally { setStockCountSaving(false); }
  };

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
  useEffect(() => { loadStockCount(); }, [loadStockCount]);
  useEffect(() => { loadLowStock(); }, [loadLowStock]);
  useEffect(() => { loadMovementHistory(0); }, [loadMovementHistory]);
  useEffect(() => { loadProcurement(); }, [loadProcurement]);

  const updateVariantForm = (field, value) => setVariantForm((current) => ({ ...current, [field]: value }));

  const createVariant = async (event) => {
    event.preventDefault();
    onError("");
    if (stockCountActive) { onError("Cancel or post the active stock count before changing the catalogue."); return; }
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
    if (stockCountActive) { onError("Inventory is frozen while a physical stock count is active."); return; }
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
    if (stockCountActive) { onError("Inventory is frozen while a physical stock count is active."); return; }
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
  const procurementVariants = catalog.flatMap((product) => (product.variants || []).map((variant) => ({
    ...variant, productName: product.name,
  })));

  return (
    <section className="pos-inventory-workspace">
      <div className="pos-inventory-intro">
        <div><span className="pos-eyebrow">CATALOGUE & STOCK CONTROL</span><h2>Inventory setup</h2><p>Create sellable variants and receive physical stock into the selected store location.</p></div>
        <button type="button" className="pos-button secondary compact" onClick={() => { loadProducts(); onRefreshCatalog(); }} disabled={productsLoading || variantsLoading}><RefreshCw size={15} /> Refresh inventory</button>
      </div>
      <section className="pos-inventory-card pos-stock-count-card">
        <div className="pos-inventory-card-heading"><ClipboardCheck size={18} /><div><h3>Physical stock count</h3><p>Freeze stock movements, count every sellable variant and post verified variances to the stock ledger.</p></div></div>
        {stockCountLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Checking active stock count…</span></div>
          : !stockCount ? (
            <div className="pos-stock-count-start">
              <label>Reason for count<input value={stockCountReason} onChange={(event) => setStockCountReason(event.target.value)} maxLength={400} placeholder="Monthly physical inventory count" /></label>
              <button type="button" className="pos-button primary" onClick={startStockCount} disabled={stockCountSaving || !locationId || !stockCountReason.trim()}>
                {stockCountSaving ? "Starting…" : "Start physical count"}
              </button>
            </div>
          ) : (
            <>
              <div className="pos-stock-count-summary">
                <span>Session #{stockCount.id} · {stockCount.status.replaceAll("_", " ")}</span>
                <strong>{stockCount.countedLineCount} / {stockCount.lineCount} counted · {stockCount.varianceLineCount} variances</strong>
              </div>
              {stockCount.status === "POSTED" && <p className="pos-retry-note">Posted by {stockCount.postedByUsername || "—"} · {stockCount.postedAt ? new Date(stockCount.postedAt).toLocaleString("en-IN") : "time unavailable"}</p>}
              {stockCount.status === "CANCELLED" && <p className="pos-retry-note">Cancelled by {stockCount.cancelledByUsername || "—"} · {stockCount.cancelledAt ? new Date(stockCount.cancelledAt).toLocaleString("en-IN") : "time unavailable"}</p>}
              <div className="pos-stock-count-table">
                <table><thead><tr><th>Product / SKU</th><th>Expected</th><th>Counted</th><th>Variance</th><th></th></tr></thead>
                  <tbody>{stockCount.lines.map((line) => <tr key={line.id}>
                    <td><strong>{line.productName}</strong><small>{line.variantName} · {line.sku}</small></td>
                    <td>{line.snapshotOnHand}</td>
                    <td>{stockCount.status === "COUNTING"
                      ? <>
                          <input type="number" min="0" step="1" value={stockCountDrafts[line.id] ?? (line.countedQuantity ?? "")}
                            onChange={(event) => setStockCountDrafts((current) => ({ ...current, [line.id]: event.target.value }))}
                            disabled={stockCountSaving || Boolean(line.countedByUsername && line.countedByUsername.toLowerCase() !== currentStaffUsername.toLowerCase())} />
                          {line.countedByUsername && <small>Counted by {line.countedByUsername}</small>}
                        </>
                      : <>{line.countedQuantity}{line.countedByUsername && <small>Counted by {line.countedByUsername}</small>}</>}</td>
                    <td>{line.variance == null ? "—" : <strong className={line.variance === 0 ? "" : line.variance > 0 ? "pos-count-positive" : "pos-count-negative"}>{line.variance > 0 ? "+" : ""}{line.variance}</strong>}</td>
                    <td>{stockCount.status === "COUNTING" && <button type="button" className="pos-button secondary compact" onClick={() => saveStockCountLine(line)} disabled={stockCountSaving || stockCountDrafts[line.id] == null || Boolean(line.countedByUsername && line.countedByUsername.toLowerCase() !== currentStaffUsername.toLowerCase())}>Save</button>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <div className="pos-stock-count-actions">
                {stockCount.status === "COUNTING" && <button type="button" className="pos-button primary" onClick={submitStockCount} disabled={stockCountSaving || stockCount.countedLineCount !== stockCount.lineCount}>Submit for review</button>}
                {stockCount.status === "READY_FOR_REVIEW" && <button type="button" className="pos-button primary" onClick={postStockCount} disabled={stockCountSaving || currentStaffPreparedCount}>Post stock variances</button>}
                {stockCountActive && <button type="button" className="pos-button secondary" onClick={cancelStockCount} disabled={stockCountSaving}>Cancel count</button>}
                {["POSTED", "CANCELLED"].includes(stockCount.status) && <button type="button" className="pos-button secondary" onClick={() => setStockCount(null)}>Start another count</button>}
              </div>
              {stockCount.status === "READY_FOR_REVIEW" && (
                <p className="pos-retry-note">
                  {currentStaffPreparedCount
                    ? "You started, counted or submitted this session. A different manager or administrator must review and post it."
                    : `Submitted by ${stockCount.submittedByUsername || "staff"}. You can independently review and post this count.`}
                </p>
              )}
              <p className="pos-retry-note">Stock receiving, adjustments, online reservations and POS sales are blocked until this count is posted or cancelled.</p>
            </>
          )}
      </section>

      <section className="pos-inventory-card pos-procurement-card">
        <div className="pos-inventory-card-heading"><Truck size={18} /><div><h3>Supplier procurement</h3><p>Create purchase orders, receive partial deliveries and return goods to suppliers with stock ledger references.</p></div>
          <button type="button" className="pos-button secondary compact" onClick={loadProcurement} disabled={procurementLoading}><RefreshCw size={14} /> Refresh</button>
        </div>
        <div className="pos-procurement-grid">
          <form className="pos-procurement-form" onSubmit={createSupplier}>
            <h4>Add supplier</h4>
            <label>Supplier name<input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} maxLength={200} required placeholder="Supplier business name" /></label>
            <div className="pos-inventory-fields">
              <label>Contact person<input value={supplierContact} onChange={(event) => setSupplierContact(event.target.value)} maxLength={120} placeholder="Optional" /></label>
              <label>Phone<input value={supplierPhone} onChange={(event) => setSupplierPhone(event.target.value)} maxLength={30} placeholder="Optional" /></label>
              <label>Email<input type="email" value={supplierEmail} onChange={(event) => setSupplierEmail(event.target.value)} maxLength={160} placeholder="Optional" /></label>
              <label>Address<input value={supplierAddress} onChange={(event) => setSupplierAddress(event.target.value)} maxLength={500} placeholder="Optional" /></label>
            </div>
            <button type="submit" className="pos-button secondary" disabled={procurementSaving}>{procurementSaving ? "Saving…" : "Save supplier"}</button>
          </form>

          <form className="pos-procurement-form" onSubmit={createPurchaseOrder}>
            <h4>Create purchase order</h4>
            <label>Supplier<select value={selectedSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)} disabled={purchaseOrderRetry} required>
              <option value="">Choose active supplier</option>
              {suppliers.filter((supplier) => supplier.active).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select></label>
            <label>Order notes<input value={purchaseOrderNotes} onChange={(event) => setPurchaseOrderNotes(event.target.value)} maxLength={500} placeholder="Optional delivery or reference notes" disabled={purchaseOrderRetry} /></label>
            <div className="pos-po-lines">
              {purchaseOrderItems.map((item, index) => <div className="pos-po-line" key={index}>
                <label>Variant<select value={item.variantId} onChange={(event) => setPurchaseOrderItems((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, variantId: event.target.value } : line))} disabled={purchaseOrderRetry} required>
                  <option value="">Select SKU</option>
                  {procurementVariants.map((variant) => <option key={variant.variantId} value={variant.variantId}>{variant.productName} · {variant.variantName} · {variant.sku}</option>)}
                </select></label>
                <label>Qty<input type="number" min="1" step="1" value={item.orderedQuantity} onChange={(event) => setPurchaseOrderItems((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, orderedQuantity: event.target.value } : line))} disabled={purchaseOrderRetry} required /></label>
                <label>Unit cost (₹)<input type="number" min="0.01" step="0.01" value={item.unitCost} onChange={(event) => setPurchaseOrderItems((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, unitCost: event.target.value } : line))} disabled={purchaseOrderRetry} required /></label>
                <button type="button" className="pos-remove-button" onClick={() => setPurchaseOrderItems((current) => current.filter((_, lineIndex) => lineIndex !== index))} disabled={purchaseOrderItems.length <= 1 || purchaseOrderRetry} aria-label="Remove purchase order line"><X size={15} /></button>
              </div>)}
            </div>
            <div className="pos-procurement-form-actions">
              <button type="button" className="pos-button secondary compact" onClick={() => setPurchaseOrderItems((current) => [...current, { variantId: "", orderedQuantity: "1", unitCost: "" }])} disabled={purchaseOrderRetry}>Add line</button>
              <button type="submit" className="pos-button primary" disabled={procurementSaving || !selectedSupplierId || !locationId}>{procurementSaving ? "Creating…" : purchaseOrderRetry ? "Retry same draft PO" : "Create draft PO"}</button>
            </div>
          </form>
        </div>

        <div className="pos-procurement-orders">
          <div className="pos-panel-heading"><div><h4>Purchase orders</h4><p>Orders for the selected store location.</p></div></div>
          {procurementLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading purchase orders…</span></div>
            : purchaseOrders.filter((order) => String(order.locationId) === String(locationId)).length === 0
              ? <div className="pos-empty-state"><Truck /><strong>No purchase orders yet</strong><span>Create a supplier and draft order above.</span></div>
              : purchaseOrders.filter((order) => String(order.locationId) === String(locationId)).map((order) => (
                <article className="pos-po-card" key={order.id}>
                  <div className="pos-po-card-heading">
                    <div><strong>{order.orderNumber}</strong><span>{order.supplierName} · {order.locationName}</span></div>
                    <div><span className={`pos-po-status ${order.status.toLowerCase().replaceAll("_", "-")}`}>{order.status.replaceAll("_", " ")}</span><strong>{money(order.subtotal)}</strong></div>
                  </div>
                  <details className="pos-po-details">
                    <summary>{order.items.length} SKU lines · View quantities</summary>
                    <div className="pos-po-detail-lines">{order.items.map((item) => <div key={item.id}>
                      <span><strong>{item.productName}</strong><small>{item.variantName} · {item.sku}</small></span>
                      <span>Ordered {item.orderedQuantity}</span><span>Received {item.receivedQuantity}</span><span>Returned {item.returnedQuantity}</span>
                    </div>)}</div>
                  </details>
                  <div className="pos-po-actions">
                    {order.status === "DRAFT" && <button type="button" className="pos-button secondary compact" onClick={() => submitPurchaseOrder(order)} disabled={procurementSaving}>Submit order</button>}
                    {["ORDERED", "PARTIALLY_RECEIVED"].includes(order.status) && <button type="button" className="pos-button primary compact" onClick={() => openGoodsReceipt(order)} disabled={stockCountActive}>Receive goods</button>}
                    {["PARTIALLY_RECEIVED", "RECEIVED"].includes(order.status) && order.items.some((item) => item.receivedQuantity > item.returnedQuantity) &&
                      <button type="button" className="pos-button secondary compact" onClick={() => openSupplierReturn(order)} disabled={stockCountActive}>Return to supplier</button>}
                  </div>
                </article>
              ))}
        </div>
      </section>

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
            <button type="submit" className="pos-button primary" disabled={variantSaving || productsLoading || !selectedProductId || stockCountActive}>
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
            <button type="submit" className="pos-button primary" disabled={receiptSaving || !locationId || !selectedVariantId || stockCountActive}>
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
            <button type="submit" className="pos-button primary" disabled={adjustmentSaving || !locationId || !selectedVariantId || stockCountActive}>
              {adjustmentSaving ? <><RefreshCw className="pos-spin" size={15} /> Adjusting…</> : adjustmentRetry ? <><RefreshCw size={15} /> Retry same adjustment</> : <><Plus size={16} /> Apply adjustment</>}
            </button>
          </form>
        </section>
      </div>

      {receivingOrder && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !goodsReceiptSaving && !goodsReceiptRetry) setReceivingOrder(null);
      }}>
        <section className="pos-procurement-modal" role="dialog" aria-modal="true" aria-labelledby="goods-receipt-title">
          <div className="pos-modal-toolbar"><div><span className="pos-eyebrow">GOODS RECEIPT</span><h2 id="goods-receipt-title">{receivingOrder.orderNumber}</h2></div>
            <button type="button" className="pos-icon-button" onClick={() => setReceivingOrder(null)} disabled={goodsReceiptSaving || goodsReceiptRetry} aria-label="Close goods receipt"><X /></button></div>
          <p>Enter quantities physically received. The backend rejects quantities above the outstanding order balance.</p>
          {procurementActionError && <p className="pos-return-error" role="alert">{procurementActionError}</p>}
          {receivingOrder.items.filter((item) => item.outstandingQuantity > 0).map((item) => <label className="pos-procurement-quantity-row" key={item.id}>
            <span><strong>{item.productName}</strong><small>{item.variantName} · {item.sku} · Outstanding {item.outstandingQuantity}</small></span>
            <input type="number" min="0" max={item.outstandingQuantity} step="1" value={goodsReceiptQuantities[item.id] || ""}
              onChange={(event) => setGoodsReceiptQuantities((current) => ({ ...current, [item.id]: Math.min(item.outstandingQuantity, Math.max(0, Number(event.target.value) || 0)) }))}
              disabled={goodsReceiptSaving || goodsReceiptRetry} />
          </label>)}
          <label className="pos-return-field">Receipt reason<input value={goodsReceiptReason} onChange={(event) => setGoodsReceiptReason(event.target.value)} maxLength={500} disabled={goodsReceiptSaving || goodsReceiptRetry} /></label>
          {goodsReceiptRetry && <p className="pos-retry-note">Retry the exact same receipt. Its original idempotency key is retained.</p>}
          <div className="pos-modal-actions">
            <button type="button" className="pos-button secondary" onClick={() => setReceivingOrder(null)} disabled={goodsReceiptSaving || goodsReceiptRetry}>Cancel</button>
            <button type="button" className="pos-button primary" onClick={receivePurchaseOrderGoods} disabled={goodsReceiptSaving || stockCountActive}>{goodsReceiptSaving ? "Receiving…" : goodsReceiptRetry ? "Retry same receipt" : "Confirm goods receipt"}</button>
          </div>
        </section>
      </div>}

      {supplierReturnOrder && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !supplierReturnSaving && !supplierReturnRetry) setSupplierReturnOrder(null);
      }}>
        <section className="pos-procurement-modal" role="dialog" aria-modal="true" aria-labelledby="supplier-return-title">
          <div className="pos-modal-toolbar"><div><span className="pos-eyebrow">SUPPLIER RETURN</span><h2 id="supplier-return-title">{supplierReturnOrder.orderNumber}</h2></div>
            <button type="button" className="pos-icon-button" onClick={() => setSupplierReturnOrder(null)} disabled={supplierReturnSaving || supplierReturnRetry} aria-label="Close supplier return"><X /></button></div>
          <p>Return received goods to the supplier. The backend prevents returning more than the received quantity or removing reserved stock.</p>
          {procurementActionError && <p className="pos-return-error" role="alert">{procurementActionError}</p>}
          {supplierReturnOrder.items.filter((item) => item.receivedQuantity > item.returnedQuantity).map((item) => {
            const returnable = item.receivedQuantity - item.returnedQuantity;
            return <label className="pos-procurement-quantity-row" key={item.id}>
              <span><strong>{item.productName}</strong><small>{item.variantName} · {item.sku} · Returnable {returnable}</small></span>
              <input type="number" min="0" max={returnable} step="1" value={supplierReturnQuantities[item.id] || ""}
                onChange={(event) => setSupplierReturnQuantities((current) => ({ ...current, [item.id]: Math.min(returnable, Math.max(0, Number(event.target.value) || 0)) }))}
                disabled={supplierReturnSaving || supplierReturnRetry} />
            </label>;
          })}
          <label className="pos-return-field">Supplier return reason<input value={supplierReturnReason} onChange={(event) => setSupplierReturnReason(event.target.value)} maxLength={500} disabled={supplierReturnSaving || supplierReturnRetry} /></label>
          {supplierReturnRetry && <p className="pos-retry-note">Retry the exact same supplier return. Its original idempotency key is retained.</p>}
          <div className="pos-modal-actions">
            <button type="button" className="pos-button secondary" onClick={() => setSupplierReturnOrder(null)} disabled={supplierReturnSaving || supplierReturnRetry}>Cancel</button>
            <button type="button" className="pos-button primary" onClick={returnPurchaseOrderGoods} disabled={supplierReturnSaving || stockCountActive}>{supplierReturnSaving ? "Recording…" : supplierReturnRetry ? "Retry same return" : "Confirm supplier return"}</button>
          </div>
        </section>
      </div>}

      <section className="pos-inventory-card pos-stock-card">
        <div className="pos-inventory-card-heading"><Package size={18} /><div><h3>Current stock by variant</h3><p>{selectedProduct?.name || "Select a product"} · {stockRows.length} active variants at this location</p></div></div>
        <div className="pos-low-stock-alerts">
          <div className="pos-low-stock-heading"><strong>Low stock alerts</strong><span>{lowStockLoading ? "Refreshing…" : `${lowStockAlerts.length} variants at or below reorder level`}</span></div>
          {lowStockLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading alerts…</span></div>
            : lowStockAlerts.length === 0 ? <p>No low-stock alerts. Set a reorder level above zero on a variant to enable alerts.</p>
              : <div className="pos-low-stock-list">{lowStockAlerts.map((item) => <div key={item.variantId}>
                <span><strong>{item.productName}</strong><small>{item.variantName} · {item.sku} · {item.locationName}</small></span>
                <span><strong>{item.availableQuantity} available</strong><small>Reorder at {item.reorderLevel}</small></span>
              </div>)}</div>}
        </div>
        {variantsLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading variants…</span></div>
          : stockRows.length === 0 ? <div className="pos-empty-state"><Package /><strong>No stockable variants yet</strong><span>Create a variant and receive stock to make this product available in POS.</span></div>
          : <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Variant</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Reorder level</th><th>Price</th></tr></thead><tbody>{stockRows.map((variant) => <tr key={variant.variantId}><td><strong>{variant.variantName}</strong></td><td>{variant.sku}</td><td>{variant.onHandQuantity}</td><td>{variant.reservedQuantity}</td><td><strong>{variant.availableQuantity}</strong></td><td><div className="pos-reorder-control"><input type="number" min="0" max="1000000" step="1" value={reorderDrafts[variant.variantId] ?? variant.reorderLevel ?? 0} onChange={(event) => setReorderDrafts((current) => ({ ...current, [variant.variantId]: event.target.value }))} aria-label={`Reorder level for ${variant.sku}`} /><button type="button" className="pos-button secondary compact" onClick={() => updateReorderLevel(variant.variantId, variant.reorderLevel ?? 0)} disabled={reorderDrafts[variant.variantId] == null}>Save</button></div></td><td>{money(variant.sellingPrice)}</td></tr>)}</tbody></table></div>}
      </section>
      <section className="pos-inventory-card pos-stock-card">
        <div className="pos-inventory-card-heading">
          <ClipboardCheck size={18} />
          <div><h3>Stock movement history</h3><p>Append-only audit ledger for receipts, sales, reservations, returns and adjustments.</p></div>
          <button type="button" className="pos-button secondary compact" onClick={() => loadMovementHistory(movementPage)} disabled={movementLoading}>
            <RefreshCw size={15} className={movementLoading ? "pos-spin" : ""} /> Refresh
          </button>
        </div>
        <div className="pos-report-filters">
          <label>Filter variant
            <select value={movementVariantId} onChange={(event) => setMovementVariantId(event.target.value)}>
              <option value="">All variants</option>
              {catalog.flatMap((product) => (product.variants || []).map((variant) => (
                <option key={variant.variantId} value={variant.variantId}>{product.name} · {variant.variantName || variant.sku} · {variant.sku}</option>
              )))}
            </select>
          </label>
        </div>
        {movementLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Loading stock movements…</span></div>
          : movementRows.length === 0 ? <div className="pos-empty-state"><ClipboardCheck /><strong>No stock movements found</strong><span>Receipts, sales and other stock ledger events will appear here.</span></div>
            : <div className="pos-history-table-wrap"><table className="pos-history-table">
              <thead><tr><th>Date</th><th>Product / SKU</th><th>Movement</th><th>Qty Δ</th><th>Reserved Δ</th><th>On hand after</th><th>Reserved after</th><th>Reference</th><th>Reason</th></tr></thead>
              <tbody>{movementRows.map((movement) => <tr key={movement.id}>
                <td>{movement.createdAt ? new Date(movement.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}</td>
                <td><strong>{movement.productName}</strong><small>{movement.variantName} · {movement.sku}</small></td>
                <td>{movement.movementType}</td>
                <td><strong>{Number(movement.quantityDelta) > 0 ? "+" : ""}{movement.quantityDelta}</strong></td>
                <td>{Number(movement.reservedDelta) > 0 ? "+" : ""}{movement.reservedDelta}</td>
                <td>{movement.onHandAfter}</td><td>{movement.reservedAfter}</td>
                <td>{movement.referenceType || "—"}{movement.referenceId ? <small>#{movement.referenceId}</small> : null}</td>
                <td>{movement.reason || "—"}</td>
              </tr>)}</tbody>
            </table></div>}
        <div className="pos-pagination">
          <span>Page {movementPages ? movementPage + 1 : 0} of {movementPages}</span>
          <div>
            <button type="button" disabled={movementPage <= 0 || movementLoading} onClick={() => loadMovementHistory(movementPage - 1)} aria-label="Previous stock movement page"><ChevronLeft size={18} /></button>
            <button type="button" disabled={movementPage + 1 >= movementPages || movementLoading} onClick={() => loadMovementHistory(movementPage + 1)} aria-label="Next stock movement page"><ChevronRight size={18} /></button>
          </div>
        </div>
      </section>
    </section>
  );
}

export default function PosTerminal() {
  const navigate = useNavigate();
  const staffRole = sessionStorage.getItem("adminRole") || "CASHIER";
  const canManageInventory = staffRole === "ADMIN" || staffRole === "MANAGER";
  const canViewHistory = staffRole === "ADMIN" || staffRole === "MANAGER";
  const canApplyDiscount = staffRole === "ADMIN" || staffRole === "MANAGER";
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState("");
  const [locationStockCountLocked, setLocationStockCountLocked] = useState(false);
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
  const [reportFrom, setReportFrom] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [reportTo, setReportTo] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [salesReport, setSalesReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [selectedHistorySale, setSelectedHistorySale] = useState(null);
  const [selectedSaleReturns, setSelectedSaleReturns] = useState(null);
  const [saleReturnsLoading, setSaleReturnsLoading] = useState(false);
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("Sale cancelled before customer leaves");
  const [voidRefunds, setVoidRefunds] = useState([]);
  const [voidSaving, setVoidSaving] = useState(false);
  const [voidRetry, setVoidRetry] = useState(false);
  const [voidPayload, setVoidPayload] = useState(null);
  const [voidError, setVoidError] = useState("");
  const voidPending = useRef(null);
  const [returnSale, setReturnSale] = useState(null);
  const [saleReturns, setSaleReturns] = useState([]);
  const [returnReason, setReturnReason] = useState("");
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnDispositions, setReturnDispositions] = useState({});
  const [returnDispositionReasons, setReturnDispositionReasons] = useState({});
  const [returnPaymentMethod, setReturnPaymentMethod] = useState("CASH");
  const [returnPaymentReference, setReturnPaymentReference] = useState("");
  const [returnLoading, setReturnLoading] = useState(false);
  const [returnSaving, setReturnSaving] = useState(false);
  const [returnRetryPending, setReturnRetryPending] = useState(false);
  const [returnPendingPayload, setReturnPendingPayload] = useState(null);
  const returnPendingKey = useRef(null);
  const [exchangeMode, setExchangeMode] = useState(false);
  const [exchangeReason, setExchangeReason] = useState("");
  const [exchangeItems, setExchangeItems] = useState([]);
  const [exchangeSelectedVariantId, setExchangeSelectedVariantId] = useState("");
  const [exchangeDiscount, setExchangeDiscount] = useState("0.00");
  const [exchangeCollectionMethod, setExchangeCollectionMethod] = useState("CASH");
  const [exchangeCollectionTendered, setExchangeCollectionTendered] = useState("");
  const [exchangeCollectionReference, setExchangeCollectionReference] = useState("");
  const [exchangeRefundMethod, setExchangeRefundMethod] = useState("CASH");
  const [exchangeRefundReference, setExchangeRefundReference] = useState("");
  const [exchangeSaving, setExchangeSaving] = useState(false);
  const [exchangeRetryPending, setExchangeRetryPending] = useState(false);
  const [exchangePendingPayload, setExchangePendingPayload] = useState(null);
  const exchangePendingKey = useRef(null);
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
    if (!locationId) { setCatalog([]); setLocationStockCountLocked(false); return; }
    setCatalogLoading(true);
    setError("");
    try {
      const data = await apiRequest(`/admin/pos/catalog?locationId=${encodeURIComponent(locationId)}`);
      setCatalog(Array.isArray(data?.products) ? data.products : []);
      setLocationStockCountLocked(Boolean(data?.stockCountLocked));
      setSelectedVariants({});
    } catch (err) { setError(err.message); }
    finally { setCatalogLoading(false); }
  }, [locationId]);

  const loadSalesReport = useCallback(async () => {
    if (!locationId || !reportFrom || !reportTo) return;
    setReportLoading(true);
    setError("");
    try {
      const data = await apiRequest(`/admin/pos/reports/sales?locationId=${encodeURIComponent(locationId)}&from=${encodeURIComponent(reportFrom)}&to=${encodeURIComponent(reportTo)}`);
      setSalesReport(data);
    } catch (err) { setError(err.message); }
    finally { setReportLoading(false); }
  }, [locationId, reportFrom, reportTo]);

  const openVoidDialog = (sale) => {
    if (selectedSaleReturns === null) {
      setError("Return history could not be verified. Close and reopen this transaction before attempting a full void.");
      return;
    }
    if (selectedSaleReturns.length > 0) {
      setError("A full void is not allowed because this sale already has a return or void record.");
      return;
    }
    setVoidReason("Sale cancelled before customer leaves");
    setVoidRefunds((sale.payments || []).map((payment) => ({
      paymentMethod: payment.paymentMethod,
      amount: payment.amount,
      transactionReference: "",
    })));
    setVoidPayload(null);
    voidPending.current = null;
    setVoidRetry(false);
    setVoidError("");
    setVoidDialogOpen(true);
  };

  const submitVoid = async () => {
    if (!selectedHistorySale || !shift?.id || !voidReason.trim()) {
      setVoidError("An open manager shift and a void reason are required.");
      return;
    }
    if (!voidPayload) {
      voidPending.current = voidPending.current || newIdempotencyKey();
      setVoidPayload({
        shiftId: shift.id,
        reason: voidReason.trim(),
        idempotencyKey: voidPending.current,
        refundPayments: voidRefunds.map((payment) => ({
          paymentMethod: payment.paymentMethod,
          amount: Number(payment.amount),
          transactionReference: payment.transactionReference.trim() || null,
        })),
      });
    }
    const payload = voidPayload || {
      shiftId: shift.id,
      reason: voidReason.trim(),
      idempotencyKey: voidPending.current,
      refundPayments: voidRefunds.map((payment) => ({
        paymentMethod: payment.paymentMethod,
        amount: Number(payment.amount),
        transactionReference: payment.transactionReference.trim() || null,
      })),
    };
    setVoidSaving(true);
    setVoidError("");
    try {
      const result = await apiRequest(`/admin/pos/sales/${selectedHistorySale.id}/void`, {
        method: "POST", body: JSON.stringify(payload),
      });
      setVoidDialogOpen(false);
      setSelectedHistorySale(null);
      setVoidPayload(null);
      voidPending.current = null;
      setVoidRetry(false);
      await Promise.all([loadHistory(historyPage), loadCatalog(), loadSalesReport()]);
      setNotice(`Sale ${result.invoiceNumber} voided. Refund ${money(result.refundTotal)} recorded.`);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setVoidRetry(uncertain);
      setVoidError(`${err.message}${uncertain ? " Retry the exact same void request; its idempotency key is retained." : ""}`);
      if (!uncertain) { setVoidPayload(null); voidPending.current = null; }
    } finally { setVoidSaving(false); }
  };

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
  useEffect(() => { if (activeTab === "reports") loadSalesReport(); }, [activeTab, loadSalesReport]);

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

  const getReturnLineInfo = (item) => {
    if (!returnSale) return { remaining: 0, refund: 0 };
    const toCents = (value) => Math.round((Number(value) || 0) * 100);
    const fromCents = (value) => value / 100;
    const roundMultiplyDivideHalfUp = (amountCents, multiplier, denominator) => {
      const divisor = BigInt(denominator);
      if (divisor <= 0n) return 0;
      const numerator = BigInt(amountCents) * BigInt(multiplier);
      return Number((numerator + divisor / 2n) / divisor);
    };

    const previous = saleReturns.flatMap((record) => record.items || [])
      .filter((returned) => Number(returned.saleItemId) === Number(item.id));
    const returnedQuantity = previous.reduce((sum, returned) => sum + Number(returned.quantity || 0), 0);
    const previouslyRefundedCents = previous.reduce((sum, returned) => sum + toCents(returned.refundAmount), 0);
    const soldQuantity = Math.max(0, Number(item.quantity || 0));
    const remaining = Math.max(0, soldQuantity - returnedQuantity);
    const quantity = Math.min(remaining, Math.max(0, Number(returnQuantities[item.id] || 0)));

    // Match the backend's ordered, cent-precise discount allocation exactly:
    // round each proportional share HALF_UP, cap it at the remaining discount,
    // and assign the final remainder to the last sale line.
    const sorted = [...(returnSale.items || [])].sort((a, b) => Number(a.id) - Number(b.id));
    const subtotalCents = toCents(returnSale.subtotal);
    const totalDiscountCents = toCents(returnSale.discountAmount);
    let allocatedDiscountCents = 0;
    let lineDiscountCents = 0;
    sorted.forEach((saleLine, index) => {
      const lineGrossCents = toCents(saleLine.lineTotal);
      let shareCents = index === sorted.length - 1
        ? totalDiscountCents - allocatedDiscountCents
        : roundMultiplyDivideHalfUp(totalDiscountCents, lineGrossCents, subtotalCents);
      shareCents = Math.max(0, Math.min(shareCents, totalDiscountCents - allocatedDiscountCents));
      if (Number(saleLine.id) === Number(item.id)) lineDiscountCents = shareCents;
      allocatedDiscountCents += shareCents;
    });

    const netLineCents = Math.max(0, toCents(item.lineTotal) - lineDiscountCents);
    const refundCents = quantity === 0 ? 0
      : quantity === remaining
        ? Math.max(0, netLineCents - previouslyRefundedCents)
        : roundMultiplyDivideHalfUp(netLineCents, quantity, Math.max(1, soldQuantity));
    return { remaining, refund: fromCents(refundCents) };
  };

  const returnQuote = useMemo(() => {
    if (!returnSale) return 0;
    return (returnSale.items || []).reduce((sum, item) => sum + getReturnLineInfo(item).refund, 0);
  }, [returnSale, saleReturns, returnQuantities]);

  const exchangeSubtotal = exchangeItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const exchangeDiscountValue = Math.max(0, Number((Number(exchangeDiscount) || 0).toFixed(2)));
  const exchangeReplacementValue = Math.max(0, exchangeSubtotal - exchangeDiscountValue);
  const exchangeCollectionDue = Math.max(0, exchangeReplacementValue - returnQuote);
  const exchangeRefundDue = Math.max(0, returnQuote - exchangeReplacementValue);
  const exchangeCatalogVariants = useMemo(() => catalog.flatMap((product) =>
    (product.variants || []).map((variant) => ({
      productId: product.productId,
      productName: product.name,
      variantId: variant.variantId,
      variantName: variant.variantName,
      sku: variant.sku,
      sellingPrice: Number(variant.sellingPrice || 0),
      availableQuantity: Number(variant.availableQuantity || 0),
    }))
  ).filter((variant) => variant.productId && variant.variantId && variant.sellingPrice > 0),
  [catalog]);

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
    if (locationStockCountLocked) { setError("A physical stock count is in progress at this location. Sales are temporarily frozen."); return; }
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
      if (err.status === 409) await loadCatalog();
      setError(`${err.message} Your cart is preserved.${!err.status || err.status >= 500 || err.status === 409 ? " Retry the exact same checkout; the same request key will be reused to prevent a duplicate sale." : " Correct the details and submit again."}`);
    } finally { setCheckoutLoading(false); }
  };

  const beginReturn = async () => {
    if (!selectedHistorySale) return;
    setReturnLoading(true);
    setError("");
    try {
      const rows = await apiRequest(`/admin/pos/sales/${selectedHistorySale.id}/returns`);
      setSaleReturns(Array.isArray(rows) ? rows : []);
      setReturnSale(selectedHistorySale);
      setExchangeMode(false);
      setReturnReason("");
      setReturnQuantities({});
      setReturnDispositions({});
      setReturnDispositionReasons({});
      setReturnPaymentMethod("CASH");
      setReturnPaymentReference("");
      setReturnRetryPending(false);
      setReturnPendingPayload(null);
      returnPendingKey.current = null;
      setSelectedHistorySale(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setReturnLoading(false);
    }
  };

  const beginExchange = async () => {
    if (!selectedHistorySale) return;
    setReturnLoading(true);
    setError("");
    try {
      const rows = await apiRequest(`/admin/pos/sales/${selectedHistorySale.id}/returns`);
      setSaleReturns(Array.isArray(rows) ? rows : []);
      setReturnSale(selectedHistorySale);
      setReturnQuantities({});
      setReturnDispositions({});
      setReturnDispositionReasons({});
      setExchangeReason("");
      setExchangeItems([]);
      setExchangeSelectedVariantId("");
      setExchangeDiscount("0.00");
      setExchangeCollectionMethod("CASH");
      setExchangeCollectionTendered("");
      setExchangeCollectionReference("");
      setExchangeRefundMethod("CASH");
      setExchangeRefundReference("");
      setExchangeRetryPending(false);
      setExchangePendingPayload(null);
      exchangePendingKey.current = null;
      setExchangeMode(true);
      setSelectedHistorySale(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setReturnLoading(false);
    }
  };

  const addExchangeItem = () => {
    const selected = exchangeCatalogVariants.find((item) => String(item.variantId) === String(exchangeSelectedVariantId));
    if (!selected) return;
    setExchangeItems((current) => {
      const existing = current.find((item) => item.variantId === selected.variantId);
      if (existing) return current.map((item) => item.variantId === selected.variantId
        ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { ...selected, quantity: 1 }];
    });
  };

  const updateExchangeQuantity = (variantId, quantity) => {
    const next = Math.max(1, Math.min(9999, Number(quantity) || 1));
    setExchangeItems((current) => current.map((item) => item.variantId === variantId ? { ...item, quantity: next } : item));
  };

  const submitExchange = async () => {
    if (!returnSale) return;
    if (!shift?.id || shift.status !== "OPEN") { setError("Open an authorized shift before processing an exchange."); return; }
    if (!exchangeReason.trim()) { setError("An exchange reason is required."); return; }
    const selectedItems = (returnSale.items || []).filter((item) => Number(returnQuantities[item.id] || 0) > 0);
    if (!selectedItems.length) { setError("Select at least one original sale quantity to exchange."); return; }
    if (!exchangeItems.length) { setError("Add at least one replacement item."); return; }
    if (exchangeDiscountValue > exchangeSubtotal) { setError("Replacement discount cannot exceed replacement subtotal."); return; }
    for (const item of selectedItems) {
      const disposition = returnDispositions[item.id] || "RESTOCK";
      if (disposition !== "RESTOCK" && !(returnDispositionReasons[item.id] || "").trim()) {
        setError("Explain why each damaged or discarded returned item cannot be restocked."); return;
      }
    }
    if (exchangeRefundDue > 0 && exchangeRefundMethod !== "CASH" && !exchangeRefundReference.trim()) {
      setError("Enter the completed UPI/card refund transaction reference."); return;
    }
    if (exchangeCollectionDue > 0 && exchangeCollectionMethod === "CASH"
        && (Number(exchangeCollectionTendered) || 0) < exchangeCollectionDue) {
      setError("Cash received must cover the amount due for the replacement."); return;
    }
    if (!exchangePendingPayload) {
      exchangePendingKey.current = exchangePendingKey.current || newIdempotencyKey();
      const payload = {
        shiftId: Number(shift.id),
        reason: exchangeReason.trim(),
        idempotencyKey: exchangePendingKey.current,
        returnItems: selectedItems.map((item) => ({
          saleItemId: Number(item.id),
          quantity: Number(returnQuantities[item.id]),
          restockDisposition: returnDispositions[item.id] || "RESTOCK",
          dispositionReason: (returnDispositionReasons[item.id] || "").trim() || null,
        })),
        replacementItems: exchangeItems.map((item) => ({
          productId: Number(item.productId), variantId: Number(item.variantId), quantity: Number(item.quantity),
        })),
        replacementDiscountAmount: Number(amount(exchangeDiscountValue)),
        collectionPayments: exchangeCollectionDue > 0 ? [{
          paymentMethod: exchangeCollectionMethod,
          amount: Number(amount(exchangeCollectionDue)),
          ...(exchangeCollectionMethod === "CASH" ? { tenderedAmount: Number(amount(exchangeCollectionTendered)) } : {}),
          ...(exchangeCollectionReference.trim() ? { transactionReference: exchangeCollectionReference.trim() } : {}),
        }] : [],
        refundPayments: exchangeRefundDue > 0 ? [{
          paymentMethod: exchangeRefundMethod,
          amount: Number(amount(exchangeRefundDue)),
          ...(exchangeRefundMethod !== "CASH" ? { transactionReference: exchangeRefundReference.trim() } : {}),
        }] : [],
      };
      setExchangePendingPayload(payload);
    }
    const payload = exchangePendingPayload || {
      shiftId: Number(shift.id), reason: exchangeReason.trim(), idempotencyKey: exchangePendingKey.current,
      returnItems: selectedItems.map((item) => ({
        saleItemId: Number(item.id), quantity: Number(returnQuantities[item.id]),
        restockDisposition: returnDispositions[item.id] || "RESTOCK",
        dispositionReason: (returnDispositionReasons[item.id] || "").trim() || null,
      })),
      replacementItems: exchangeItems.map((item) => ({ productId: Number(item.productId), variantId: Number(item.variantId), quantity: Number(item.quantity) })),
      replacementDiscountAmount: Number(amount(exchangeDiscountValue)),
      collectionPayments: exchangeCollectionDue > 0 ? [{
        paymentMethod: exchangeCollectionMethod, amount: Number(amount(exchangeCollectionDue)),
        ...(exchangeCollectionMethod === "CASH" ? { tenderedAmount: Number(amount(exchangeCollectionTendered)) } : {}),
        ...(exchangeCollectionReference.trim() ? { transactionReference: exchangeCollectionReference.trim() } : {}),
      }] : [],
      refundPayments: exchangeRefundDue > 0 ? [{
        paymentMethod: exchangeRefundMethod, amount: Number(amount(exchangeRefundDue)),
        ...(exchangeRefundMethod !== "CASH" ? { transactionReference: exchangeRefundReference.trim() } : {}),
      }] : [],
    };
    setExchangeSaving(true);
    setError("");
    try {
      const result = await apiRequest(`/admin/pos/sales/${returnSale.id}/exchange`, {
        method: "POST", body: JSON.stringify(payload),
      });
      setReturnSale(null);
      setExchangeMode(false);
      setExchangeItems([]);
      setExchangePendingPayload(null);
      exchangePendingKey.current = null;
      setExchangeRetryPending(false);
      setNotice(`Exchange #${result.id} recorded. Credit applied: ${money(result.creditApplied)}. Collected: ${money(result.amountCollected)}. Refunded: ${money(result.actualRefund)}.`);
      await Promise.all([loadCatalog(), loadCurrentShift(), loadHistory(historyPage)]);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setExchangeRetryPending(uncertain);
      if (!uncertain) { setExchangePendingPayload(null); exchangePendingKey.current = null; }
      setError(`${err.message}${uncertain ? " Retry the exact same exchange request; its idempotency key is retained." : ""}`);
    } finally { setExchangeSaving(false); }
  };

  const submitReturn = async () => {
    if (!returnSale) return;
    if (!shift?.id || shift.status !== "OPEN") {
      setError("Open your own cashier shift before processing a return.");
      return;
    }
    if (!returnReason.trim()) {
      setError("A return reason is required.");
      return;
    }

    const selectedItems = (returnSale.items || []).filter((item) => Number(returnQuantities[item.id] || 0) > 0);
    if (!selectedItems.length) {
      setError("Select at least one quantity to return.");
      return;
    }
    for (const item of selectedItems) {
      const disposition = returnDispositions[item.id] || "RESTOCK";
      if (disposition !== "RESTOCK" && !(returnDispositionReasons[item.id] || "").trim()) {
        setError("Explain why each damaged or discarded item cannot be restocked.");
        return;
      }
    }
    if (returnQuote > 0 && returnPaymentMethod !== "CASH" && !returnPaymentReference.trim()) {
      setError("Enter the completed UPI/card refund transaction reference.");
      return;
    }

    if (!returnPendingPayload) {
      returnPendingKey.current = returnPendingKey.current || newIdempotencyKey();
      const payload = {
        shiftId: Number(shift.id),
        reason: returnReason.trim(),
        idempotencyKey: returnPendingKey.current,
        items: selectedItems.map((item) => ({
          saleItemId: Number(item.id),
          quantity: Number(returnQuantities[item.id]),
          restockDisposition: returnDispositions[item.id] || "RESTOCK",
          dispositionReason: (returnDispositionReasons[item.id] || "").trim() || null,
        })),
        refundPayments: returnQuote > 0 ? [{
          paymentMethod: returnPaymentMethod,
          amount: Number(amount(returnQuote)),
          ...(returnPaymentMethod !== "CASH" ? { transactionReference: returnPaymentReference.trim() } : {}),
        }] : [],
      };
      setReturnPendingPayload(payload);
    }

    const payload = returnPendingPayload || {
      shiftId: Number(shift.id),
      reason: returnReason.trim(),
      idempotencyKey: returnPendingKey.current,
      items: selectedItems.map((item) => ({
        saleItemId: Number(item.id),
        quantity: Number(returnQuantities[item.id]),
        restockDisposition: returnDispositions[item.id] || "RESTOCK",
        dispositionReason: (returnDispositionReasons[item.id] || "").trim() || null,
      })),
      refundPayments: returnQuote > 0 ? [{
        paymentMethod: returnPaymentMethod,
        amount: Number(amount(returnQuote)),
        ...(returnPaymentMethod !== "CASH" ? { transactionReference: returnPaymentReference.trim() } : {}),
      }] : [],
    };

    setReturnSaving(true);
    setError("");
    try {
      const record = await apiRequest(`/admin/pos/sales/${returnSale.id}/returns`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setReturnSale(null);
      setReturnPendingPayload(null);
      returnPendingKey.current = null;
      setReturnRetryPending(false);
      setNotice(`Return ${record.returnNumber} recorded. Refund total: ${money(record.refundTotal)}.`);
      await Promise.all([loadCatalog(), loadCurrentShift(), loadHistory(historyPage)]);
    } catch (err) {
      const uncertain = !err.status || err.status >= 500 || err.status === 409;
      setReturnRetryPending(uncertain);
      if (!uncertain) {
        setReturnPendingPayload(null);
        returnPendingKey.current = null;
      }
      setError(`${err.message}${uncertain ? " Retry the exact same return request; its original idempotency key is retained." : ""}`);
    } finally {
      setReturnSaving(false);
    }
  };

  const openHistorySale = async (sale) => {
    setSelectedHistorySale(sale);
    setSelectedSaleReturns(null);
    setSaleReturnsLoading(true);
    try {
      const full = await apiRequest(`/admin/pos/sales/${sale.id}`);
      setSelectedHistorySale(full);
      const rows = await apiRequest(`/admin/pos/sales/${sale.id}/returns`);
      setSelectedSaleReturns(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaleReturnsLoading(false);
    }
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
          {staffRole === "ADMIN" && (
            <button type="button" className="pos-back-button" onClick={() => navigate("/admin/dashboard")} aria-label="Back to admin dashboard"><ArrowLeft size={18} /></button>
          )}
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
            {canViewHistory && <button type="button" className={`pos-tab-button ${activeTab === "reports" ? "active" : ""}`} onClick={() => setActiveTab("reports")}><BarChart3 size={17} /> Reports</button>}
          </div>
        </div>

        {error && <div className="pos-alert error" role="alert"><AlertCircle size={18} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
        {notice && <div className="pos-alert success" role="status"><CheckCircle2 size={18} /><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss notice"><X size={16} /></button></div>}

        {locationStockCountLocked && <div className="pos-alert error" role="alert"><AlertCircle size={18} /><span>Physical stock count in progress. Sales and stock movements are temporarily frozen at this location.</span></div>}

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
            {(!shift?.id || shift.status === "CLOSED") ? (
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
                <div className="pos-discount-row"><label htmlFor="pos-discount">Discount (₹)</label><input id="pos-discount" type="number" min="0" max={subtotal} step="0.01" value={discount} disabled={retryPending || !canApplyDiscount} onChange={(e) => setDiscount(e.target.value)} /></div>
                {!canApplyDiscount && <p className="pos-retry-note">Sale discounts require ADMIN or MANAGER approval.</p>}
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
                {(payments.some((payment) => payment.paymentMethod === "UPI" || payment.paymentMethod === "CARD")) && (
                  <p className="pos-retry-note">For UPI or card, collect payment using the shop's QR code or card terminal and verify it succeeded before completing this sale. This POS records the tender and reference; it does not initiate or verify the provider payment.</p>
                )}
                {payments.length < 3 && <button type="button" className="pos-add-split" onClick={addSplitPayment} disabled={retryPending}><Plus size={15} /> Add split payment</button>}
                <div className={Math.abs(paymentTotal - grandTotal) < 0.001 ? "pos-payment-match" : "pos-payment-mismatch"}><span>Payment total</span><strong>{money(paymentTotal)}</strong></div>
                {cashChange > 0 && <div className="pos-change-row"><span>Change to return</span><strong>{money(cashChange)}</strong></div>}
              </div>

              <button type="button" className="pos-complete-button" onClick={completeSale} disabled={checkoutLoading || !cart.length || !locationId || locationStockCountLocked || !shift?.id || shift.status !== "OPEN" || Math.abs(paymentTotal - grandTotal) > 0.001}>
                {checkoutLoading ? <><RefreshCw className="pos-spin" size={18} /> Processing sale…</> : retryPending ? <><RefreshCw size={18} /> Retry same checkout · {money(grandTotal)}</> : <><Receipt size={18} /> Complete sale · {money(grandTotal)}</>}
              </button>
              <p className="pos-secure-note">Prices and stock are verified by the server. Completed sales are recorded with an audit trail.</p>
            </aside>
          </div>
        ) : activeTab === "inventory" ? (
          <InventoryPanel locationId={locationId} catalog={catalog} onRefreshCatalog={loadCatalog} onNotice={setNotice} onError={setError} />
        ) : activeTab === "reports" ? (
          <section className="pos-history-panel pos-report-panel">
            <div className="pos-panel-heading">
              <div><h2>Sales and refund reports</h2><p>Completed POS sales and returns processed during the selected period. No tax or profit calculations are included.</p></div>
              <button type="button" className="pos-button secondary compact" onClick={loadSalesReport} disabled={reportLoading}><RefreshCw size={15} className={reportLoading ? "pos-spin" : ""} /> Refresh</button>
            </div>
            <div className="pos-report-filters">
              <label>From<input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></label>
              <label>To<input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></label>
              <button type="button" className="pos-button primary" onClick={loadSalesReport} disabled={reportLoading || !reportFrom || !reportTo || reportTo < reportFrom}>Run report</button>
            </div>
            {reportLoading ? <div className="pos-empty-state"><RefreshCw className="pos-spin" /><span>Calculating report…</span></div>
              : !salesReport ? <div className="pos-empty-state"><BarChart3 /><strong>No report loaded</strong><span>Choose a date range and run the report.</span></div>
                : <>
                  <div className="pos-report-summary">
                    <article><span>Transactions</span><strong>{salesReport.transactionCount}</strong></article>
                    <article><span>Subtotal</span><strong>{money(salesReport.subtotal)}</strong></article>
                    <article><span>Discounts</span><strong>{money(salesReport.discounts)}</strong></article>
                    <article><span>Sales after discount</span><strong>{money(salesReport.netSalesBeforeRefunds)}</strong></article>
                    <article><span>Sales reversals</span><strong>{money(salesReport.salesReversals ?? salesReport.refunds)}</strong></article>
                    <article><span>Recorded refund payments</span><strong>{money(salesReport.recordedRefundPayments ?? salesReport.refunds)}</strong></article>
                    <article><span>Exchange credit applied</span><strong>{money(salesReport.exchangeCreditApplied ?? 0)}</strong></article>
                    <article><span>Net after reversals</span><strong>{money(salesReport.netSalesAfterRefunds)}</strong></article>
                  </div>
                  <div className="pos-report-grid">
                    <section><h3>Sales by payment method</h3>
                      {Object.keys(salesReport.salesByPaymentMethod || {}).length ? Object.entries(salesReport.salesByPaymentMethod).map(([method, total]) => <div className="pos-report-row" key={method}><span>{method}</span><strong>{money(total)}</strong></div>) : <p>No sales tenders.</p>}
                    </section>
                    <section><h3>Refunds by payment method</h3>
                      {Object.keys(salesReport.refundsByPaymentMethod || {}).length ? Object.entries(salesReport.refundsByPaymentMethod).map(([method, total]) => <div className="pos-report-row" key={method}><span>{method}</span><strong>{money(total)}</strong></div>) : <p>No refunds in this period.</p>}
                    </section>
                  </div>
                  <section className="pos-report-table-section"><h3>Cashier totals</h3>
                    <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Cashier</th><th>Transactions</th><th>Subtotal</th><th>Discounts</th><th>Net sales</th></tr></thead><tbody>
                      {(salesReport.cashiers || []).map((row) => <tr key={row.cashierUsername}><td>{row.cashierUsername}</td><td>{row.transactionCount}</td><td>{money(row.subtotal)}</td><td>{money(row.discounts)}</td><td><strong>{money(row.netSales)}</strong></td></tr>)}
                    </tbody></table></div>
                  </section>
                  <section className="pos-report-table-section"><h3>Daily totals</h3>
                    <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Date</th><th>Transactions</th><th>Sales</th><th>Returns</th><th>Refunds</th><th>Net after refunds</th></tr></thead><tbody>
                      {(salesReport.daily || []).map((row) => <tr key={row.date}><td>{row.date}</td><td>{row.transactionCount}</td><td>{money(row.netSales)}</td><td>{row.returnCount}</td><td>{money(row.refunds)}</td><td><strong>{money(row.netAfterRefunds)}</strong></td></tr>)}
                    </tbody></table></div>
                  </section>
                  <section className="pos-report-table-section"><h3>Top products</h3>
                    <div className="pos-history-table-wrap"><table className="pos-history-table"><thead><tr><th>Product</th><th>SKU</th><th>Gross qty sold</th><th>Gross line total</th></tr></thead><tbody>
                      {(salesReport.topProducts || []).map((row) => <tr key={row.productId}><td>{row.productName}</td><td>{row.sku || "—"}</td><td>{row.quantitySold}</td><td><strong>{money(row.grossLineTotal)}</strong></td></tr>)}
                    </tbody></table></div>
                  </section>
                </>}
          </section>
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
          <div className="pos-modal-actions">
            <button type="button" className="pos-button secondary" onClick={() => setSelectedHistorySale(null)}>Close</button>
            {canViewHistory && <button type="button" className="pos-button secondary" onClick={beginReturn} disabled={returnLoading}>{returnLoading ? "Loading…" : "Process return"}</button>}
            {canViewHistory && shift?.status === "OPEN" && <button type="button" className="pos-button secondary" onClick={beginExchange} disabled={returnLoading || locationStockCountLocked}>{returnLoading ? "Loading…" : "Process exchange"}</button>}
            {canViewHistory && shift?.status === "OPEN" && selectedSaleReturns?.length === 0 &&
              <button type="button" className="pos-button secondary" onClick={() => openVoidDialog(selectedHistorySale)} disabled={saleReturnsLoading}>Void full sale</button>}
            {canViewHistory && selectedSaleReturns?.length > 0 &&
              <p className="pos-return-note">Full void unavailable: this sale already has a return or void record.</p>}
            {canViewHistory && saleReturnsLoading && <span className="pos-retry-note">Checking return history…</span>}
            <button type="button" className="pos-button primary" onClick={openReceiptFromHistory}><Printer size={17} /> Print invoice</button>
          </div>
        </section>
      </div>}
      {returnSale && !exchangeMode && (
        <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !returnSaving && !returnRetryPending) setReturnSale(null);
        }}>
          <section className="pos-return-modal" role="dialog" aria-modal="true" aria-labelledby="pos-return-title">
            <div className="pos-modal-toolbar">
              <div><span className="pos-eyebrow">CUSTOMER RETURN</span><h2 id="pos-return-title">{returnSale.invoiceNumber}</h2></div>
              <button type="button" className="pos-icon-button" onClick={() => setReturnSale(null)} disabled={returnSaving || returnRetryPending} aria-label="Close return"><X /></button>
            </div>
            <p className="pos-return-note">Return quantities are checked against the original sale and previous returns. Only resaleable items marked RESTOCK will increase stock.</p>
            {error && <p className="pos-return-error" role="alert">{error}</p>}
            <div className="pos-return-lines">
              <table>
                <thead><tr><th>Item</th><th>Sold</th><th>Remaining</th><th>Return qty</th><th>Disposition</th></tr></thead>
                <tbody>
                  {(returnSale.items || []).map((item) => {
                    const info = getReturnLineInfo(item);
                    return <tr key={item.id}>
                      <td><strong>{item.productName}</strong><small>{item.variantName || item.sku}</small></td>
                      <td>{item.quantity}</td>
                      <td>{info.remaining}</td>
                      <td><input type="number" min="0" max={info.remaining} step="1"
                        value={returnQuantities[item.id] || ""}
                        disabled={returnSaving || returnRetryPending || info.remaining <= 0}
                        onChange={(event) => setReturnQuantities((current) => ({
                          ...current, [item.id]: Math.min(info.remaining, Math.max(0, Number(event.target.value) || 0))
                        }))} /></td>
                      <td>
                        <select value={returnDispositions[item.id] || "RESTOCK"}
                          disabled={returnSaving || returnRetryPending || Number(returnQuantities[item.id] || 0) <= 0}
                          onChange={(event) => setReturnDispositions((current) => ({ ...current, [item.id]: event.target.value }))}>
                          <option value="RESTOCK">Restock</option><option value="DAMAGED">Damaged</option><option value="DISCARD">Discard</option>
                        </select>
                        {(returnDispositions[item.id] || "RESTOCK") !== "RESTOCK" && Number(returnQuantities[item.id] || 0) > 0 &&
                          <input className="pos-return-disposition-reason" value={returnDispositionReasons[item.id] || ""}
                            onChange={(event) => setReturnDispositionReasons((current) => ({ ...current, [item.id]: event.target.value }))}
                            placeholder="Disposition reason" maxLength={500} disabled={returnSaving || returnRetryPending} />}
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <label className="pos-return-field">Return reason
              <input value={returnReason} onChange={(event) => setReturnReason(event.target.value)} maxLength={500}
                placeholder="Reason for return" disabled={returnSaving || returnRetryPending} />
            </label>
            <div className="pos-return-payment">
              <div><span>Calculated refund</span><strong>{money(returnQuote)}</strong></div>
              {returnQuote > 0 && <>
                <label>Refund method
                  <select value={returnPaymentMethod} onChange={(event) => setReturnPaymentMethod(event.target.value)} disabled={returnSaving || returnRetryPending}>
                    <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option>
                  </select>
                </label>
                {returnPaymentMethod !== "CASH" && <label>Refund transaction reference
                  <input value={returnPaymentReference} onChange={(event) => setReturnPaymentReference(event.target.value)}
                    maxLength={150} placeholder="Provider-confirmed refund reference" disabled={returnSaving || returnRetryPending} />
                </label>}
              </>}
            </div>
            {returnQuote > 0 && returnPaymentMethod !== "CASH" && <p className="pos-return-warning">Complete and verify the refund in the UPI/card provider first. This POS records the reference; it does not send the provider refund.</p>}
            <div className="pos-modal-actions">
              <button type="button" className="pos-button secondary" onClick={() => setReturnSale(null)} disabled={returnSaving || returnRetryPending}>Cancel</button>
              <button type="button" className="pos-button primary" onClick={submitReturn} disabled={returnSaving || !shift?.id || shift.status !== "OPEN"}>
                {returnSaving ? "Recording…" : returnRetryPending ? "Retry same return" : "Confirm return"}
              </button>
            </div>
          </section>
        </div>
      )}
      {returnSale && exchangeMode && (
        <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !exchangeSaving && !exchangeRetryPending) { setReturnSale(null); setExchangeMode(false); }
        }}>
          <section className="pos-return-modal pos-exchange-modal" role="dialog" aria-modal="true" aria-labelledby="pos-exchange-title">
            <div className="pos-modal-toolbar">
              <div><span className="pos-eyebrow">LINKED RETURN + REPLACEMENT SALE</span><h2 id="pos-exchange-title">Exchange {returnSale.invoiceNumber}</h2></div>
              <button type="button" className="pos-icon-button" onClick={() => { setReturnSale(null); setExchangeMode(false); }}
                disabled={exchangeSaving || exchangeRetryPending} aria-label="Close exchange"><X /></button>
            </div>
            <p className="pos-return-note">This creates one linked exchange. The original return and replacement sale, stock movements and actual cash movements commit together. Returned value becomes non-cash exchange credit; only the price difference is collected or refunded.</p>
            {error && <p className="pos-return-error" role="alert">{error}</p>}

            <h3 className="pos-exchange-section-title">1. Original items being returned</h3>
            <div className="pos-return-lines">
              <table>
                <thead><tr><th>Item</th><th>Sold</th><th>Remaining</th><th>Exchange qty</th><th>Disposition</th></tr></thead>
                <tbody>
                  {(returnSale.items || []).map((item) => {
                    const info = getReturnLineInfo(item);
                    return <tr key={item.id}>
                      <td><strong>{item.productName}</strong><small>{item.variantName || item.sku}</small></td>
                      <td>{item.quantity}</td><td>{info.remaining}</td>
                      <td><input type="number" min="0" max={info.remaining} step="1"
                        value={returnQuantities[item.id] || ""}
                        disabled={exchangeSaving || exchangeRetryPending || info.remaining <= 0}
                        onChange={(event) => setReturnQuantities((current) => ({
                          ...current, [item.id]: Math.min(info.remaining, Math.max(0, Number(event.target.value) || 0))
                        }))} /></td>
                      <td>
                        <select value={returnDispositions[item.id] || "RESTOCK"}
                          disabled={exchangeSaving || exchangeRetryPending || Number(returnQuantities[item.id] || 0) <= 0}
                          onChange={(event) => setReturnDispositions((current) => ({ ...current, [item.id]: event.target.value }))}>
                          <option value="RESTOCK">Restock</option><option value="DAMAGED">Damaged</option><option value="DISCARD">Discard</option>
                        </select>
                        {(returnDispositions[item.id] || "RESTOCK") !== "RESTOCK" && Number(returnQuantities[item.id] || 0) > 0 &&
                          <input className="pos-return-disposition-reason" value={returnDispositionReasons[item.id] || ""}
                            onChange={(event) => setReturnDispositionReasons((current) => ({ ...current, [item.id]: event.target.value }))}
                            placeholder="Disposition reason" maxLength={500} disabled={exchangeSaving || exchangeRetryPending} />}
                      </td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <label className="pos-return-field">Exchange reason
              <input value={exchangeReason} onChange={(event) => setExchangeReason(event.target.value)} maxLength={500}
                placeholder="Reason for exchange" disabled={exchangeSaving || exchangeRetryPending} />
            </label>

            <h3 className="pos-exchange-section-title">2. Replacement items</h3>
            <div className="pos-exchange-add-row">
              <select value={exchangeSelectedVariantId} onChange={(event) => setExchangeSelectedVariantId(event.target.value)}
                disabled={exchangeSaving || exchangeRetryPending}>
                <option value="">Choose a replacement product / variant</option>
                {exchangeCatalogVariants.map((item) => <option key={item.variantId} value={item.variantId}>
                  {item.productName} — {item.variantName || item.sku} · {money(item.sellingPrice)} · available {item.availableQuantity}
                </option>)}
              </select>
              <button type="button" className="pos-button secondary" onClick={addExchangeItem}
                disabled={!exchangeSelectedVariantId || exchangeSaving || exchangeRetryPending}><Plus size={16} /> Add item</button>
            </div>
            {exchangeItems.length > 0 ? <div className="pos-exchange-items">
              {exchangeItems.map((item) => <div className="pos-exchange-item" key={item.variantId}>
                <div><strong>{item.productName}</strong><small>{item.variantName || item.sku} · {money(item.unitPrice)} each</small></div>
                <label>Qty<input type="number" min="1" max="9999" value={item.quantity}
                  onChange={(event) => updateExchangeQuantity(item.variantId, event.target.value)}
                  disabled={exchangeSaving || exchangeRetryPending} /></label>
                <strong>{money(item.unitPrice * item.quantity)}</strong>
                <button type="button" className="pos-icon-button" onClick={() => setExchangeItems((current) => current.filter((row) => row.variantId !== item.variantId))}
                  disabled={exchangeSaving || exchangeRetryPending} aria-label={`Remove ${item.productName}`}><Trash2 size={16} /></button>
              </div>)}
            </div> : <p className="pos-retry-note">No replacement items added yet.</p>}
            <label className="pos-return-field">Replacement discount
              <input type="number" min="0" step="0.01" value={exchangeDiscount}
                onChange={(event) => setExchangeDiscount(event.target.value)}
                disabled={!canApplyDiscount || exchangeSaving || exchangeRetryPending} />
            </label>

            <h3 className="pos-exchange-section-title">3. Settlement</h3>
            <div className="pos-exchange-settlement">
              <div><span>Returned value</span><strong>{money(returnQuote)}</strong></div>
              <div><span>Replacement subtotal</span><strong>{money(exchangeSubtotal)}</strong></div>
              <div><span>Replacement discount</span><strong>− {money(exchangeDiscountValue)}</strong></div>
              <div><span>Replacement value</span><strong>{money(exchangeReplacementValue)}</strong></div>
              <div><span>Exchange credit applied</span><strong>{money(Math.min(returnQuote, exchangeReplacementValue))}</strong></div>
              <div className="difference"><span>Customer pays</span><strong>{money(exchangeCollectionDue)}</strong></div>
              <div className="difference"><span>Customer receives refund</span><strong>{money(exchangeRefundDue)}</strong></div>
            </div>
            {exchangeCollectionDue > 0 && <div className="pos-exchange-payment">
              <strong>Collect the difference</strong>
              <label>Payment method<select value={exchangeCollectionMethod} onChange={(event) => setExchangeCollectionMethod(event.target.value)} disabled={exchangeSaving || exchangeRetryPending}>
                <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option>
              </select></label>
              {exchangeCollectionMethod === "CASH" ? <label>Cash received
                <input type="number" min={amount(exchangeCollectionDue)} step="0.01" value={exchangeCollectionTendered}
                  onChange={(event) => setExchangeCollectionTendered(event.target.value)} disabled={exchangeSaving || exchangeRetryPending} />
              </label> : <label>Payment reference (optional)
                <input value={exchangeCollectionReference} onChange={(event) => setExchangeCollectionReference(event.target.value)}
                  maxLength={150} placeholder="UPI/card transaction reference" disabled={exchangeSaving || exchangeRetryPending} />
              </label>}
              {exchangeCollectionMethod !== "CASH" && <p className="pos-return-warning">Complete and verify the UPI/card collection externally first. This POS records the reference; it does not verify provider settlement.</p>}
            </div>}
            {exchangeRefundDue > 0 && <div className="pos-exchange-payment">
              <strong>Refund the excess returned value</strong>
              <label>Refund method<select value={exchangeRefundMethod} onChange={(event) => setExchangeRefundMethod(event.target.value)} disabled={exchangeSaving || exchangeRetryPending}>
                <option value="CASH">Cash</option><option value="UPI">UPI</option><option value="CARD">Card</option>
              </select></label>
              {exchangeRefundMethod !== "CASH" && <label>Refund transaction reference
                <input value={exchangeRefundReference} onChange={(event) => setExchangeRefundReference(event.target.value)}
                  maxLength={150} placeholder="Completed provider refund reference" disabled={exchangeSaving || exchangeRetryPending} />
              </label>}
              {exchangeRefundMethod !== "CASH" && <p className="pos-return-warning">Complete and verify the UPI/card refund externally first. This POS records the reference; it does not send the provider refund.</p>}
            </div>}
            <div className="pos-modal-actions">
              <button type="button" className="pos-button secondary" onClick={() => { setReturnSale(null); setExchangeMode(false); }}
                disabled={exchangeSaving || exchangeRetryPending}>Cancel</button>
              <button type="button" className="pos-button primary" onClick={submitExchange}
                disabled={exchangeSaving || !shift?.id || shift.status !== "OPEN" || !exchangeItems.length}>
                {exchangeSaving ? "Processing…" : exchangeRetryPending ? "Retry same exchange" : "Confirm exchange"}
              </button>
            </div>
          </section>
        </div>
      )}
      {voidDialogOpen && selectedHistorySale && <div className="pos-modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !voidSaving && !voidRetry) setVoidDialogOpen(false);
      }}>
        <section className="pos-procurement-modal pos-void-modal" role="dialog" aria-modal="true" aria-labelledby="pos-void-title">
          <div className="pos-modal-toolbar"><div><span className="pos-eyebrow">MANAGER ACTION</span><h2 id="pos-void-title">Void {selectedHistorySale.invoiceNumber}</h2></div>
            <button type="button" className="pos-icon-button" onClick={() => setVoidDialogOpen(false)} disabled={voidSaving || voidRetry} aria-label="Close void dialog"><X /></button></div>
          <p>A full void returns every line to stock and records a full refund. Use this only when the sale is being cancelled before goods leave the shop. A sale with an earlier return cannot be voided.</p>
          {voidError && <p className="pos-return-error" role="alert">{voidError}</p>}
          <label className="pos-return-field">Void reason<input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} maxLength={500} disabled={voidSaving || voidRetry} /></label>
          <h3>Refund allocation</h3>
          {voidRefunds.map((payment, index) => <div className="pos-void-refund-row" key={index}>
            <span><strong>{payment.paymentMethod}</strong><small>{money(payment.amount)}</small></span>
            {payment.paymentMethod === "CASH" ? <span className="pos-void-cash-note">Cash refund recorded in your open shift</span>
              : <label>Refund transaction reference<input value={payment.transactionReference} onChange={(event) => setVoidRefunds((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, transactionReference: event.target.value } : row))} maxLength={150} disabled={voidSaving || voidRetry} required /></label>}
          </div>)}
          {voidRefunds.length === 0 && <p className="pos-retry-note">This sale has no collected payment amount. The full sale will be voided without a cash refund.</p>}
          <p className="pos-retry-note">Refunds to UPI/card must be completed through the payment provider or bank first. Enter the actual refund reference; this POS records the refund but does not send it to the provider.</p>
          <div className="pos-modal-actions">
            <button type="button" className="pos-button secondary" onClick={() => setVoidDialogOpen(false)} disabled={voidSaving || voidRetry}>Cancel</button>
            <button type="button" className="pos-button primary" onClick={submitVoid} disabled={voidSaving || !shift?.id || !voidReason.trim()}>{voidSaving ? "Voiding…" : voidRetry ? "Retry same void" : "Confirm full void"}</button>
          </div>
        </section>
      </div>}

      <ReceiptView sale={receipt} onClose={() => setReceipt(null)} />
    </main>
  );
}
