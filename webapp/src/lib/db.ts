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

export async function fetchAll() {
  const [clientsRes, productsRes, ordersRes] = await Promise.all([
    supabase.from("clients").select("*").order("name"),
    supabase.from("products").select("*").order("product_name"),
    supabase.from("orders").select("*").order("delivery_date"),
  ]);
  if (clientsRes.error) throw clientsRes.error;
  if (productsRes.error) throw productsRes.error;
  if (ordersRes.error) throw ordersRes.error;
  return {
    clients: (clientsRes.data as ClientRow[]).map(clientFromRow),
    products: (productsRes.data as ProductRow[]).map(productFromRow),
    orders: (ordersRes.data as OrderRow[]).map(orderFromRow),
  };
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

function drawingExtension(mime: string): string {
  return mime.split("/")[1]?.split("+")[0] || "png";
}

// One entry is emitted per slot, including empty ones, so indices keep lining
// up with the form. Skipping empties would shift every later drawing down a
// slot and scramble the numbering after a save and reload.
async function persistDrawings(productId: string, drawings: string[], existingPaths: string[]): Promise<DrawingRef[]> {
  const out: DrawingRef[] = [];
  const plan = planDrawingSlots(drawings, existingPaths);
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (step.kind === "keep") {
      out.push({ path: step.path });
      continue;
    }
    const d = drawings[i];
    const bytes = Uint8Array.from(atob(d.split(",")[1]), c => c.charCodeAt(0));
    const path = `${productId}/${Date.now()}-${i}.${drawingExtension(step.mime)}`;
    const { error } = await supabase.storage.from("product-drawings").upload(path, bytes, { contentType: step.mime, upsert: true });
    if (error) throw error;
    out.push({ path });
  }
  return out;
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
  for (const signed of data ?? []) {
    const original = wanted.find(x => x.p === signed.path);
    if (original && signed.signedUrl) out[original.i] = signed.signedUrl;
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

export async function upsertOrder(o: OrderRecord): Promise<OrderRecord> {
  const { data, error } = await supabase
    .from("orders")
    .upsert({ id: o.id, ...orderToRow(o) })
    .select()
    .single();
  if (error) throw error;
  return orderFromRow(data as OrderRow);
}

export async function deleteOrder(id: string): Promise<void> {
  const { error } = await supabase.from("orders").delete().eq("id", id);
  if (error) throw error;
}
