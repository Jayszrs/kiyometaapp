import { supabase } from "./supabaseClient";
import type { Client, Product, ProductTask, OrderRecord } from "../App";

// ---- Row <-> app-model mapping ----
// DB columns are snake_case; the UI's TS interfaces (carried over unchanged
// from the design) are camelCase. These functions are the only place that
// translates between the two.

interface ClientRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  postal_code: string;
  address: string;
}

interface ProductRow {
  id: string;
  client_name: string;
  product_name: string;
  product_number: string;
  unit_price: number;
  tasks: ProductTask[];
  drawings: { path: string; url: string }[];
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

// Drawings are stored as Supabase Storage refs ({path, url}); the UI only
// ever reads/writes a plain string (the <img src> / data URI), so drawing
// rows are widened to string[] the moment they leave this module.
function productFromRow(r: ProductRow): Product {
  return {
    id: r.id,
    clientName: r.client_name,
    productName: r.product_name,
    productNumber: r.product_number,
    unitPrice: r.unit_price,
    tasks: r.tasks ?? [],
    drawings: (r.drawings ?? []).map(d => d.url),
  };
}

function productToRow(p: Product, drawingRefs: { path: string; url: string }[]) {
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

// ---- Products ----
// New drawing entries arrive from the UI as data: URIs (FileReader output);
// existing ones are already https:// storage URLs — only the former need
// uploading.

async function persistDrawings(productId: string, drawings: string[]): Promise<{ path: string; url: string }[]> {
  const out: { path: string; url: string }[] = [];
  for (let i = 0; i < drawings.length; i++) {
    const d = drawings[i];
    if (!d) continue;
    if (d.startsWith("data:")) {
      const [, mime = "image/png"] = /^data:([^;]+);base64,/.exec(d) ?? [];
      const ext = mime.split("/")[1]?.split("+")[0] || "png";
      const bytes = Uint8Array.from(atob(d.split(",")[1]), c => c.charCodeAt(0));
      const path = `${productId}/${Date.now()}-${i}.${ext}`;
      const { error } = await supabase.storage.from("product-drawings").upload(path, bytes, { contentType: mime, upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from("product-drawings").getPublicUrl(path);
      out.push({ path, url: data.publicUrl });
    } else {
      out.push({ path: "", url: d });
    }
  }
  return out;
}

export async function upsertProduct(p: Product): Promise<Product> {
  const drawingRefs = await persistDrawings(p.id, p.drawings);
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
