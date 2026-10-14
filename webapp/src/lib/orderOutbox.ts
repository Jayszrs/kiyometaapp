import type { OrderRecord } from "../App";
import { supabase } from "./supabaseClient";
import { submitOrderOnce, StaleOrderError } from "./db";
import { genUUID } from "./uuid";
import { readRecovery, writeRecovery } from "./recoveryStorage";

export interface PendingOrder {
  requestId: string;
  order: OrderRecord;
  state: "pending" | "blocked";
  message?: string;
}
export class QueuedOrderError extends Error {
  constructor() { super("Submission saved on this device. It will retry when connected or when the app reopens."); }
}
export const pendingOrders = (owner: string) => readRecovery<PendingOrder[]>(owner, "outbox") ?? [];
const notify = () => window.dispatchEvent(new Event("kiyometa-outbox"));
function store(owner: string, items: PendingOrder[]) { writeRecovery(owner, "outbox", items); notify(); }
export function discardSubmission(owner: string, requestId: string) {
  store(owner, pendingOrders(owner).filter(item => item.requestId !== requestId));
}
const flights = new Map<string, Promise<OrderRecord>>();
export function isRetryable(error: unknown): boolean {
  if (error instanceof StaleOrderError) return false;
  const e = error as { code?: string; status?: number; message?: string };
  if (e?.code && /^(22|23|28|42|P0)/.test(e.code)) return false;
  if ((e?.status ?? 0) >= 500 || /^PGRST00[012]$/.test(e?.code ?? "")) return true;
  if (e?.code?.startsWith("PGRST")) return false;
  return error instanceof TypeError || (e?.status ?? 0) >= 500 ||
    /network|fetch|connection|timeout|timed out|abort/i.test(e?.message ?? "");
}
async function deliver(owner: string, item: PendingOrder): Promise<OrderRecord> {
  const key = `${owner}:${item.requestId}`;
  if (flights.has(key)) return flights.get(key)!;
  const flight = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user.id !== owner || !navigator.onLine) throw new QueuedOrderError();
      const saved = await submitOrderOnce(item.requestId, item.order, owner);
      for (const slot of ["entry-form", "search-form", "schedule-form", `checklist-form-${item.order.id}`]) {
        const draft = readRecovery<OrderRecord | null>(owner, slot);
        if (draft?.id === item.order.id && draft.version === item.order.version) {
          writeRecovery(owner, slot, JSON.stringify(draft) === JSON.stringify(item.order) ? saved : { ...draft, version: saved.version });
          if (slot === "entry-form") {
            writeRecovery(owner, "entry-new", false);
            writeRecovery(owner, "entry-selection", saved.id);
          }
        }
      }
      discardSubmission(owner, item.requestId);
      window.dispatchEvent(new CustomEvent("kiyometa-order-saved", { detail: { owner, submitted: item.order, saved } }));
      return saved;
    } catch (error) {
      if (error instanceof QueuedOrderError || isRetryable(error)) throw new QueuedOrderError();
      store(owner, pendingOrders(owner).map(entry => entry.requestId === item.requestId
        ? { ...entry, state: "blocked", message: error instanceof Error ? error.message : (error as {message?: string})?.message || "Could not save order." }
        : entry));
      throw error;
    }
  })();
  flights.set(key, flight);
  try { return await flight; } finally { flights.delete(key); }
}
export async function saveOrderDurably(order: OrderRecord, owner: string): Promise<OrderRecord> {
  if (!owner) throw new Error("Sign in before submitting.");
  const items = pendingOrders(owner);
  let item = items.find(entry => entry.order.id === order.id);
  if (item) {
    if (JSON.stringify(item.order) !== JSON.stringify(order) || item.state === "blocked")
      throw new Error("An earlier submission for this order needs review. Open Pending submissions before submitting these edits.");
  } else {
    if (items.length >= 100) throw new Error("Too many pending submissions. Connect and sync before submitting more orders.");
    item = { requestId: genUUID(), order: structuredClone(order), state: "pending" };
    // Do not send anything if durable storage fails.
    store(owner, [...items, item]);
  }
  return deliver(owner, item);
}
export async function syncOrders(owner: string): Promise<void> {
  for (const item of pendingOrders(owner)) {
    if (item.state === "blocked") continue;
    try { await deliver(owner, item); }
    catch (error) { if (error instanceof QueuedOrderError) break; }
  }
}

export async function retryReviewedSubmission(owner: string, requestId: string, reviewed: OrderRecord): Promise<OrderRecord> {
  const items = pendingOrders(owner);
  if (!items.some(item => item.requestId === requestId && item.state === "blocked")) throw new Error("This submission changed. Review Pending submissions again.");
  const replacement: PendingOrder = { requestId: genUUID(), order: structuredClone(reviewed), state: "pending" };
  // Replace in one storage write: a storage failure must retain the old action.
  store(owner, items.map(item => item.requestId === requestId ? replacement : item));
  return deliver(owner, replacement);
}
