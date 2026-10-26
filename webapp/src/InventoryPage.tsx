import { useDurableState } from "./lib/useDurableState";
import { readRecovery, writeRecovery, removeRecovery } from "./lib/recoveryStorage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, type DeliverySlipMode, type Lang, type Page, type Product } from "./App";
import { useAuth } from "./lib/auth";
import { MIGRATION_REQUIRED_MESSAGE, probeOperationsBackend } from "./lib/backendStatus";
import { createExcelWorkbook, readExcelRows, type ExcelColumn, type ImportedExcelRow } from "./lib/excel";
import { isValidISODate, parseNumberStrict, todayJST } from "./lib/date";
import { useIsTabletOrWider } from "./lib/useMediaQuery";
import {
  addStockMovement,
  deleteBomItem,
  deleteInventoryItem,
  deletePurchase,
  deleteStockMovement,
  fetchInventoryData,
  importInventoryRows,
  saveBomItem,
  saveInventoryItem,
  savePurchase,
  StalePurchaseError,
  type BomItem,
  type InventoryCategory,
  type InventoryItem,
  type ProcurementType,
  type Purchase,
  type StockMovement,
} from "./lib/operations";
import { genUUID } from "./lib/uuid";
import { isAndroidWebView, printBillingDocument, useBillingAction } from "./lib/billingActions";
import { hasNativeBridge } from "./lib/nativeBridge";
import { supabase } from "./lib/supabaseClient";
import { useDialog } from "./components/AppDialog";
import { Icon } from "./components/Icon";

interface Props {
  products: Product[];
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
}

type Tab = "inventory" | "purchases" | "movements" | "bom";

// The office runs on Japan time. toISOString() returned the UTC day, so a
// purchase entered at 08:30 JST was stamped with yesterday.
const today = () => todayJST();
const money = (value: number) => `¥${Math.round(value).toLocaleString()}`;

// Number("") is 0 and Number("abc") is NaN, so the old `Number(value) || 0`
// turned a blank cell into a real zero and a typo into a price of nothing. The
// import path now uses requiredNumber, which distinguishes a missing value from
// a genuine zero, and the form fields keep the coercing version because a
// number input holding "" has to map onto a numeric state field.
const number = (value: unknown) => parseNumberStrict(value as string | number | null | undefined) ?? 0;
const text = (value: unknown) => String(value ?? "").trim();
const autoNumber = (value: unknown) => {
  const normalized = text(value);
  return /^(auto|generated automatically)$/i.test(normalized) ? "" : normalized;
};

// Excel dates arrive in three shapes depending on how the cell was authored:
// a real Date (styled date cell), a serial number (unformatted), or a string.
// The old version fell through to new Date(normalized), which silently rolled an
// impossible date such as 2025-02-30 over to March 2 and accepted bare years,
// so a typo landed in the ledger as a different, valid looking day.
function excelDate(value: unknown, fallback = ""): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // The 1899-12-30 epoch is Excel's day zero, accounting for its own
    // non-existent 1900-02-29.
    const serial = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return `${serial.getUTCFullYear()}-${String(serial.getUTCMonth() + 1).padStart(2, "0")}-${String(serial.getUTCDate()).padStart(2, "0")}`;
  }
  const normalized = text(value);
  if (!normalized) return fallback;
  // Accept the two shapes people actually type, then validate strictly.
  const slashed = normalized.replace(/[/.]/g, "-");
  const isoCandidate = /^\d{4}-\d{1,2}-\d{1,2}$/.test(slashed)
    ? `${slashed.slice(0, 4)}-${slashed.slice(5, 7).padStart(2, "0")}-${slashed.slice(8, 10).padStart(2, "0")}`
    : "";
  if (isValidISODate(isoCandidate)) return isoCandidate;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return normalized;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function boolean(value: unknown, fallback = true) {
  if (typeof value === "boolean") return value;
  const normalized = text(value).toLowerCase();
  if (["false", "no", "0", "inactive"].includes(normalized)) return false;
  if (["true", "yes", "1", "active"].includes(normalized)) return true;
  return fallback;
}

