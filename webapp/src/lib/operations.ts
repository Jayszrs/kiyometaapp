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
  quantityPerUnit: number;
  notes: string;
}

function functionError(data: unknown, fallback: string): Error {
  if (data && typeof data === "object" && "error" in data) {
    return new Error(String((data as { error: unknown }).error));
  }
  return new Error(fallback);
}

async function invokeUsers(body: Record<string, unknown>) {
  let result = await supabase.functions.invoke("manage-users", { body });
  let { data, error } = result;
  let candidate = error as (Error & { context?: Response }) | null;
  let status = candidate?.context instanceof Response ? candidate.context.status : 0;

  // A browser can retain an expired access token while the refresh token is
  // still valid. Refresh once and retry instead of leaving the page in a 401 loop.
  if (status === 401) {
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session) {
      result = await supabase.functions.invoke("manage-users", { body });
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

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const data = await invokeUsers({ action: "list" });
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

export async function fetchAuditLogs(limit = 200): Promise<AuditLog[]> {
  const { data, error } = await supabase
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
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
  "profiles",
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
  };
}

export async function fetchInventoryData() {
  const [itemsResult, purchasesResult, movementsResult, bomResult] = await Promise.all([
    supabase.from("inventory_balances").select("*").order("item_code"),
    supabase.from("purchases").select("*").order("purchase_date", { ascending: false }),
    supabase.from("stock_movements").select("*").order("created_at", { ascending: false }).limit(500),
    supabase.from("product_materials").select("*").order("product_id"),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (purchasesResult.error) throw purchasesResult.error;
  if (movementsResult.error) throw movementsResult.error;
  if (bomResult.error) throw bomResult.error;

  return {
    items: (itemsResult.data ?? []).map(inventoryFromRow),
    purchases: (purchasesResult.data ?? []).map(purchaseFromRow),
    movements: (movementsResult.data ?? []).map(row => ({
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
    bom: (bomResult.data ?? []).map(row => ({
      id: row.id,
      bomNo: row.bom_no ?? "",
      productId: row.product_id,
      inventoryItemId: row.inventory_item_id,
      quantityPerUnit: Number(row.quantity_per_unit),
      notes: row.notes,
    })) as BomItem[],
  };
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
  const result = item.itemCode
    ? await supabase.from("inventory_items").update(row).eq("id", item.id)
    : await supabase.from("inventory_items").insert(row);
  const { error } = result;
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
  const result = purchase.purchaseNo
    ? await supabase.from("purchases").update(row).eq("id", purchase.id)
    : await supabase.from("purchases").insert(row);
  const { error } = result;
  if (error) throw error;
}

export async function deletePurchase(id: string): Promise<void> {
  const { error } = await supabase.from("purchases").delete().eq("id", id);
  if (error) throw error;
}

export async function addStockMovement(input: Omit<StockMovement, "id" | "movementNo" | "createdAt">) {
  const { error } = await supabase.from("stock_movements").insert({
    movement_date: input.movementDate,
    movement_type: input.movementType,
    reference_type: input.referenceType,
    reference_id: input.referenceId || null,
    item_id: input.itemId,
    quantity: input.quantity,
    delta: input.delta,
    pic: input.pic.trim(),
    notes: input.notes.trim(),
  });
  if (error) throw error;
}

export async function deleteStockMovement(movement: StockMovement): Promise<void> {
  if (movement.referenceType !== "manual") {
    throw new Error("Automatic movements must be removed through their related purchase or order.");
  }
  const { error } = await supabase.from("stock_movements").delete().eq("id", movement.id);
  if (error) throw error;
}

export async function saveBomItem(item: BomItem) {
  const row = {
    id: item.id,
    product_id: item.productId,
    inventory_item_id: item.inventoryItemId,
    quantity_per_unit: item.quantityPerUnit,
    notes: item.notes.trim(),
  };
  const result = item.bomNo
    ? await supabase.from("product_materials").update(row).eq("id", item.id)
    : await supabase.from("product_materials").insert(row);
  const { error } = result;
  if (error) throw error;
}

export async function deleteBomItem(id: string) {
  const { error } = await supabase.from("product_materials").delete().eq("id", id);
  if (error) throw error;
}
