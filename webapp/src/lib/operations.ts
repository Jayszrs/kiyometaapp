import { supabase } from "./supabaseClient";
import { AppError, resultCode } from "./resultCodes";
import { newProcessId, recordFrontendFailure, startProcess, traceQuery } from "./diagnostics";
import type { UserRole } from "./auth";

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
  actualTimeBasis: "per_unit" | "per_batch" | null;
  processedQuantity: number | null;
  completedQuantity: number | null;
  operatorId: string | null;
  completedAt: string | null;
  version: number;
}

export interface ProductRouteLink {
  productId: string;
  operationId: string;
  standardMinutes: number | null;
}

export interface WipValuationSettings {
  valuationMethod: "standard_time" | "actual_time" | null;
  actualTimeBasis: "per_unit" | "per_batch" | null;
  includeInProgressOperation: boolean | null;
  materialIssuePoint: "issue" | "process_start" | "actual_consumption" | null;
  outsourcingRecognition: "sent" | "received" | "invoiced" | null;
  stockValuationMethod: "fifo" | "weighted_average" | "standard_cost" | null;
  includeLaborCost: boolean | null;
  includeMachineCost: boolean | null;
  includeOverheadCost: boolean | null;
  configuredAt: string | null;
  clientDecisions: Record<string, string>;
  version: number;
}

function wipSettingsFromRow(row: Record<string, unknown>): WipValuationSettings {
  return {
    valuationMethod: row.valuation_method as WipValuationSettings["valuationMethod"],
    actualTimeBasis: row.actual_time_basis as WipValuationSettings["actualTimeBasis"],
    includeInProgressOperation: row.include_in_progress_operation == null ? null : Boolean(row.include_in_progress_operation),
    materialIssuePoint: row.material_issue_point as WipValuationSettings["materialIssuePoint"],
    outsourcingRecognition: row.outsourcing_recognition as WipValuationSettings["outsourcingRecognition"],
    stockValuationMethod: row.stock_valuation_method as WipValuationSettings["stockValuationMethod"],
    includeLaborCost: row.include_labor_cost == null ? null : Boolean(row.include_labor_cost),
    includeMachineCost: row.include_machine_cost == null ? null : Boolean(row.include_machine_cost),
    includeOverheadCost: row.include_overhead_cost == null ? null : Boolean(row.include_overhead_cost),
    configuredAt: row.configured_at ? String(row.configured_at) : null,
    clientDecisions: (row.client_decisions ?? {}) as Record<string, string>,
    version: Number(row.version ?? 1),
  };
}

export async function fetchWipValuationSettings(): Promise<WipValuationSettings> {
  const { data, error } = await traceQuery(supabase.from("wip_valuation_settings").select("*").eq("id", true).maybeSingle(), startProcess("inventory.wip_policy.fetch"), "inventory.wip_policy.fetch");
  if (error) throw error;
  return wipSettingsFromRow(data ?? {});
}

export async function saveWipValuationSettings(settings: WipValuationSettings): Promise<WipValuationSettings> {
  const processId = startProcess("inventory.wip_policy.save");
  const row = {
    id: true,
    client_decisions: settings.clientDecisions,
    valuation_method: "standard_time" as const,
    actual_time_basis: "per_unit" as const,
    include_in_progress_operation: settings.includeInProgressOperation,
    material_issue_point: settings.materialIssuePoint,
    outsourcing_recognition: settings.outsourcingRecognition,
    stock_valuation_method: settings.stockValuationMethod,
    include_labor_cost: true,
    include_machine_cost: true,
    include_overhead_cost: true,
    configured_at: new Date().toISOString(),
    configured_by: (await supabase.auth.getUser()).data.user?.id ?? null,
  };
  const { data, error } = await traceQuery(supabase.from("wip_valuation_settings").update({ ...row, version: settings.version + 1 }).eq("id", true).eq("version", settings.version).select().maybeSingle(), processId, "inventory.wip_policy.save");
  if (error) throw error;
  if (!data) throw new Error("The policy changed on another device. Reload before saving again.");
  return wipSettingsFromRow(data);
}