const CATEGORY_LABELS: Record<InventoryCategory, string> = {
  finished_good: "Finished goods",
  component: "Component / WIP",
  material: "Raw material",
  purchased_part: "Purchased part",
  consumable: "Consumable",
  subcontract: "Subcontract item",
};
const CATEGORY_LABELS_JA: Record<InventoryCategory, string> = {
  finished_good: "完成品", component: "部品・仕掛品", material: "原材料",
  purchased_part: "購入部品", consumable: "消耗品", subcontract: "外注品",
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
const MOVEMENT_LABELS_JA: Record<string, string> = {
  purchase_receipt: "仕入受入", material_issue: "材料払出", production_output: "製造完了",
  sale_shipment: "出荷", subcontract_out: "外注先へ出庫", subcontract_in: "外注先から入庫",
  adjustment_in: "在庫増加調整", adjustment_out: "在庫減少調整",
  order_material_issue: "受注による自動使用", order_material_reversal: "受注使用の戻し",
  undo: "取り消し・訂正",
};

const ITEM_COLUMNS: ExcelColumn[] = [
  { key: "itemNo", header: "Item No", width: 18, auto: true },
  { key: "itemName", header: "Item Name", width: 30, required: true },
  { key: "category", header: "Category", width: 22, required: true, options: Object.values(CATEGORY_LABELS) },
  { key: "procurement", header: "Procurement", width: 17, required: true, options: ["Buy", "Make", "Subcontract"] },
  { key: "unit", header: "Unit", width: 12, required: true },
  { key: "openingQty", header: "Opening Qty", width: 15, numberFormat: "#,##0.000" },
  { key: "minimumQty", header: "Minimum Qty", width: 15, numberFormat: "#,##0.000" },
  { key: "targetQty", header: "Target Qty", width: 15, numberFormat: "#,##0.000" },
  { key: "supplier", header: "Supplier", width: 26 },
  { key: "unitCost", header: "Unit Cost", width: 16, numberFormat: "¥#,##0.00" },
  { key: "active", header: "Active", width: 12, options: ["Yes", "No"] },
];

const PURCHASE_COLUMNS: ExcelColumn[] = [
  { key: "purchaseNo", header: "Purchase No", width: 22, auto: true },
  { key: "purchaseDate", header: "Purchase Date", width: 17, required: true, numberFormat: "yyyy-mm-dd" },
  { key: "supplier", header: "Supplier", width: 26, required: true },
  { key: "itemNo", header: "Item No", width: 18, required: true },
  { key: "orderedQty", header: "Ordered Qty", width: 15, required: true, numberFormat: "#,##0.000" },
  { key: "receivedQty", header: "Received Qty", width: 15, numberFormat: "#,##0.000" },
  { key: "unitPrice", header: "Unit Price", width: 16, numberFormat: "¥#,##0.00" },
  { key: "dueDate", header: "Due Date", width: 17, numberFormat: "yyyy-mm-dd" },
  { key: "status", header: "Status", width: 18, required: true, options: ["Ordered", "Partial", "Received", "Cancelled"] },
  { key: "pic", header: "PIC", width: 20 },
  { key: "notes", header: "Notes", width: 36 },
];

const MOVEMENT_COLUMNS: ExcelColumn[] = [
  { key: "movementNo", header: "Movement No", width: 22, auto: true },
  { key: "movementDate", header: "Movement Date", width: 17, required: true, numberFormat: "yyyy-mm-dd" },
  { key: "movementType", header: "Movement Type", width: 26, required: true, options: ["Material issued", "Production output", "Shipment", "Sent to subcontractor", "Returned from subcontractor", "Positive adjustment", "Negative adjustment"] },
  { key: "itemNo", header: "Item No", width: 18, required: true },
  { key: "quantity", header: "Quantity", width: 15, required: true, numberFormat: "#,##0.000" },
  { key: "pic", header: "PIC", width: 20 },
  { key: "notes", header: "Notes", width: 36 },
];

const BOM_COLUMNS: ExcelColumn[] = [
  { key: "bomNo", header: "BOM No", width: 18, auto: true },
  { key: "parentBomNo", header: "Parent BOM No", width: 20 },
  { key: "productNo", header: "Product No", width: 20, required: true },
  { key: "itemNo", header: "Item No", width: 18, required: true },
  { key: "quantity", header: "Qty per Product", width: 18, required: true, numberFormat: "#,##0.000" },
  { key: "notes", header: "Notes", width: 36 },
];

const TAB_EXCEL: Record<Tab, { title: string; subtitle: string; file: string; columns: ExcelColumn[] }> = {
  inventory: { title: "Inventory Master", subtitle: "Materials, components, purchased parts, consumables, and finished goods", file: "inventory-master", columns: ITEM_COLUMNS },
  purchases: { title: "Purchase Register", subtitle: "Inventory purchasing and goods receipt register", file: "purchase-register", columns: PURCHASE_COLUMNS },
  movements: { title: "Stock Movement Journal", subtitle: "Incoming and outgoing inventory transactions", file: "stock-movements", columns: MOVEMENT_COLUMNS },
  bom: { title: "Product Materials (BOM)", subtitle: "Material requirements per finished product", file: "product-materials-bom", columns: BOM_COLUMNS },
};

const blankItem = (): InventoryItem => ({
  id: genUUID(), itemCode: "", itemName: "", category: "material",
  procurementType: "buy", unit: "pcs", openingQty: 0, minimumQty: 0,
  targetQty: 0, supplierName: "", unitCost: 0, active: true,
  availableQty: 0, suggestedPurchaseQty: 0, needsReorder: false, stockValue: 0,
});

const blankPurchase = (): Purchase => ({
  id: genUUID(), purchaseNo: "", purchaseDate: today(), supplierName: "",
  itemId: "", orderedQty: 1, receivedQty: 0, unitPrice: 0,
  dueDate: "", status: "ordered", pic: "", notes: "",
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-600 text-slate-500">{label}</span>{children}</label>;
}

const inputClass = "w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-blue-100";
const outlineButton = "rounded border border-slate-300 bg-white px-3 py-2 text-sm font-700 text-slate-700 hover:bg-slate-50 disabled:opacity-40";

function categoryFromExcel(value: unknown): InventoryCategory {
  const normalized = text(value).toLowerCase();
  const match = (Object.entries(CATEGORY_LABELS) as [InventoryCategory, string][])
    .find(([key, label]) => key === normalized || label.toLowerCase() === normalized);
  if (!match) throw new Error(`Unknown category "${text(value)}".`);
  return match[0];
}

function procurementFromExcel(value: unknown): ProcurementType {
  const normalized = text(value).toLowerCase();
  if (!["buy", "make", "subcontract"].includes(normalized)) throw new Error(`Unknown procurement "${text(value)}".`);
  return normalized as ProcurementType;
}

function movementTypeFromExcel(value: unknown) {
  const normalized = text(value).toLowerCase();
  const allowed = ["material_issue", "production_output", "sale_shipment", "subcontract_out", "subcontract_in", "adjustment_in", "adjustment_out"];
  const match = allowed.find(key => key === normalized || MOVEMENT_LABELS[key].toLowerCase() === normalized);
  if (!match) throw new Error(`Unknown movement type "${text(value)}".`);
  return match;
}

// Deleting an inventory item orphans every stock movement and BOM line that
// references it, so it stays administrator-only, matching the DELETE policies
// in migration 010. The row disappears from the ledger's history, which is not
// a correction an operator should be able to make from the item list.


// Number("") is 0 and Number("abc") is NaN, so the old `Number(value) || 0`
// turned a blank Excel cell into a real zero and a typo into a price of nothing.
// The import path uses this, which distinguishes a missing value from a genuine
// zero, so a quantity that was never filled in is reported instead of quietly
// becoming "no stock".
const requiredNumber = (value: unknown) => parseNumberStrict(value as string | number | null | undefined);

// One prepared import row, discriminated by tab so the write phase cannot read
// the wrong payload shape. The payload types are exactly what the save functions
// in operations.ts accept.
type InventoryPayload = Parameters<typeof saveInventoryItem>[0];
type PurchasePayload = Parameters<typeof savePurchase>[0];
type MovementPayload = Parameters<typeof addStockMovement>[0];

type PreparedRow =
  | { kind: "inventory"; existingId: string; payload: InventoryPayload }
  | { kind: "purchases"; existingId: string; payload: PurchasePayload }
  | { kind: "movements"; existingId: string; payload: MovementPayload }
  | { kind: "bom"; existingId: string; payload: BomItem }
  | { kind: "skip" };

type TransferDialogState = {
  mode: "import" | "export";
  template: boolean;
  file: File | null;
  fileName: string;
};

// The identity a row addresses, used to reject a file that sets the same record
// twice. A row that creates a new record has no identity yet, so it is exempt.
function duplicateKey(row: PreparedRow): string {
  if (row.kind === "skip" || !row.existingId) return "";
  return `${row.kind}:${row.existingId}`;
}

export default function InventoryPage({ products, onNavigate, lang, setLang }: Props) {
  const { profile } = useAuth();
  const dialog = useDialog();
  const canDelete = profile.role === "administrator";
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useDurableState<Tab>("inventory-tab", "inventory");
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [bom, setBom] = useState<BomItem[]>([]);
  const [itemForm, setItemForm] = useDurableState<InventoryItem | null>("inventory-item", null);
  const [purchaseForm, setPurchaseForm] = useDurableState<Purchase | null>("inventory-purchase", null);
  const [purchaseEditorLabel, setPurchaseEditorLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!purchaseForm?.updatedBy) { setPurchaseEditorLabel(null); return; }
    let cancelled = false;
    setPurchaseEditorLabel(null);
    // The editor's username sits on the row already; user_label only adds the
    // current display name + role, which are hidden from other users by RLS.
    void (async () => {
      const { data } = await supabase.rpc("user_label", { p_user_id: purchaseForm.updatedBy });
      if (!cancelled) setPurchaseEditorLabel((data as string | null) ?? null);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [purchaseForm?.id, purchaseForm?.updatedBy]);
  const [movementOpen, setMovementOpen] = useDurableState("movement-open", false);
  const [movementItem, setMovementItem] = useDurableState("movement-item", "");
  const [movementType, setMovementType] = useDurableState("movement-type", "material_issue");
  const [movementQty, setMovementQty] = useDurableState("movement-quantity", 1);
  const [movementNotes, setMovementNotes] = useDurableState("movement-notes", "");
  const [bomProduct, setBomProduct] = useDurableState("bom-product", "");
  const [bomParent, setBomParent] = useDurableState("bom-parent", "");
  const [bomInventoryItem, setBomInventoryItem] = useDurableState("bom-inventory-item", "");
  const [bomQty, setBomQty] = useDurableState("bom-quantity", 1);
  const [printPurchase, setPrintPurchase] = useState<Purchase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [transferDialog, setTransferDialog] = useState<TransferDialogState | null>(null);
  const [search, setSearch] = useState("");
  const isWide = useIsTabletOrWider();
  const printAction = useBillingAction(() => { void dialog.alert(lang === "ja" ? "印刷を開始できませんでした。再試行してください。" : "Could not start printing. Please retry."); });
  const [movementDirection, setMovementDirection] = useState<"all" | "outgoing" | "incoming">("all");
  const langRef = useRef(lang);
  langRef.current = lang;
  const text = (english: unknown, japanese?: string) => japanese === undefined
    ? String(english ?? "").trim()
    : lang === "ja" ? japanese : String(english ?? "").trim();
  const unitLabel = (unit: string) => {
    if (lang !== "ja") return unit;
    const normalized = unit.trim().toLowerCase();
    return ({ pcs: "個", pc: "個", piece: "個", pieces: "個", set: "セット", sets: "セット" } as Record<string, string>)[normalized] ?? unit;
  };
  const categoryLabel = (category: InventoryCategory) => lang === "ja" ? CATEGORY_LABELS_JA[category] : CATEGORY_LABELS[category];
  const movementLabel = (type: string) => (lang === "ja" ? MOVEMENT_LABELS_JA[type] : MOVEMENT_LABELS[type]) ?? type;
  const procurementLabel = (type: ProcurementType) => lang === "ja"
    ? ({ buy: "購入", make: "製造", subcontract: "外注" } as const)[type]
    : ({ buy: "Buy", make: "Make", subcontract: "Subcontract" } as const)[type];
  const purchaseStatusLabel = (status: Purchase["status"]) => lang === "ja"
    ? ({ ordered: "発注済み", partial: "一部入荷", received: "入荷済み", cancelled: "キャンセル" } as const)[status]
    : status;

  const load = useCallback(async (forceProbe = false) => {
    setError("");
    setBusy(true);
    try {
      if (!await probeOperationsBackend(forceProbe)) {
        setError(langRef.current === "ja" ? "在庫機能に必要なデータベース更新が適用されていません。管理者にお問い合わせください。" : MIGRATION_REQUIRED_MESSAGE);
        return;
      }
      const data = await fetchInventoryData();
      setItems(data.items);
      setPurchases(data.purchases);
      setMovements(data.movements);
      setBom(data.bom);
    } catch (err) {
      setError(langRef.current === "ja" ? "データを読み込めませんでした。通信状態を確認してください。" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let timer: number | undefined;
    const scheduleLoad = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 150);
    };
    const channel = supabase.channel("inventory-data-refresh");
    for (const table of ["inventory_items", "purchases", "stock_movements", "product_materials"] as const) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleLoad);
    }
    void channel.subscribe();
    return () => {
      window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await load();
      setNotice(success);
    } catch (err) {
      setError(langRef.current === "ja" ? "処理に失敗しました。入力内容と通信状態を確認してください。" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(() => ({
    itemCount: items.length,
    stockValue: items.reduce((sum, item) => sum + item.stockValue, 0),
    reorderCount: items.filter(item => item.needsReorder).length,
    outOfStock: items.filter(item => item.availableQty <= 0).length,
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

  // These were plain .find() calls made once per rendered row, so every list
  // here re-scanned the item and product tables. Indexed lookups, built once.
  const itemNameById = useMemo(() => new Map(items.map(item => [item.id, item.itemName])), [items]);
  const productNameById = useMemo(() => new Map(products.map(product => [product.id, product.productName])), [products]);
  const itemById = useMemo(() => {
    const byId = new Map(items.map(item => [item.id, item]));
    return (id: string) => byId.get(id);
  }, [items]);
  const itemName = (id: string) => itemNameById.get(id) ?? "Unknown item";
  const productName = (id: string) => productNameById.get(id) ?? "Unknown product";
  const orderedBom = useMemo(() => {
    const result: Array<{ row: BomItem; depth: number }> = [];
    const productsInTree = [...new Set(bom.map(row => row.productId))];
    for (const productId of productsInTree) {
      const productRows = bom.filter(row => row.productId === productId);
      const walk = (parentBomNo: string, depth: number, visited: Set<string>) => {
        for (const row of productRows.filter(candidate => candidate.parentBomNo === parentBomNo)) {
          if (visited.has(row.bomNo)) continue;
          result.push({ row, depth });
          walk(row.bomNo, depth + 1, new Set(visited).add(row.bomNo));
        }
      };
      walk("", 0, new Set());
    }
    return result;
  }, [bom]);

  const submitItem = () => {
    if (!itemForm?.itemName.trim()) return;
    void run(async () => { await saveInventoryItem(itemForm); setItemForm(null); }, "Inventory master saved. Item number is generated automatically.");
  };

  const submitPurchase = () => {
    if (!purchaseForm?.itemId || !purchaseForm.supplierName.trim()) return;
    void run(async () => {
      try {
        await savePurchase(purchaseForm);
        setPurchaseForm(null);
      } catch (err) {
        if (err instanceof StalePurchaseError) {
          setError(lang === "ja"
            ? "この仕入は編集している間に別のユーザーが保存しました。最新の内容を読み込んで変更をやり直してください。"
            : err.message);
        } else {
          throw err;
        }
      }
    }, text("Purchase and stock receipt saved. Purchase number is generated automatically.", "仕入と入荷を登録しました。仕入番号は自動採番されます。"));
  };

  const submitMovement = () => {
    if (!movementItem || movementQty <= 0) return;
    const positive = ["production_output", "subcontract_in", "adjustment_in"].includes(movementType);
    const pending = readRecovery<MovementPayload>(profile.id, "movement-submit");
    if (pending && (pending.itemId !== movementItem || pending.quantity !== movementQty || pending.notes !== movementNotes || pending.movementType !== movementType)) {
      setError(text("A previous stock submission is unconfirmed. Retry its original fields before recording a different movement.", "前回の在庫移動が未確認です。別の移動を記録する前に、元の入力内容で再試行してください。"));
      return;
    }
    const selectedItem = itemById(movementItem);
    if (!pending && !positive && selectedItem && movementQty > selectedItem.availableQty) {
      setError(lang === "ja"
        ? `在庫が不足しています（${selectedItem.itemCode}）。利用可能数：${selectedItem.availableQty.toLocaleString()} ${unitLabel(selectedItem.unit)}`
        : `Insufficient stock for ${selectedItem.itemCode}. Available: ${selectedItem.availableQty.toLocaleString()} ${selectedItem.unit}.`);
      return;
    }
    const submission: MovementPayload = pending ?? {
      movementDate: today(), movementType, referenceType: "manual", referenceId: null,
      itemId: movementItem, quantity: movementQty, delta: positive ? movementQty : -movementQty,
      pic: profile.displayName || profile.username, notes: movementNotes, idempotencyKey: genUUID(),
    };
    try { writeRecovery(profile.id, "movement-submit", submission); }
    catch (error) { setError(errorMessage(error)); return; }
    void run(async () => {
      await addStockMovement(submission);
      removeRecovery(profile.id, "movement-submit");
      setMovementOpen(false);
      setMovementQty(1);
      setMovementNotes("");
    }, text("Stock movement recorded with an automatic movement number.", "在庫移動を記録しました。在庫移動番号は自動採番されます。"));
  };

  const askDelete = (message: string, task: () => Promise<void>, success: string) => {
    void dialog.confirm(message, { tone: "danger" }).then(ok => { if (ok) void run(task, success); });
  };

  const rowsForExport = (selectedTab: Tab): Record<string, unknown>[] => {
    if (selectedTab === "inventory") return items.map(item => ({
      itemNo: item.itemCode, itemName: item.itemName, category: categoryLabel(item.category),
      procurement: procurementLabel(item.procurementType), unit: item.unit,
      openingQty: item.openingQty, minimumQty: item.minimumQty, targetQty: item.targetQty,
      supplier: item.supplierName, unitCost: item.unitCost, active: item.active ? "Yes" : "No",
    }));
    if (selectedTab === "purchases") return purchases.map(purchase => ({
      purchaseNo: purchase.purchaseNo, purchaseDate: purchase.purchaseDate, supplier: purchase.supplierName,
      itemNo: itemById(purchase.itemId)?.itemCode ?? "", orderedQty: purchase.orderedQty,
      receivedQty: purchase.receivedQty, unitPrice: purchase.unitPrice, dueDate: purchase.dueDate,
      status: purchase.status[0].toUpperCase() + purchase.status.slice(1), pic: purchase.pic, notes: purchase.notes,
    }));
    if (selectedTab === "movements") return movements.map(movement => ({
      movementNo: movement.movementNo, movementDate: movement.movementDate,
      movementType: movementLabel(movement.movementType),
      itemNo: itemById(movement.itemId)?.itemCode ?? "", quantity: movement.delta,
      pic: movement.pic, notes: movement.notes,
    }));
    return bom.map(row => ({
      bomNo: row.bomNo, parentBomNo: row.parentBomNo, productNo: products.find(product => product.id === row.productId)?.productNumber ?? "",
      itemNo: itemById(row.inventoryItemId)?.itemCode ?? "", quantity: row.quantityPerUnit, notes: row.notes,
    }));
  };

  const downloadExcel = async (template: boolean) => {
    setError("");
    const config = TAB_EXCEL[tab];
    try {
      await createExcelWorkbook({
        title: `${config.title}${template ? " · Import Template" : ""}`,
        subtitle: config.subtitle,
        fileName: `${config.file}-${template ? "template" : today()}.xlsx`,
        sheetName: config.title,
        columns: config.columns,
        rows: template ? [] : rowsForExport(tab),
        template,
      });
      setNotice(template ? text("Excel template downloaded.", "Excelテンプレートをダウンロードしました。") : text("Excel export downloaded.", "Excelデータをダウンロードしました。"));
    } catch (err) {
      setError(lang === "ja" ? "Excelファイルを作成できませんでした。" : errorMessage(err));
    }
  };

  const openImportDialog = () => {
    setError("");
    setTransferDialog({ mode: "import", template: false, file: null, fileName: "" });
  };

  const openExportDialog = (template: boolean) => {
    setError("");
    const config = TAB_EXCEL[tab];
    setTransferDialog({
      mode: "export",
      template,
      file: null,
      fileName: `${config.file}-${template ? "template" : today()}.xlsx`,
    });
  };

  const validateRequired = (row: ImportedExcelRow, columns: ExcelColumn[]) => {
    const missing = columns.filter(column => column.required && !text(row.values[column.key]));
    if (missing.length) throw new Error(`Row ${row.rowNumber}: ${missing.map(column => column.header).join(", ")} is required.`);
  };

  // The old loop called saveInventoryItem / savePurchase / addStockMovement once
  // per row, awaited each one, and threw on the first failure. A 200 row file
  // with a typo on row 150 left the first 149 rows committed with no way to undo
  // them from the UI. Every row is now validated and prepared up front, so
  // nothing is written until the whole file is known to be sound.
  const prepareRow = (row: ImportedExcelRow): PreparedRow => {
    validateRequired(row, TAB_EXCEL[tab].columns);
    if (tab === "inventory") {
      const itemNo = autoNumber(row.values.itemNo);
      const current = items.find(item => item.itemCode.toLowerCase() === itemNo.toLowerCase());
      // A missing or non-numeric quantity is no longer a silent zero. The import
      // refuses instead, because a zero here reads as "this item is out of
      // stock" rather than "nobody filled in the cell".
      const openingQty = requiredNumber(row.values.openingQty);
      if (openingQty === null) throw new Error("Opening Qty must be a number.");
      if (openingQty < 0) throw new Error("Opening Qty cannot be negative.");
      const minimumQty = requiredNumber(row.values.minimumQty) ?? 0;
      const targetQty = requiredNumber(row.values.targetQty) ?? 0;
      if (minimumQty < 0 || targetQty < 0) throw new Error("Minimum Qty and Target Qty cannot be negative.");
      const unitCost = requiredNumber(row.values.unitCost);
      if (unitCost === null) throw new Error("Unit Cost must be a number.");
      if (unitCost < 0) throw new Error("Unit Cost cannot be negative.");
      const itemName = text(row.values.itemName);
      if (!itemName) throw new Error("Item Name is required.");
      return {
        kind: "inventory",
        existingId: current?.id ?? "",
        payload: {
          ...(current ?? blankItem()), itemCode: current?.itemCode ?? "",
          itemName, category: categoryFromExcel(row.values.category),
          procurementType: procurementFromExcel(row.values.procurement), unit: text(row.values.unit) || "pcs",
          openingQty, minimumQty, targetQty, supplierName: text(row.values.supplier),
          unitCost, active: boolean(row.values.active),
        },
      };
    }
    if (tab === "purchases") {
      const purchaseNo = autoNumber(row.values.purchaseNo);
      const current = purchases.find(purchase => purchase.purchaseNo.toLowerCase() === purchaseNo.toLowerCase());
      const item = items.find(candidate => candidate.itemCode.toLowerCase() === text(row.values.itemNo).toLowerCase());
      if (!item) throw new Error(`Item No "${text(row.values.itemNo)}" was not found.`);
      const status = text(row.values.status).toLowerCase() as Purchase["status"];
      if (!["ordered", "partial", "received", "cancelled"].includes(status)) throw new Error(`Unknown status "${text(row.values.status)}".`);
      const orderedQty = requiredNumber(row.values.orderedQty);
      const receivedQty = requiredNumber(row.values.receivedQty) ?? 0;
      if (orderedQty === null) throw new Error("Ordered Qty must be a number.");
      if (orderedQty <= 0 || receivedQty < 0 || receivedQty > orderedQty) throw new Error("Received quantity must be between zero and the ordered quantity.");
      const unitPrice = requiredNumber(row.values.unitPrice);
      if (unitPrice === null) throw new Error("Unit Price must be a number.");
      if (unitPrice < 0) throw new Error("Unit Price cannot be negative.");
      const purchaseDate = excelDate(row.values.purchaseDate, today());
      if (!isValidISODate(purchaseDate)) throw new Error(`Purchase Date "${text(row.values.purchaseDate)}" is not a valid date.`);
      const dueDate = excelDate(row.values.dueDate);
      if (dueDate && !isValidISODate(dueDate)) throw new Error(`Due Date "${text(row.values.dueDate)}" is not a valid date.`);
      return {
        kind: "purchases",
        existingId: current?.id ?? "",
        payload: {
          ...(current ?? blankPurchase()), purchaseNo: current?.purchaseNo ?? "",
          purchaseDate, supplierName: text(row.values.supplier),
          itemId: item.id, orderedQty, receivedQty, unitPrice,
          dueDate, status, pic: text(row.values.pic), notes: text(row.values.notes),
        },
      };
    }
    if (tab === "movements") {
      const movementNo = autoNumber(row.values.movementNo);
      if (movementNo && movements.some(movement => movement.movementNo.toLowerCase() === movementNo.toLowerCase())) {
        return { kind: "skip" };
      }
      const item = items.find(candidate => candidate.itemCode.toLowerCase() === text(row.values.itemNo).toLowerCase());
      if (!item) throw new Error(`Item No "${text(row.values.itemNo)}" was not found.`);
      const importedMovementType = movementTypeFromExcel(row.values.movementType);
      const rawQuantity = requiredNumber(row.values.quantity);
      if (rawQuantity === null) throw new Error("Quantity must be a number.");
      if (!rawQuantity) throw new Error("Quantity cannot be zero.");
      const positive = ["production_output", "subcontract_in", "adjustment_in"].includes(importedMovementType);
      const quantity = Math.abs(rawQuantity);
      const movementDate = excelDate(row.values.movementDate, today());
      if (!isValidISODate(movementDate)) throw new Error(`Movement Date "${text(row.values.movementDate)}" is not a valid date.`);
      return {
        kind: "movements",
        existingId: "",
        payload: {
          movementDate, movementType: importedMovementType,
          referenceType: "manual", referenceId: null, itemId: item.id, quantity,
          delta: positive ? quantity : -quantity, pic: text(row.values.pic) || profile.displayName || profile.username,
          notes: text(row.values.notes),
          idempotencyKey: genUUID(),
        },
      };
    }
    const bomNo = autoNumber(row.values.bomNo);
    const current = bom.find(candidate => candidate.bomNo.toLowerCase() === bomNo.toLowerCase());
    const product = products.find(candidate => candidate.productNumber.toLowerCase() === text(row.values.productNo).toLowerCase());
    if (!product) throw new Error(`Product No "${text(row.values.productNo)}" was not found.`);
    const parentBomNo = text(row.values.parentBomNo);
    if (parentBomNo && !bom.some(candidate => candidate.bomNo.toLowerCase() === parentBomNo.toLowerCase() && candidate.productId === product.id)) {
      throw new Error(`Parent BOM No "${parentBomNo}" must identify an existing BOM row for this product.`);
    }
    const item = items.find(candidate => candidate.itemCode.toLowerCase() === text(row.values.itemNo).toLowerCase());
    if (!item) throw new Error(`Item No "${text(row.values.itemNo)}" was not found.`);
    const quantity = requiredNumber(row.values.quantity);
    if (quantity === null) throw new Error("Qty per Product must be a number.");
    if (quantity <= 0) throw new Error("Qty per Product must be greater than zero.");
    return {
      kind: "bom",
      existingId: current?.id ?? "",
      payload: {
        id: current?.id ?? genUUID(), bomNo: current?.bomNo ?? "", productId: product.id,
        inventoryItemId: item.id, parentBomNo, quantityPerUnit: quantity, notes: text(row.values.notes),
      },
    };
  };

  const importRows = async (rows: ImportedExcelRow[]) => {
    // Phase 1: validate and resolve every row against the current state, with no
    // writes at all.
    const prepared: PreparedRow[] = [];
    for (const row of rows) {
      try {
        prepared.push(prepareRow(row));
      } catch (err) {
        throw new Error(`Row ${row.rowNumber}: ${errorMessage(err)}`);
      }
    }
    const skipped = prepared.filter(row => row.kind === "skip").length;
    const writable = prepared.filter((row): row is Exclude<PreparedRow, { kind: "skip" }> => row.kind !== "skip");
    if (!writable.length && !skipped) throw new Error("No data rows were found in the Excel file.");

    // A second row addressing the same record would silently overwrite the
    // first, because each one is matched against the state as it was before the
    // import. That is a spreadsheet mistake, not an intent worth honouring.
    const collisions = new Map<string, number>();
    for (const row of writable) {
      const key = duplicateKey(row);
      if (!key) continue;
      const seen = collisions.get(key);
      if (seen !== undefined) {
        throw new Error(`The file contains more than one row for ${key}. Merge them into a single row and import again.`);
      }
      collisions.set(key, 1);
    }

    // Phase 2 is one database call and therefore one transaction: a failure in
    // any row rolls the entire batch back.
    const saved = await importInventoryRows(writable);
    return `${saved} record${saved === 1 ? "" : "s"} imported${skipped ? `, ${skipped} existing journal row${skipped === 1 ? "" : "s"} skipped` : ""}.`;
  };

  const handleExcelFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setTransferDialog(current => current?.mode === "import" ? { ...current, file, fileName: file.name } : current);
  };

  const confirmTransfer = async () => {
    if (!transferDialog) return;
    if (transferDialog.mode === "export") {
      await downloadExcel(transferDialog.template);
      setTransferDialog(null);
      return;
    }
    if (!transferDialog.file) return;
    const activeTab = tab;
    const file = transferDialog.file;
    setTransferDialog(null);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const rows = await readExcelRows(file, TAB_EXCEL[activeTab].columns);
      const result = await importRows(rows);
      await load();
      setNotice(result);
    } catch (err) {
      setError(lang === "ja" ? "Excelファイルを読み込めませんでした。内容を確認してください。" : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const printReceipt = (purchase: Purchase) => {
    void printAction.run(async () => {
      if (hasNativeBridge() || !isAndroidWebView()) {
        setPrintPurchase(purchase);
        await new Promise<void>(resolve => setTimeout(resolve, 120));
      }
      await printBillingDocument(lang, message => dialog.alert(message));
    });
  };

  return (
    <AppShell onNavigate={onNavigate} title={text("Inventory & Purchasing", "在庫・仕入管理")} activePage="inventory" showBack backTarget="home" backLabel={text("Home", "ホーム")} lang={lang} setLang={setLang} noPrint>
      <div className="border-b border-slate-200 bg-white px-4 sm:px-8 print:hidden">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-1 py-2 sm:flex sm:overflow-x-auto">
          {(["inventory", "purchases", "movements", "bom"] as Tab[]).map(value => <button key={value} onClick={() => setTab(value)} className={`rounded px-2 py-2 text-xs font-600 capitalize sm:whitespace-nowrap sm:px-4 sm:text-sm ${tab === value ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{value === "bom" ? text("Product materials (BOM)", "製品材料（BOM）") : ({ inventory: text("Inventory", "在庫"), purchases: text("Purchases", "仕入"), movements: text("Movements", "在庫移動") } as const)[value]}</button>)}
        </div>
      </div>

      <main className="page-enter flex-1 overflow-y-auto p-3 sm:p-6 print:hidden">
        <div className="mx-auto max-w-7xl space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[{ label: text("Master items", "登録品目数"), value: summary.itemCount.toLocaleString(), danger: false }, { label: text("Stock value", "在庫金額"), value: money(summary.stockValue), danger: false }, { label: text("Out of stock", "在庫切れ"), value: summary.outOfStock.toLocaleString(), danger: summary.outOfStock > 0 }, { label: text("Need purchase", "要発注"), value: summary.reorderCount.toLocaleString(), danger: false }].map(card => <div key={card.label} className={`rounded-lg p-4 shadow-sm ring-1 ${card.danger ? "bg-red-50 ring-red-200" : "bg-white ring-slate-200"}`}><p className={`text-xs font-600 ${card.danger ? "text-red-600" : "text-slate-500"}`}>{card.label}</p><p className={`mt-2 text-xl font-700 sm:text-2xl ${card.danger ? "text-red-700" : "text-[#1a3458]"}`}>{card.value}</p></div>)}
          </div>
          {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{error}</span><button type="button" disabled={busy} onClick={() => void load(true)} className="rounded border border-red-300 bg-white px-3 py-1.5 font-700 text-red-700 hover:bg-red-100 disabled:opacity-50">{busy ? text("Checking...", "確認中…") : text("Check again", "再確認")}</button></div>}
          {notice && <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          <section className="flex flex-col gap-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-700 text-[#0d7377]">{text("Excel tools", "Excel入出力")}</p><h2 className="font-700 text-[#1a3458]">{lang === "ja" ? ({ inventory: "在庫マスタ", purchases: "仕入台帳", movements: "在庫移動台帳", bom: "製品材料（BOM）" } as const)[tab] : TAB_EXCEL[tab].title}</h2><p className="text-xs text-slate-500">{text("Import validates every row. Automatic numbers may be left blank.", "インポート時に全行を検証します。自動採番の項目は空欄にできます。")}</p></div>
            <div className="flex flex-wrap gap-2">
              <button disabled={busy} onClick={() => openExportDialog(true)} className={`${outlineButton} flex-1 whitespace-nowrap sm:flex-none`}>{text("Template", "テンプレート")}</button>
              <button disabled={busy} onClick={openImportDialog} className={`${outlineButton} flex-1 whitespace-nowrap sm:flex-none`}>{text("Import Excel", "Excelをインポート")}</button>
              <button disabled={busy} onClick={() => openExportDialog(false)} className="flex-1 whitespace-nowrap rounded bg-[#0d7377] px-3 py-2 text-sm font-700 text-white hover:bg-[#0a6063] disabled:opacity-40 sm:flex-none">{text("Export Excel", "Excelをエクスポート")}</button>
              <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleExcelFile} className="hidden" />
            </div>
          </section>

          {tab === "inventory" && (
            <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div><h2 className="text-lg font-700 text-[#1a3458]">{text("Inventory master", "在庫マスタ")}</h2><p className="text-sm text-slate-500">{text("Item numbers are generated automatically and cannot be edited.", "品目番号は自動採番され、編集できません。")}</p></div>
                <div className="flex gap-2"><input value={search} onChange={event => setSearch(event.target.value)} placeholder={text("Search item...", "品目を検索…")} className="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2 text-sm sm:w-56" /><button onClick={() => setItemForm(blankItem())} className="whitespace-nowrap rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">＋ {text("Item", "品目")}</button></div>
              </div>
              {!isWide && <div className="divide-y divide-slate-100">{filteredItems.map(item => { const empty = item.availableQty <= 0; return <article key={item.id} className={empty ? "space-y-3 bg-red-50 p-4" : item.needsReorder ? "space-y-3 bg-amber-50/60 p-4" : "space-y-3 p-4"}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-700">{item.itemName}</p><p className="font-mono text-xs text-slate-500">{item.itemCode}</p></div><span className={`shrink-0 rounded px-2 py-1 text-xs font-700 ${empty ? "bg-red-200 text-red-800" : "bg-slate-100"}`}>{empty ? text("Out of stock", "在庫切れ") : categoryLabel(item.category)}</span></div><div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs font-600 text-slate-400">{text("Available", "在庫数")}</p><p className={`font-mono font-700 ${empty ? "text-red-700" : item.needsReorder ? "text-amber-700" : ""}`}>{item.availableQty.toLocaleString()} {unitLabel(item.unit)}</p></div><div><p className="text-xs font-600 text-slate-400">{text("Stock value", "在庫金額")}</p><p className="font-mono font-700">{money(item.stockValue)}</p></div><div><p className="text-xs font-600 text-slate-400">{text("Min / target", "下限 / 目標")}</p><p className="font-mono">{item.minimumQty.toLocaleString()} / {item.targetQty.toLocaleString()}</p></div><div><p className="text-xs font-600 text-slate-400">{text("Supplier", "仕入先")}</p><p className="break-words">{item.supplierName || "-"}</p></div></div>{item.needsReorder && <p className={`text-xs font-700 ${empty ? "text-red-700" : "text-amber-700"}`}>{text("Suggested purchase", "推奨発注数")} +{item.suggestedPurchaseQty.toLocaleString()}</p>}<div className="flex gap-2"><button onClick={() => setItemForm(item)} className={`${outlineButton} flex-1`}>{text("Edit", "編集")}</button><button onClick={() => askDelete(text(`Delete ${item.itemCode} · ${item.itemName}?`, `品目 ${item.itemCode}・${item.itemName} を削除しますか？`), () => deleteInventoryItem(item.id), text("Inventory item deleted.", "在庫品目を削除しました。"))} disabled={!canDelete} title={text("Only an administrator can delete an inventory item. Use a stock adjustment to correct the balance instead.", "在庫品目の削除は管理者のみ行えます。残高を修正するには在庫調整を使用してください。")} className="flex-1 rounded border border-red-200 px-3 py-2 text-sm font-700 text-red-600 disabled:cursor-not-allowed disabled:opacity-40">{text("Delete", "削除")}</button></div></article>; })}</div>}
              {isWide && <div className="overflow-x-auto"><table className="w-full min-w-[1040px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-600 text-slate-500"><tr><th className="px-4 py-3">{text("No / item", "番号 / 品目")}</th><th className="px-4 py-3">{text("Category", "分類")}</th><th className="px-4 py-3 text-right">{text("Available", "在庫数")}</th><th className="px-4 py-3 text-right">{text("Min / target", "下限 / 目標")}</th><th className="px-4 py-3">{text("Supplier", "仕入先")}</th><th className="px-4 py-3 text-right">{text("Stock value", "在庫金額")}</th><th className="px-4 py-3 text-right">{text("Actions", "操作")}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{filteredItems.map(item => <tr key={item.id} className={item.availableQty <= 0 ? "bg-red-50" : item.needsReorder ? "bg-amber-50/60" : "hover:bg-slate-50"}>
                  <td className="px-4 py-3"><p className="font-700">{item.itemName}</p><p className="font-mono text-xs text-slate-500">{item.itemCode}</p></td>
                  <td className="px-4 py-3"><p>{categoryLabel(item.category)}</p><p className="text-xs capitalize text-slate-500">{procurementLabel(item.procurementType)}</p></td>
                  <td className="px-4 py-3 text-right"><span className={`font-mono font-700 ${item.availableQty <= 0 ? "text-red-700" : item.needsReorder ? "text-amber-700" : "text-slate-800"}`}>{item.availableQty.toLocaleString()} {unitLabel(item.unit)}</span>{item.availableQty <= 0 ? <p className="text-xs font-700 text-red-700">{text("Out of stock", "在庫切れ")}</p> : item.needsReorder && <p className="text-xs text-amber-700">{text("Suggest", "推奨発注数")} +{item.suggestedPurchaseQty.toLocaleString()}</p>}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs">{item.minimumQty.toLocaleString()} / {item.targetQty.toLocaleString()}</td><td className="px-4 py-3">{item.supplierName || "-"}</td><td className="px-4 py-3 text-right font-mono">{money(item.stockValue)}</td>
                  <td className="px-4 py-3"><div className="flex justify-end gap-2"><button onClick={() => setItemForm(item)} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-white">{text("Edit", "編集")}</button><button onClick={() => askDelete(text(`Delete ${item.itemCode} · ${item.itemName}?`, `品目 ${item.itemCode}・${item.itemName} を削除しますか？`), () => deleteInventoryItem(item.id), text("Inventory item deleted.", "在庫品目を削除しました。"))} disabled={!canDelete} title={text("Only an administrator can delete an inventory item. Use a stock adjustment to correct the balance instead.", "在庫品目の削除は管理者のみ行えます。残高を修正するには在庫調整を使用してください。")} className="rounded border border-red-200 px-3 py-1.5 font-600 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">{text("Delete", "削除")}</button></div></td>
                </tr>)}</tbody>
              </table></div>}
            </section>
          )}

          {tab === "purchases" && (
            <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
              <div className="flex items-center justify-between border-b border-slate-200 p-4"><div><h2 className="text-lg font-700 text-[#1a3458]">{text("Purchasing register", "仕入台帳")}</h2><p className="text-sm text-slate-500">{text("Purchase numbers are automatic; received quantities create related stock movements.", "仕入番号は自動採番です。入荷数量は在庫移動に反映されます。")}</p></div><button onClick={() => setPurchaseForm(blankPurchase())} className="rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">＋ {text("Purchase", "仕入")}</button></div>
              {!isWide && <div className="divide-y divide-slate-100">{purchases.map(purchase => <article key={purchase.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-mono font-700">{purchase.purchaseNo}</p><p className="text-xs text-slate-500">{purchase.purchaseDate}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-700">{purchaseStatusLabel(purchase.status)}</span></div><div><p className="font-700">{itemName(purchase.itemId)}</p><p className="text-sm text-slate-500">{purchase.supplierName}</p></div><div className="grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs font-600 text-slate-400">{text("Ordered / received", "発注数 / 入荷数")}</p><p className="font-mono">{purchase.orderedQty.toLocaleString()} / {purchase.receivedQty.toLocaleString()}</p></div><div><p className="text-xs font-600 text-slate-400">{text("Amount", "金額")}</p><p className="font-mono font-700">{money(purchase.orderedQty * purchase.unitPrice)}</p></div></div><div className="grid grid-cols-3 gap-2"><button onClick={() => printReceipt(purchase)} className={outlineButton}>{text("Print", "印刷")}</button><button onClick={() => setPurchaseForm(purchase)} className={outlineButton}>{text("Edit", "編集")}</button><button onClick={() => askDelete(text(`Delete purchase ${purchase.purchaseNo}? Its automatic stock receipt will be reversed.`, `仕入 ${purchase.purchaseNo} を削除しますか？自動入荷分の在庫も戻されます。`), () => deletePurchase(purchase.id), text("Purchase deleted and stock reconciled.", "仕入を削除し、在庫を修正しました。"))} className="rounded border border-red-200 px-2 py-2 text-sm font-700 text-red-600">{text("Delete", "削除")}</button></div></article>)}</div>}
              {isWide && <div className="overflow-x-auto"><table className="w-full min-w-[1020px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-600 text-slate-500"><tr><th className="px-4 py-3">{text("Purchase no / date", "仕入番号 / 日付")}</th><th className="px-4 py-3">{text("Supplier", "仕入先")}</th><th className="px-4 py-3">{text("Item", "品目")}</th><th className="px-4 py-3 text-right">{text("Ordered / received", "発注数 / 入荷数")}</th><th className="px-4 py-3 text-right">{text("Amount", "金額")}</th><th className="px-4 py-3">{text("Status", "状態")}</th><th className="px-4 py-3 text-right">{text("Actions", "操作")}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{purchases.map(purchase => <tr key={purchase.id} className="hover:bg-slate-50"><td className="px-4 py-3"><p className="font-700">{purchase.purchaseNo}</p><p className="text-xs text-slate-500">{purchase.purchaseDate}</p></td><td className="px-4 py-3">{purchase.supplierName}</td><td className="px-4 py-3">{itemName(purchase.itemId)}</td><td className="px-4 py-3 text-right font-mono">{purchase.orderedQty.toLocaleString()} / {purchase.receivedQty.toLocaleString()}</td><td className="px-4 py-3 text-right font-mono">{money(purchase.orderedQty * purchase.unitPrice)}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-700">{purchaseStatusLabel(purchase.status)}</span></td><td className="px-4 py-3"><div className="flex justify-end gap-2"><button onClick={() => printReceipt(purchase)} className="rounded border border-slate-300 px-3 py-1.5 font-600">{text("Print", "印刷")}</button><button onClick={() => setPurchaseForm(purchase)} className="rounded border border-slate-300 px-3 py-1.5 font-600">{text("Edit", "編集")}</button><button onClick={() => askDelete(text(`Delete purchase ${purchase.purchaseNo}? Its automatic stock receipt will be reversed.`, `仕入 ${purchase.purchaseNo} を削除しますか？自動入荷分の在庫も戻されます。`), () => deletePurchase(purchase.id), text("Purchase deleted and stock reconciled.", "仕入を削除し、在庫を修正しました。"))} className="rounded border border-red-200 px-3 py-1.5 font-600 text-red-600">{text("Delete", "削除")}</button></div></td></tr>)}</tbody>
              </table></div>}
            </section>
          )}

          {tab === "movements" && (
            <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-700 text-[#1a3458]">{text("Stock movement journal", "在庫移動台帳")}</h2><p className="text-sm text-slate-500">{text("Every movement receives an immutable automatic journal number.", "各在庫移動に変更できない自動番号が付与されます。")}</p></div><div className="flex gap-2"><select value={movementDirection} onChange={event => setMovementDirection(event.target.value as typeof movementDirection)} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm"><option value="all">{text("All movements", "すべて")}</option><option value="outgoing">{text("Outgoing materials", "出庫")}</option><option value="incoming">{text("Incoming stock", "入庫")}</option></select><button onClick={() => setMovementOpen(true)} className="whitespace-nowrap rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">＋ {text("Manual movement", "手動在庫移動")}</button></div></div>
              {!isWide && <div className="divide-y divide-slate-100">{filteredMovements.map(movement => <article key={movement.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-mono font-700">{movement.movementNo}</p><p className="text-xs text-slate-500">{movement.movementDate}</p></div><p className={`font-mono font-700 ${movement.delta < 0 ? "text-red-600" : "text-emerald-700"}`}>{movement.delta > 0 ? "+" : ""}{movement.delta.toLocaleString()}</p></div><div><p className="font-700">{itemName(movement.itemId)}</p><p className="text-sm text-slate-500">{movementLabel(movement.movementType)}</p></div><div className="text-sm"><p>{movement.pic || "-"} · <span className="font-mono text-xs text-slate-500">{text(movement.referenceType, movement.referenceType === "manual" ? "手動" : "自動")}</span></p><p className="mt-1 break-words text-slate-500">{movement.notes || "-"}</p></div>{movement.referenceType === "manual" && <button onClick={() => askDelete(text(`Delete manual movement ${movement.movementNo}?`, `手動在庫移動 ${movement.movementNo} を削除しますか？`), () => deleteStockMovement(movement), text("Manual stock movement deleted.", "手動在庫移動を削除しました。"))} className="w-full rounded border border-red-200 px-3 py-2 text-sm font-700 text-red-600">{text("Delete manual movement", "手動在庫移動を削除")}</button>}</article>)}</div>}
              {isWide && <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-sm">
                <thead className="bg-slate-50 text-left text-xs font-600 text-slate-500"><tr><th className="px-4 py-3">{text("Movement no / date", "在庫移動番号 / 日付")}</th><th className="px-4 py-3">{text("Movement", "在庫移動")}</th><th className="px-4 py-3">{text("Item", "品目")}</th><th className="px-4 py-3 text-right">{text("Delta", "増減数")}</th><th className="px-4 py-3">{text("PIC / reference", "担当者 / 参照")}</th><th className="px-4 py-3">{text("Notes", "備考")}</th><th className="px-4 py-3 text-right">{text("Action", "操作")}</th></tr></thead>
                <tbody className="divide-y divide-slate-100">{filteredMovements.map(movement => <tr key={movement.id} className="hover:bg-slate-50"><td className="whitespace-nowrap px-4 py-3"><p className="font-mono font-700">{movement.movementNo}</p><p className="text-xs text-slate-500">{movement.movementDate}</p></td><td className="px-4 py-3 font-600">{movementLabel(movement.movementType)}</td><td className="px-4 py-3">{itemName(movement.itemId)}</td><td className={`px-4 py-3 text-right font-mono font-700 ${movement.delta < 0 ? "text-red-600" : "text-emerald-700"}`}>{movement.delta > 0 ? "+" : ""}{movement.delta.toLocaleString()}</td><td className="px-4 py-3"><p>{movement.pic || "-"}</p><p className="font-mono text-xs text-slate-500">{text(movement.referenceType, movement.referenceType === "manual" ? "手動" : "自動")}{movement.referenceId ? ` · ${movement.referenceId.slice(0, 8)}` : ""}</p></td><td className="max-w-sm px-4 py-3 text-slate-500">{movement.notes || "-"}</td><td className="px-4 py-3 text-right">{movement.referenceType === "manual" ? <button onClick={() => askDelete(text(`Delete manual movement ${movement.movementNo}?`, `手動在庫移動 ${movement.movementNo} を削除しますか？`), () => deleteStockMovement(movement), text("Manual stock movement deleted.", "手動在庫移動を削除しました。"))} className="font-700 text-red-600">{text("Delete", "削除")}</button> : <span className="text-xs text-slate-400">{text("Automatic", "自動")}</span>}</td></tr>)}</tbody>
              </table></div>}
            </section>
          )}

          {tab === "bom" && (
            <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <div className="mb-5"><h2 className="text-lg font-700 text-[#1a3458]">{text("Product material requirements (BOM)", "製品ごとの材料所要量（BOM）")}</h2><p className="text-sm text-slate-500">{text("Build a parent–child product structure. Stock is deducted from leaf components when production starts.", "親子構造でBOMを登録します。製作開始時に末端部品の在庫を引き当てます。")}</p></div>
              <div className="grid gap-3 rounded bg-slate-50 p-4 md:grid-cols-[1fr_1fr_1fr_140px_auto]">
                <Field label={text("Product", "製品")}><select value={bomProduct} onChange={e => { setBomProduct(e.target.value); setBomParent(""); }} className={inputClass}><option value="">{text("Select product", "製品を選択")}</option>{products.map(product => <option key={product.id} value={product.id}>{product.productNumber} · {product.productName}</option>)}</select></Field>
                <Field label={text("Parent assembly", "親部品（任意）")}><select value={bomParent} onChange={e => setBomParent(e.target.value)} className={inputClass} disabled={!bomProduct}><option value="">{text("Root component", "製品直下")}</option>{bom.filter(row => row.productId === bomProduct).map(row => <option key={row.bomNo} value={row.bomNo}>{row.bomNo} · {itemName(row.inventoryItemId)}</option>)}</select></Field>
                <Field label={text("Material / part", "材料 / 部品")}><select value={bomInventoryItem} onChange={e => setBomInventoryItem(e.target.value)} className={inputClass}><option value="">{text("Select item", "品目を選択")}</option>{items.filter(item => item.category !== "finished_good").map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field>
                <Field label={text("Qty per parent", "親あたり数量")}><input type="number" min="0.001" step="0.001" value={bomQty} onChange={e => setBomQty(number(e.target.value))} className={inputClass} /></Field>
                <button disabled={busy || !bomProduct || !bomInventoryItem || bomQty <= 0} onClick={() => void run(async () => { await saveBomItem({ id: genUUID(), bomNo: "", productId: bomProduct, inventoryItemId: bomInventoryItem, parentBomNo: bomParent, quantityPerUnit: bomQty, notes: "" }); setBomInventoryItem(""); setBomParent(""); setBomQty(1); }, text("BOM component added.", "BOM部品を追加しました。"))} className="self-end rounded bg-[#1a3458] px-4 py-2.5 font-700 text-white disabled:opacity-40">{text("Add", "追加")}</button>
              </div>
              {!isWide && <div className="mt-5 divide-y divide-slate-100">{orderedBom.map(({ row, depth }) => <article key={row.id} className="space-y-2 py-4" style={{ paddingInlineStart: `${depth * 20}px` }}><div className="flex items-start justify-between gap-3"><div><p className="font-700">{itemName(row.inventoryItemId)}</p><p className="font-mono text-xs text-slate-500">{row.bomNo}{row.parentBomNo ? ` · ${text("Child of", "親")}: ${row.parentBomNo}` : ` · ${productName(row.productId)}`}</p></div><p className="font-mono font-700">× {row.quantityPerUnit.toLocaleString()}</p></div><button onClick={() => askDelete(bom.some(child => child.parentBomNo === row.bomNo) ? text(`Remove ${row.bomNo} and all its subcomponents?`, `${row.bomNo} とその子部品をすべて削除しますか？`) : text(`Remove ${row.bomNo} from this product?`, `この製品から ${row.bomNo} を削除しますか？`), () => deleteBomItem(row.id), text("BOM component removed.", "BOM部品を削除しました。"))} className="w-full rounded border border-red-200 px-3 py-2 text-sm font-700 text-red-600">{text("Remove", "削除")}</button></article>)}</div>}
              {isWide && <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[860px] text-sm"><thead className="border-b border-slate-200 text-left text-xs font-600 text-slate-500"><tr><th className="px-3 py-3">{text("BOM no", "BOM番号")}</th><th className="px-3 py-3">{text("Product", "製品")}</th><th className="px-3 py-3">{text("Parent → component", "親 → 部品")}</th><th className="px-3 py-3 text-right">{text("Qty / parent", "親あたり数量")}</th><th className="px-3 py-3"></th></tr></thead><tbody className="divide-y divide-slate-100">{orderedBom.map(({ row, depth }) => <tr key={row.id}><td className="px-3 py-3 font-mono text-xs text-slate-500">{row.bomNo}</td><td className="px-3 py-3 font-600">{productName(row.productId)}</td><td className="px-3 py-3"><div style={{ paddingInlineStart: `${depth * 22}px` }}><span className="text-slate-400">{depth ? "↳ " : ""}</span>{itemName(row.inventoryItemId)}{row.parentBomNo && <span className="ml-2 font-mono text-xs text-slate-400">({row.parentBomNo})</span>}</div></td><td className="px-3 py-3 text-right font-mono">{row.quantityPerUnit.toLocaleString()}</td><td className="px-3 py-3 text-right"><button onClick={() => askDelete(text(`Remove ${row.bomNo} from this product?`, `この製品から ${row.bomNo} を削除しますか？`), () => deleteBomItem(row.id), text("BOM component removed.", "BOM部品を削除しました。"))} className="text-sm font-700 text-red-600">{text("Remove", "削除")}</button></td></tr>)}</tbody></table></div>}
            </section>
          )}
        </div>
      </main>

      {itemForm && <div className="popup-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-2 pt-4 print:hidden sm:items-center sm:p-4"><div className="popup-panel max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-4 shadow-2xl sm:max-h-[90vh] sm:p-6">
        <div className="mb-5 flex items-start justify-between"><div><h2 className="text-xl font-700 text-[#1a3458]">{text("Inventory master item", "在庫品目マスタ")}</h2><p className="text-sm text-slate-500">{text("Configure minimum stock, target, supplier, and standard cost.", "最低在庫数、目標在庫数、仕入先、標準原価を設定します。")}</p></div><button onClick={() => setItemForm(null)} className="text-xl text-slate-400">×</button></div>
        <div className="grid gap-4 sm:grid-cols-2"><Field label={text("Item number", "品目番号")}><input value={itemForm.itemCode || text("Generated automatically", "自動採番")} readOnly className={`${inputClass} cursor-not-allowed bg-slate-100 font-mono text-slate-500`} /></Field><Field label={text("Item name", "品目名")}><input value={itemForm.itemName} onChange={e => setItemForm({ ...itemForm, itemName: e.target.value })} className={inputClass} /></Field><Field label={text("Category", "カテゴリ")}><select value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value as InventoryCategory })} className={inputClass}>{Object.entries(lang === "ja" ? CATEGORY_LABELS_JA : CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={text("Procurement", "調達方法")}><select value={itemForm.procurementType} onChange={e => setItemForm({ ...itemForm, procurementType: e.target.value as ProcurementType })} className={inputClass}><option value="buy">{procurementLabel("buy")}</option><option value="make">{procurementLabel("make")}</option><option value="subcontract">{procurementLabel("subcontract")}</option></select></Field><Field label={text("Unit", "単位")}><input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} className={inputClass} /></Field><Field label={text("Opening quantity", "初期在庫数")}><input type="number" step="0.001" value={itemForm.openingQty} onChange={e => setItemForm({ ...itemForm, openingQty: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Minimum quantity", "最低在庫数")}><input type="number" step="0.001" value={itemForm.minimumQty} onChange={e => setItemForm({ ...itemForm, minimumQty: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Target quantity", "目標在庫数")}><input type="number" step="0.001" value={itemForm.targetQty} onChange={e => setItemForm({ ...itemForm, targetQty: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Supplier", "仕入先")}><input value={itemForm.supplierName} onChange={e => setItemForm({ ...itemForm, supplierName: e.target.value })} className={inputClass} /></Field><Field label={text("Standard unit cost", "標準単価")}><input type="number" min="0" value={itemForm.unitCost} onChange={e => setItemForm({ ...itemForm, unitCost: number(e.target.value) })} className={inputClass} /></Field></div>
        <div className="mt-6 flex justify-end gap-2"><button onClick={() => setItemForm(null)} className={outlineButton}>{text("Cancel", "キャンセル")}</button><button disabled={busy || !itemForm.itemName.trim()} onClick={submitItem} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">{text("Save item", "品目を保存")}</button></div>
      </div></div>}

      {purchaseForm && <div className="popup-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-2 pt-4 print:hidden sm:items-center sm:p-4"><div className="popup-panel max-h-[94dvh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-4 shadow-2xl sm:max-h-[90vh] sm:p-6">
        <div className="mb-5 flex items-start justify-between"><div><h2 className="text-xl font-700 text-[#1a3458]">{text("Purchase inventory", "在庫品を仕入")}</h2><p className="text-sm text-slate-500">{text("Received quantity is posted directly into stock.", "入荷数は在庫に直接反映されます。")}</p></div><button onClick={() => setPurchaseForm(null)} className="text-xl text-slate-400">×</button></div>
        {purchaseForm.updatedByUsername && <p className="-mt-2 mb-4 text-xs text-slate-400">{text("Last edited by", "最終編集")}: {purchaseEditorLabel ?? purchaseForm.updatedByUsername}</p>}
        <div className="grid gap-4 sm:grid-cols-2"><Field label={text("Purchase number", "仕入番号")}><input value={purchaseForm.purchaseNo || text("Generated automatically", "自動採番")} readOnly className={`${inputClass} cursor-not-allowed bg-slate-100 font-mono text-slate-500`} /></Field><Field label={text("Purchase date", "仕入日")}><input type="date" value={purchaseForm.purchaseDate} onChange={e => setPurchaseForm({ ...purchaseForm, purchaseDate: e.target.value })} className={inputClass} /></Field><Field label={text("Supplier", "仕入先")}><input value={purchaseForm.supplierName} onChange={e => setPurchaseForm({ ...purchaseForm, supplierName: e.target.value })} className={inputClass} /></Field><Field label={text("Inventory item", "在庫品目")}><select value={purchaseForm.itemId} onChange={e => { const selected = items.find(item => item.id === e.target.value); setPurchaseForm({ ...purchaseForm, itemId: e.target.value, unitPrice: selected?.unitCost ?? purchaseForm.unitPrice, supplierName: purchaseForm.supplierName || selected?.supplierName || "" }); }} className={inputClass}><option value="">{text("Select item", "品目を選択")}</option>{items.map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field><Field label={text("Ordered quantity", "発注数")}><input type="number" min="0.001" step="0.001" value={purchaseForm.orderedQty} onChange={e => setPurchaseForm({ ...purchaseForm, orderedQty: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Received quantity", "入荷数")}><input type="number" min="0" max={purchaseForm.orderedQty} step="0.001" value={purchaseForm.receivedQty} onChange={e => setPurchaseForm({ ...purchaseForm, receivedQty: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Unit price", "単価")}><input type="number" min="0" value={purchaseForm.unitPrice} onChange={e => setPurchaseForm({ ...purchaseForm, unitPrice: number(e.target.value) })} className={inputClass} /></Field><Field label={text("Due date", "納期")}><input type="date" value={purchaseForm.dueDate} onChange={e => setPurchaseForm({ ...purchaseForm, dueDate: e.target.value })} className={inputClass} /></Field><Field label={text("Status", "状態")}><select value={purchaseForm.status} onChange={e => setPurchaseForm({ ...purchaseForm, status: e.target.value as Purchase["status"] })} className={inputClass}><option value="ordered">{purchaseStatusLabel("ordered")}</option><option value="partial">{purchaseStatusLabel("partial")}</option><option value="received">{purchaseStatusLabel("received")}</option><option value="cancelled">{purchaseStatusLabel("cancelled")}</option></select></Field><Field label={text("PIC", "担当者")}><input value={purchaseForm.pic} onChange={e => setPurchaseForm({ ...purchaseForm, pic: e.target.value })} className={inputClass} /></Field></div>
        <Field label={text("Notes", "備考")}><textarea value={purchaseForm.notes} onChange={e => setPurchaseForm({ ...purchaseForm, notes: e.target.value })} className={`${inputClass} mt-4 min-h-20`} /></Field>
        <div className="mt-6 flex justify-end gap-2"><button onClick={() => setPurchaseForm(null)} className={outlineButton}>{text("Cancel", "キャンセル")}</button><button disabled={busy || !purchaseForm.itemId || !purchaseForm.supplierName.trim() || purchaseForm.orderedQty <= 0 || purchaseForm.receivedQty > purchaseForm.orderedQty} onClick={submitPurchase} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">{text("Save purchase", "仕入を保存")}</button></div>
      </div></div>}

      {movementOpen && <div className="popup-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-2 pt-4 print:hidden sm:items-center sm:p-4"><div className="popup-panel w-full max-w-lg rounded-lg bg-white p-4 shadow-2xl sm:p-6">
        <h2 className="text-xl font-700 text-[#1a3458]">{text("Manual stock movement", "手動在庫移動")}</h2><p className="mt-1 text-sm text-slate-500">{text("The movement number is generated automatically.", "在庫移動番号は自動採番されます。")}</p>
        <div className="mt-5 space-y-4"><Field label={text("Item", "品目")}><select value={movementItem} onChange={e => setMovementItem(e.target.value)} className={inputClass}><option value="">{text("Select item", "品目を選択")}</option>{items.map(item => <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName}</option>)}</select></Field><Field label={text("Movement type", "在庫移動種別")}><select value={movementType} onChange={e => setMovementType(e.target.value)} className={inputClass}><option value="material_issue">{movementLabel("material_issue")} (-)</option><option value="production_output">{movementLabel("production_output")} (+)</option><option value="subcontract_out">{movementLabel("subcontract_out")} (-)</option><option value="subcontract_in">{movementLabel("subcontract_in")} (+)</option><option value="sale_shipment">{movementLabel("sale_shipment")} (-)</option><option value="adjustment_in">{movementLabel("adjustment_in")} (+)</option><option value="adjustment_out">{movementLabel("adjustment_out")} (-)</option></select></Field><Field label={text("Positive quantity", "数量（正の値）")}><input type="number" min="0.001" step="0.001" value={movementQty} onChange={e => setMovementQty(number(e.target.value))} className={inputClass} /></Field><Field label={text("Notes", "備考")}><textarea value={movementNotes} onChange={e => setMovementNotes(e.target.value)} className={`${inputClass} min-h-20`} /></Field></div>
        <div className="mt-6 flex justify-end gap-2"><button onClick={() => setMovementOpen(false)} className={outlineButton}>{text("Cancel", "キャンセル")}</button><button disabled={busy || !movementItem || movementQty <= 0} onClick={submitMovement} className="rounded bg-[#1a3458] px-5 py-2 font-700 text-white disabled:opacity-40">{text("Post movement", "在庫移動を登録")}</button></div>
      </div></div>}

      {transferDialog && <div className="popup-backdrop fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 print:hidden" role="dialog" aria-modal="true">
        <div className="popup-panel w-full max-w-md rounded-lg bg-white p-5 shadow-2xl">
          <div className="flex items-start gap-3 border-b border-slate-200 pb-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-[#e7f5f4] text-[#0d7377]"><Icon name={transferDialog.mode === "import" ? "upload" : "file-text"} size={20} /></div>
            <div><h2 className="text-lg font-700 text-[#1a3458]">{transferDialog.mode === "import" ? text("Import Excel file", "Excelファイルをインポート") : transferDialog.template ? text("Download import template", "インポートテンプレートをダウンロード") : text("Export Excel file", "Excelファイルをエクスポート")}</h2><p className="mt-1 text-sm text-slate-500">{transferDialog.mode === "import" ? text("Choose a file, then confirm to validate and import it.", "ファイルを選択し、確認すると内容を検証してインポートします。") : text("The file will be downloaded to your device.", "ファイルを端末にダウンロードします。")}</p></div>
          </div>
          <div className="mt-5 rounded border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-xs font-700 text-slate-500">{text("File name", "ファイル名")}</p>
            <p className="mt-1 break-all font-mono text-sm text-slate-800">{transferDialog.fileName || text("No file selected", "ファイル未選択")}</p>
            {transferDialog.mode === "import" && <button type="button" onClick={() => fileInput.current?.click()} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-700 text-slate-700 hover:bg-slate-100"><Icon name="upload" size={16} />{text("Choose another file", "ファイルを選択")}</button>}
          </div>
          <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setTransferDialog(null)} className={outlineButton}>{text("Cancel", "キャンセル")}</button><button type="button" disabled={busy || (transferDialog.mode === "import" && !transferDialog.file)} onClick={() => void confirmTransfer()} className="rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white disabled:cursor-not-allowed disabled:opacity-40">{transferDialog.mode === "import" ? text("Import file", "インポート") : text("Download", "ダウンロード")}</button></div>
        </div>
      </div>}

      {printPurchase && <article id="purchase-receipt" className="hidden print:block"><div className="mx-auto max-w-3xl p-10 text-black"><div className="flex items-start justify-between border-b-2 border-black pb-5"><div className="flex items-center gap-4"><img src="/app-logo.png" alt="Kiyometa" className="h-14 w-14 rounded object-cover" /><div><p className="text-xs font-700">Kiyometa Manufacturing</p><h1 className="mt-1 text-3xl font-700">{text("Purchase receipt", "仕入伝票")}</h1></div></div><div className="text-right"><p className="font-mono text-lg font-700">{printPurchase.purchaseNo}</p><p>{printPurchase.purchaseDate}</p></div></div><div className="mt-8 grid grid-cols-2 gap-8"><div><p className="text-xs font-700 text-slate-500">{text("Supplier", "仕入先")}</p><p className="mt-1 text-lg font-700">{printPurchase.supplierName}</p></div><div><p className="text-xs font-700 text-slate-500">{text("PIC", "担当者")}</p><p className="mt-1 text-lg">{printPurchase.pic || "-"}</p></div></div><table className="mt-8 w-full border-collapse"><thead><tr className="border-y border-black text-left"><th className="py-3">{text("Item", "品目")}</th><th className="py-3 text-right">{text("Qty", "数量")}</th><th className="py-3 text-right">{text("Unit price", "単価")}</th><th className="py-3 text-right">{text("Total", "合計")}</th></tr></thead><tbody><tr><td className="py-4">{itemName(printPurchase.itemId)}</td><td className="py-4 text-right">{printPurchase.orderedQty.toLocaleString()}</td><td className="py-4 text-right">{money(printPurchase.unitPrice)}</td><td className="py-4 text-right font-700">{money(printPurchase.orderedQty * printPurchase.unitPrice)}</td></tr></tbody></table><div className="mt-10 border-t border-black pt-4 text-sm"><p>{text("Received quantity:", "入荷数：")} <strong>{printPurchase.receivedQty.toLocaleString()}</strong></p><p>{text("Status:", "状態：")} <strong>{purchaseStatusLabel(printPurchase.status)}</strong></p><p className="mt-3">{text("Notes:", "備考：")} {printPurchase.notes || "-"}</p></div></div></article>}
    </AppShell>
  );
}
