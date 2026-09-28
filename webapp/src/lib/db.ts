import { supabase } from "./supabaseClient";
import type { Client, Product, ProductTask, OrderRecord } from "../App";

// DB columns are snake_case; the UI types are camelCase. This module is the
// only translation between the two.

interface ClientRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  postal_code: string;
  address: string;
}

// A drawing is referenced by its Storage object key and nothing else. The
// bucket is private, so a key is the only durable handle: a display URL is
// minted on demand and expires, which makes it unfit for storage. Rows written
// before migration 009 also carry a "url" key, which is now ignored.
interface DrawingRef {
  path: string;
  url?: string;
}

interface ProductRow {
  id: string;
  client_name: string;
  product_name: string;
  product_number: string;
  unit_price: number;
  tasks: ProductTask[];
  drawings: DrawingRef[];
}

interface OrderRow {
  id: string;
  order_date: string;
  delivery_date: string;
  client: string;
  order_number: string;
  product_name: string;
  quantity: number;
  order_amount: number;
  progress: string;
  required_manhours: number;
  worked_manhours: number;
  production_end_date: string | null;
  order_contact: string;
  contact_contents: string;
  finish_task: boolean;
  has_contact: boolean;
  completed_tasks: boolean[];
  version: number;
  inventory_stock_applied: boolean;
}

function clientFromRow(r: ClientRow): Client {
  return { id: r.id, name: r.name, phone: r.phone, email: r.email, postalCode: r.postal_code, address: r.address };
}

function clientToRow(c: Client) {
  return { name: c.name, phone: c.phone, email: c.email, postal_code: c.postalCode, address: c.address };
}

// Drawings are stored as Storage refs, one entry per slot, index aligned with
// the form so that emptying slot 1 does not slide every later drawing down a
// slot. Only the path round-trips through here; the caller mints display URLs
// separately because they expire.
function productFromRow(r: ProductRow): Product {
  const drawings = r.drawings ?? [];
  return {
    id: r.id,
    clientName: r.client_name,
    productName: r.product_name,
    productNumber: r.product_number,
    unitPrice: r.unit_price,
    tasks: r.tasks ?? [],
    // Deliberately blank: the row holds keys, not displayable URLs. The caller
    // signs the ones it needs, and only for the product actually opened.
    drawings: drawings.map(() => ""),
    drawingPaths: drawings.map(d => d?.path ?? ""),
  };
}

// Same shape for the list projection, which never carries the heavy columns.
// The blank placeholders keep a list product distinguishable from an unedited
// one, and the product form refetches the real row when it is opened.
function productListFromRow(r: ProductListRow): Product {
  return {
    id: r.id,
    clientName: r.client_name,
    productName: r.product_name,
    productNumber: r.product_number,
    unitPrice: r.unit_price,
    tasks: [],
    drawings: [],
    drawingPaths: [],
  };
}

function productToRow(p: Product, drawingRefs: DrawingRef[]) {
  return {
    client_name: p.clientName,
    product_name: p.productName,
    product_number: p.productNumber,
    unit_price: p.unitPrice === "" ? 0 : p.unitPrice,
    tasks: p.tasks,
    drawings: drawingRefs,
  };
}

function orderFromRow(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    orderDate: r.order_date,
    deliveryDate: r.delivery_date,
    client: r.client,
    orderNumber: r.order_number,
    productName: r.product_name,
    quantity: r.quantity,
    orderAmount: r.order_amount,
    progress: r.progress,
    requiredManhours: r.required_manhours,
    workedManhours: r.worked_manhours,
    productionEndDate: r.production_end_date ?? "",
    orderContact: r.order_contact,
    contactContents: r.contact_contents,
    finishTask: r.finish_task,
    hasContact: r.has_contact,
    completedTasks: r.completed_tasks ?? [],
    version: r.version ?? 1,
    materialsIssued: r.inventory_stock_applied ?? false,
  };
}

function orderToRow(o: OrderRecord) {
  return {
    order_date: o.orderDate,
    delivery_date: o.deliveryDate,
    client: o.client,
    order_number: o.orderNumber,
    product_name: o.productName,
    quantity: o.quantity,
    order_amount: o.orderAmount,
    progress: o.progress,
    required_manhours: o.requiredManhours,
    worked_manhours: o.workedManhours,
    production_end_date: o.productionEndDate || null,
    order_contact: o.orderContact,
    contact_contents: o.contactContents,
    finish_task: o.finishTask,
    has_contact: o.hasContact,
    completed_tasks: o.completedTasks ?? [],
  };
}