export async function calculateWipValuation(asOf?: string): Promise<{ configured: boolean; reason?: string; total?: number; rows?: Array<Record<string, unknown>>; policy?: WipValuationSettings }> {
  const { data, error } = await traceQuery(supabase.rpc("calculate_wip_valuation", { p_as_of: asOf ?? new Date().toISOString().slice(0, 10) }), startProcess("inventory.wip_value.calculate"), "inventory.wip_value.calculate");
  if (error) throw error;
  return data as { configured: boolean; reason?: string; total?: number; rows?: Array<Record<string, unknown>>; policy?: WipValuationSettings };
}

async function invokeUsers(body: Record<string, unknown>, signal?: AbortSignal) {
  const operation = `user_management.${String(body.action ?? "request")}`;
  const processId = startProcess(operation);
  const headers = { "x-process-id": processId, "x-process-operation": operation };
  let result = await supabase.functions.invoke("manage-users", { body, signal, headers });
  let { data, error } = result;
  let candidate = error as (Error & { context?: Response }) | null;
  let status = candidate?.context instanceof Response ? candidate.context.status : 0;

  // A browser can retain an expired access token while the refresh token is
  // still valid. Refresh once and retry instead of leaving the page in a 401 loop.
  if (status === 401) {
    if (signal?.aborted) throw new DOMException("Read cancelled", "AbortError");
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session) {
      result = await supabase.functions.invoke("manage-users", { body, signal, headers });
      data = result.data;
      error = result.error;
      candidate = error as (Error & { context?: Response }) | null;
      status = candidate?.context instanceof Response ? candidate.context.status : 0;
    }
  }
  if (error) {
    if (status === 401) {
      await supabase.auth.signOut({ scope: "local" });
      throw new AppError("AUTH-001");
    }
    if (status === 403) throw new AppError("AUTH-002");
    if (status === 429) throw new AppError("SVC-002");
    if (status >= 500 || status === 404) throw new AppError("SVC-001");
    if (status === 400 || status === 422) {
      const response = candidate?.context;
      const payload = response ? await response.clone().json().catch(() => null) : null;
      const code = typeof payload?.error === "string" && /^[A-Z]+-\d{3}$/.test(payload.error) ? payload.error : "VAL-002";
      throw new AppError(code);
    }
    if (status === 0 && candidate?.name === "FunctionsFetchError") throw new AppError("NET-002");
    const fallback = status ? new AppError(status >= 500 ? "SVC-001" : "SYS-001") : (error as Error);
    throw new AppError(resultCode(fallback));
  }
  if (data?.error) {
    const code = typeof data.error === "string" && /^[A-Z]+-\d{3}$/.test(data.error) ? data.error : "SYS-001";
    throw new AppError(code);
  }
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

export interface AuditLogQuery {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  search?: string;
  sortBy?: "created_at" | "username" | "action" | "entity" | "entity_id";
  ascending?: boolean;
}

export interface AuditLogPage {
  logs: AuditLog[];
  total: number;
}

function auditLogFromRow(row: Record<string, any>): AuditLog {
  return {
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
  };
}

export async function fetchAuditLogPage(options: AuditLogQuery = {}, signal?: AbortSignal): Promise<AuditLogPage> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  let query = supabase.from("audit_logs").select("*", { count: "exact" });
  if (options.from) query = query.gte("created_at", options.from);
  if (options.to) query = query.lte("created_at", options.to);
  const search = options.search?.normalize("NFKC").trim().replace(/[^\p{L}\p{N}_.@\- ]/gu, "").slice(0, 100);
  if (search) query = query.or(`username.ilike.%${search}%,action.ilike.%${search}%,entity.ilike.%${search}%`);
  query = query
    .order(options.sortBy ?? "created_at", { ascending: options.ascending ?? false })
    .order("id", { ascending: options.ascending ?? false })
    .range(offset, offset + limit - 1);
  if (signal) query.abortSignal(signal);
  const { data, error, count } = await traceQuery(query, startProcess("audit.fetch_page"), "audit.fetch_page");
  if (error) throw error;
  return { logs: (data ?? []).map(row => auditLogFromRow(row)), total: count ?? 0 };
}

