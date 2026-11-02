import { supabase } from "./supabaseClient";
import type { UserRole } from "./auth";
import { EDGE_FUNCTION_REQUIRED_MESSAGE } from "./backendStatus";

export interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  username: string;
  action: string;
  entity: string;
  entityId: string | null;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  undoneAt: string | null;
}

export type InventoryCategory =
  | "finished_good"
  | "component"
  | "material"
  | "purchased_part"
  | "consumable"
  | "subcontract";

export type ProcurementType = "make" | "buy" | "subcontract";

export interface InventoryItem {
  id: string;
  itemCode: string;
  itemName: string;
  category: InventoryCategory;
  procurementType: ProcurementType;
  unit: string;
  openingQty: number;
  minimumQty: number;
  targetQty: number;
  supplierName: string;
  unitCost: number;
  active: boolean;
  availableQty: number;
  suggestedPurchaseQty: number;
  needsReorder: boolean;
  stockValue: number;
  version?: number;
}

export interface Purchase {
  id: string;
  purchaseNo: string;
  purchaseDate: string;
  supplierName: string;
  itemId: string;
  orderedQty: number;
  receivedQty: number;
  unitPrice: number;
  dueDate: string;
  status: "ordered" | "partial" | "received" | "cancelled";
  pic: string;
  notes: string;
  version?: number;
  updatedBy?: string | null;
  updatedByUsername?: string | null;
}

export interface StockMovement {
  id: string;
  movementNo: string;
  movementDate: string;
  movementType: string;
  referenceType: string;
  referenceId: string | null;
  itemId: string;
  quantity: number;
  delta: number;
  pic: string;
  notes: string;
  createdAt: string;
}

export interface BomItem {
  id: string;
  bomNo: string;
  productId: string;
  inventoryItemId: string;
  componentProductId: string;
  parentBomNo: string;
  quantityPerUnit: number;
  notes: string;
  version?: number;
}

export interface ManufacturingOperation {
  id: string;
  operationCode: string;
  operationName: string;
  operationNameJa: string;
  baseTimeChargeJpy: number;
  defaultMinutes: number | null;
  sequence: number;
  isActive: boolean;
  version: number;
}

export type ProductionTaskStatus = "pending" | "in_progress" | "completed" | "issue";

export interface ProductionTaskProgress {
  id: string;
  orderId: string;
  operationId: string;
  status: ProductionTaskStatus;
  actualMinutes: number | null;
  operatorId: string | null;
  completedAt: string | null;
  version: number;
}

function functionError(data: unknown, fallback: string): Error {
  if (data && typeof data === "object" && "error" in data) {
    return new Error(String((data as { error: unknown }).error));
  }
  return new Error(fallback);
}

async function invokeUsers(body: Record<string, unknown>, signal?: AbortSignal) {
  let result = await supabase.functions.invoke("manage-users", { body, signal });
  let { data, error } = result;
  let candidate = error as (Error & { context?: Response }) | null;
  let status = candidate?.context instanceof Response ? candidate.context.status : 0;

  // A browser can retain an expired access token while the refresh token is
  // still valid. Refresh once and retry instead of leaving the page in a 401 loop.
  if (status === 401) {
    if (signal?.aborted) throw new DOMException("Read cancelled", "AbortError");
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session) {
      result = await supabase.functions.invoke("manage-users", { body, signal });
      data = result.data;
      error = result.error;
      candidate = error as (Error & { context?: Response }) | null;
      status = candidate?.context instanceof Response ? candidate.context.status : 0;
    }
  }
  if (error) {
    let serverMessage = "";
    if (candidate?.context instanceof Response) {
      try {
        const payload = await candidate.context.clone().json() as { error?: unknown };
        serverMessage = typeof payload.error === "string" ? payload.error : "";
      } catch {
        // The fallback below is still more useful than failing while parsing.
      }
    }
    if (status === 401) {
      await supabase.auth.signOut({ scope: "local" });
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (status === 403) throw new Error(serverMessage || "This account is not allowed to perform that action.");
    const text = `${candidate?.name ?? ""} ${candidate?.message ?? ""}`.toLowerCase();
    if (status === 404 || /fetch|cors|failed to send|relay/.test(text)) {
      throw new Error(EDGE_FUNCTION_REQUIRED_MESSAGE);
    }
    throw new Error(serverMessage || candidate?.message || "User management request failed");
  }
  if (data?.error) throw functionError(data, "User management failed");
  return data;
}

