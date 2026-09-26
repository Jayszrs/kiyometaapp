import { useCallback, useEffect, useMemo, useState } from "react";
import type { Product } from "./App";
import { genUUID } from "./lib/uuid";
import { useAuth } from "./lib/auth";
import { MIGRATION_REQUIRED_MESSAGE, probeOperationsBackend } from "./lib/backendStatus";
import {
  addStockMovement,
  deleteBomItem,
  fetchInventoryData,
  saveBomItem,
  saveInventoryItem,
  savePurchase,
  type BomItem,
  type InventoryCategory,
  type InventoryItem,
  type ProcurementType,
  type Purchase,
  type StockMovement,
} from "./lib/operations";

interface Props {
  products: Product[];
  onBack: () => void;
}

type Tab = "inventory" | "purchases" | "movements" | "bom";

const today = () => new Date().toISOString().slice(0, 10);
const money = (value: number) => `¥${Math.round(value).toLocaleString()}`;
const number = (value: string) => Number(value) || 0;

const CATEGORY_LABELS: Record<InventoryCategory, string> = {
  finished_good: "Finished goods",
  component: "Component / WIP",
  material: "Raw material",
  purchased_part: "Purchased part",
  consumable: "Consumable",
  subcontract: "Subcontract item",
};

const MOVEMENT_LABELS: Record<string, string> = {
  purchase_receipt: "Purchase received",
  material_issue: "Material issued",
  production_output: "Production output",
  sale_shipment: "Shipment",
  subcontract_out: "Sent to subcontractor",
  subcontract_in: "Returned from subcontractor",
  adjustment_in: "Positive adjustment",
  adjustment_out: "Negative adjustment",
  order_material_issue: "Automatic order usage",
  order_material_reversal: "Order usage reversed",
  undo: "Undo / correction",
};

const blankItem = (): InventoryItem => ({
  id: genUUID(), itemCode: "", itemName: "", category: "material",
  procurementType: "buy", unit: "pcs", openingQty: 0, minimumQty: 0,
  targetQty: 0, supplierName: "", unitCost: 0, active: true,
  availableQty: 0, suggestedPurchaseQty: 0, needsReorder: false, stockValue: 0,
});