export async function fetchAuditLogs(options: number | AuditLogQuery = 200, signal?: AbortSignal): Promise<AuditLog[]> {
  const normalized = typeof options === "number" ? { limit: options } : options;
  let query = supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false });
  if (normalized.from) query = query.gte("created_at", normalized.from);
  if (normalized.to) query = query.lte("created_at", normalized.to);
  query = query.limit(normalized.limit ?? 1000);
  if (signal) query.abortSignal(signal);
  const { data, error } = await traceQuery(query, startProcess("audit.fetch"), "audit.fetch");
  if (error) throw error;
  return (data ?? []).map(row => auditLogFromRow(row));
}

export async function undoAuditLog(id: string): Promise<void> {
  const processId = startProcess("audit.undo");
  const { error } = await traceQuery(supabase.rpc("undo_audit_entry", { p_audit_id: id }), processId, "audit.undo");
  if (error) {
    const code = (error as { code?: string }).code;
    const rc = resultCode(error);
    void recordFrontendFailure("audit.undo", error);
    throw new AppError(code === "42501" ? "AUTH-002" : rc.startsWith("NET-") ? "TXN-001" : "UNDO-001");
  }
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
  const processId = startProcess("inventory.fetch_all");
  const [items, purchases, movements, bom] = await Promise.all([
    fetchAllPages((from, to) => {
      const query = traceQuery(supabase.from("inventory_balances").select("*").order("item_code").range(from, to), processId, "inventory.fetch_all");
      return signal ? query.abortSignal(signal) : query;
    }),
    fetchAllPages((from, to) => {
      const query = traceQuery(supabase.from("purchases").select("*").order("purchase_date", { ascending: false }).order("id").range(from, to), processId, "inventory.fetch_all");
      return signal ? query.abortSignal(signal) : query;
    }),
    (async () => {
      const query = traceQuery(supabase.from("stock_movements").select("*").order("created_at", { ascending: false }).limit(500), processId, "inventory.fetch_all");
      const result = await (signal ? query.abortSignal(signal) : query);
      if (result.error) throw result.error;
      return result.data ?? [];
    })(),
    fetchAllPages((from, to) => {
      const query = traceQuery(supabase.from("product_materials").select("*").order("product_id").order("id").range(from, to), processId, "inventory.fetch_all");
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

export type InventoryPageOptions = {
  page?: number;
  pageSize?: number;
  search?: string;
  movementDirection?: "all" | "outgoing" | "incoming";
  productId?: string;
  signal?: AbortSignal;
};
export type InventoryPage<T> = { rows: T[]; total: number; page: number; pageSize: number };
export type InventoryTab = "inventory" | "purchases" | "movements" | "bom";
export type InventorySummary = { itemCount: number; stockValue: number; reorderCount: number; outOfStock: number };

/** One bounded inventory query. Use this for visible tabs; full fetch remains for export/print. */
export async function fetchInventoryPage(tab: InventoryTab, options: InventoryPageOptions = {}): Promise<InventoryPage<InventoryItem | Purchase | StockMovement | BomItem>> {
  const processId = startProcess("inventory.page");
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 50)));
  const page = Math.max(0, Math.floor(options.page ?? 0));
  const from = page * pageSize;
  const to = from + pageSize - 1;
  const search = options.search?.trim().replace(/[%,()]/g, " ");
  const run = async <T>(q: any, map: (row: any) => T): Promise<InventoryPage<T>> => {
    const traced = traceQuery(q, processId, "inventory.page");
    const result = await (options.signal ? traced.abortSignal(options.signal) : traced);
    if (result.error) throw result.error;
    return { rows: (result.data ?? []).map(map), total: result.count ?? 0, page, pageSize };
  };
  const movementMap = (row: any): StockMovement => ({ id: row.id, movementNo: row.movement_no ?? "", movementDate: row.movement_date, movementType: row.movement_type, referenceType: row.reference_type, referenceId: row.reference_id, itemId: row.item_id, quantity: Number(row.quantity), delta: Number(row.delta), pic: row.pic, notes: row.notes, createdAt: row.created_at });
  const bomMap = (row: any): BomItem => ({ id: row.id, bomNo: row.bom_no ?? "", productId: row.product_id, inventoryItemId: row.inventory_item_id, componentProductId: row.component_product_id ?? "", parentBomNo: row.parent_bom_no ?? "", quantityPerUnit: Number(row.quantity_per_unit), notes: row.notes, version: Number(row.version ?? 1) });
  if (tab === "inventory") {
    let query = supabase.from("inventory_balances").select("*", { count: "exact" }).order("item_code").range(from, to);
    if (search) query = query.or(`item_code.ilike.%${search}%,item_name.ilike.%${search}%,supplier_name.ilike.%${search}%`);
    return run(query, inventoryFromRow);
  }
  if (tab === "purchases") {
    let query = supabase.from("purchases").select("*", { count: "exact" }).order("purchase_date", { ascending: false }).order("id").range(from, to);
    if (search) query = query.or(`purchase_no.ilike.%${search}%,supplier_name.ilike.%${search}%,pic.ilike.%${search}%,notes.ilike.%${search}%`);
    return run(query, purchaseFromRow);
  }
  if (tab === "movements") {
    let query = supabase.from("stock_movements").select("*", { count: "exact" }).order("created_at", { ascending: false }).order("id").range(from, to);
    if (search) query = query.or(`movement_no.ilike.%${search}%,reference_id.ilike.%${search}%,pic.ilike.%${search}%,notes.ilike.%${search}%`);
    if (options.movementDirection === "outgoing") query = query.lt("delta", 0);
    if (options.movementDirection === "incoming") query = query.gt("delta", 0);
    return run(query, movementMap);
  }
  let query = supabase.from("product_materials").select("*", { count: "exact" }).order("product_id").order("id").range(from, to);
  if (options.productId) query = query.eq("product_id", options.productId);
  if (search) query = query.or(`bom_no.ilike.%${search}%,parent_bom_no.ilike.%${search}%,notes.ilike.%${search}%`);
  return run(query, bomMap);
}

export async function fetchInventorySummary(signal?: AbortSignal): Promise<InventorySummary> {
  const processId = startProcess("inventory.summary");
  const make = (filter?: (query: any) => any) => {
    let query: any = supabase.from("inventory_balances").select("stock_value", { count: "exact" });
    if (filter) query = filter(query);
    const traced = traceQuery(query, processId, "inventory.summary");
    return signal ? traced.abortSignal(signal) : traced;
  };
  const [all, reorder, out] = await Promise.all([
    fetchAllPages((from, to) => make(query => query.range(from, to))),
    make(query => query.eq("needs_reorder", true).limit(0)),
    make(query => query.lte("available_qty", 0).limit(0)),
  ]);
  if (reorder.error) throw reorder.error;
  if (out.error) throw out.error;
  return {
    itemCount: all.length,
    stockValue: (all as Array<{ stock_value?: number | string | null }>).reduce((sum, row) => sum + Number(row.stock_value ?? 0), 0),
    reorderCount: reorder.count ?? 0,
    outOfStock: out.count ?? 0,
  };
}

export async function fetchProductMaterialData(): Promise<{ items: InventoryItem[]; bom: BomItem[] }> {
  const processId = newProcessId();
  const [items, bom] = await Promise.all([
    fetchAllPages((from, to) => traceQuery(supabase.from("inventory_balances").select("*").order("item_code").range(from, to), processId, "product_materials.fetch")),
    fetchAllPages((from, to) => traceQuery(supabase.from("product_materials").select("*").order("product_id").order("id").range(from, to), processId, "product_materials.fetch")),
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
  const processId = startProcess("inventory.item.save");
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
    const { data, error } = await traceQuery(supabase.from("inventory_items").update({ ...row, version: version + 1 })
      .eq("id", item.id).eq("version", version).select("id").maybeSingle(), processId, "inventory.item.save");
    if (error) throw error;
    if (!data) throw new Error("This inventory item changed on another device. Reload it and reapply your edit.");
    return;
  }
  const { error } = await traceQuery(supabase.from("inventory_items").insert({ ...row, version: 1 }), processId, "inventory.item.save");
  if (error) throw error;
}

export async function deleteInventoryItem(id: string): Promise<void> {
  const { error } = await traceQuery(supabase.from("inventory_items").delete().eq("id", id), startProcess("inventory.item.delete"), "inventory.item.delete");
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
  const processId = startProcess("inventory.purchase.save");
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
    const { data, error } = await traceQuery(supabase
      .from("purchases")
      .update({ ...row, version: expectedVersion + 1 })
      .eq("id", purchase.id)
      .eq("version", expectedVersion)
      .select("id")
      .maybeSingle(), processId, "inventory.purchase.save");
    if (error) throw error;
    if (!data) throw new StalePurchaseError(purchase.id);
    return;
  }
  const { error } = await traceQuery(supabase.from("purchases").insert({ ...row, version: 1 }), processId, "inventory.purchase.save");
  if (error) throw error;
}

export async function deletePurchase(id: string): Promise<void> {
  const { error } = await traceQuery(supabase.from("purchases").delete().eq("id", id), startProcess("inventory.purchase.delete"), "inventory.purchase.delete");
  if (error) throw error;
}

export async function addStockMovement(
  input: Omit<StockMovement, "id" | "movementNo" | "createdAt"> & { idempotencyKey: string },
) {
  // PostgREST insert is revoked on stock_movements; the only client path is
  // record_stock_movement, which rejects a reference_type that would imply a
  // purchase or an order exists behind the movement.
  const processId = startProcess("inventory.movement.record", { idempotencyKey: input.idempotencyKey });
  const { data, error } = await traceQuery(supabase.rpc("record_stock_movement", {
    p_movement_date: input.movementDate,
    p_movement_type: input.movementType,
    p_reference_id: input.referenceId || null,
    p_item_id: input.itemId,
    p_quantity: input.quantity,
    p_delta: input.delta,
    p_pic: input.pic.trim(),
    p_notes: input.notes.trim(),
    p_idempotency_key: input.idempotencyKey,
  }), processId, "inventory.movement.record");
  if (error) throw error;
  return (data ?? null) as StockMovement | null;
}

export async function deleteStockMovement(movement: StockMovement): Promise<void> {
  if (movement.referenceType !== "manual") {
    throw new Error("Automatic movements must be removed through their related purchase or order.");
  }
  const { error } = await traceQuery(supabase.from("stock_movements").delete().eq("id", movement.id), startProcess("inventory.movement.delete"), "inventory.movement.delete");
  if (error) throw error;
}

export async function importInventoryRows(rows: readonly unknown[]): Promise<number> {
  const { data, error } = await traceQuery(supabase.rpc("import_manufacturing_rows", { p_rows: rows }), startProcess("inventory.import"), "inventory.import");
  if (error) throw error;
  return Number(data ?? 0);
}

export async function saveBomItem(item: BomItem) {
  const processId = startProcess("product_materials.save");
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
    const { data, error } = await traceQuery(supabase.from("product_materials").update({ ...row, version: version + 1 })
      .eq("id", item.id).eq("version", version).select("id").maybeSingle(), processId, "product_materials.save");
    if (error) throw error;
    if (!data) throw new Error("This BOM row changed on another device. Reload it and reapply your edit.");
    return;
  }
  const { error } = await traceQuery(supabase.from("product_materials").insert({ ...row, version: 1 }), processId, "product_materials.save");
  if (error) throw error;
}

export async function deleteBomItem(id: string) {
  const { error } = await traceQuery(supabase.from("product_materials").delete().eq("id", id), startProcess("product_materials.delete"), "product_materials.delete");
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
    actualTimeBasis: row.actual_time_basis as ProductionTaskProgress["actualTimeBasis"] ?? null,
    processedQuantity: row.processed_quantity == null ? null : Number(row.processed_quantity),
    completedQuantity: row.completed_quantity == null ? null : Number(row.completed_quantity),
    operatorId: row.operator_id ? String(row.operator_id) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    version: Number(row.version ?? 1),
  };
}