export async function listManagedUsers(signal?: AbortSignal): Promise<ManagedUser[]> {
  const data = await invokeUsers({ action: "list" }, signal);
  return (data.users ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name ?? row.username),
    role: row.role as UserRole,
    active: Boolean(row.active),
    createdAt: String(row.created_at ?? ""),
  }));
}

export async function createManagedUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}): Promise<void> {
  await invokeUsers({ action: "create", ...input });
}

export async function updateManagedUser(input: {
  userId: string;
  displayName?: string;
  role?: UserRole;
  active?: boolean;
}): Promise<void> {
  await invokeUsers({ action: "update", ...input });
}

export async function resetManagedUserPassword(userId: string, password: string): Promise<void> {
  await invokeUsers({ action: "reset-password", userId, password });
}

export async function fetchAuditLogs(limit = 200, signal?: AbortSignal): Promise<AuditLog[]> {
  const query = supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (signal) query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(row => ({
    id: row.id,
    username: row.username,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    oldData: row.old_data,
    newData: row.new_data,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  }));
}

export async function undoAuditLog(id: string): Promise<void> {
  const { error } = await supabase.rpc("undo_audit_entry", { p_audit_id: id });
  if (error) throw error;
}

const UNDOABLE_ENTITIES = new Set([
  "clients",
  "products",
  "orders",
  "inventory_items",
  "purchases",
  "stock_movements",
  "product_materials",
  "production_tasks",
  "manufacturing_operations",
  "production_costs",
]);

export function isUndoableAuditLog(log: AuditLog): boolean {
  const source = String(log.metadata.source ?? "");
  const stockReference = String((log.newData ?? log.oldData)?.reference_type ?? "");
  const automaticStock = log.entity === "stock_movements" && ["purchase", "order"].includes(stockReference);
  return (
    !log.undoneAt
    && !source.startsWith("undo:")
    && !automaticStock
    && ["insert", "update", "delete"].includes(log.action)
    && UNDOABLE_ENTITIES.has(log.entity)
  );
}

function inventoryFromRow(row: Record<string, unknown>): InventoryItem {
  return {
    id: String(row.id),
    itemCode: String(row.item_code),
    itemName: String(row.item_name),
    category: row.category as InventoryCategory,
    procurementType: row.procurement_type as ProcurementType,
    unit: String(row.unit),
    openingQty: Number(row.opening_qty ?? 0),
    minimumQty: Number(row.minimum_qty ?? 0),
    targetQty: Number(row.target_qty ?? 0),
    supplierName: String(row.supplier_name ?? ""),
    unitCost: Number(row.unit_cost ?? 0),
    active: Boolean(row.active),
    availableQty: Number(row.available_qty ?? row.opening_qty ?? 0),
    suggestedPurchaseQty: Number(row.suggested_purchase_qty ?? 0),
    needsReorder: Boolean(row.needs_reorder),
    stockValue: Number(row.stock_value ?? 0),
    version: Number(row.version ?? 1),
  };
}

function purchaseFromRow(row: Record<string, unknown>): Purchase {
  return {
    id: String(row.id),
    purchaseNo: String(row.purchase_no),
    purchaseDate: String(row.purchase_date),
    supplierName: String(row.supplier_name),
    itemId: String(row.item_id),
    orderedQty: Number(row.ordered_qty),
    receivedQty: Number(row.received_qty),
    unitPrice: Number(row.unit_price),
    dueDate: String(row.due_date ?? ""),
    status: row.status as Purchase["status"],
    pic: String(row.pic ?? ""),
    notes: String(row.notes ?? ""),
    version: Number(row.version ?? 1),
    updatedBy: row.updated_by ? String(row.updated_by) : null,
    updatedByUsername: row.updated_by_username ? String(row.updated_by_username) : null,
  };
}