// ---- Fetch (initial load) ----

// Product lists and the order board never render a drawing or a task schedule,
// so selecting "*" shipped the 54-entry tasks jsonb and the drawings jsonb for
// every product on every load. The product form asks for them itself when a
// product is opened, which is the only place they are displayed.
const PRODUCT_LIST_COLUMNS =
  "id, client_name, product_name, product_number, unit_price, updated_at";

// The list projection omits tasks and drawings, so it needs its own row type
// instead of being forced through ProductRow.
type ProductListRow = Omit<ProductRow, "tasks" | "drawings">;

export async function fetchAll() {
  const [clientsRes, productsRes, ordersRes] = await Promise.all([
    supabase.from("clients").select("*").order("name"),
    supabase.from("products").select(PRODUCT_LIST_COLUMNS).order("product_name"),
    supabase.from("orders").select("*").order("delivery_date"),
  ]);
  if (clientsRes.error) throw clientsRes.error;
  if (productsRes.error) throw productsRes.error;
  if (ordersRes.error) throw ordersRes.error;
  return {
    clients: (clientsRes.data as ClientRow[]).map(clientFromRow),
    products: (productsRes.data as ProductListRow[]).map(productListFromRow),
    orders: (ordersRes.data as OrderRow[]).map(orderFromRow),
  };
}

// Full product row including tasks and drawing keys, for the product form only.
export async function fetchProduct(id: string): Promise<Product | null> {
  const { data, error } = await supabase.from("products").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? productFromRow(data as ProductRow) : null;
}

// ---- Clients ----

export async function upsertClient(c: Client): Promise<Client> {
  const { data, error } = await supabase
    .from("clients")
    .upsert({ id: c.id, ...clientToRow(c) })
    .select()
    .single();
  if (error) throw error;
  return clientFromRow(data as ClientRow);
}

export async function deleteClient(id: string): Promise<void> {
  const { error } = await supabase.from("clients").delete().eq("id", id);
  if (error) throw error;
}

// Drawings arrive from the UI as either a data URI for a freshly picked file or
// a display string for a slot that was never re-edited. Only data URIs are
// uploaded. Everything else keeps the Storage key recorded in existingPaths,
// which is why that array has to be threaded through: without it a save would
// have nothing durable to write and the drawing would be silently lost.
//
// What has to happen to each drawing slot on save, decided without touching the
// network so it can be reasoned about and tested on its own.
//
// existingPaths is authoritative for what stays stored, never the display
// string. A display string can be empty simply because signing has not finished
// yet, and treating that as a deletion would drop the drawing on a save that
// happened to land before the signed URLs arrived. The display string only ever
// decides whether a new file gets uploaded.
export type DrawingSlotPlan =
  | { kind: "upload"; mime: string }
  | { kind: "keep"; path: string };

export function planDrawingSlots(drawings: string[], existingPaths: string[]): DrawingSlotPlan[] {
  return drawings.map((d, i) => {
    if (d && d.startsWith("data:")) {
      const [, mime = "image/png"] = /^data:([^;]+);base64,/.exec(d) ?? [];
      return { kind: "upload", mime };
    }
    return { kind: "keep", path: existingPaths[i] ?? "" };
  });
}

// One entry is emitted per slot, including empty ones, so indices keep lining
// up with the form. Skipping empties would shift every later drawing down a
// slot and scramble the numbering after a save and reload.
//
// The bucket is bounded to 10 MB and a MIME allowlist (migration 010), and the
// same allowlist is applied here. Accepting a client-declared type unchecked
// would let an .svg or .html through, and the signed URL then serves it with
// that content type from the project's own storage origin.
export const DRAWING_MAX_BYTES = 10 * 1024 * 1024;
const DRAWING_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function validateDrawingFile(file: File): string | null {
  if (!DRAWING_MIME.has(file.type)) {
    return `Unsupported file type (${file.type || "unknown"}). Use JPG, PNG, WebP or PDF.`;
  }
  if (file.size > DRAWING_MAX_BYTES) {
    return `File is too large (${(file.size / 1048576).toFixed(1)} MB). The limit is 10 MB.`;
  }
  return null;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function drawingExtension(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? "png";
}

async function persistDrawings(productId: string, drawings: string[], existingPaths: string[]): Promise<DrawingRef[]> {
  const plan = planDrawingSlots(drawings, existingPaths);
  const out: DrawingRef[] = new Array(plan.length);

  // Uploads are independent, so they run together with a small concurrency cap
  // instead of one roundtrip after another. Slot order is preserved by writing
  // into the output array by index rather than pushing.
  const pending: Promise<void>[] = [];
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (step.kind === "keep") {
      out[i] = { path: step.path };
      continue;
    }
    const d = drawings[i];
    const path = `${productId}/${Date.now()}-${i}.${drawingExtension(step.mime)}`;
    pending.push(
      (async () => {
        const { error } = await supabase.storage
          .from("product-drawings")
          .upload(path, dataUriToBytes(d), { contentType: step.mime, upsert: true });
        if (error) throw error;
        out[i] = { path };
      })(),
    );
  }
  await Promise.all(pending);
  return out;
}

