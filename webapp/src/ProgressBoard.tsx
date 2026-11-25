import { actualBatchMinutes } from "./lib/manufacturingPolicy";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageContainer, StatusBadge, type DeliverySlipMode, type Lang, type OrderRecord, type Page, type Product } from "./App";
import { useAuth } from "./lib/auth";
import { useDialog } from "./components/AppDialog";
import { supabase } from "./lib/supabaseClient";
import { subscribeRealtime } from "./lib/diagnostics";
import { useReadRefresh } from "./lib/useReadRefresh";
import { friendlyNetworkMessage, isConnectivityError } from "./lib/networkStatus";
import { useDurableState } from "./lib/useDurableState";
import HelpDialog from "./components/HelpDialog";
import {
  createManufacturingOperation,
  fetchManufacturingProgress,
  saveProductionTask,
  StaleProductionTaskError,
  updateManufacturingOperationCharge,
  updateManufacturingOperationDefaultMinutes,
  updateManufacturingOperationName,
  type ManufacturingOperation,
  type ProductionTaskProgress,
  type ProductionTaskStatus,
} from "./lib/operations";

interface Props {
  orders: OrderRecord[];
  products: Product[];
  onNavigate: (page: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  lang: Lang;
  setLang: (lang: Lang) => void;
  focusOrderId?: string;
  focusProductId?: string;
}

const STATUS_ORDER: ProductionTaskStatus[] = ["pending", "in_progress", "completed", "issue"];
const STATUS_CLASS: Record<ProductionTaskStatus, string> = {
  pending: "border-slate-200 bg-slate-100 text-slate-700",
  in_progress: "border-amber-300 bg-amber-100 text-amber-900",
  completed: "border-emerald-300 bg-emerald-100 text-emerald-900",
  issue: "border-red-300 bg-red-100 text-red-900",
};

interface ProductionTaskDraft {
  status: ProductionTaskStatus;
  actualMinutes: string;
  actualTimeBasis: "per_unit" | "per_batch" | null;
  processedQuantity: string;
  completedQuantity: string;
  baseVersion: number | null;
  conflict: boolean;
  readyToSave: boolean;
  requestId: string;
}

const draftFromTask = (task?: ProductionTaskProgress): ProductionTaskDraft => ({
  status: task?.status ?? "pending",
  actualMinutes: task?.actualMinutes == null ? "" : String(task.actualMinutes),
  actualTimeBasis: task?.actualTimeBasis ?? "per_unit",
  processedQuantity: task?.processedQuantity == null ? "" : String(task.processedQuantity),
  completedQuantity: task?.completedQuantity == null ? "" : String(task.completedQuantity),
  baseVersion: task?.version ?? null,
  conflict: false,
  readyToSave: false,
  requestId: "",
});

type ProgressSnapshot = Awaited<ReturnType<typeof fetchManufacturingProgress>>;
let progressSnapshot: ProgressSnapshot | null = null;
let progressSnapshotRequest: Promise<ProgressSnapshot> | null = null;

export function preloadProductionProgress(): Promise<ProgressSnapshot> {
  if (progressSnapshot) return Promise.resolve(progressSnapshot);
  if (!progressSnapshotRequest) {
    progressSnapshotRequest = fetchManufacturingProgress().then(data => {
      progressSnapshot = data;
      return data;
    }).finally(() => { progressSnapshotRequest = null; });
  }
  return progressSnapshotRequest;
}

export default function ProgressBoard({ orders, products, onNavigate, lang, setLang, focusOrderId, focusProductId }: Props) {
  const { profile } = useAuth();
  const dialog = useDialog();
  const text = (en: string, ja: string) => lang === "ja" ? ja : en;
  const [operations, setOperations] = useState<ManufacturingOperation[]>(() => progressSnapshot?.operations ?? []);
  const [tasks, setTasks] = useState<ProductionTaskProgress[]>(() => progressSnapshot?.tasks ?? []);
  const [routes, setRoutes] = useState<{ productId: string; operationId: string; standardMinutes: number | null }[]>(() => progressSnapshot?.routes ?? []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => !progressSnapshot);
  const [loaded, setLoaded] = useState(() => !!progressSnapshot);
  const [search, setSearch] = useState("");
  const [orderStatus, setOrderStatus] = useState("all");
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [taskDrafts, setTaskDrafts] = useDurableState<Record<string, ProductionTaskDraft>>("production-task-drafts", {});
  const [retryPulse, setRetryPulse] = useState(0);
  const [newName, setNewName] = useState("");
  const [newNameJa, setNewNameJa] = useState("");
  const [newMinutes, setNewMinutes] = useState("");
  const [newCharge, setNewCharge] = useState("");
  const [page, setPage] = useState(0);
  const [focusOrder, setFocusOrder] = useState(focusOrderId ?? "");
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const pendingWrites = useRef(new Set<string>());

  const scopedOrderIds = useMemo(() => orders.map(order => order.id), [orders]);
  const scopedProductIds = useMemo(() => {
    const ids = new Set<string>();
    const productsByKey = new Map(products.map(product => [`${product.clientName}\u0000${product.productName}`, product.id]));
    for (const order of orders) {
      const productId = order.productId ?? productsByKey.get(`${order.client}\u0000${order.productName}`);
      if (productId) ids.add(productId);
    }
    return [...ids];
  }, [orders, products]);
  const load = useReadRefresh(
    signal => fetchManufacturingProgress(signal, { orderIds: scopedOrderIds, productIds: scopedProductIds }),
    data => { progressSnapshot = data; setOperations(data.operations); setTasks(data.tasks); setRoutes(data.routes); setError(""); setLoaded(true); },
    failure => setError(isConnectivityError(failure) ? "" : friendlyNetworkMessage(failure, lang)),
    setLoading,
  );

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 120);
    };
    const channel = supabase.channel("production-progress-board")
      .on("postgres_changes", { event: "*", schema: "public", table: "production_tasks" }, schedule)
      .on("postgres_changes", { event: "*", schema: "public", table: "manufacturing_operations" }, schedule);
    subscribeRealtime(channel, "production-progress-board");
    return () => {
      window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const productById = useMemo(() => new Map(products.map(product => [product.id, product])), [products]);
  const productByKey = useMemo(
    () => new Map(products.map(product => [`${product.clientName}\u0000${product.productName}`, product])),
    [products],
  );
  const taskByKey = useMemo(
    () => new Map(tasks.map(task => [`${task.orderId}\u0000${task.operationId}`, task])),
    [tasks],
  );
  const operationTimesByProduct = useMemo(() => {
    const result = new Map<string, Map<string, number | null>>();
    for (const route of routes) {
      const times = result.get(route.productId) ?? new Map<string, number | null>();
      times.set(route.operationId, route.standardMinutes);
      result.set(route.productId, times);
    }
    return result;
  }, [routes]);
  const productionOrders = useMemo(() => orders.filter(order => order.progress === "In production" || order.progress === "Complete"), [orders]);
  const orderStatuses = useMemo(() => Array.from(new Set(orders.map(order => order.progress))).sort(), [orders]);
  const filteredOrders = useMemo(() => {
    const normalize = (value: unknown) => String(value ?? "").normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const terms = normalize(search).split(" ").filter(Boolean);
    return orders.filter(order => {
      if (focusProductId && order.productId !== focusProductId) return false;
      if (focusOrder && order.id !== focusOrder) return false;
      if (order.progress === "Cancelled") return false;
      if (orderStatus !== "all" && order.progress !== orderStatus) return false;
      if (terms.length === 0) return true;
      const product = (order.productId ? productById.get(order.productId) : productByKey.get(`${order.client}\u0000${order.productName}`));
      const searchable = normalize([
        order.orderNumber, order.productName, order.client, order.progress,
        order.deliveryDate, product?.productNumber, product?.internalCompanyName,
      ].join(" "));
      return terms.every(term => searchable.includes(term));
    }).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.orderNumber.localeCompare(b.orderNumber));
  }, [focusOrder, focusProductId, orderStatus, orders, productByKey, productById, search]);
  const operationsByOrder = useMemo(() => {
    const result = new Map<string, Map<string, number | null>>();
    for (const order of filteredOrders) {
      const product = (order.productId ? productById.get(order.productId) : productByKey.get(`${order.client}\u0000${order.productName}`));
      if (!product) continue;
      const route = operationTimesByProduct.get(product.id);
      if (order.progress === "Complete") {
        // The client selected active production orders for new stages. A
        // completed order keeps the stages it already has instead of gaining
        // later master-route additions.
        const existing = new Map<string, number | null>();
        for (const task of tasks.filter(item => item.orderId === order.id)) {
          existing.set(task.operationId, operationTimesByProduct.get(product.id)?.get(task.operationId) ?? null);
        }
        if (existing.size) result.set(order.id, existing);
      } else if (route?.size) result.set(order.id, route);
    }
    return result;
  }, [filteredOrders, operationTimesByProduct, productByKey, productById, tasks]);
  const visibleOperations = useMemo(() => {
    const used = new Set<string>();
    for (const route of operationsByOrder.values()) for (const id of route.keys()) used.add(id);
    return operations.filter(operation => used.has(operation.id));
  }, [operations, operationsByOrder]);
  const isFullMachiningOperation = (operation: ManufacturingOperation) =>
    operation.operationCode === "FULL_MACHINING"
    || operation.operationName.trim().toLocaleLowerCase() === "full machining"
    || operation.operationNameJa.trim() === "全加工";
  const visibleRealOperations = useMemo(
    () => visibleOperations.filter(operation => !isFullMachiningOperation(operation)),
    [visibleOperations],
  );
  const fullMachiningStatusByOrder = useMemo(() => {
    const result = new Map<string, ProductionTaskStatus>();
    for (const order of filteredOrders) {
      const route = operationsByOrder.get(order.id);
      const realOperationIds = route
        ? Array.from(route.keys()).filter(operationId => {
          const operation = operations.find(item => item.id === operationId);
          return operation ? !isFullMachiningOperation(operation) : true;
        })
        : [];
      const statuses = realOperationIds.map(operationId => taskByKey.get(`${order.id}\u0000${operationId}`)?.status ?? "pending");
      let status: ProductionTaskStatus = "pending";
      if (statuses.some(value => value === "issue")) status = "issue";
      else if (statuses.length > 0 && statuses.every(value => value === "completed")) status = "completed";
      else if (statuses.some(value => value === "in_progress" || value === "completed")) status = "in_progress";
      result.set(order.id, status);
    }
    return result;
  }, [filteredOrders, operations, operationsByOrder, taskByKey]);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const visibleOrders = filteredOrders.slice(page * pageSize, (page + 1) * pageSize);
  const productionOrderIds = useMemo(() => new Set(productionOrders.map(order => order.id)), [productionOrders]);
  const productionTaskSummary = useMemo(() => {
    const visibleProductionIds = new Set(filteredOrders.filter(order => productionOrderIds.has(order.id)).map(order => order.id));
    const relevantTasks = tasks.filter(task => visibleProductionIds.has(task.orderId));
    return {
      orders: visibleProductionIds.size,
      completed: relevantTasks.filter(task => task.status === "completed").length,
      active: relevantTasks.filter(task => task.status === "in_progress").length,
      issues: relevantTasks.filter(task => task.status === "issue").length,
    };
  }, [filteredOrders, productionOrderIds, tasks]);
  useEffect(() => setPage(0), [search, orderStatus]);
  useEffect(() => setPage(current => Math.min(current, pageCount - 1)), [pageCount]);

  const persistTaskDraft = async (orderId: string, operationId: string, draft: ProductionTaskDraft, existing = taskByKey.get(`${orderId}\u0000${operationId}`)) => {
    const key = `${orderId}\u0000${operationId}`;
    const submittedDraft = { ...draft, readyToSave: true, requestId: draft.requestId || crypto.randomUUID() };
    setTaskDrafts(previous => ({ ...previous, [key]: submittedDraft }));
    const actualMinutes = submittedDraft.actualMinutes.trim() === "" ? null : Number(submittedDraft.actualMinutes);
    const processedQuantity = submittedDraft.processedQuantity.trim() === "" ? null : Number(submittedDraft.processedQuantity);
    const completedQuantity = submittedDraft.completedQuantity.trim() === "" ? null : Number(submittedDraft.completedQuantity);
    const changed = submittedDraft.status !== (existing?.status ?? "pending")
      || submittedDraft.actualMinutes !== (existing?.actualMinutes == null ? "" : String(existing.actualMinutes))
      || submittedDraft.processedQuantity !== (existing?.processedQuantity == null ? "" : String(existing.processedQuantity))
      || submittedDraft.completedQuantity !== (existing?.completedQuantity == null ? "" : String(existing.completedQuantity));
    if (!changed) {
      setTaskDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
      return;
    }
    if ([actualMinutes, processedQuantity, completedQuantity].some(value => value !== null && (!Number.isFinite(value) || value < 0))) {
      setError(text("Enter nonnegative numbers for time and quantities.", "時間と数量は0以上の数値で入力してください。")); return;
    }
    if (processedQuantity !== null && completedQuantity !== null && completedQuantity > processedQuantity) {
      setError(text("Completed quantity cannot exceed processed quantity.", "完了数量は処理数量を超えられません。")); return;
    }
    if (!navigator.onLine) {
      setError(text("Offline. This edit is saved on this tablet and will sync when you reconnect.", "オフラインです。この変更は端末に保存され、再接続後に同期します。")); return;
    }
    if (pendingWrites.current.has(key)) return;
    pendingWrites.current.add(key);
    setSaving(previous => new Set(previous).add(key));
    setError("");
    try {
      const saved = await saveProductionTask({
        existingId: draft.baseVersion == null ? undefined : existing?.id,
        completedAt: existing?.completedAt,
        expectedVersion: submittedDraft.baseVersion ?? undefined,
        requestId: submittedDraft.requestId,
        orderId,
        operationId,
        status: submittedDraft.status,
        actualMinutes,
        actualTimeBasis: submittedDraft.actualTimeBasis ?? "per_unit",
        processedQuantity,
        completedQuantity,
        operatorId: profile.id,
      });
      setTasks(previous => [...previous.filter(task => !(task.orderId === orderId && task.operationId === operationId)), saved]);
      setTaskDrafts(previous => {
        if (JSON.stringify(previous[key]) !== JSON.stringify(submittedDraft)) return previous;
        const next = { ...previous }; delete next[key]; return next;
      });
    } catch (failure) {
      if (failure instanceof StaleProductionTaskError) {
        if (failure.latest) setTasks(previous => [...previous.filter(task => !(task.orderId === orderId && task.operationId === operationId)), failure.latest!]);
        setTaskDrafts(previous => ({ ...previous, [key]: { ...submittedDraft, conflict: true, baseVersion: failure.latest?.version ?? null } }));
      }
      setError(friendlyNetworkMessage(failure, lang));
    } finally {
      pendingWrites.current.delete(key);
      setSaving(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  };

  useEffect(() => {
    const retry = () => setRetryPulse(value => value + 1);
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => { window.removeEventListener("online", retry); window.removeEventListener("focus", retry); };
  }, []);

  useEffect(() => {
    if (!loaded || !navigator.onLine) return;
    for (const [key, draft] of Object.entries(taskDrafts)) {
      if (draft.conflict || !draft.readyToSave || pendingWrites.current.has(key)) continue;
      const [orderId, operationId] = key.split("\u0000");
      if (orderId && operationId) void persistTaskDraft(orderId, operationId, draft, taskByKey.get(key));
    }
  // Retry only on app load, focus, or reconnection. A failed request stays queued without a tight retry loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, retryPulse]);

  const addOperation = async () => {
    if (!newName.trim() || newName.trim().toLocaleLowerCase() === "full machining" || newNameJa.trim() === "全加工") {
      setError(text("The protected Full machining name is reserved.", "『全加工』の名称は予約されています。"));
      return;
    }
    setError("");
    try {
      await createManufacturingOperation({
        operationName: newName,
        operationNameJa: newNameJa,
        defaultMinutes: newMinutes === "" ? null : Math.max(0, Number(newMinutes)),
        baseTimeChargeJpy: Math.max(0, Number(newCharge) || 0),
        sequence: (operations.at(-1)?.sequence ?? 0) + 10,
      });
      setNewName(""); setNewNameJa(""); setNewMinutes(""); setNewCharge("");
      load();
    } catch (failure) {
      setError(friendlyNetworkMessage(failure, lang));
    }
  };

  const saveOperationCharge = async (operation: ManufacturingOperation, value: string) => {
    if (isProtectedOperation(operation)) return;
    const charge = Number(value);
    if (!Number.isFinite(charge) || charge < 0 || charge === operation.baseTimeChargeJpy) return;
    setError("");
    try {
      await updateManufacturingOperationCharge(operation.id, operation.version, charge);
      setOperations(previous => previous.map(row => row.id === operation.id ? { ...row, baseTimeChargeJpy: charge, version: row.version + 1 } : row));
    } catch (failure) {
      setError(friendlyNetworkMessage(failure, lang));
    }
  };

  const saveOperationMinutes = async (operation: ManufacturingOperation, value: string) => {
    if (isProtectedOperation(operation)) return;
    const trimmed = value.trim();
    const minutes = trimmed === "" ? null : Number(trimmed);
    if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
      setError(text("Enter a positive standard time or leave it blank.", "0以上の標準時間を入力するか、空欄にしてください。"));
      return;
    }
    if (minutes === operation.defaultMinutes) return;
    setError("");
    try {
      await updateManufacturingOperationDefaultMinutes(operation.id, operation.version, minutes);
      setOperations(previous => previous.map(row => row.id === operation.id ? { ...row, defaultMinutes: minutes, version: row.version + 1 } : row));
    } catch (failure) {
      setError(friendlyNetworkMessage(failure, lang));
      load();
    }
  };

  const saveOperationName = async (operation: ManufacturingOperation, name: string, nameJa: string) => {
    const trimmedName = name.trim();
    const trimmedNameJa = nameJa.trim();
    if (!trimmedName || (trimmedName === operation.operationName && trimmedNameJa === operation.operationNameJa)) return;
    const confirmed = await dialog.confirm(text("This changes the process name in every product route that uses it. Continue?", "この工程を使うすべての製品ルートの名称が変わります。続けますか？"), { title: text("Change process name", "工程名を変更") });
    if (!confirmed) { load(); return; }
    setError("");
    try {
      await updateManufacturingOperationName(operation.id, operation.version, trimmedName, trimmedNameJa);
      setOperations(previous => previous.map(row => row.id === operation.id
        ? { ...row, operationName: trimmedName, operationNameJa: trimmedNameJa, version: row.version + 1 }
        : row));
    } catch (failure) {
      setError(friendlyNetworkMessage(failure, lang));
      load();
    }
  };

  const isProtectedOperation = (operation: ManufacturingOperation) =>
    operation.operationCode === "FULL_MACHINING"
    || operation.operationName.trim().toLocaleLowerCase() === "full machining"
    || operation.operationNameJa.trim() === "全加工";

  return (
    <AppShell onNavigate={onNavigate} title={text("Production Stage Progress", "製作工程進捗")} activePage="production-progress" showBack backTarget="home" backLabel={text("Home", "ホーム")} lang={lang} setLang={setLang}>
      <main className="page-enter flex-1 overflow-y-auto bg-[#f5f6f8] p-3 sm:p-5">
        <PageContainer className="space-y-4">
          <section className="rounded-sm border border-slate-200 bg-white p-4">
              {(focusOrder || focusProductId) && <div className="mb-3 flex items-center justify-between rounded bg-sky-50 px-3 py-2 text-sm text-sky-900"><span>{text("Showing matching production orders", "該当する製造受注を表示しています")}</span><button type="button" onClick={() => { setFocusOrder(""); setSearch(""); onNavigate("production-progress"); }} className="font-700 underline">{text("Show all orders", "すべての受注を表示")}</button></div>}
            {Object.keys(taskDrafts).length > 0 && <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><span>{text(`${Object.keys(taskDrafts).length} progress edits are saved on this tablet.`, `進捗の未同期変更 ${Object.keys(taskDrafts).length} 件を端末に保存しています。`)}</span><button type="button" onClick={() => setRetryPulse(value => value + 1)} disabled={!navigator.onLine || Object.values(taskDrafts).every(draft => draft.conflict || !draft.readyToSave)} className="font-700 underline disabled:opacity-50">{text("Sync saved edits", "保存済み変更を同期")}</button></div>}
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h1 className="text-xl font-700 text-[#1a3458]">{text("Production Stage Progress", "製作工程進捗")}</h1>
                <div className="mt-2 flex items-center gap-2 text-sm text-slate-600"><span>{text("Enter actual minutes and quantities inside each process cell. These values update progress and WIP.", "各工程欄に実績分数と数量を入力します。入力値は進捗とWIPに反映されます。")}</span><HelpDialog title={text("What do I enter here?", "ここに何を入力しますか？")} description={text("Planned time is the standard minutes per item multiplied by the order quantity. Enter actual minutes, processed quantity, and completed quantity in the process cell. Actual values show work already done and affect WIP. They do not change the standard time.", "予定時間は標準分数に注文数量を掛けた値です。工程欄に実績分数、処理数量、完了数量を入力します。実績値は作業済みの内容としてWIPに反映されます。標準分数は変更しません。")} lang={lang} /></div>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(15rem,1fr)_12rem]">
                <label className="text-sm font-600 text-slate-600">{text("Search", "検索")}
                  <input value={search} onChange={event => setSearch(event.target.value)} placeholder={text("Search order, product, drawing no. or customer", "注文番号・製品名・図番・取引先を検索")} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <label className="text-sm font-600 text-slate-600">{text("Order status", "受注状態")}
                  <select value={orderStatus} onChange={event => setOrderStatus(event.target.value)} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 font-normal">
                    <option value="all">{text("All statuses", "すべて")}</option>
                    {orderStatuses.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                </label>
              </div>
            </div>
          </section>

          <section aria-label={text("Production summary", "製造進捗の概要")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {[
              [text("Orders shown", "表示中の受注"), filteredOrders.length, "text-[#1a3458]"],
              [text("Tracked production orders", "追跡中の製造受注"), productionTaskSummary.orders, "text-[#1a3458]"],
              [text("Completed stages", "完了工程"), productionTaskSummary.completed, "text-emerald-700"],
              [text("Active stages", "作業中の工程"), productionTaskSummary.active, "text-amber-700"],
              [text("Issues", "問題"), productionTaskSummary.issues, productionTaskSummary.issues ? "text-red-700" : "text-slate-700"],
            ].map(([label, value, color]) => <div key={String(label)} className="rounded-sm border border-slate-200 bg-white px-4 py-3"><p className="text-xs font-600 text-slate-500">{label}</p><p className={`mt-1 min-h-8 text-2xl font-700 ${color}`}>{!loaded && loading ? <span className="skeleton-block inline-block h-7 w-12 align-middle" /> : value}</p></div>)}
          </section>

          {profile.role === "administrator" && (
            <section className="rounded border border-slate-200 bg-white p-4">
              <div className="flex w-full items-center gap-3"><button type="button" aria-expanded={catalogExpanded} onClick={() => setCatalogExpanded(value => !value)} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-left"><span className="min-w-0 flex-1"><span className="block font-700 text-[#1a3458]">{text("Process catalog & time charges", "工程カタログ・時間単価")}</span><span className="block text-sm text-slate-600">{text("Stages and planned time used by production orders", "製造指図で使う工程と予定時間")}</span></span><span className="shrink-0 rounded border px-3 py-2 text-sm font-700 text-[#1a3458]">{catalogExpanded ? text("Close", "閉じる") : text("View settings", "設定を見る")}</span></button><HelpDialog title={text("Process catalog & time charges", "工程カタログ・時間単価")} description={text("This catalog controls which production stages appear for each product. Standard minutes set planned time per item. The hourly rate is used for WIP cost calculation.\n\nKeep the process name matched to the product process.", "製品ごとに表示する製造工程を登録します。標準分数は1個あたりの予定時間です。時間単価はWIP原価の計算に使います。\n\n工程名は製品の工程と一致させてください。") } lang={lang} /></div>
              {catalogExpanded && <div className="mt-4 border-t pt-4">
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="border-b border-slate-200 text-left text-xs text-slate-500"><tr><th className="px-3 py-2">{text("Process name", "工程名")}</th><th className="px-3 py-2">{text("Standard min/unit", "標準分/個")}</th><th className="px-3 py-2">{text("Time charge (JPY/hour)", "時間単価（円/時）")}</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{operations.map(operation => <tr key={operation.id}><td className="px-3 py-2"><div className="flex min-w-64 gap-2"><input aria-label={text("Process name", "工程名")} key={`${operation.id}:name:${operation.version}`} defaultValue={operation.operationName} disabled={isProtectedOperation(operation)} onBlur={event => void saveOperationName(operation, event.target.value, operation.operationNameJa)} className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 disabled:bg-slate-100" />{lang === "ja" && <input aria-label={text("Japanese process name", "工程名（日本語）")} key={`${operation.id}:ja:${operation.version}`} defaultValue={operation.operationNameJa} disabled={isProtectedOperation(operation)} onBlur={event => void saveOperationName(operation, operation.operationName, event.target.value)} className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 disabled:bg-slate-100" />}</div>{isProtectedOperation(operation) && <span className="text-xs text-slate-500">{text("Summary only", "サマリーのみ")}</span>}</td><td className="px-3 py-2"><label className="flex items-center gap-2"><span className="sr-only">{text("Standard minutes per item", "1個あたり標準分数")}</span><input key={`${operation.id}:minutes:${operation.version}`} type="number" min="0" step="0.1" placeholder="-" defaultValue={operation.defaultMinutes ?? ""} disabled={isProtectedOperation(operation)} onBlur={event => void saveOperationMinutes(operation, event.target.value)} className="w-32 rounded border border-slate-300 px-3 py-2 text-right font-mono disabled:bg-slate-100" /></label></td><td className="px-3 py-2"><label className="flex items-center gap-2"><span className="sr-only">{text("JPY per hour", "円/時")}</span><input key={`${operation.id}:${operation.baseTimeChargeJpy}:${operation.version}`} type="number" min="0" step="1" defaultValue={operation.baseTimeChargeJpy} disabled={isProtectedOperation(operation)} onBlur={event => void saveOperationCharge(operation, event.target.value)} className="w-36 rounded border border-slate-300 px-3 py-2 text-right font-mono disabled:bg-slate-100" /><span className="text-xs text-slate-500">JPY/h</span></label></td></tr>)}</tbody>
                </table>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_10rem_12rem_auto]">
                <label className="text-sm font-600 text-slate-600">{text("Process name", "工程名")}<input value={newName} onChange={event => setNewName(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                {lang === "ja" && <label className="text-sm font-600 text-slate-600">{text("Process name (Japanese)", "工程名（日本語）")}<input value={newNameJa} onChange={event => setNewNameJa(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>}
                <label className="text-sm font-600 text-slate-600">{text("Default min/unit", "標準分/個")}<input type="number" min="0" step="0.1" value={newMinutes} onChange={event => setNewMinutes(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <label className="text-sm font-600 text-slate-600">{text("Time charge (JPY/hour)", "時間単価（円/時）")}<input type="number" min="0" step="1" value={newCharge} onChange={event => setNewCharge(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <button disabled={!newName.trim()} onClick={() => void addOperation()} className="self-end rounded bg-[#1a3458] px-4 py-2.5 font-700 text-white disabled:opacity-40">{text("Add process", "工程を追加")}</button>
              </div>
              </div>}
            </section>
          )}

          {error && <div role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <section className="overflow-hidden rounded-sm border border-slate-200 bg-white">
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead className="sticky top-0 z-20 bg-[#1a3458] text-white">
                  <tr>
                    <th className="sticky left-0 z-30 w-64 min-w-64 max-w-64 border-r border-white/20 bg-[#1a3458] px-4 py-3 text-left">{text("Order / product", "受注・製品")}</th>
                    {visibleRealOperations.map(operation => <th key={operation.id} className="w-60 min-w-60 border-r border-white/20 px-3 py-3 text-left"><span className="block font-700">{lang === "ja" && operation.operationNameJa ? operation.operationNameJa : operation.operationName}</span><span className="mt-0.5 block text-xs font-normal text-white/70">{operation.defaultMinutes == null ? text("Standard time not set", "標準時間未設定") : `${operation.defaultMinutes} ${text("min/unit", "分/個")}`}</span></th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading && !loaded && Array.from({ length: 4 }, (_, row) => <tr key={`loading-production-${row}`} aria-hidden="true"><td colSpan={visibleRealOperations.length + 1} className="p-0"><div className="grid items-center gap-3 border-b border-slate-100 px-4 py-3" style={{ gridTemplateColumns: `minmax(16rem, 1.1fr) repeat(${Math.max(1, visibleRealOperations.length)}, minmax(10rem, 1fr))` }}><div className="space-y-2"><div className="skeleton-block h-3 w-2/5" /><div className="skeleton-block h-4 w-3/4" /><div className="skeleton-block h-3 w-1/2" /></div>{visibleRealOperations.length ? visibleRealOperations.map(operation => <div key={operation.id} className="space-y-2"><div className="skeleton-block h-3 w-4/5" /><div className="skeleton-block h-9 w-full" /><div className="skeleton-block h-8 w-full" /></div>) : <div className="skeleton-block h-8 w-full" />}</div></td></tr>)}
                  {(loading && !loaded ? [] : visibleOrders).map(order => {
                    const product = (order.productId ? productById.get(order.productId) : productByKey.get(`${order.client}\u0000${order.productName}`));
                    const route = operationsByOrder.get(order.id);
                    return <tr key={order.id}>
                      <th className="sticky left-0 z-10 w-64 min-w-64 max-w-64 border-r border-slate-200 bg-white px-4 py-3 text-left align-top shadow-[3px_0_4px_-4px_rgba(15,23,42,.45)]">
                        <span className="block font-mono text-xs text-slate-500">{order.orderNumber} · {order.deliveryDate}</span>
                        <span className="mt-1 block font-700 text-slate-800">{order.productName}</span>
                        <span className="block font-mono text-xs text-slate-500">{product?.productNumber || "-"}{product?.internalCompanyName ? ` · ${product.internalCompanyName}` : ""}</span>
                        <span className="mt-1 inline-block"><StatusBadge status={order.progress} small lang={lang} /></span>
                        <span className="mt-2 block text-xs text-slate-600">{text(`Qty: ${order.quantity} · ${order.client}`, `数量: ${order.quantity} · ${order.client}`)}</span>
                        <span className={`mt-2 block rounded border px-2 py-1 text-xs ${STATUS_CLASS[fullMachiningStatusByOrder.get(order.id) ?? "pending"]}`}>
                          {text("Full machining summary", "全加工サマリー")}: {text(({ pending: "Not started", in_progress: "In progress", completed: "Complete", issue: "Issue" } as const)[fullMachiningStatusByOrder.get(order.id) ?? "pending"], ({ pending: "未着手", in_progress: "作業中", completed: "完了", issue: "問題" } as const)[fullMachiningStatusByOrder.get(order.id) ?? "pending"])}
                        </span>
                      </th>
                      {visibleRealOperations.map(operation => {
                        const key = `${order.id}\u0000${operation.id}`;
                        if (!productionOrderIds.has(order.id)) return <td key={operation.id} className="border-r border-slate-200 bg-slate-50 p-2 text-center align-middle text-xs text-slate-500">{text("Progress starts in production", "製作開始後に進捗を記録")}</td>;
                        if (!route?.has(operation.id)) return <td key={operation.id} className="border-r border-slate-200 bg-slate-100 p-2 text-center align-middle text-xs font-700 text-slate-500">{text("N/A", "対象外")}</td>;
                        const task = taskByKey.get(key);
                        const draft = taskDrafts[key];
                        const status = draft?.status ?? task?.status ?? "pending";
                        const standardMinutes = route.get(operation.id) ?? operation.defaultMinutes;
                        const actualBasis = draft?.actualTimeBasis ?? task?.actualTimeBasis ?? "per_unit";
                        const setDraftField = (field: "actualMinutes" | "processedQuantity" | "completedQuantity", value: string) => {
                          setTaskDrafts(previous => {
                            const current = previous[key] ?? draftFromTask(task);
                            return { ...previous, [key]: { ...current, [field]: value, requestId: "", readyToSave: false } };
                          });
                        };
                        return <td key={operation.id} className={`border-r border-slate-200 p-2 align-top ${STATUS_CLASS[status]}`}>
                          <p className="mb-2 text-xs text-slate-700">{standardMinutes == null ? text("Standard time not set", "標準時間未設定") : `${standardMinutes} ${text("min/unit", "分/個")} × ${order.quantity} = ${standardMinutes * order.quantity} ${text("min planned", "分（計画）")}`}</p>
                          {draft?.conflict && <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800"><p>{text("Another tablet saved this stage first. Review the latest value before applying your edit.", "別の端末で先に保存されました。最新の値を確認してから変更を適用してください。")}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={!task} onClick={() => void persistTaskDraft(order.id, operation.id, { ...draft, baseVersion: task?.version ?? null, conflict: false, readyToSave: true }, task)} className="font-700 underline disabled:opacity-50">{text("Apply my edit", "自分の変更を適用")}</button><button type="button" onClick={() => setTaskDrafts(previous => { const next = { ...previous }; delete next[key]; return next; })} className="font-700 underline">{text("Use latest value", "最新の値を使う")}</button></div></div>}
                          <select aria-label={`${operation.operationName} status for ${order.orderNumber}`} disabled={saving.has(key) || draft?.conflict} value={status} onChange={event => void persistTaskDraft(order.id, operation.id, { ...(draft ?? draftFromTask(task)), status: event.target.value as ProductionTaskStatus, requestId: "", readyToSave: true }, task)} className="w-full rounded border border-black/10 bg-white/70 px-2 py-2 font-700 disabled:opacity-50">
                            {STATUS_ORDER.map(value => <option key={value} value={value}>{text(({ pending: "Not started", in_progress: "In progress", completed: "Completed", issue: "Issue" } as const)[value], ({ pending: "未着手", in_progress: "作業中", completed: "完了", issue: "問題" } as const)[value])}</option>)}
                          </select>
                          <label className="mt-2 block text-xs font-600 opacity-80">{text(actualBasis === "per_batch" ? "Actual min/batch (legacy)" : "Actual min/unit", actualBasis === "per_batch" ? "実績分/バッチ（旧記録）" : "実績分/個")}
                            <input type="number" min="0" step="0.1" disabled={saving.has(key) || draft?.conflict} value={draft?.actualMinutes ?? (task?.actualMinutes == null ? "" : String(task.actualMinutes))} placeholder="-" onChange={event => setDraftField("actualMinutes", event.target.value)} onBlur={event => { const next = { ...(taskDrafts[key] ?? draftFromTask(task)), actualMinutes: event.currentTarget.value }; void persistTaskDraft(order.id, operation.id, next, task); }} className="mt-1 w-full rounded border border-black/10 bg-white/70 px-2 py-1.5 font-mono disabled:opacity-50" />
                          </label>
                          {actualBasis === "per_batch" && <p className="mt-1 text-xs text-slate-600">{text("This older value is kept as batch time.", "旧記録はバッチ単位のまま保持します。")}</p>}
                          {task?.actualMinutes != null && task.actualTimeBasis === "per_batch" && <p className="mt-2 text-xs text-amber-800">{text("Legacy batch total", "旧記録のバッチ合計")}: {actualBatchMinutes(task.actualMinutes, "per_batch", task.processedQuantity ?? order.quantity)} {text("min/batch", "分/バッチ")}</p>}
                          {(["processedQuantity", "completedQuantity"] as const).map(field => <label key={field} className="mt-2 block text-xs font-600">
                            {field === "processedQuantity" ? text("Processed quantity", "処理数量") : text("Completed quantity", "完了数量")}
                            <input type="number" min="0" step="0.001" value={draft?.[field] ?? (task?.[field] == null ? "" : String(task[field]))} disabled={saving.has(key) || draft?.conflict} onChange={event => setDraftField(field, event.target.value)} onBlur={event => { const next = { ...(taskDrafts[key] ?? draftFromTask(task)), [field]: event.currentTarget.value }; void persistTaskDraft(order.id, operation.id, next, task); }} className="mt-1 min-h-11 w-full rounded-sm border border-black/10 bg-white px-2 py-2 font-mono disabled:opacity-50" />
                          </label>)}
                          {draft && !draft.conflict && <p className={`mt-2 text-xs ${draft.readyToSave ? "text-amber-800" : "text-slate-500"}`}>{draft.readyToSave ? text("Saved on this tablet; waiting to sync.", "端末に保存済み。同期待ちです。") : text("Draft saved on this tablet.", "入力中の内容を端末に保存しています。")}</p>}
                        </td>;
                      })}
                    </tr>;
                  })}
                  {loaded && filteredOrders.length === 0 && <tr><td colSpan={visibleRealOperations.length + 1} className="px-6 py-12 text-center text-slate-500">{text("No matching orders.", "該当する受注がありません。")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          {filteredOrders.length > pageSize && <nav aria-label={text("Production orders pages", "受注ページ")} className="flex items-center justify-end gap-3 text-sm">
            <button type="button" disabled={page === 0} onClick={() => setPage(current => Math.max(0, current - 1))} className="rounded border border-slate-300 bg-white px-3 py-2 disabled:opacity-40">{text("Previous", "前へ")}</button>
            <span className="tabular-nums text-slate-600">{page + 1} / {pageCount}</span>
            <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))} className="rounded border border-slate-300 bg-white px-3 py-2 disabled:opacity-40">{text("Next", "次へ")}</button>
          </nav>}
        </PageContainer>
      </main>
    </AppShell>
  );
}
