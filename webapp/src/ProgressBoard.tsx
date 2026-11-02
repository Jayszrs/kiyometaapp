import { useEffect, useMemo, useState } from "react";
import { AppShell, type DeliverySlipMode, type Lang, type OrderRecord, type Page, type Product } from "./App";
import { useAuth } from "./lib/auth";
import { supabase } from "./lib/supabaseClient";
import { useReadRefresh } from "./lib/useReadRefresh";
import {
  createManufacturingOperation,
  fetchManufacturingProgress,
  saveProductionTask,
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
}

const STATUS_ORDER: ProductionTaskStatus[] = ["pending", "in_progress", "completed", "issue"];
const STATUS_CLASS: Record<ProductionTaskStatus, string> = {
  pending: "border-slate-200 bg-slate-100 text-slate-700",
  in_progress: "border-amber-300 bg-amber-100 text-amber-900",
  completed: "border-emerald-300 bg-emerald-100 text-emerald-900",
  issue: "border-red-300 bg-red-100 text-red-900",
};

export default function ProgressBoard({ orders, products, onNavigate, lang, setLang }: Props) {
  const { profile } = useAuth();
  const text = (en: string, ja: string) => lang === "ja" ? ja : en;
  const [operations, setOperations] = useState<ManufacturingOperation[]>([]);
  const [tasks, setTasks] = useState<ProductionTaskProgress[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [orderStatus, setOrderStatus] = useState("all");
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [minuteDrafts, setMinuteDrafts] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newNameJa, setNewNameJa] = useState("");
  const [newMinutes, setNewMinutes] = useState("");
  const [newCharge, setNewCharge] = useState("");

  const load = useReadRefresh(
    signal => fetchManufacturingProgress(signal),
    data => { setOperations(data.operations); setTasks(data.tasks); setError(""); },
    failure => setError(failure instanceof Error ? failure.message : String(failure)),
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
    void channel.subscribe();
    return () => {
      window.clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const productByKey = useMemo(
    () => new Map(products.map(product => [`${product.clientName}\u0000${product.productName}`, product])),
    [products],
  );
  const taskByKey = useMemo(
    () => new Map(tasks.map(task => [`${task.orderId}\u0000${task.operationId}`, task])),
    [tasks],
  );
  const orderStatuses = useMemo(() => Array.from(new Set(orders.map(order => order.progress))).sort(), [orders]);
  const filteredOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orders.filter(order => {
      if (orderStatus !== "all" && order.progress !== orderStatus) return false;
      if (!query) return true;
      const product = productByKey.get(`${order.client}\u0000${order.productName}`);
      return [order.orderNumber, order.productName, order.client, product?.productNumber, product?.internalCompanyName]
        .some(value => String(value ?? "").toLowerCase().includes(query));
    }).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.orderNumber.localeCompare(b.orderNumber));
  }, [orderStatus, orders, productByKey, search]);

  const persistTask = async (orderId: string, operationId: string, status: ProductionTaskStatus, actualMinutes: number | null) => {
    const key = `${orderId}\u0000${operationId}`;
    const existing = taskByKey.get(key);
    setSaving(previous => new Set(previous).add(key));
    setError("");
    try {
      const saved = await saveProductionTask({
        existingId: existing?.id,
        orderId,
        operationId,
        status,
        actualMinutes,
        operatorId: profile.id,
      });
      setTasks(previous => [...previous.filter(task => !(task.orderId === orderId && task.operationId === operationId)), saved]);
      setMinuteDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  };

  const addOperation = async () => {
    if (!newName.trim()) return;
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
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <AppShell onNavigate={onNavigate} title={text("Production Stage Progress", "製作工程進捗")} activePage="production-progress" showBack backTarget="home" backLabel={text("Home", "ホーム")} lang={lang} setLang={setLang}>
      <main className="page-enter flex-1 overflow-y-auto bg-[#f5f6f8] p-3 sm:p-5">
        <div className="mx-auto max-w-[1600px] space-y-4">
          <section className="rounded-sm border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <h1 className="text-xl font-700 text-[#1a3458]">{text("Production Stage Progress", "製作工程進捗")}</h1>
                <p className="mt-1 text-sm text-slate-500">{text("Track each order across reusable manufacturing processes. Status and actual minutes are saved per order.", "受注ごとに製造工程の状態と実績時間を記録します。")}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(15rem,1fr)_12rem]">
                <label className="text-sm font-600 text-slate-600">{text("Search", "検索")}
                  <input value={search} onChange={event => setSearch(event.target.value)} placeholder={text("Order, product, drawing no., internal name", "注文番号・製品名・図番・社内名称")} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" />
                </label>
                <label className="text-sm font-600 text-slate-600">{text("Order status", "受注状態")}
                  <select value={orderStatus} onChange={event => setOrderStatus(event.target.value)} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 font-normal">
                    <option value="all">{text("All statuses", "すべて")}</option>
                    {orderStatuses.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs font-700">
              {STATUS_ORDER.map(status => <span key={status} className={`rounded border px-2.5 py-1 ${STATUS_CLASS[status]}`}>{text(({ pending: "Not started", in_progress: "In progress", completed: "Completed", issue: "Issue" } as const)[status], ({ pending: "未着手", in_progress: "作業中", completed: "完了", issue: "問題" } as const)[status])}</span>)}
              <span className="ml-auto self-center text-slate-500">{loading ? text("Refreshing…", "更新中…") : `${filteredOrders.length} ${text("orders", "件")} · ${operations.length} ${text("processes", "工程")}`}</span>
            </div>
          </section>

          {profile.role === "administrator" && (
            <details className="rounded-sm border border-slate-200 bg-white p-4">
              <summary className="cursor-pointer font-700 text-[#1a3458]">{text("Add manufacturing process", "製造工程を追加")}</summary>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_10rem_12rem_auto]">
                <label className="text-sm font-600 text-slate-600">{text("Process name", "工程名（英語）")}<input value={newName} onChange={event => setNewName(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <label className="text-sm font-600 text-slate-600">{text("Japanese name", "工程名（日本語）")}<input value={newNameJa} onChange={event => setNewNameJa(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <label className="text-sm font-600 text-slate-600">{text("Default min/unit", "標準分/個")}<input type="number" min="0" step="0.1" value={newMinutes} onChange={event => setNewMinutes(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <label className="text-sm font-600 text-slate-600">{text("Time charge (JPY/hour)", "時間単価（円/時）")}<input type="number" min="0" step="1" value={newCharge} onChange={event => setNewCharge(event.target.value)} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 font-normal" /></label>
                <button disabled={!newName.trim()} onClick={() => void addOperation()} className="self-end rounded bg-[#1a3458] px-4 py-2.5 font-700 text-white disabled:opacity-40">{text("Add process", "工程を追加")}</button>
              </div>
            </details>
          )}

          {error && <div role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          <section className="overflow-hidden rounded-sm border border-slate-200 bg-white">
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="min-w-max border-collapse text-sm">
                <thead className="sticky top-0 z-20 bg-[#1a3458] text-white">
                  <tr>
                    <th className="sticky left-0 z-30 min-w-[17rem] border-r border-white/20 bg-[#1a3458] px-4 py-3 text-left">{text("Order / product", "受注・製品")}</th>
                    {operations.map(operation => <th key={operation.id} className="w-48 min-w-48 border-r border-white/20 px-3 py-3 text-left"><span className="block font-700">{lang === "ja" && operation.operationNameJa ? operation.operationNameJa : operation.operationName}</span><span className="mt-0.5 block text-xs font-normal text-white/70">{operation.defaultMinutes == null ? text("No standard time", "標準時間なし") : `${operation.defaultMinutes} ${text("min/unit", "分/個")}`}</span></th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredOrders.map(order => {
                    const product = productByKey.get(`${order.client}\u0000${order.productName}`);
                    return <tr key={order.id}>
                      <th className="sticky left-0 z-10 border-r border-slate-200 bg-white px-4 py-3 text-left align-top shadow-[3px_0_4px_-4px_rgba(15,23,42,.45)]">
                        <span className="block font-mono text-xs text-slate-500">{order.orderNumber} · {order.deliveryDate}</span>
                        <span className="mt-1 block font-700 text-slate-800">{order.productName}</span>
                        <span className="block font-mono text-xs text-slate-500">{product?.productNumber || "-"}{product?.internalCompanyName ? ` · ${product.internalCompanyName}` : ""}</span>
                        <span className="mt-1 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{order.progress}</span>
                      </th>
                      {operations.map(operation => {
                        const key = `${order.id}\u0000${operation.id}`;
                        const task = taskByKey.get(key);
                        const status = task?.status ?? "pending";
                        return <td key={operation.id} className={`border-r border-slate-200 p-2 align-top ${STATUS_CLASS[status]}`}>
                          <select aria-label={`${operation.operationName} status for ${order.orderNumber}`} disabled={saving.has(key)} value={status} onChange={event => void persistTask(order.id, operation.id, event.target.value as ProductionTaskStatus, task?.actualMinutes ?? operation.defaultMinutes)} className="w-full rounded border border-black/10 bg-white/70 px-2 py-2 font-700 disabled:opacity-50">
                            {STATUS_ORDER.map(value => <option key={value} value={value}>{text(({ pending: "Not started", in_progress: "In progress", completed: "Completed", issue: "Issue" } as const)[value], ({ pending: "未着手", in_progress: "作業中", completed: "完了", issue: "問題" } as const)[value])}</option>)}
                          </select>
                          <label className="mt-2 block text-xs font-600 opacity-80">{text("Actual min", "実績分")}
                            <input type="number" min="0" step="0.1" disabled={saving.has(key)} value={minuteDrafts[key] ?? (task?.actualMinutes == null ? "" : String(task.actualMinutes))} placeholder={operation.defaultMinutes == null ? "-" : String(operation.defaultMinutes)} onChange={event => setMinuteDrafts(previous => ({ ...previous, [key]: event.target.value }))} onBlur={event => { const value = event.target.value === "" ? null : Math.max(0, Number(event.target.value)); if (value !== (task?.actualMinutes ?? null)) void persistTask(order.id, operation.id, status, value); }} className="mt-1 w-full rounded border border-black/10 bg-white/70 px-2 py-1.5 font-mono disabled:opacity-50" />
                          </label>
                        </td>;
                      })}
                    </tr>;
                  })}
                  {filteredOrders.length === 0 && <tr><td colSpan={operations.length + 1} className="px-6 py-12 text-center text-slate-500">{text("No matching orders.", "該当する受注がありません。")}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