// Uint8Array.from(string, mapFn) invokes the callback once per byte, which is
// several million calls for a multi-megabyte drawing. A manual loop over a
// pre-allocated buffer is the same result at a fraction of the cost.
function dataUriToBytes(dataUri: string): Uint8Array {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Mints short lived signed URLs for a product's stored drawings. The bucket is
// private (migration 009), so this is the only way to display one. Kept out of
// fetchAll on purpose: signing every drawing of every product on a three second
// poll would be pure waste, and the product list does not show images. Callers
// sign only the product actually opened for editing.
const SIGNED_URL_TTL_SECONDS = 3600;

export async function signProductDrawings(paths: string[]): Promise<string[]> {
  const wanted = paths.map((p, i) => ({ p, i })).filter(x => x.p);
  if (wanted.length === 0) return paths.map(() => "");

  const { data, error } = await supabase.storage
    .from("product-drawings")
    .createSignedUrls(wanted.map(x => x.p), SIGNED_URL_TTL_SECONDS);
  if (error) throw error;

  const out = paths.map(() => "");
  const byPath = new Map<string, number>(wanted.map(x => [x.p, x.i]));
  for (const signed of data ?? []) {
    if (!signed.path) continue;
    const index = byPath.get(signed.path);
    if (index !== undefined && signed.signedUrl) out[index] = signed.signedUrl;
  }
  return out;
}

export async function upsertProduct(p: Product): Promise<Product> {
  const drawingRefs = await persistDrawings(p.id, p.drawings, p.drawingPaths);
  const { data, error } = await supabase
    .from("products")
    .upsert({ id: p.id, ...productToRow(p, drawingRefs) })
    .select()
    .single();
  if (error) throw error;
  return productFromRow(data as ProductRow);
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from("products").delete().eq("id", id);
  if (error) throw error;
}

// ---- Orders ----

// Concurrent edit protection.
//
// upsertOrder used to write all sixteen columns with no precondition, so two
// operators editing the same order produced a silent last-write-wins. The
// worst case was not a lost field: reverting progress made the BOM trigger post
// a material reversal, handing back stock for goods that had already shipped.
//
// The database carries a version column that the trigger bumps on every write.
// A save sends the version it read and only applies if it still matches. A miss
// is a conflict the user has to resolve by reloading, never a silent overwrite.
export class StaleOrderError extends Error {
  constructor(public readonly orderId: string) {
    super("This order was changed by someone else while you were editing it. Reload to see the current values, then reapply your change.");
    this.name = "StaleOrderError";
  }
}

export async function upsertOrder(o: OrderRecord): Promise<OrderRecord> {
  const expectedVersion = o.version ?? 1;

  const { data, error } = await supabase
    .from("orders")
    .update({ ...orderToRow(o), version: expectedVersion + 1 })
    .eq("id", o.id)
    .eq("version", expectedVersion)
    .select()
    .single();

  if (error) {
    // Postgres reports a missing row on .single() as 0 rows. That is either a
    // genuinely new order or a version that has moved on, so distinguish the
    // two before deciding to insert.
    const { data: existing } = await supabase
      .from("orders")
      .select("id, version")
      .eq("id", o.id)
      .maybeSingle();
    if (existing) throw new StaleOrderError(o.id);
  }

  if (data) return orderFromRow(data as OrderRow);

  const { data: inserted, error: insertError } = await supabase
    .from("orders")
    .insert({ id: o.id, ...orderToRow(o), version: 1 })
    .select()
    .single();
  if (insertError) throw insertError;
  return orderFromRow(inserted as OrderRow);
}

export async function deleteOrder(id: string): Promise<void> {
  const { error } = await supabase.from("orders").delete().eq("id", id);
  if (error) throw error;
}