export async function fetchInventoryData(signal?: AbortSignal) {
  const [items, purchases, movements, bom] = await Promise.all([
    fetchAllPages((from, to) => {
      const query = supabase.from("inventory_balances").select("*").order("item_code").range(from, to);
      return signal ? query.abortSignal(signal) : query;
    }),
    fetchAllPages((from, to) => {
      const query = supabase.from("purchases").select("*").order("purchase_date", { ascending: false }).order("id").range(from, to);
      return signal ? query.abortSignal(signal) : query;
    }),
    (async () => {
      const query = supabase.from("stock_movements").select("*").order("created_at", { ascending: false }).limit(500);
      const result = await (signal ? query.abortSignal(signal) : query);
      if (result.error) throw result.error;
      return result.data ?? [];
    })(),
    fetchAllPages((from, to) => {
      const query = supabase.from("product_materials").select("*").order("product_id").order("id").range(from, to);
      return signal ? query.abortSignal(signal) : query;
    }),
  ]);

  return {
    items: items.map(inventoryFromRow),
    purchases: purchases.map(purchaseFromRow),
    movements: movements.map(row => ({
      id: row.id,
      movementNo: row.movement_no ?? "",
      movementDate: row.movement_date,
      movementType: row.movement_type,
      referenceType: row.reference_type,
      referenceId: row.reference_id,
      itemId: row.item_id,
      quantity: Number(row.quantity),
      delta: Number(row.delta),
      pic: row.pic,
      notes: row.notes,
      createdAt: row.created_at,
    })) as StockMovement[],
    bom: bom.map(row => ({
      id: row.id,
      bomNo: row.bom_no ?? "",
      productId: row.product_id,
      inventoryItemId: row.inventory_item_id,
      componentProductId: row.component_product_id ?? "",
      parentBomNo: row.parent_bom_no ?? "",
      quantityPerUnit: Number(row.quantity_per_unit),
      notes: row.notes,
      version: Number(row.version ?? 1),
    })) as BomItem[],
  };
}

export async function fetchProductMaterialData(): Promise<{ items: InventoryItem[]; bom: BomItem[] }> {
  const [items, bom] = await Promise.all([
    fetchAllPages((from, to) => supabase.from("inventory_balances").select("*").order("item_code").range(from, to)),
    fetchAllPages((from, to) => supabase.from("product_materials").select("*").order("product_id").order("id").range(from, to)),
  ]);
  return {
    items: items.map(inventoryFromRow),
    bom: bom.map(row => ({
      id: row.id,
      bomNo: row.bom_no ?? "",
      productId: row.product_id,
      inventoryItemId: row.inventory_item_id,
      componentProductId: row.component_product_id ?? "",
      parentBomNo: row.parent_bom_no ?? "",
      quantityPerUnit: Number(row.quantity_per_unit),
      notes: row.notes,
      version: Number(row.version ?? 1),
    })) as BomItem[],
  };
}

const DATA_PAGE_SIZE = 500;
async function fetchAllPages<T>(makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += DATA_PAGE_SIZE) {
    const { data, error } = await makeQuery(from, from + DATA_PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < DATA_PAGE_SIZE) return rows;
  }
}

export async function saveInventoryItem(item: Omit<InventoryItem, "availableQty" | "suggestedPurchaseQty" | "needsReorder" | "stockValue">) {
  const row = {
    id: item.id,
    item_name: item.itemName.trim(),
    category: item.category,
    procurement_type: item.procurementType,
    unit: item.unit.trim(),
    opening_qty: item.openingQty,
    minimum_qty: item.minimumQty,
    target_qty: item.targetQty,
    supplier_name: item.supplierName.trim(),
    unit_cost: item.unitCost,
    active: item.active,
    updated_at: new Date().toISOString(),
  };
  if (item.itemCode) {
    const version = item.version ?? 1;
    const { data, error } = await supabase.from("inventory_items").update({ ...row, version: version + 1 })
      .eq("id", item.id).eq("version", version).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This inventory item changed on another device. Reload it and reapply your edit.");
    return;
  }
  const { error } = await supabase.from("inventory_items").insert({ ...row, version: 1 });
  if (error) throw error;
}

export async function deleteInventoryItem(id: string): Promise<void> {
  const { error } = await supabase.from("inventory_items").delete().eq("id", id);
  if (!error) return;
  if (error.code === "23503") {
    throw new Error("Item cannot be deleted because it is already used by a purchase, movement, or BOM. Remove those references first.");
  }
  throw error;
}

// Concurrent edit protection, mirroring the orders guard in db.ts. The old
// save was a plain update with no precondition, so two operators editing the
// same purchase silently overwrote each other — and a reverted "received"
// status could re-post an automatic stock reversal. The database now carries a
// version column; a save only applies when it still matches, and a miss is a
// conflict the user has to resolve by reloading, never a silent overwrite.
export class StalePurchaseError extends Error {
  constructor(public readonly purchaseId: string) {
    super("This purchase was changed by someone else while you were editing it. Reload to see the current values, then reapply your change.");
    this.name = "StalePurchaseError";
  }
}