const blankPurchase = (): Purchase => ({
  id: genUUID(), purchaseNo: `PO-${new Date().getFullYear()}-`, purchaseDate: today(),
  supplierName: "", itemId: "", orderedQty: 1, receivedQty: 0,
  unitPrice: 0, dueDate: "", status: "ordered", pic: "", notes: "",
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-700 uppercase tracking-wide text-slate-500">{label}</span>{children}</label>;
}

const inputClass = "w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-blue-100";

export default function InventoryPage({ products, onBack }: Props) {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>("inventory");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [bom, setBom] = useState<BomItem[]>([]);
  const [itemForm, setItemForm] = useState<InventoryItem | null>(null);
  const [purchaseForm, setPurchaseForm] = useState<Purchase | null>(null);
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementItem, setMovementItem] = useState("");
  const [movementType, setMovementType] = useState("material_issue");
  const [movementQty, setMovementQty] = useState(1);
  const [movementNotes, setMovementNotes] = useState("");
  const [bomProduct, setBomProduct] = useState("");
  const [bomInventoryItem, setBomInventoryItem] = useState("");
  const [bomQty, setBomQty] = useState(1);
  const [printPurchase, setPrintPurchase] = useState<Purchase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [movementDirection, setMovementDirection] = useState<"all" | "outgoing" | "incoming">("all");

  const load = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      if (!await probeOperationsBackend(true)) {
        setError(MIGRATION_REQUIRED_MESSAGE);
        return;
      }
      const data = await fetchInventoryData();
      setItems(data.items);
      setPurchases(data.purchases);
      setMovements(data.movements);
      setBom(data.bom);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(success); await load(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };

  const summary = useMemo(() => ({
    itemCount: items.length,
    stockValue: items.reduce((sum, item) => sum + item.stockValue, 0),
    reorderCount: items.filter(item => item.needsReorder).length,
    outgoing: movements.filter(movement => movement.delta < 0).reduce((sum, movement) => sum + Math.abs(movement.delta), 0),
  }), [items, movements]);

  const filteredItems = useMemo(() => {
    const keyword = search.toLowerCase().trim();
    return keyword ? items.filter(item => `${item.itemCode} ${item.itemName} ${item.supplierName}`.toLowerCase().includes(keyword)) : items;
  }, [items, search]);

  const filteredMovements = useMemo(() => movements.filter(movement => {
    if (movementDirection === "outgoing") return movement.delta < 0;
    if (movementDirection === "incoming") return movement.delta > 0;
    return true;
  }), [movementDirection, movements]);

  const itemName = (id: string) => items.find(item => item.id === id)?.itemName ?? "Unknown item";
  const productName = (id: string) => products.find(product => product.id === id)?.productName ?? "Unknown product";

  const submitItem = () => {
    if (!itemForm?.itemCode.trim() || !itemForm.itemName.trim()) return;
    void run(async () => { await saveInventoryItem(itemForm); setItemForm(null); }, "Inventory master saved.");
  };

  const submitPurchase = () => {
    if (!purchaseForm?.purchaseNo.trim() || !purchaseForm.itemId || !purchaseForm.supplierName.trim()) return;
    void run(async () => { await savePurchase(purchaseForm); setPurchaseForm(null); }, "Purchase and stock receipt saved.");
  };

  const submitMovement = () => {
    if (!movementItem || movementQty <= 0) return;
    const positive = ["production_output", "subcontract_in", "adjustment_in"].includes(movementType);
    void run(async () => {
      await addStockMovement({
        movementDate: today(), movementType, referenceType: "manual", referenceId: null,
        itemId: movementItem, quantity: movementQty, delta: positive ? movementQty : -movementQty,
        pic: profile.displayName || profile.username, notes: movementNotes,
      });
      setMovementOpen(false); setMovementQty(1); setMovementNotes("");
    }, "Stock movement recorded.");
  };

  const printReceipt = (purchase: Purchase) => {
    setPrintPurchase(purchase);
    window.setTimeout(() => window.print(), 80);
  };

  return (
    <div className="flex h-full flex-col bg-[#f5f6f8] text-slate-800">
      <header className="flex items-center gap-3 bg-[#1a3458] px-4 py-3 text-white print:hidden">
        <button onClick={onBack} className="rounded px-2 py-1.5 text-sm hover:bg-white/10">← Home</button>
        <div className="min-w-0 flex-1"><h1 className="truncate text-base font-700">Inventory & Purchasing</h1><p className="truncate text-xs text-blue-200">Stock movements, purchase receipts, and automatic material usage</p></div>
        <span className="hidden text-xs text-blue-200 sm:block">@{profile.username}</span>
      </header>

      <div className="border-b border-slate-200 bg-white px-4 sm:px-8 print:hidden">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto py-2">
          {(["inventory", "purchases", "movements", "bom"] as Tab[]).map(value => <button key={value} onClick={() => setTab(value)} className={`whitespace-nowrap rounded px-4 py-2 text-sm font-600 capitalize ${tab === value ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{value === "bom" ? "Product materials (BOM)" : value}</button>)}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6 print:hidden">
        <div className="mx-auto max-w-7xl space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[{ label: "Master items", value: summary.itemCount.toLocaleString() }, { label: "Stock value", value: money(summary.stockValue) }, { label: "Need purchase", value: summary.reorderCount.toLocaleString() }, { label: "Materials issued", value: summary.outgoing.toLocaleString() }].map(card => <div key={card.label} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200"><p className="text-xs font-700 uppercase tracking-wide text-slate-500">{card.label}</p><p className="mt-2 text-xl font-700 text-[#1a3458] sm:text-2xl">{card.value}</p></div>)}
          </div>
          {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{error}</span><button type="button" disabled={busy} onClick={() => void load()} className="rounded border border-red-300 bg-white px-3 py-1.5 font-700 text-red-700 hover:bg-red-100 disabled:opacity-50">{busy ? "Checking..." : "Check again"}</button></div>}
          {notice && <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          {tab === "inventory" && <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-700 text-[#1a3458]">Inventory master</h2><p className="text-sm text-slate-500">Based on the Excel material, purchased-part, consumable, component, and finished-product masters.</p></div><div className="flex gap-2"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search item..." className="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2 text-sm sm:w-56" /><button onClick={() => setItemForm(blankItem())} className="whitespace-nowrap rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">+ Item</button></div></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Code / item</th><th className="px-4 py-3">Category</th><th className="px-4 py-3 text-right">Available</th><th className="px-4 py-3 text-right">Min / target</th><th className="px-4 py-3">Supplier</th><th className="px-4 py-3 text-right">Stock value</th><th className="px-4 py-3"></th></tr></thead><tbody className="divide-y divide-slate-100">{filteredItems.map(item => <tr key={item.id} className={item.needsReorder ? "bg-amber-50/60" : "hover:bg-slate-50"}><td className="px-4 py-3"><p className="font-700">{item.itemName}</p><p className="font-mono text-xs text-slate-500">{item.itemCode}</p></td><td className="px-4 py-3"><p>{CATEGORY_LABELS[item.category]}</p><p className="text-xs capitalize text-slate-500">{item.procurementType}</p></td><td className="px-4 py-3 text-right"><span className={`font-mono font-700 ${item.needsReorder ? "text-amber-700" : "text-slate-800"}`}>{item.availableQty.toLocaleString()} {item.unit}</span>{item.needsReorder && <p className="text-xs text-amber-700">Suggest +{item.suggestedPurchaseQty.toLocaleString()}</p>}</td><td className="px-4 py-3 text-right font-mono text-xs">{item.minimumQty.toLocaleString()} / {item.targetQty.toLocaleString()}</td><td className="px-4 py-3">{item.supplierName || "-"}</td><td className="px-4 py-3 text-right font-mono">{money(item.stockValue)}</td><td className="px-4 py-3 text-right"><button onClick={() => setItemForm(item)} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-white">Edit</button></td></tr>)}</tbody></table></div>
          </section>}

          {tab === "purchases" && <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 p-4"><div><h2 className="text-lg font-700 text-[#1a3458]">Purchasing register</h2><p className="text-sm text-slate-500">Receiving quantity automatically creates a related stock mutation.</p></div><button onClick={() => setPurchaseForm(blankPurchase())} className="rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">+ Purchase</button></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">PO / date</th><th className="px-4 py-3">Supplier</th><th className="px-4 py-3">Item</th><th className="px-4 py-3 text-right">Ordered / received</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Actions</th></tr></thead><tbody className="divide-y divide-slate-100">{purchases.map(purchase => <tr key={purchase.id} className="hover:bg-slate-50"><td className="px-4 py-3"><p className="font-700">{purchase.purchaseNo}</p><p className="text-xs text-slate-500">{purchase.purchaseDate}</p></td><td className="px-4 py-3">{purchase.supplierName}</td><td className="px-4 py-3">{itemName(purchase.itemId)}</td><td className="px-4 py-3 text-right font-mono">{purchase.orderedQty.toLocaleString()} / {purchase.receivedQty.toLocaleString()}</td><td className="px-4 py-3 text-right font-mono">{money(purchase.orderedQty * purchase.unitPrice)}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-700 capitalize">{purchase.status}</span></td><td className="px-4 py-3"><div className="flex justify-end gap-2"><button onClick={() => printReceipt(purchase)} className="rounded border border-slate-300 px-3 py-1.5 font-600">Print</button><button onClick={() => setPurchaseForm(purchase)} className="rounded border border-slate-300 px-3 py-1.5 font-600">Edit</button></div></td></tr>)}</tbody></table></div>
          </section>}

          {tab === "movements" && <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-700 text-[#1a3458]">Stock mutation journal</h2><p className="text-sm text-slate-500">Incoming, outgoing, purchasing, production, and automatic order usage in one ledger.</p></div><div className="flex gap-2"><select value={movementDirection} onChange={event => setMovementDirection(event.target.value as typeof movementDirection)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"><option value="all">All movements</option><option value="outgoing">Outgoing materials</option><option value="incoming">Incoming stock</option></select><button onClick={() => setMovementOpen(true)} className="whitespace-nowrap rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">+ Manual mutation</button></div></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm"><thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Mutation</th><th className="px-4 py-3">Item</th><th className="px-4 py-3 text-right">Delta</th><th className="px-4 py-3">PIC / reference</th><th className="px-4 py-3">Notes</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredMovements.map(movement => <tr key={movement.id} className="hover:bg-slate-50"><td className="whitespace-nowrap px-4 py-3">{movement.movementDate}</td><td className="px-4 py-3 font-600">{MOVEMENT_LABELS[movement.movementType] ?? movement.movementType}</td><td className="px-4 py-3">{itemName(movement.itemId)}</td><td className={`px-4 py-3 text-right font-mono font-700 ${movement.delta < 0 ? "text-red-600" : "text-emerald-700"}`}>{movement.delta > 0 ? "+" : ""}{movement.delta.toLocaleString()}</td><td className="px-4 py-3"><p>{movement.pic || "-"}</p><p className="font-mono text-xs text-slate-500">{movement.referenceType}{movement.referenceId ? ` · ${movement.referenceId.slice(0, 8)}` : ""}</p></td><td className="max-w-sm px-4 py-3 text-slate-500">{movement.notes || "-"}</td></tr>)}</tbody></table></div>
          </section>}

          {tab === "bom" && <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="mb-5"><h2 className="text-lg font-700 text-[#1a3458]">Product material requirements (BOM)</h2><p className="text-sm text-slate-500">When an order becomes Complete or Shipped, these quantities are deducted automatically.</p></div>
            <div className="grid gap-3 rounded bg-slate-50 p-4 md:grid-cols-[1fr_1fr_140px_auto]"><Field label="Product"><select value={bomProduct} onChange={e => setBomProduct(e.target.value)} className={inputClass}><option value="">Select product</option>{products.map(product => <option key={product.id} value={product.id}>{product.productNumber} · {product.productName}</option>)}</select></Field><Field label="Material / part"><select value={bomInventoryItem} onChange={e => setBomInventoryItem(e.target.value)} className={inputClass}><option value="">Select item</option>{items.filter(item => item.category !== "finished_good").map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field><Field label="Qty per product"><input type="number" min="0.001" step="0.001" value={bomQty} onChange={e => setBomQty(number(e.target.value))} className={inputClass} /></Field><button disabled={busy || !bomProduct || !bomInventoryItem || bomQty <= 0} onClick={() => void run(async () => { await saveBomItem({ id: genUUID(), productId: bomProduct, inventoryItemId: bomInventoryItem, quantityPerUnit: bomQty, notes: "" }); setBomInventoryItem(""); setBomQty(1); }, "Product material added.")} className="self-end rounded bg-[#1a3458] px-4 py-2.5 font-700 text-white disabled:opacity-40">Add</button></div>
            <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[650px] text-sm"><thead className="border-b border-slate-200 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-3">Product</th><th className="px-3 py-3">Required item</th><th className="px-3 py-3 text-right">Qty / unit</th><th className="px-3 py-3"></th></tr></thead><tbody className="divide-y divide-slate-100">{bom.map(row => <tr key={row.id}><td className="px-3 py-3 font-600">{productName(row.productId)}</td><td className="px-3 py-3">{itemName(row.inventoryItemId)}</td><td className="px-3 py-3 text-right font-mono">{row.quantityPerUnit.toLocaleString()}</td><td className="px-3 py-3 text-right"><button onClick={() => void run(() => deleteBomItem(row.id), "Product material removed.")} className="text-sm font-700 text-red-600">Remove</button></td></tr>)}</tbody></table></div>
          </section>}
        </div>
      </main>

      {itemForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 print:hidden"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-2xl"><div className="mb-5 flex items-start justify-between"><div><h2 className="text-xl font-700 text-[#1a3458]">Inventory master item</h2><p className="text-sm text-slate-500">Configure minimum stock, target, supplier, and standard cost.</p></div><button onClick={() => setItemForm(null)} className="text-xl text-slate-400">×</button></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Item code"><input value={itemForm.itemCode} onChange={e => setItemForm({ ...itemForm, itemCode: e.target.value.toUpperCase() })} className={inputClass} /></Field><Field label="Item name"><input value={itemForm.itemName} onChange={e => setItemForm({ ...itemForm, itemName: e.target.value })} className={inputClass} /></Field><Field label="Category"><select value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value as InventoryCategory })} className={inputClass}>{Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Procurement"><select value={itemForm.procurementType} onChange={e => setItemForm({ ...itemForm, procurementType: e.target.value as ProcurementType })} className={inputClass}><option value="buy">Buy</option><option value="make">Make</option><option value="subcontract">Subcontract</option></select></Field><Field label="Unit"><input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} className={inputClass} /></Field><Field label="Opening quantity"><input type="number" step="0.001" value={itemForm.openingQty} onChange={e => setItemForm({ ...itemForm, openingQty: number(e.target.value) })} className={inputClass} /></Field><Field label="Minimum quantity"><input type="number" step="0.001" value={itemForm.minimumQty} onChange={e => setItemForm({ ...itemForm, minimumQty: number(e.target.value) })} className={inputClass} /></Field><Field label="Target quantity"><input type="number" step="0.001" value={itemForm.targetQty} onChange={e => setItemForm({ ...itemForm, targetQty: number(e.target.value) })} className={inputClass} /></Field><Field label="Supplier"><input value={itemForm.supplierName} onChange={e => setItemForm({ ...itemForm, supplierName: e.target.value })} className={inputClass} /></Field><Field label="Standard unit cost"><input type="number" min="0" value={itemForm.unitCost} onChange={e => setItemForm({ ...itemForm, unitCost: number(e.target.value) })} className={inputClass} /></Field></div><div className="mt-6 flex justify-end gap-2"><button onClick={() => setItemForm(null)} className="rounded border border-slate-300 px-4 py-2">Cancel</button><button disabled={busy || !itemForm.itemCode || !itemForm.itemName} onClick={submitItem} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">Save item</button></div></div></div>}

      {purchaseForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 print:hidden"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-6 shadow-2xl"><div className="mb-5 flex items-start justify-between"><div><h2 className="text-xl font-700 text-[#1a3458]">Purchase inventory</h2><p className="text-sm text-slate-500">Received quantity is posted directly into stock.</p></div><button onClick={() => setPurchaseForm(null)} className="text-xl text-slate-400">×</button></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Purchase number"><input value={purchaseForm.purchaseNo} onChange={e => setPurchaseForm({ ...purchaseForm, purchaseNo: e.target.value })} className={inputClass} /></Field><Field label="Purchase date"><input type="date" value={purchaseForm.purchaseDate} onChange={e => setPurchaseForm({ ...purchaseForm, purchaseDate: e.target.value })} className={inputClass} /></Field><Field label="Supplier"><input value={purchaseForm.supplierName} onChange={e => setPurchaseForm({ ...purchaseForm, supplierName: e.target.value })} className={inputClass} /></Field><Field label="Inventory item"><select value={purchaseForm.itemId} onChange={e => { const selected = items.find(item => item.id === e.target.value); setPurchaseForm({ ...purchaseForm, itemId: e.target.value, unitPrice: selected?.unitCost ?? purchaseForm.unitPrice, supplierName: purchaseForm.supplierName || selected?.supplierName || "" }); }} className={inputClass}><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field><Field label="Ordered quantity"><input type="number" min="0.001" step="0.001" value={purchaseForm.orderedQty} onChange={e => setPurchaseForm({ ...purchaseForm, orderedQty: number(e.target.value) })} className={inputClass} /></Field><Field label="Received quantity"><input type="number" min="0" max={purchaseForm.orderedQty} step="0.001" value={purchaseForm.receivedQty} onChange={e => setPurchaseForm({ ...purchaseForm, receivedQty: number(e.target.value) })} className={inputClass} /></Field><Field label="Unit price"><input type="number" min="0" value={purchaseForm.unitPrice} onChange={e => setPurchaseForm({ ...purchaseForm, unitPrice: number(e.target.value) })} className={inputClass} /></Field><Field label="Due date"><input type="date" value={purchaseForm.dueDate} onChange={e => setPurchaseForm({ ...purchaseForm, dueDate: e.target.value })} className={inputClass} /></Field><Field label="Status"><select value={purchaseForm.status} onChange={e => setPurchaseForm({ ...purchaseForm, status: e.target.value as Purchase["status"] })} className={inputClass}><option value="ordered">Ordered</option><option value="partial">Partially received</option><option value="received">Received</option><option value="cancelled">Cancelled</option></select></Field><Field label="PIC"><input value={purchaseForm.pic} onChange={e => setPurchaseForm({ ...purchaseForm, pic: e.target.value })} className={inputClass} /></Field></div><Field label="Notes"><textarea value={purchaseForm.notes} onChange={e => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} className={`${inputClass} mt-4 min-h-20`} /></Field><div className="mt-6 flex justify-end gap-2"><button onClick={() => setPurchaseForm(null)} className="rounded border border-slate-300 px-4 py-2">Cancel</button><button disabled={busy || !purchaseForm.purchaseNo || !purchaseForm.itemId || !purchaseForm.supplierName} onClick={submitPurchase} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">Save purchase</button></div></div></div>}

      {movementOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 print:hidden"><div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-2xl"><h2 className="text-xl font-700 text-[#1a3458]">Manual stock mutation</h2><div className="mt-5 space-y-4"><Field label="Item"><select value={movementItem} onChange={e => setMovementItem(e.target.value)} className={inputClass}><option value="">Select item</option>{items.map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field><Field label="Mutation type"><select value={movementType} onChange={e => setMovementType(e.target.value)} className={inputClass}><option value="material_issue">Material issued (-)</option><option value="production_output">Production output (+)</option><option value="subcontract_out">Sent to subcontractor (-)</option><option value="subcontract_in">Returned from subcontractor (+)</option><option value="sale_shipment">Shipment (-)</option><option value="adjustment_in">Positive adjustment (+)</option><option value="adjustment_out">Negative adjustment (-)</option></select></Field><Field label="Positive quantity"><input type="number" min="0.001" step="0.001" value={movementQty} onChange={e => setMovementQty(number(e.target.value))} className={inputClass} /></Field><Field label="Notes"><textarea value={movementNotes} onChange={e => setMovementNotes(e.target.value)} className={`${inputClass} min-h-20`} /></Field></div><div className="mt-6 flex justify-end gap-2"><button onClick={() => setMovementOpen(false)} className="rounded border border-slate-300 px-4 py-2">Cancel</button><button disabled={busy || !movementItem || movementQty <= 0} onClick={submitMovement} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">Post mutation</button></div></div></div>}

      {printPurchase && <article id="purchase-receipt" className="hidden print:block"><div className="mx-auto max-w-3xl p-10 text-black"><div className="flex items-start justify-between border-b-2 border-black pb-5"><div><p className="text-xs font-700 uppercase tracking-[0.2em]">Kiyometa Manufacturing</p><h1 className="mt-2 text-3xl font-700">PURCHASE RECEIPT</h1></div><div className="text-right"><p className="font-mono text-lg font-700">{printPurchase.purchaseNo}</p><p>{printPurchase.purchaseDate}</p></div></div><div className="mt-8 grid grid-cols-2 gap-8"><div><p className="text-xs font-700 uppercase text-slate-500">Supplier</p><p className="mt-1 text-lg font-700">{printPurchase.supplierName}</p></div><div><p className="text-xs font-700 uppercase text-slate-500">PIC</p><p className="mt-1 text-lg">{printPurchase.pic || "-"}</p></div></div><table className="mt-8 w-full border-collapse"><thead><tr className="border-y border-black text-left"><th className="py-3">Item</th><th className="py-3 text-right">Qty</th><th className="py-3 text-right">Unit price</th><th className="py-3 text-right">Total</th></tr></thead><tbody><tr><td className="py-4">{itemName(printPurchase.itemId)}</td><td className="py-4 text-right">{printPurchase.orderedQty.toLocaleString()}</td><td className="py-4 text-right">{money(printPurchase.unitPrice)}</td><td className="py-4 text-right font-700">{money(printPurchase.orderedQty * printPurchase.unitPrice)}</td></tr></tbody></table><div className="mt-10 border-t border-black pt-4 text-sm"><p>Received quantity: <strong>{printPurchase.receivedQty.toLocaleString()}</strong></p><p>Status: <strong className="capitalize">{printPurchase.status}</strong></p><p className="mt-3">Notes: {printPurchase.notes || "-"}</p></div></div></article>}
    </div>
  );
}