export async function fetchManufacturingProgress(signal?: AbortSignal, scope?: { orderIds?: readonly string[]; productIds?: readonly string[] }): Promise<{
  operations: ManufacturingOperation[];
  tasks: ProductionTaskProgress[];
  routes: ProductRouteLink[];
}> {
  const processId = startProcess("production.progress.fetch");
  const operationQuery = traceQuery(supabase.from("manufacturing_operations").select("*").eq("is_active", true).order("sequence").order("operation_name"), processId, "production.progress.fetch");
  const orderIds = [...new Set((scope?.orderIds ?? []).filter(Boolean))];
  const productIds = [...new Set((scope?.productIds ?? []).filter(Boolean))];
  const taskResult = fetchAllPages((from, to) => {
    let builder = supabase.from("production_tasks").select("*");
    if (scope && orderIds.length === 0) builder = builder.in("order_id", ["00000000-0000-0000-0000-000000000000"]);
    else if (orderIds.length) builder = builder.in("order_id", orderIds);
    const query = traceQuery(builder.order("updated_at").order("id").range(from, to), processId, "production.progress.fetch");
    return signal ? query.abortSignal(signal) : query;
  });
  const routeQuery = fetchAllPages((from, to) => {
    let builder = supabase.from("products").select("id,tasks");
    if (scope && productIds.length === 0) builder = builder.in("id", ["00000000-0000-0000-0000-000000000000"]);
    else if (productIds.length) builder = builder.in("id", productIds);
    const query = traceQuery(builder.range(from, to), processId, "production.progress.fetch");
    return signal ? query.abortSignal(signal) : query;
  });
  if (signal) operationQuery.abortSignal(signal);
  const [operationRes, tasks, products] = await Promise.all([operationQuery, taskResult, routeQuery]);
  if (operationRes.error) throw operationRes.error;
  return {
    operations: (operationRes.data ?? []).map(row => operationFromRow(row)),
    tasks: tasks.map(row => productionTaskFromRow(row)),
    routes: products.flatMap(product => (Array.isArray(product.tasks) ? product.tasks : [])
      .flatMap((task: unknown) => {
        if (!task || typeof task !== "object") return [];
        const row = task as Record<string, unknown>;
        const operation = (operationRes.data ?? []).find(operation => row.operationId
          ? operation.id === row.operationId
          : operation.operation_name === String(row.content ?? "").trim()
            || (operation.operation_name_ja && operation.operation_name_ja === String(row.content ?? "").trim()));
        const time = Number(row.time);
        return operation ? [{
          productId: String(product.id),
          operationId: String(operation.id),
          standardMinutes: row.time === "" || row.time == null || !Number.isFinite(time) || time < 0 ? null : time,
        }] : [];
      })),
  };
}