export async function savePurchase(purchase: Purchase) {
  const row = {
    id: purchase.id,
    purchase_date: purchase.purchaseDate,
    supplier_name: purchase.supplierName.trim(),
    item_id: purchase.itemId,
    ordered_qty: purchase.orderedQty,
    received_qty: purchase.receivedQty,
    unit_price: purchase.unitPrice,
    due_date: purchase.dueDate || null,
    status: purchase.status,
    pic: purchase.pic.trim(),
    notes: purchase.notes.trim(),
    updated_at: new Date().toISOString(),
  };
  if (purchase.purchaseNo) {
    const expectedVersion = purchase.version ?? 1;
    const { data, error } = await supabase
      .from("purchases")
      .update({ ...row, version: expectedVersion + 1 })
      .eq("id", purchase.id)
      .eq("version", expectedVersion)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new StalePurchaseError(purchase.id);
    return;
  }
  const { error } = await supabase.from("purchases").insert({ ...row, version: 1 });
  if (error) throw error;
}

export async function deletePurchase(id: string): Promise<void> {
  const { error } = await supabase.from("purchases").delete().eq("id", id);
  if (error) throw error;
}

export async function addStockMovement(
  input: Omit<StockMovement, "id" | "movementNo" | "createdAt"> & { idempotencyKey: string },
) {
  // PostgREST insert is revoked on stock_movements; the only client path is
  // record_stock_movement, which rejects a reference_type that would imply a
  // purchase or an order exists behind the movement.
  const { data, error } = await supabase.rpc("record_stock_movement", {
    p_movement_date: input.movementDate,
    p_movement_type: input.movementType,
    p_reference_id: input.referenceId || null,
    p_item_id: input.itemId,
    p_quantity: input.quantity,
    p_delta: input.delta,
    p_pic: input.pic.trim(),
    p_notes: input.notes.trim(),
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return (data ?? null) as StockMovement | null;
}

export async function deleteStockMovement(movement: StockMovement): Promise<void> {
  if (movement.referenceType !== "manual") {
    throw new Error("Automatic movements must be removed through their related purchase or order.");
  }
  const { error } = await supabase.from("stock_movements").delete().eq("id", movement.id);
  if (error) throw error;
}

export async function importInventoryRows(rows: readonly unknown[]): Promise<number> {
  const { data, error } = await supabase.rpc("import_manufacturing_rows", { p_rows: rows });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function saveBomItem(item: BomItem) {
  const row = {
    id: item.id,
    product_id: item.productId,
    inventory_item_id: item.inventoryItemId,
    component_product_id: item.componentProductId || null,
    parent_bom_no: item.parentBomNo || null,
    quantity_per_unit: item.quantityPerUnit,
    notes: item.notes.trim(),
  };
  if (item.bomNo) {
    const version = item.version ?? 1;
    const { data, error } = await supabase.from("product_materials").update({ ...row, version: version + 1 })
      .eq("id", item.id).eq("version", version).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("This BOM row changed on another device. Reload it and reapply your edit.");
    return;
  }
  const { error } = await supabase.from("product_materials").insert({ ...row, version: 1 });
  if (error) throw error;
}

export async function deleteBomItem(id: string) {
  const { error } = await supabase.from("product_materials").delete().eq("id", id);
  if (error) throw error;
}

function operationFromRow(row: Record<string, unknown>): ManufacturingOperation {
  return {
    id: String(row.id),
    operationCode: String(row.operation_code),
    operationName: String(row.operation_name),
    operationNameJa: String(row.operation_name_ja ?? ""),
    baseTimeChargeJpy: Number(row.base_time_charge_jpy ?? 0),
    defaultMinutes: row.default_minutes == null ? null : Number(row.default_minutes),
    sequence: Number(row.sequence ?? 0),
    isActive: Boolean(row.is_active),
    version: Number(row.version ?? 1),
  };
}

function productionTaskFromRow(row: Record<string, unknown>): ProductionTaskProgress {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    operationId: String(row.operation_id),
    status: row.status as ProductionTaskStatus,
    actualMinutes: row.actual_minutes == null ? null : Number(row.actual_minutes),
    operatorId: row.operator_id ? String(row.operator_id) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    version: Number(row.version ?? 1),
  };
}

export async function fetchManufacturingProgress(signal?: AbortSignal): Promise<{
  operations: ManufacturingOperation[];
  tasks: ProductionTaskProgress[];
}> {
  const operationQuery = supabase.from("manufacturing_operations").select("*").eq("is_active", true).order("sequence").order("operation_name");
  const taskResult = fetchAllPages((from, to) => {
    const query = supabase.from("production_tasks").select("*").order("updated_at").order("id").range(from, to);
    return signal ? query.abortSignal(signal) : query;
  });
  if (signal) operationQuery.abortSignal(signal);
  const [operationRes, tasks] = await Promise.all([operationQuery, taskResult]);
  if (operationRes.error) throw operationRes.error;
  return {
    operations: (operationRes.data ?? []).map(row => operationFromRow(row)),
    tasks: tasks.map(row => productionTaskFromRow(row)),
  };
}

export async function fetchManufacturingOperations(signal?: AbortSignal): Promise<ManufacturingOperation[]> {
  const query = supabase.from("manufacturing_operations").select("*").eq("is_active", true).order("sequence").order("operation_name");
  if (signal) query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(row => operationFromRow(row));
}

export async function createManufacturingOperation(input: {
  operationName: string;
  operationNameJa: string;
  defaultMinutes: number | null;
  baseTimeChargeJpy: number;
  sequence: number;
}): Promise<ManufacturingOperation> {
  const operationCode = `${input.operationName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "PROCESS"}_${Date.now().toString(36).toUpperCase()}`;
  const { data, error } = await supabase.from("manufacturing_operations").insert({
    operation_code: operationCode,
    operation_name: input.operationName.trim(),
    operation_name_ja: input.operationNameJa.trim(),
    default_minutes: input.defaultMinutes,
    base_time_charge_jpy: input.baseTimeChargeJpy,
    sequence: input.sequence,
  }).select().single();
  if (error) throw error;
  return operationFromRow(data);
}

export async function updateManufacturingOperationCharge(operationId: string, expectedVersion: number, baseTimeChargeJpy: number): Promise<void> {
  const { data, error } = await supabase.from("manufacturing_operations")
    .update({ base_time_charge_jpy: baseTimeChargeJpy, version: expectedVersion + 1 })
    .eq("id", operationId).eq("version", expectedVersion).select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This process rate changed on another device. Reload the process list before editing it again.");
}

export class StaleProductionTaskError extends Error {
  constructor(public readonly latest: ProductionTaskProgress | null) {
    super("This process status changed on another device. The latest value has been loaded; review it before making another change.");
    this.name = "StaleProductionTaskError";
  }
}

export async function saveProductionTask(input: {
  existingId?: string;
  expectedVersion?: number;
  orderId: string;
  operationId: string;
  status: ProductionTaskStatus;
  actualMinutes: number | null;
  operatorId: string;
}): Promise<ProductionTaskProgress> {
  const row = {
    order_id: input.orderId,
    operation_id: input.operationId,
    status: input.status,
    actual_minutes: input.actualMinutes,
    operator_id: input.operatorId,
    completed_at: input.status === "completed" ? new Date().toISOString() : null,
  };
  if (input.existingId) {
    const version = input.expectedVersion ?? 1;
    const { data, error } = await supabase.from("production_tasks")
      .update({ ...row, version: version + 1 }).eq("id", input.existingId).eq("version", version)
      .select().maybeSingle();
    if (error) throw error;
    if (data) return productionTaskFromRow(data);
    const latest = await supabase.from("production_tasks").select("*").eq("id", input.existingId).maybeSingle();
    if (latest.error) throw latest.error;
    throw new StaleProductionTaskError(latest.data ? productionTaskFromRow(latest.data) : null);
  }
  const { data, error } = await supabase.from("production_tasks").insert({ ...row, version: 1 }).select().single();
  if (error?.code === "23505") {
    const latest = await supabase.from("production_tasks").select("*").eq("order_id", input.orderId).eq("operation_id", input.operationId).maybeSingle();
    if (latest.error) throw latest.error;
    throw new StaleProductionTaskError(latest.data ? productionTaskFromRow(latest.data) : null);
  }
  if (error) throw error;
  return productionTaskFromRow(data);
}