export async function fetchManufacturingOperations(signal?: AbortSignal): Promise<ManufacturingOperation[]> {
  const query = traceQuery(supabase.from("manufacturing_operations").select("*").eq("is_active", true).order("sequence").order("operation_name"), startProcess("production.operations.fetch"), "production.operations.fetch");
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
  const processId = startProcess("production.operation.create");
  const operationCode = `${input.operationName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "PROCESS"}_${Date.now().toString(36).toUpperCase()}`;
  const { data, error } = await traceQuery(supabase.from("manufacturing_operations").insert({
    operation_code: operationCode,
    operation_name: input.operationName.trim(),
    operation_name_ja: input.operationNameJa.trim(),
    default_minutes: input.defaultMinutes,
    base_time_charge_jpy: input.baseTimeChargeJpy,
    sequence: input.sequence,
  }).select().single(), processId, "production.operation.create");
  if (error) throw error;
  return operationFromRow(data);
}

export async function updateManufacturingOperationName(
  operationId: string,
  expectedVersion: number,
  operationName: string,
  operationNameJa: string,
): Promise<void> {
  const processId = startProcess("production.operation.update");
  const { data, error } = await traceQuery(supabase.from("manufacturing_operations")
    .update({ operation_name: operationName.trim(), operation_name_ja: operationNameJa.trim(), version: expectedVersion + 1 })
    .eq("id", operationId).eq("version", expectedVersion).select("id").maybeSingle(), processId, "production.operation.update");
  if (error) throw error;
  if (!data) throw new Error("This process changed on another device. Reload the process list before editing it again.");
}

export async function updateManufacturingOperationCharge(operationId: string, expectedVersion: number, baseTimeChargeJpy: number): Promise<void> {
  const processId = startProcess("production.operation_rate.update");
  const { data, error } = await traceQuery(supabase.from("manufacturing_operations")
    .update({ base_time_charge_jpy: baseTimeChargeJpy, version: expectedVersion + 1 })
    .eq("id", operationId).eq("version", expectedVersion).select("id").maybeSingle(), processId, "production.operation_rate.update");
  if (error) throw error;
  if (!data) throw new Error("This process rate changed on another device. Reload the process list before editing it again.");
}

export async function updateManufacturingOperationDefaultMinutes(operationId: string, expectedVersion: number, defaultMinutes: number | null): Promise<void> {
  const processId = startProcess("production.operation_time.update");
  const { data, error } = await traceQuery(supabase.from("manufacturing_operations")
    .update({ default_minutes: defaultMinutes, version: expectedVersion + 1 })
    .eq("id", operationId).eq("version", expectedVersion).select("id").maybeSingle(), processId, "production.operation_time.update");
  if (error) throw error;
  if (!data) throw new Error("This standard time changed on another device. Reload the process list before editing it again.");
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
  requestId: string;
  completedAt?: string | null;
  orderId: string;
  operationId: string;
  status: ProductionTaskStatus;
  actualMinutes: number | null;
  operatorId: string;
  actualTimeBasis: "per_unit" | "per_batch" | null;
  processedQuantity: number | null;
  completedQuantity: number | null;
}): Promise<ProductionTaskProgress> {
  const processId = startProcess("production.task.save", { idempotencyKey: input.requestId });
  const { data, error } = await traceQuery(supabase.rpc("save_production_task_once", {
    p_request_id: input.requestId,
    p_existing_id: input.existingId ?? null,
    p_expected_version: input.expectedVersion ?? null,
    p_order_id: input.orderId,
    p_operation_id: input.operationId,
    p_status: input.status,
    p_actual_minutes: input.actualMinutes,
    p_actual_time_basis: input.actualTimeBasis,
    p_processed_quantity: input.processedQuantity,
    p_completed_quantity: input.completedQuantity,
    p_completed_at: input.completedAt ?? null,
    p_operator_id: input.operatorId,
  }), processId, "production.task.save");
  if (error) throw error;
  const result = data as { ok?: boolean; conflict?: boolean; task?: Record<string, unknown>; latest?: Record<string, unknown> | null };
  if (result?.conflict) throw new StaleProductionTaskError(result.latest ? productionTaskFromRow(result.latest) : null);
  if (!result?.ok || !result.task) throw new Error("The production update could not be confirmed. It will retry safely.");
  return productionTaskFromRow(result.task);
}
