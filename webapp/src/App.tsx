import { useState, useMemo, useEffect, useRef } from "react";
import { useAuth } from "./lib/auth";
import { fetchAll, upsertOrder, deleteOrder, upsertClient, deleteClient, upsertProduct, deleteProduct } from "./lib/db";
import { genUUID } from "./lib/uuid";

// ---- Types ----

type Page =
  | "home"
  | "order-entry"
  | "search-billing"
  | "invoice"
  | "client-master"
  | "product-master"
  | "delivery-slip"
  | "schedule"
  | "checklist";

type DeliverySlipMode = "single" | "multiple";

type ScanStage = "idle" | "need-client" | "need-product" | "filling";

interface ScanFillData {
  // Order form
  orderDate: string;
  deliveryDate: string;
  client: string;
  orderNumber: string;
  productName: string;
  quantity: number;
  orderAmount: number;
  // Client master (for routing)
  clientPhone: string;
  clientAddress: string;
  clientPostalCode: string;
  // Product master (for routing)
  productNumber: string;
  unitPrice: number;
}

interface ScanRouting {
  stage: ScanStage;
  data: ScanFillData | null;
}

export interface OrderRecord {
  id: string;
  orderDate: string;
  deliveryDate: string;
  client: string;
  orderNumber: string;
  productName: string;
  quantity: number;
  orderAmount: number;
  progress: string;
  requiredManhours: number;
  workedManhours: number;
  productionEndDate: string;
  orderContact: string;
  contactContents: string;
  finishTask: boolean;
  hasContact: boolean;
  completedTasks?: boolean[];
}

export interface Client {
  id: string;
  name: string;
  phone: string;
  email: string;
  postalCode: string;
  address: string;
}

export interface ProductTask {
  content: string;
  time: number | "";
}

export interface Product {
  id: string;
  clientName: string;
  productName: string;
  productNumber: string;
  unitPrice: number | "";
  tasks: ProductTask[];
  drawings: string[];
}

type FormErrors = Record<string, string>;

// ---- Icons ----

const PATHS: Record<string, string> = {
  menu: "M4 6h16M4 12h16M4 18h16",
  home: "M3 12l9-9 9 9M5 10v10h4v-5h6v5h4V10",
  close: "M6 6l12 12M6 18L18 6",
  search: "M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z",
  "chevron-left": "M15 18l-6-6 6-6",
  "chevron-right": "M9 18l6-6-6-6",
  save: "M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2zM17 21v-8H7v8M7 3v5h8",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  plus: "M12 5v14M5 12h14",
  printer: "M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z",
  "file-text": "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  scan: "M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M7 12h10",
  users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 7a4 4 0 100 8 4 4 0 000-8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75",
  package: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 001 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12",
  "arrow-right": "M5 12h14M12 5l7 7-7 7",
  check: "M20 6L9 17l-5-5",
  share: "M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98M21 5a3 3 0 11-6 0 3 3 0 016 0zM9 12a3 3 0 11-6 0 3 3 0 016 0zM21 19a3 3 0 11-6 0 3 3 0 016 0z",
  "file-invoice": "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M12 18v-6M9 15h6",
  truck: "M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM18.5 19a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 8h.01M12 12v4",
  "alert-triangle": "M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01",
  image: "M21 15l-5-5L5 21M3 3h18v18H3zM8.5 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z",
};

export function Icon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-hidden>
      <path stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d={PATHS[name] ?? ""} />
    </svg>
  );
}

// ---- Sample data ----

const today = new Date().toISOString().slice(0, 10);

function makeTasks(count = 54): ProductTask[] {
  return Array.from({ length: count }, () => ({ content: "", time: "" as number | "" }));
}

function makeDrawings(count = 4): string[] {
  return Array.from({ length: count }, () => "");
}

const PROGRESS_OPTIONS = [
  "Order request",
  "Receipt",
  "In preparation",
  "Preparation complete",
  "In production",
  "Complete",
  "Shipped",
];

const PROGRESS_JA: Record<string, string> = {
  "Order request": "発注依頼",
  "Receipt": "受領",
  "In preparation": "準備中",
  "Preparation complete": "準備完了",
  "In production": "製作中",
  "Complete": "完了",
  "Shipped": "出荷済み",
  "Contact": "要連絡",
};

const SCHEDULE_STATUSES = [
  "Order request",
  "Receipt",
  "In preparation",
  "Preparation complete",
  "In production",
  "Complete",
  "Shipped",
  "Contact",
];

const SCHEDULE_STATUS_COLORS: Record<string, string> = {
  "Order request": "bg-pink-500 text-white border-pink-600",
  "Receipt": "bg-pink-200 text-slate-800 border-pink-300",
  "In preparation": "bg-purple-500 text-white border-purple-600",
  "Preparation complete": "bg-green-400 text-slate-800 border-green-500",
  "In production": "bg-cyan-400 text-slate-800 border-cyan-500",
  "Complete": "bg-blue-600 text-white border-blue-700",
  "Shipped": "bg-yellow-400 text-slate-800 border-yellow-500",
  "Contact": "bg-red-600 text-white border-red-700",
};

const ARRANGEMENT_OPTIONS = [
  "Material procurement",
  "Subcontracting",
  "Machine scheduling",
  "Labor assignment",
  "No arrangement",
];

// ---- Scan documents ----
// Doc 1 & 2: existing clients/products -> direct fill
// Doc 3: new client + new product -> triggers routing

const SCAN_DOCS: { label: string; fields: { label: string; source: string; target: string; page: string }[]; data: ScanFillData }[] = [
  {
    label: "Shinwa Technos",
    data: { orderDate: "2026-08-17", deliveryDate: "2026-08-20", client: "Shinwa Technos Co., Ltd.", orderNumber: "210266", productName: "Tank", quantity: 3, orderAmount: 15000, clientPhone: "0266-28-0105", clientAddress: "Nagano-ken Suwa-gun Shimosuwa-machi 4611-90", clientPostalCode: "393-0011", productNumber: "NHD-F1772-11", unitPrice: 5000 },
    fields: [
      { label: "Order date", source: "2026/08/17", target: "Order entry: order date", page: "P1" },
      { label: "Delivery date", source: "08/20", target: "Order entry: delivery date", page: "P1" },
      { label: "Client", source: "Shinwa Technos Co., Ltd.", target: "Order entry: client / Client master: name", page: "P1+P4" },
      { label: "Order no.", source: "210266", target: "Order entry: order number", page: "P1" },
      { label: "Drawing no.", source: "NHD-F1772-11", target: "Product master: product number", page: "P5" },
      { label: "Part name", source: "Tank", target: "Order entry: product name / Product master: name", page: "P1+P5" },
      { label: "Quantity", source: "3", target: "Order entry: quantity", page: "P1" },
      { label: "Unit price", source: "¥5,000", target: "Product master: unit price", page: "P5" },
      { label: "Total", source: "¥15,000", target: "Order entry: order amount", page: "P1" },
      { label: "Address", source: "Shimosuwa-machi 4611-90", target: "Client master: address", page: "P4" },
      { label: "Phone", source: "0266-28-0105", target: "Client master: phone number", page: "P4" },
    ],
  },
  {
    label: "Masuda Corp.",
    data: { orderDate: "2026-07-27", deliveryDate: "2026-08-03", client: "Masuda Corp. Sheet Metal Dept.", orderNumber: "MS294541", productName: "Tank (TOP)", quantity: 1, orderAmount: 6000, clientPhone: "0265-85-2100", clientAddress: "Nagano-ken Kamiina-gun Miyada-mura 6623-2", clientPostalCode: "399-4301", productNumber: "NSQ-F0124-05", unitPrice: 6000 },
    fields: [
      { label: "Order date", source: "26/07/27", target: "Order entry: order date", page: "P1" },
      { label: "Delivery date", source: "26/08/03", target: "Order entry: delivery date", page: "P1" },
      { label: "Client", source: "Masuda Corp. Sheet Metal Dept.", target: "Order entry: client / Client master: name", page: "P1+P4" },
      { label: "Order no.", source: "MS294541", target: "Order entry: order number", page: "P1" },
      { label: "Item code", source: "NSQ-F0124-05", target: "Product master: product number", page: "P5" },
      { label: "Item name", source: "Tank (TOP)", target: "Order entry: product name / Product master: name", page: "P1+P5" },
      { label: "Quantity", source: "1", target: "Order entry: quantity", page: "P1" },
      { label: "Unit price", source: "¥6,000", target: "Product master: unit price", page: "P5" },
      { label: "Order amount", source: "¥6,000", target: "Order entry: order amount", page: "P1" },
      { label: "Postal + address", source: "399-4301 Miyada-mura 6623-2", target: "Client master: postal code + address", page: "P4" },
    ],
  },
  {
    label: "Nakamura Precision (new)",
    data: { orderDate: "2026-09-10", deliveryDate: "2026-09-18", client: "Nakamura Precision Works Ltd.", orderNumber: "NKM-00931", productName: "Bracket plate", quantity: 10, orderAmount: 45000, clientPhone: "054-321-7890", clientAddress: "Shizuoka-ken Hamamatsu-shi Naka-ku Takajo 1-5-3", clientPostalCode: "430-0901", productNumber: "NKM-BP-220", unitPrice: 4500 },
    fields: [
      { label: "Order date", source: "2026/09/10", target: "Order entry: order date", page: "P1" },
      { label: "Delivery date", source: "2026/09/18", target: "Order entry: delivery date", page: "P1" },
      { label: "Client", source: "Nakamura Precision Works Ltd.", target: "Order entry: client / Client master: name", page: "P1+P4" },
      { label: "Order no.", source: "NKM-00931", target: "Order entry: order number", page: "P1" },
      { label: "Part code", source: "NKM-BP-220", target: "Product master: product number", page: "P5" },
      { label: "Part name", source: "Bracket plate", target: "Order entry: product name / Product master: name", page: "P1+P5" },
      { label: "Quantity", source: "10", target: "Order entry: quantity", page: "P1" },
      { label: "Unit price", source: "¥4,500", target: "Product master: unit price", page: "P5" },
      { label: "Total", source: "¥45,000", target: "Order entry: order amount", page: "P1" },
      { label: "Phone", source: "054-321-7890", target: "Client master: phone number", page: "P4" },
      { label: "Address", source: "Hamamatsu-shi Naka-ku Takajo 1-5-3", target: "Client master: address", page: "P4" },
    ],
  },
];

const PAGE_TAG: Record<string, string> = {
  P1: "bg-blue-700 text-white",
  "P1+P4": "bg-violet-700 text-white",
  "P1+P5": "bg-teal-700 text-white",
  P4: "bg-orange-600 text-white",
  P5: "bg-green-700 text-white",
};

// ---- Validation ----

const ALPHANUM = /^[a-zA-Z0-9\-_ ]*$/;
const PHONE_RE = /^[0-9\-]*$/;
const POSTAL_RE = /^\d{3}-\d{4}$/;

function validateOrder(form: OrderRecord, clients: Client[], products: Product[]): FormErrors {
  const e: FormErrors = {};

  if (!form.orderDate) e.orderDate = "Order date is required.";

  if (!form.deliveryDate) {
    e.deliveryDate = "Delivery date is required.";
  } else if (form.orderDate && form.deliveryDate < form.orderDate) {
    e.deliveryDate = "Delivery date must be equal to or later than the order date.";
  }

  if (!form.client) {
    e.client = "Client is required.";
  } else if (!clients.some(c => c.name === form.client)) {
    e.client = "Client must match an existing entry in the Client Master.";
  }

  if (form.orderNumber.length > 50) e.orderNumber = "Maximum 50 characters.";

  if (!form.productName) {
    e.productName = "Product name is required.";
  } else if (form.productName.length > 100) {
    e.productName = "Maximum 100 characters.";
  } else if (!products.some(p => p.productName === form.productName)) {
    e.productName = "Product must match an existing entry in the Product Master.";
  }

  if (!Number.isInteger(form.quantity) || form.quantity < 1 || form.quantity > 99999)
    e.quantity = "Must be a whole number between 1 and 99,999.";

  if (!Number.isInteger(form.orderAmount) || form.orderAmount < 0 || form.orderAmount > 999999999)
    e.orderAmount = "Must be a whole number from 0 to 999,999,999. No decimals.";

  if (!Number.isInteger(form.requiredManhours) || form.requiredManhours < 0 || form.requiredManhours > 9999)
    e.requiredManhours = "Must be a whole number from 0 to 9,999.";

  if (!Number.isInteger(form.workedManhours) || form.workedManhours < 0 || form.workedManhours > 9999)
    e.workedManhours = "Must be a whole number from 0 to 9,999.";
  else if (form.workedManhours > form.requiredManhours)
    e.workedManhours = "Worked man-hours cannot exceed required man-hours.";

  if (form.orderContact.length > 500)
    e.orderContact = `Maximum 500 characters (${form.orderContact.length} used).`;

  if (form.productionEndDate && form.orderDate && form.productionEndDate < form.orderDate)
    e.productionEndDate = "Cannot be earlier than the order date.";
  else if (form.productionEndDate && form.deliveryDate && form.productionEndDate > form.deliveryDate)
    e.productionEndDate = "Cannot be later than the delivery date.";

  return e;
}

function validateClient(form: Client, allClients: Client[], isNew: boolean): FormErrors {
  const e: FormErrors = {};

  if (!form.name) {
    e.name = "Client name is required.";
  } else if (form.name.length > 100) {
    e.name = "Maximum 100 characters.";
  } else if (isNew && allClients.some(c => c.name === form.name)) {
    e.name = "Client name must be unique. This name already exists.";
  }

  if (form.phone.length > 20) e.phone = "Maximum 20 characters.";
  else if (form.phone && !PHONE_RE.test(form.phone)) e.phone = "Only digits and hyphens are allowed.";

  if (form.postalCode && !POSTAL_RE.test(form.postalCode))
    e.postalCode = "Format must be: 3 digits, hyphen, 4 digits (e.g. 393-0011).";

  if (form.address.length > 255) e.address = "Maximum 255 characters.";

  return e;
}

function validateProduct(form: Product, allProducts: Product[], isNew: boolean): FormErrors {
  const e: FormErrors = {};

  if (!form.productName) {
    e.productName = "Product name is required.";
  } else if (form.productName.length > 100) {
    e.productName = "Maximum 100 characters.";
  }

  if (!form.productNumber) {
    e.productNumber = "Product number is required.";
  } else if (form.productNumber.length > 50) {
    e.productNumber = "Maximum 50 characters.";
  } else if (!ALPHANUM.test(form.productNumber)) {
    e.productNumber = "Only letters, numbers, hyphens, and underscores.";
  } else if (isNew && allProducts.some(p => p.clientName === form.clientName && p.productNumber === form.productNumber)) {
    e.productNumber = "Product number must be unique per client.";
  }

  const up = form.unitPrice === "" ? NaN : Number(form.unitPrice);
  if (isNaN(up) || !Number.isInteger(up) || up < 0 || up > 99999999)
    e.unitPrice = "Must be a whole number from 0 to 99,999,999.";

  form.tasks.forEach((t, i) => {
    if (t.content.length > 100)
      e[`task_content_${i}`] = `Row ${i + 1}: maximum 100 characters.`;
    if (t.time !== "") {
      const n = Number(t.time);
      if (isNaN(n) || n < 0 || n > 999.9)
        e[`task_time_${i}`] = `Row ${i + 1}: must be 0.0 to 999.9.`;
    }
  });

  return e;
}

// ---- UI primitives ----

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-sm font-600 text-slate-500 mb-1">{children}</span>;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <p className="flex items-center gap-1 mt-1 text-sm text-red-600">
      <Icon name="alert-triangle" size={13} className="shrink-0" />
      {msg}
    </p>
  );
}

function FieldBox({ label, error, children, className = "" }: {
  label: string; error?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={className}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      <FieldError msg={error} />
    </div>
  );
}

export function TextInput({ value, onChange, type = "text", placeholder = "", className = "", readOnly = false, hasError = false, maxLength, step }: {
  value: string | number; onChange?: (v: string) => void; type?: string;
  placeholder?: string; className?: string; readOnly?: boolean;
  hasError?: boolean; maxLength?: number; step?: string;
}) {
  const border = hasError
    ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
    : "border-slate-300 focus:border-[#1a3458] focus:ring-[#1a3458]/20";
  return (
    <input type={type} value={value} readOnly={readOnly} placeholder={placeholder}
      maxLength={maxLength} step={step}
      onChange={e => onChange?.(e.target.value)}
      className={`w-full px-3 py-2 text-base border rounded-sm bg-white focus:outline-none focus:ring-2 transition-colors ${border} ${readOnly ? "bg-slate-50 text-slate-400 cursor-default" : ""} ${className}`} />
  );
}

function SelectInput({ value, onChange, options, hasError = false, placeholder = "select...", className = "" }: {
  value: string; onChange: (v: string) => void; options: string[]; hasError?: boolean; placeholder?: string; className?: string;
}) {
  const border = hasError
    ? "border-red-400 focus:border-red-500"
    : "border-slate-300 focus:border-[#1a3458]";
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className={`w-full px-3 py-2 text-base border rounded-sm bg-white focus:outline-none transition-colors ${border} ${className}`}>
      {options.map(o => <option key={o} value={o}>{o || placeholder}</option>)}
    </select>
  );
}

type BtnVariant = "primary" | "action" | "danger" | "ghost" | "outline";

export function Btn({ children, onClick, variant = "outline", size = "md", disabled = false, className = "" }: {
  children: React.ReactNode; onClick?: () => void;
  variant?: BtnVariant; size?: "sm" | "md" | "lg"; disabled?: boolean; className?: string;
}) {
  const vars: Record<BtnVariant, string> = {
    primary: "bg-[#1a3458] hover:bg-[#112240] text-white border-[#1a3458]",
    action: "bg-[#0d7377] hover:bg-[#0a5a5e] text-white border-[#0d7377]",
    danger: "bg-red-600 hover:bg-red-700 text-white border-red-600",
    ghost: "bg-white/10 hover:bg-white/20 text-white border-white/30",
    outline: "bg-white hover:bg-slate-50 text-slate-700 border-slate-300 hover:border-slate-400",
  };
  const sizes = { sm: "px-3 py-1.5 text-sm gap-1.5", md: "px-4 py-2 text-base gap-2", lg: "px-6 py-2.5 text-base gap-2" };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center font-600 border rounded-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${vars[variant]} ${sizes[size]} ${className}`}>
      {children}
    </button>
  );
}

function StatusBadge({ status, small = false, lang }: { status: string; small?: boolean; lang?: Lang }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 font-500 border rounded-sm ${small ? "text-xs" : "text-sm"} ${SCHEDULE_STATUS_COLORS[status] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}>
      {lang === "ja" ? PROGRESS_JA[status] ?? status : status}
    </span>
  );
}

// ---- Scan routing banner ----

function ScanBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 px-5 py-3 bg-blue-50 border-b border-blue-200 shrink-0">
      <Icon name="info" size={17} className="text-blue-600 mt-0.5" />
      <p className="text-sm text-blue-800">{message}</p>
    </div>
  );
}

// ---- Shell ----

function AppShell({ children, onNavigate, showBack = false, backTarget = "home" as Page, backLabel = "Home", title, lang, setLang }: {
  children: React.ReactNode; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  showBack?: boolean; backTarget?: Page; backLabel?: string; title?: string;
  lang?: "ja" | "en"; setLang?: (l: "ja" | "en") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex flex-col h-full bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onNavigate={onNavigate} />
      <header className="flex items-center gap-2 px-4 py-3 bg-[#1a3458] text-white shrink-0">
        <button onClick={() => setMenuOpen(true)}
          className="p-1.5 rounded hover:bg-white/15 transition-colors cursor-pointer shrink-0" aria-label="Menu">
          <Icon name="menu" size={20} />
        </button>
        <span className="text-base font-600 flex-1">{title ?? "Kiyometa Order Management"}</span>
        {lang !== undefined && setLang && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-sm bg-white/10 shrink-0">
            <ToggleSwitch
              checked={lang === "en"}
              onChange={v => setLang(v ? "en" : "ja")}
              offLabel="日本語"
              onLabel="English"
              dark
            />
          </div>
        )}
        <UserMenuButton />
      </header>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
}

function UserMenuButton() {
  const { email, signOut } = useAuth();
  return (
    <button onClick={signOut} title="Sign out"
      className="flex items-center gap-1.5 text-sm text-blue-200 hover:text-white transition-colors cursor-pointer shrink-0">
      <Icon name="user" size={15} className="shrink-0" />
      <span className="max-w-[180px] truncate">{email}</span>
    </button>
  );
}

function NavDrawer({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void }) {
  if (!open) return null;
  const items = [
    { label: "Home", page: "home" as Page, icon: "home", desc: "Dashboard overview" },
    { label: "Order entry", page: "order-entry" as Page, icon: "file-text", desc: "Create and manage orders" },
    { label: "Search & billing", page: "search-billing" as Page, icon: "search", desc: "Search orders and print invoices" },
    { label: "Client master", page: "client-master" as Page, icon: "users", desc: "Manage client records" },
    { label: "Product master", page: "product-master" as Page, icon: "package", desc: "Manage product specifications" },
    { label: "Schedule", page: "schedule" as Page, icon: "calendar", desc: "Production schedule & capacity" },
  ];
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <nav className="relative w-72 bg-white h-full flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 bg-[#1a3458] text-white">
          <span className="font-600 text-base">Navigation</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20 cursor-pointer" aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex-1 py-2">
          {items.map(item => (
            <button key={item.label} onClick={() => { onNavigate(item.page); onClose(); }}
              className="w-full flex items-center gap-4 px-5 py-3 text-left hover:bg-slate-50 border-b border-slate-100 cursor-pointer transition-colors">
              <span className="flex items-center justify-center w-9 h-9 rounded bg-[#1a3458] text-white shrink-0">
                <Icon name={item.icon} size={16} />
              </span>
              <span className="text-base font-600 text-slate-800">{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

// ---- Scan modal ----

function targetToDataKey(target: string): keyof ScanFillData | null {
  const t = target.toLowerCase();
  if (t.includes("order date")) return "orderDate";
  if (t.includes("delivery date")) return "deliveryDate";
  if (t.includes("order number")) return "orderNumber";
  if (t.includes("order amount")) return "orderAmount";
  if (t.includes("unit price")) return "unitPrice";
  if (t.includes("product number")) return "productNumber";
  if (t.includes("product name")) return "productName";
  if (t.includes("quantity")) return "quantity";
  if (t.includes("phone")) return "clientPhone";
  if (t.includes("postal code")) return "clientPostalCode";
  if (t.includes("address")) return "clientAddress";
  if (t.includes("entry: client")) return "client";
  return null;
}

function ScanModal({ clients, products, onClose, onApply }: {
  clients: Client[];
  products: Product[];
  onClose: () => void;
  onApply: (data: ScanFillData, clientExists: boolean, productExists: boolean) => void;
}) {
  const [docIdx, setDocIdx] = useState(0);
  const [editedData, setEditedData] = useState<ScanFillData>({ ...SCAN_DOCS[0].data });

  useEffect(() => {
    setEditedData({ ...SCAN_DOCS[docIdx].data });
  }, [docIdx]);

  const doc = SCAN_DOCS[docIdx];

  const setField = (key: keyof ScanFillData, val: string) => {
    setEditedData(prev => ({
      ...prev,
      [key]: (key === "quantity" || key === "orderAmount") ? (parseInt(val.replace(/[^0-9]/g, ""), 10) || 0) : val,
    }));
  };

  const clientExists = clients.some(c => c.name === editedData.client);
  const productExists = products.some(
    p => p.productName === editedData.productName && p.clientName === editedData.client
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-white rounded-sm shadow-2xl flex flex-col max-h-[88vh] border border-slate-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <Icon name="scan" size={20} className="text-[#1a3458]" />
            <h2 className="text-lg font-700 text-slate-800">Scan quotation</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 cursor-pointer transition-colors">
            <Icon name="close" size={18} className="text-slate-500" />
          </button>
        </div>

        {/* Equal-width document tabs */}
        <div className="flex border-b border-slate-200">
          {SCAN_DOCS.map((d, i) => (
            <button key={i} onClick={() => setDocIdx(i)}
              className={`flex-1 h-10 px-3 text-sm font-600 border-r border-slate-200 last:border-r-0 transition-colors cursor-pointer whitespace-nowrap ${i === docIdx ? "bg-[#1a3458] text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              {d.label}
            </button>
          ))}
        </div>

        {/* Routing status */}
        <div className="flex gap-4 px-5 py-2.5 bg-slate-50 border-b border-slate-100 text-sm">
          <span className={`flex items-center gap-1.5 ${clientExists ? "text-green-700" : "text-amber-700"}`}>
            <Icon name={clientExists ? "check" : "alert-triangle"} size={14} />
            Client {clientExists ? "found" : "not in master"}
          </span>
          <span className="text-slate-300">,</span>
          <span className={`flex items-center gap-1.5 ${productExists ? "text-green-700" : "text-amber-700"}`}>
            <Icon name={productExists ? "check" : "alert-triangle"} size={14} />
            Product {productExists ? "found" : "not in master"}
          </span>
        </div>

        <div className="overflow-y-auto flex-1">
          <table className="w-full text-base border-collapse">
            <thead className="sticky top-0 bg-white border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-2.5 text-sm font-600 text-slate-500 w-32">Field</th>
                <th className="text-left px-4 py-2.5 text-sm font-600 text-slate-500">Value (edit to correct)</th>
              </tr>
            </thead>
            <tbody>
              {doc.fields.map((f, i) => {
                const dataKey = targetToDataKey(f.target);
                const val = dataKey ? String(editedData[dataKey] ?? f.source) : f.source;
                return (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="px-4 py-2 text-sm text-slate-500 align-middle">{f.label}</td>
                    <td className="px-4 py-1.5 align-middle">
                      {dataKey ? (
                        <input
                          type={dataKey === "orderDate" || dataKey === "deliveryDate" ? "date" : "text"}
                          value={val}
                          onChange={e => setField(dataKey, e.target.value)}
                          className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-200 rounded-sm focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 bg-white transition-colors"
                        />
                      ) : (
                        <span className="text-sm font-mono text-slate-400">{f.source}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-3 px-5 py-4 border-t border-slate-200">
          <Btn variant="outline" onClick={onClose}>Cancel</Btn>
          <div className="flex-1" />
          <Btn variant="primary" size="lg" onClick={() => onApply(editedData, clientExists, productExists)}>
            <Icon name="check" size={16} />
            {clientExists && productExists ? "Apply to form" : "Begin guided import"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ---- Page: Home ----

function HomePage({ orders, onNavigate, lang, setLang }: { orders: OrderRecord[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; lang: Lang; setLang: (l: Lang) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dateStr = new Date().toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const inProd = orders.filter(o => o.progress === "In production").length;
  const shipped = orders.filter(o => o.progress === "Shipped").length;

  const quickNav = [
    { label: t("orderEntry", lang), desc: "Create and manage orders", page: "order-entry" as Page, icon: "file-text" },
    { label: t("searchBilling", lang), desc: "Search orders, print invoices and delivery slips", page: "search-billing" as Page, icon: "search" },
    { label: t("clientMaster", lang), desc: "View and edit client information", page: "client-master" as Page, icon: "users" },
    { label: t("productMaster", lang), desc: "View and edit product specifications", page: "product-master" as Page, icon: "package" },
  ];

  return (
    <div className="flex flex-col h-full bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onNavigate={onNavigate} />
      <header className="flex items-center gap-3 px-4 py-3 bg-[#1a3458] text-white shrink-0">
        <button onClick={() => setMenuOpen(true)} className="p-1.5 rounded hover:bg-white/15 transition-colors cursor-pointer">
          <Icon name="menu" size={20} />
        </button>
        <div className="flex items-center gap-2.5 flex-1">
          <span className="flex items-center justify-center w-7 h-7 rounded bg-[#0d7377] text-white text-sm font-700 shrink-0">K</span>
          <span className="text-base font-600">{t("appTitle", lang)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-sm bg-white/10 shrink-0">
          <ToggleSwitch
            checked={lang === "en"}
            onChange={v => setLang(v ? "en" : "ja")}
            offLabel="日本語"
            onLabel="English"
            dark
          />
        </div>
        <UserMenuButton />
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-slate-200 bg-white">
          <div className="px-8 pt-7 pb-5 max-w-5xl mx-auto flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-700 text-[#1a3458]">{t("greeting", lang)}</h1>
              <p className="text-base text-slate-500 mt-1">{dateStr}</p>
            </div>
            <p className="text-sm text-slate-500 text-right">
              <span className="font-600 text-slate-700">{inProd}</span>{t("inProdSuffix", lang)},{" "}
              <span className="font-600 text-slate-700">{shipped}</span>{t("shippedSuffix", lang)}
            </p>
          </div>
        </div>

        <div className="px-8 py-6 max-w-5xl mx-auto space-y-6">

          {/* Row 1: Quick actions */}
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => onNavigate("order-entry")}
              className="flex items-center gap-3 px-5 py-4 bg-[#1a3458] text-white rounded-sm hover:bg-[#112240] transition-colors cursor-pointer">
              <Icon name="plus" size={20} className="text-blue-200 shrink-0" />
              <span className="font-700 text-base">{t("newOrder", lang)}</span>
            </button>
            <button onClick={() => onNavigate("order-entry")}
              className="flex items-center gap-3 px-5 py-4 bg-white border border-slate-200 rounded-sm hover:border-[#1a3458] transition-colors cursor-pointer group">
              <Icon name="scan" size={20} className="text-slate-400 group-hover:text-[#1a3458] transition-colors shrink-0" />
              <span className="font-700 text-base text-slate-800">{t("scanButton", lang)}</span>
            </button>
          </div>

          {/* Row 2: Sections */}
          <div>
            <p className="text-xs font-700 text-slate-400 mb-2">{t("sectionsHeader", lang)}</p>
            <div className="grid grid-cols-4 gap-2">
              {quickNav.map(item => (
                <button key={item.label} onClick={() => onNavigate(item.page)}
                  className="flex flex-col items-center gap-2 px-4 py-4 bg-white border border-slate-200 rounded-sm hover:border-[#1a3458] hover:bg-slate-50 cursor-pointer transition-colors text-center">
                  <span className="flex items-center justify-center w-9 h-9 rounded bg-[#f0f4f8] text-[#1a3458]">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="text-sm font-600 text-slate-800 leading-tight">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Row 3: Recent orders */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-700 text-slate-700">{t("recentOrders", lang)}</h2>
              <button onClick={() => onNavigate("order-entry")}
                className="flex items-center gap-1 text-sm text-[#0d7377] hover:text-[#0a5a5e] font-600 cursor-pointer transition-colors">
                {t("viewAll", lang)} <Icon name="chevron-right" size={14} />
              </button>
            </div>
            <div className="bg-white border border-slate-200 rounded-sm overflow-hidden">
              <table className="w-full text-base border-collapse">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th className="text-left px-4 py-2.5 text-sm font-600 text-slate-500">{t("productNameLabel", lang)}</th>
                    <th className="text-left px-4 py-2.5 text-sm font-600 text-slate-500">{t("clientLabel", lang)}</th>
                    <th className="text-right px-4 py-2.5 text-sm font-600 text-slate-500">{t("amountLabel", lang)}</th>
                    <th className="text-left px-4 py-2.5 text-sm font-600 text-slate-500">{t("progressLabel", lang)}</th>
                    <th className="text-right px-4 py-2.5 text-sm font-600 text-slate-500">{t("deliveryLabel", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map(o => (
                    <tr key={o.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 cursor-pointer transition-colors" onClick={() => onNavigate("order-entry")}>
                      <td className="px-4 py-3 font-500 text-slate-800">{o.productName}</td>
                      <td className="px-4 py-3 text-sm text-slate-500">{o.client.split(" ")[0]}</td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-slate-700">¥{o.orderAmount.toLocaleString()}</td>
                      <td className="px-4 py-3"><StatusBadge status={o.progress} lang={lang} /></td>
                      <td className="px-4 py-3 text-right font-mono text-sm text-slate-500">{o.deliveryDate}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}

// ---- Page 1: Order entry ----

// ---- Translations ----

const LABELS = {
  displayOrder:       { ja: "表示順",           en: "Display Order" },
  sortBy:             { ja: "並び替え基準",      en: "Sort by" },
  deliveryDate:       { ja: "納期",             en: "Delivery Date" },
  orderDate:          { ja: "受注日",           en: "Order Date" },
  direction:          { ja: "方向",             en: "Direction" },
  ascending:          { ja: "昇順",             en: "Ascending ↑" },
  descending:         { ja: "降順",             en: "Descending ↓" },
  filter:             { ja: "絞り込み",          en: "Filter" },
  progress:           { ja: "進捗状況",          en: "Progress" },
  "Order request":    { ja: "発注依頼",          en: "Order request" },
  "Receipt":          { ja: "受領",             en: "Receipt" },
  "In preparation":   { ja: "準備中",            en: "In preparation" },
  "Preparation complete": { ja: "準備完了",      en: "Preparation complete" },
  "In production":    { ja: "製作中",            en: "In production" },
  "Complete":         { ja: "完了",             en: "Complete" },
  "Shipped":          { ja: "出荷済み",          en: "Shipped" },
  orderDateLabel:     { ja: "受注日",           en: "Order Date" },
  deliveryDateLabel:  { ja: "納期",             en: "Delivery Date" },
  client:             { ja: "取引先",           en: "Client" },
  orderNumber:        { ja: "注文番号",          en: "Order Number" },
  productName:        { ja: "製品名",           en: "Product Name" },
  productNumber:      { ja: "製品番号",          en: "Product Number" },
  quantity:           { ja: "数量",             en: "Quantity" },
  orderAmount:        { ja: "受注金額",          en: "Order Amount" },
  autoBadge:          { ja: "自動",             en: "Auto" },
  yenUnit:            { ja: "円",              en: "¥" },
  manhours:           { ja: "工数",             en: "Man-hours" },
  requiredManhours:   { ja: "必要工数",          en: "Required" },
  workedManhours:     { ja: "作業工数",          en: "Worked" },
  remainingManhours:  { ja: "残り工数",          en: "Remaining" },
  productionEndDate:  { ja: "製作終了日",        en: "Production End Date" },
  progressStatus:     { ja: "進捗状況",          en: "Progress Status" },
  finishTask:         { ja: "終了作業",          en: "Finish Task" },
  done:               { ja: "完了",             en: "Done" },
  pending:            { ja: "未完了",            en: "Pending" },
  contact:            { ja: "連絡",             en: "Contact" },
  contactOff:         { ja: "オフ",             en: "Off" },
  contactOn:          { ja: "要手配",           en: "Required Arrangements" },
  orderContact:       { ja: "注文連絡",          en: "Order Contact" },
  contactContents:    { ja: "連絡内容",          en: "Contact Contents" },
  scanHint:           { ja: "見積書からフォームを自動入力", en: "Auto-fill from quotation" },
  scanButton:         { ja: "見積書スキャン",     en: "Scan quotation" },
  calc:               { ja: "計算",             en: "Calc" },
  searchBilling:      { ja: "検索・請求",        en: "Search & billing" },
  newButton:          { ja: "新規",             en: "New" },
  saveButton:         { ja: "保存",             en: "Save" },
  deleteButton:       { ja: "削除",             en: "Delete" },
  selectPlaceholder:  { ja: "選択...",          en: "select..." },
  searchItem:         { ja: "検索アイテム",      en: "Search Item" },
  searchPlaceholder:  { ja: "製品名・取引先",     en: "Product / Client" },
  deliveryDateFilter: { ja: "納期日",           en: "Delivery Date Filter" },
  toggleOff:          { ja: "オフ",             en: "Off" },
  toggleOn:           { ja: "オン",             en: "On" },
  afterDate:          { ja: "以降",             en: "After this date" },
  calendarDisplay:    { ja: "カレンダーに表示",   en: "Show on calendar" },
  searchPeriod:       { ja: "検索期間",          en: "Search Period" },
  sameDay:            { ja: "同日",             en: "Same Day" },
  oneMonth:           { ja: "1ヶ月",            en: "One Month" },
  fromLabel:          { ja: "自",              en: "From" },
  toLabel:            { ja: "至",              en: "To" },
  clientSection:      { ja: "取引先",           en: "Client" },
  statusSection:      { ja: "状態",             en: "Status" },
  dlvPrefix:          { ja: "納",              en: "Dlv" },
  orderNoPrefix:      { ja: "注文",             en: "Order No." },
  partNoPrefix:       { ja: "製番",             en: "Part No." },
  unitPriceLabel:     { ja: "単価",             en: "Unit Price" },
  qtyLabel:           { ja: "数量",             en: "Quantity" },
  taxExclAmount:      { ja: "税抜金額",          en: "Tax-excl. Amount" },
  qtyUnit:            { ja: "個",              en: "units" },
  prePrepPrint:       { ja: "事前準備印刷",      en: "Pre-preparation Print" },
  singleSlipPrint:    { ja: "単一納品書印刷",     en: "Single Delivery Slip Print" },
  multipleSlipPrint:  { ja: "複数納品書印刷",     en: "Multiple Delivery Slip Print" },
  invoicePrint:       { ja: "請求書印刷",        en: "Invoice Print" },
  csvCreate:          { ja: "CSV作成",          en: "CSV Creation" },
  errorBanner:        { ja: "保存前に以下のエラーを修正してください。", en: "Please correct the following errors before saving:" },
  clientMaster:       { ja: "取引先マスタ",      en: "Client Master" },
  backButton:         { ja: "ホーム",           en: "Home" },
  searchClients:      { ja: "取引先を検索...",   en: "Search clients..." },
  clientDetails:      { ja: "取引先詳細",        en: "Client Details" },
  editingPrefix:      { ja: "編集中",           en: "Editing" },
  newClient:          { ja: "新規取引先",        en: "New Client" },
  clientNameLabel:    { ja: "取引先名",          en: "Client name" },
  phoneNumber:        { ja: "電話番号",          en: "Phone number" },
  emailAddress:       { ja: "メールアドレス",     en: "Email address" },
  postalCodeLabel:    { ja: "郵便番号",          en: "Postal code" },
  addressLabel:       { ja: "住所",             en: "Address" },
  noClientsFound:     { ja: "該当する取引先が見つかりません", en: "No clients found" },
  saveAndContinue:    { ja: "保存して続行",       en: "Save & continue" },
  addressAutoFill:    { ja: "[自動] 郵便番号 {postal} の住所", en: "[Auto-filled] Address for postal code {postal}" },
  productMaster:      { ja: "製品マスタ",        en: "Product Master" },
  searchItemPlaceholder: { ja: "製品名・品番を検索...", en: "Search items by name or number..." },
  appTitle:         { ja: "キヨメタ受注管理V2",   en: "Kiyometa Order Management" },
  greeting:         { ja: "おはようございます",   en: "Good morning" },
  inProdSuffix:     { ja: "件 製作中",           en: " in production" },
  shippedSuffix:    { ja: "件 出荷済み",         en: " shipped" },
  newOrder:         { ja: "新規",              en: "New order" },
  sectionsHeader:   { ja: "セクション",          en: "Sections" },
  orderEntry:       { ja: "受注登録",           en: "Order entry" },
  recentOrders:     { ja: "最近の受注",          en: "Recent orders" },
  viewAll:          { ja: "すべて見る",          en: "View all" },
  clientLabel:      { ja: "取引先",             en: "Client" },
  amountLabel:      { ja: "受注金額",           en: "Amount" },
  progressLabel:    { ja: "進捗状況",           en: "Progress" },
  deliveryLabel:    { ja: "納期",              en: "Delivery" },
  invoiceTitle:     { ja: "請求書",             en: "Invoice" },
  prevPage:         { ja: "前へ",              en: "Previous page" },
  nextPage:         { ja: "次へ",              en: "Next page" },
  printButton:      { ja: "印刷",              en: "Print" },
  pageOf:           { ja: "{c} / {t}",         en: "page {c} of {t}" },
  billingDateLabel: { ja: "請求日",             en: "Billing date" },
  paymentDeadline:  { ja: "お支払い期限",        en: "Payment deadline" },
  subjectPrefix:    { ja: "件名:",             en: "Subject:" },
  totalAmount:      { ja: "合計金額",           en: "Total Amount" },
  taxRate:          { ja: "税率",              en: "Tax Rate" },
  taxAmount:        { ja: "消費税額",           en: "Tax Amount" },
  billedAmount:     { ja: "お請求金額",         en: "Billed Amount" },
  invoiceAmount:    { ja: "金額",              en: "Amount" },
  itemLabel:        { ja: "品目",              en: "Product / Item" },
  sendersCompany:   { ja: "株式会社キヨメタ",     en: "Kiyometa" },
  returnButton:     { ja: "戻る",              en: "Return" },
  orderNotFound:    { ja: "注文が見つかりません。", en: "Order not found." },
  tasksButton:      { ja: "作業",              en: "Tasks" },
  saveAndReturn:    { ja: "登録して戻る",        en: "Save & Return" },
  toCad:            { ja: "CAD図面へ",          en: "To CAD" },
  taskLabelPrefix:  { ja: "作業",              en: "Task " },
  deliverySlipTitle: { ja: "納品書",            en: "Delivery slip" },
  inCharge:         { ja: "担当",              en: "In charge" },
  deliveryConditions:{ ja: "納入条件",          en: "Delivery conditions" },
  paymentTerms:     { ja: "お支払い条件",        en: "Payment terms" },
  orderNoLabel:     { ja: "発注 No.",           en: "Order No." },
  consumptionTax:   { ja: "消費税",             en: "Consumption tax" },
  taxIncludedAmount:{ ja: "税込金額",           en: "Tax-included amount" },
  scheduleTitle:    { ja: "生産スケジュール",     en: "Schedule & Capacity" },
  scheduleFilter:   { ja: "状態フィルタ",        en: "Status filter" },
  remainingHeads:   { ja: "残",               en: "Remaining" },
  headsUnit:        { ja: "人",               en: "heads" },
  orderDetailsHeader:{ ja: "受注詳細",          en: "Order Details" },
  selectBlockHint:  { ja: "カレンダーのタスクブロックを選択すると、詳細を表示・編集できます。", en: "Select a task block on the calendar to view and edit its details." },
  deliveryMargin:   { ja: "納期余裕",           en: "Delivery Margin" },
  dayUnit:          { ja: "日",               en: "days" },
  saved:            { ja: "保存しました",        en: "Saved" },
  noProductsFound:    { ja: "該当する製品が見つかりません", en: "No products found" },
  productNameLabel:   { ja: "製品名",           en: "Product name" },
  productNumberLabel: { ja: "製品番号",          en: "Product number" },
  unitPriceYen:       { ja: "単価 (円)",        en: "Unit price (¥)" },
  drawings:           { ja: "図面 (1-{n})",     en: "Drawings (1-{n})" },
  drawingLabel:       { ja: "図面",             en: "Drawing" },
  addImage:           { ja: "クリックして画像を追加", en: "Tap or click to add an image" },
  addDrawingSlots:    { ja: "画像スロットを追加",  en: "Add more drawing slots" },
  totalRequiredTime:  { ja: "合計必要時間",       en: "Total required time" },
  minPerUnit:         { ja: "分 / 1個",         en: "min / 1 unit" },
  totalCalculation:   { ja: "合計計算",          en: "Total calculation" },
  autoCalculated:     { ja: "自動計算",          en: "Auto-calculated" },
  autoCalcInfo:       { ja: "合計時間は下のタスクから自動計算されます。", en: "Total time is automatically calculated from the tasks below." },
  manufacturingTasks: { ja: "製造タスク (1-54)",  en: "Manufacturing tasks (1-54)" },
  taskNoHeader:       { ja: "No.",             en: "No." },
  taskContent:        { ja: "作業内容",          en: "Task content" },
  taskTime:           { ja: "所要時間 (分/個)",   en: "Time (min / unit)" },
  minUnit:            { ja: "分",              en: "min" },
  unitDelivery:       { ja: "納期まで",          en: "Until Delivery" },
  unitRequired:       { ja: "必要工数",          en: "Required Man-hours" },
  unitMargin:         { ja: "納期までの余裕",     en: "Margin until Delivery" },
  unitEnd:            { ja: "終了まで",          en: "Until End" },
  dayHeader:          { ja: "日",              en: "days" },
  hrHeader:           { ja: "時間",             en: "hr" },
  minHeader:          { ja: "分",              en: "min" },
} as const;

type Lang = "ja" | "en";
function t(key: keyof typeof LABELS, lang: Lang): string {
  return LABELS[key][lang];
}

// ---- Toggle Switch ----

function ToggleSwitch({ checked, onChange, offLabel = "オフ", onLabel = "オン", dark = false }: {
  checked: boolean; onChange: (v: boolean) => void; offLabel?: string; onLabel?: string; dark?: boolean;
}) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className="flex items-center gap-2 cursor-pointer focus:outline-none group">
      <span className={`text-sm font-600 transition-colors ${dark ? (!checked ? "text-white" : "text-white/50") : (!checked ? "text-slate-700" : "text-slate-400")}`}>{offLabel}</span>
      <span className={`relative inline-flex w-11 h-6 rounded-full border-2 transition-colors duration-200 ${dark ? (checked ? "bg-[#0d7377] border-[#0d7377]" : "bg-white/20 border-white/30") : (checked ? "bg-[#1a3458] border-[#1a3458]" : "bg-slate-200 border-slate-300")}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${checked ? "translate-x-5" : "translate-x-0"}`} />
      </span>
      <span className={`text-sm font-600 transition-colors ${dark ? (checked ? "text-white" : "text-white/50") : (checked ? "text-[#1a3458]" : "text-slate-400")}`}>{onLabel}</span>
    </button>
  );
}

// ---- Time Matrix Column (vertical stack of 3 read-only boxes) ----

function TimeStack({ titleJa, titleEn, values, lang }: {
  titleJa: string; titleEn: string; values: { d: number; h: number; m: number }; lang: Lang;
}) {
  const unitLabels = lang === "ja" ? ["日", "時間", "分"] : ["days", "hr", "min"];
  return (
    <div className="flex flex-col gap-1">
      <p className="text-center text-sm font-700 text-[#1a3458]">{lang === "ja" ? titleJa : titleEn}</p>
      {unitLabels.map((label, i) => {
        const v = i === 0 ? values.d : i === 1 ? values.h : values.m;
        return (
          <div key={label} className="flex items-center gap-1.5">
            <span className="w-9 shrink-0 text-xs font-700 text-slate-500">{label}</span>
            <input
              type="number"
              value={v}
              readOnly
              className="flex-1 min-w-0 px-2 py-1.5 text-base border border-slate-200 rounded-sm bg-slate-50 text-slate-600 font-mono text-center cursor-default focus:outline-none"
            />
          </div>
        );
      })}
    </div>
  );
}

function OrderEntryPage({ orders, setOrders, clients, products, scanRouting, setScanRouting, onNavigate, lang, setLang }: {
  orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  clients: Client[]; products: Product[];
  scanRouting: ScanRouting; setScanRouting: (s: ScanRouting) => void;
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  lang: Lang; setLang: (l: Lang) => void;
}) {
  const newId = () => genUUID();

  const blankForm = (): OrderRecord => ({
    id: newId(), orderDate: today, deliveryDate: today,
    client: "", orderNumber: "", productName: "", quantity: 1, orderAmount: 0,
    progress: "Order request", requiredManhours: 0, workedManhours: 0,
    productionEndDate: "", orderContact: "", contactContents: "", finishTask: false, hasContact: false,
    completedTasks: [],
  });

  const isFilling = scanRouting.stage === "filling" && scanRouting.data !== null;

  const [selectedId, setSelectedId] = useState(isFilling ? "" : (orders[0]?.id ?? ""));
  const [form, setForm] = useState<OrderRecord>(() => {
    if (isFilling && scanRouting.data) {
      const d = scanRouting.data;
      return { ...blankForm(), orderDate: d.orderDate, deliveryDate: d.deliveryDate, client: d.client, orderNumber: d.orderNumber, productName: d.productName, quantity: d.quantity, orderAmount: d.orderAmount };
    }
    return orders[0] ?? blankForm();
  });
  const [isNew, setIsNew] = useState(isFilling);
  const [errors, setErrors] = useState<FormErrors>({});
  const [scanOpen, setScanOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [sortBy, setSortBy] = useState<"delivery" | "order">("delivery");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [progressFilter, setProgressFilter] = useState<Record<string, boolean>>(
    Object.fromEntries(PROGRESS_OPTIONS.map(p => [p, true]))
  );
  const [deliveryFilterOn, setDeliveryFilterOn] = useState(false);
  const [deliveryFilterDate, setDeliveryFilterDate] = useState(today);
  const [calendarDisplay, setCalendarDisplay] = useState(false);
  const [arrangement, setArrangement] = useState("");

  useEffect(() => {
    if (isFilling) setScanRouting({ stage: "idle", data: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ARRANGEMENT_JA: Record<string, string> = {
    "Material procurement": "材料手配",
    "Subcontracting": "外注手配",
    "Machine scheduling": "機械手配",
    "Labor assignment": "人員手配",
    "No arrangement": "手配なし",
  };

  const filtered = useMemo(() => {
    const seen = new Set<string>();
    return orders
      .filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; })
      .filter(o => !searchText || o.productName.toLowerCase().includes(searchText.toLowerCase()) || o.client.toLowerCase().includes(searchText.toLowerCase()))
      .filter(o => progressFilter[o.progress])
      .filter(o => !deliveryFilterOn || o.deliveryDate >= deliveryFilterDate)
      .sort((a, b) => {
        const k = sortBy === "delivery" ? "deliveryDate" : "orderDate";
        return sortDir === "asc" ? a[k].localeCompare(b[k]) : b[k].localeCompare(a[k]);
      });
  }, [orders, searchText, progressFilter, sortBy, sortDir, deliveryFilterOn, deliveryFilterDate]);

  const sf = (v: keyof OrderRecord) => (e: string) => {
    setForm(prev => ({ ...prev, [v]: e }));
    setErrors(prev => ({ ...prev, [v]: "" }));
  };

  const setProductByName = (name: string) => {
    const p = products.find(pt => pt.productName === name);
    const total = p ? p.tasks.reduce((s, t) => s + (Number(t.time) || 0), 0) : 0;
    const unitPrice = p && p.unitPrice !== "" ? Number(p.unitPrice) : 0;
    setForm(prev => ({ ...prev, productName: name, requiredManhours: total, orderAmount: prev.quantity * unitPrice }));
    setErrors(prev => ({ ...prev, productName: "", requiredManhours: "", orderAmount: "" }));
  };

  const handleNew = () => { setForm(blankForm()); setIsNew(true); setSelectedId(""); setErrors({}); };

  const handleSave = async () => {
    const errs = validateOrder(form, clients, products);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    if (isNew) {
      const record = { ...form, id: newId() };
      setOrders(prev => prev.some(o => o.id === record.id) ? prev : [record, ...prev]);
      setSelectedId(record.id);
      setIsNew(false);
      await upsertOrder(record).catch(err => alert(`Failed to save order: ${err.message}`));
    } else {
      setOrders(prev => prev.map(o => o.id === form.id ? form : o));
      await upsertOrder(form).catch(err => alert(`Failed to save order: ${err.message}`));
    }
    setErrors({});
  };

  const handleDelete = async () => {
    const deletedId = form.id;
    setOrders(prev => prev.filter(o => o.id !== deletedId));
    const rest = orders.filter(o => o.id !== deletedId);
    if (rest[0]) { setForm(rest[0]); setSelectedId(rest[0].id); }
    else { handleNew(); }
    setErrors({});
    await deleteOrder(deletedId).catch(err => alert(`Failed to delete order: ${err.message}`));
  };

  const handleScanApply = (data: ScanFillData, clientExists: boolean, productExists: boolean) => {
    setScanOpen(false);
    if (!clientExists) { setScanRouting({ stage: "need-client", data }); onNavigate("client-master"); return; }
    if (!productExists) { setScanRouting({ stage: "need-product", data }); onNavigate("product-master"); return; }
    setForm(prev => ({ ...prev, id: `o${Date.now()}`, orderDate: data.orderDate, deliveryDate: data.deliveryDate, client: data.client, orderNumber: data.orderNumber, productName: data.productName, quantity: data.quantity, orderAmount: data.orderAmount }));
    setIsNew(true); setSelectedId(""); setErrors({});
  };

  const remaining = (form.requiredManhours || 0) - (form.workedManhours || 0);
  const MINUTES_PER_DAY = 480;
  const calcDHM = (totalMins: number) => ({
    d: Math.floor(Math.abs(totalMins) / MINUTES_PER_DAY) * Math.sign(totalMins),
    h: Math.floor((Math.abs(totalMins) % MINUTES_PER_DAY) / 60) * Math.sign(totalMins),
    m: (Math.abs(totalMins) % 60) * Math.sign(totalMins),
  });
  const todayDate = new Date(); todayDate.setHours(0, 0, 0, 0);

  const deliveryTotalMins = (() => {
    if (!form.deliveryDate) return 0;
    const dd = new Date(form.deliveryDate); dd.setHours(0, 0, 0, 0);
    const days = Math.round((dd.getTime() - todayDate.getTime()) / 86400000);
    return Math.max(0, days) * MINUTES_PER_DAY;
  })();
  const deliveryDHM = calcDHM(deliveryTotalMins);
  const requiredDHM = calcDHM(form.requiredManhours || 0);
  const marginMinutes = deliveryTotalMins - remaining;
  const marginDHM = calcDHM(marginMinutes);
  const untilEndDHM = (() => {
    if (!form.productionEndDate) return { d: 0, h: 0, m: 0 };
    const ed = new Date(form.productionEndDate); ed.setHours(0, 0, 0, 0);
    const days = Math.round((ed.getTime() - todayDate.getTime()) / 86400000);
    return calcDHM(Math.max(0, days) * MINUTES_PER_DAY);
  })();

  const inputCls = (hasErr?: boolean) =>
    `w-full px-3 py-2 text-base border rounded-sm bg-white focus:outline-none focus:ring-2 transition-colors ${hasErr ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : "border-slate-300 focus:border-[#1a3458] focus:ring-[#1a3458]/20"}`;

  const L = (key: keyof typeof LABELS) => t(key, lang);

  return (
    <AppShell onNavigate={onNavigate} title="Kiyometa Order Management V2" showBack backTarget="home" backLabel="Home" lang={lang} setLang={setLang}>
      {scanOpen && <ScanModal clients={clients} products={products} onClose={() => setScanOpen(false)} onApply={handleScanApply} />}

      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* Column 1: Filter & Sort */}
        <aside className="w-52 flex flex-col bg-white border-r-2 border-slate-200 shrink-0 overflow-y-auto">

          {/* Display Order */}
          <div className="px-3 pt-3 pb-3 border-b border-slate-200">
            <p className="text-xs font-700 text-white bg-[#1a3458] px-2 py-1 mb-2 rounded-sm">{L("displayOrder")}</p>

            <p className="text-xs font-700 text-slate-500 mb-1.5">{L("sortBy")}</p>
            <div className="space-y-1.5">
              {([["delivery", "deliveryDate"] as const, ["order", "orderDate"] as const]).map(([v, labelKey]) => (
                <label key={v} className="flex items-center gap-2.5 cursor-pointer" onClick={() => setSortBy(v)}>
                  <span className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 transition-colors ${sortBy === v ? "border-[#1a3458] bg-[#1a3458]" : "border-slate-300 bg-white"}`}>
                    {sortBy === v && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                  <span className="text-sm font-700 text-slate-700">{L(labelKey)}</span>
                </label>
              ))}
            </div>

            <p className="text-xs font-700 text-slate-500 mt-2 mb-1.5">{L("direction")}</p>
            <div className="space-y-1.5">
              {([["asc", "ascending"] as const, ["desc", "descending"] as const]).map(([v, labelKey]) => (
                <label key={v} className="flex items-center gap-2.5 cursor-pointer" onClick={() => setSortDir(v)}>
                  <span className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 transition-colors ${sortDir === v ? "border-[#0d7377] bg-[#0d7377]" : "border-slate-300 bg-white"}`}>
                    {sortDir === v && <span className="w-2 h-2 rounded-full bg-white" />}
                  </span>
                  <span className="text-sm font-700 text-slate-700">{L(labelKey)}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Progress Filter */}
          <div className="px-3 pt-3 pb-3 border-b border-slate-200">
            <p className="text-xs font-700 text-white bg-[#0d7377] px-2 py-1 mb-2 rounded-sm">{L("filter")}</p>
            <p className="text-xs font-700 text-slate-500 mb-1.5">{L("progress")}</p>
            <div className="space-y-1.5">
              {PROGRESS_OPTIONS.map(p => (
                <label key={p} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!progressFilter[p]}
                    onChange={e => setProgressFilter(prev => ({ ...prev, [p]: e.target.checked }))}
                    className="w-4 h-4 accent-[#1a3458] cursor-pointer shrink-0" />
                  <span className="text-sm font-700 text-slate-700">
                    {lang === "ja" ? PROGRESS_JA[p] : p}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Date Filter */}
          <div className="px-3 pt-3 pb-3">
            <p className="text-xs font-700 text-white bg-slate-600 px-2 py-1 mb-2 rounded-sm">{L("deliveryDateFilter")}</p>
            <div className="flex items-center mb-2">
              <ToggleSwitch checked={deliveryFilterOn} onChange={setDeliveryFilterOn} offLabel={L("toggleOff")} onLabel={L("toggleOn")} />
            </div>
            <div className="mb-1">
              <input type="date" value={deliveryFilterDate} onChange={e => setDeliveryFilterDate(e.target.value)}
                className="w-full px-2 py-1.5 text-sm border-2 border-slate-300 rounded-sm bg-white focus:outline-none focus:border-[#1a3458]" />
            </div>
            <p className="text-sm font-700 text-slate-600 mb-2">{L("afterDate")}</p>
            <label className="flex items-center gap-2 cursor-pointer mb-2">
              <input type="checkbox" checked={calendarDisplay} onChange={e => setCalendarDisplay(e.target.checked)}
                className="w-4 h-4 accent-[#1a3458] cursor-pointer" />
              <span className="text-xs text-slate-600">{L("calendarDisplay")}</span>
            </label>
          </div>
        </aside>

        {/* Column 2: Search & Record List */}
        <aside className="w-56 flex flex-col bg-[#f8f9fb] border-r-2 border-slate-200 shrink-0 overflow-hidden">
          <div className="px-3 pt-3 pb-2 border-b border-slate-200 shrink-0">
            <p className="text-xs font-700 text-white bg-[#1a3458] px-2 py-1 mb-2 rounded-sm">{L("searchItem")}</p>
            <div className="flex items-center gap-2 px-2.5 py-2 border-2 border-slate-300 rounded-sm bg-white focus-within:border-[#1a3458] transition-colors">
              <Icon name="search" size={16} className="text-slate-400 shrink-0" />
              <input value={searchText} onChange={e => setSearchText(e.target.value)} placeholder={L("searchPlaceholder")}
                className="flex-1 text-base focus:outline-none bg-transparent" />
            </div>
            <p className="text-sm text-slate-600 mt-1.5 font-600">
              <span className="text-lg font-700 text-[#1a3458]">{filtered.length}</span> {lang === "ja" ? "件" : "items"}
            </p>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0">
            {filtered.map(o => (
              <button key={o.id} onClick={() => { setForm(o); setSelectedId(o.id); setIsNew(false); setErrors({}); }}
                className={`w-full text-left px-3 py-3 border-b border-slate-200 hover:bg-white cursor-pointer transition-colors ${selectedId === o.id ? "bg-blue-50 border-l-4 border-l-[#1a3458]" : "border-l-4 border-l-transparent"}`}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs text-slate-500 font-mono font-600">{lang === "ja" ? `(納)${o.deliveryDate}` : `(Dlv)${o.deliveryDate}`}</span>
                  {selectedId === o.id && <span className="w-2 h-2 rounded-full bg-[#1a3458]" />}
                </div>
                <div className="text-xs text-slate-400">{o.client.split(" ")[0]}</div>
                <div className="text-sm font-700 text-slate-800 mt-0.5 truncate">{o.productName}</div>
                <div className="flex items-center justify-between gap-1 mt-1">
                  <span className="text-xs text-slate-500">{lang === "ja" ? `数量${o.quantity}個/${o.orderAmount.toLocaleString()}円` : `Qty ${o.quantity} / ¥${o.orderAmount.toLocaleString()}`}</span>
                  <StatusBadge status={o.progress} small />
                </div>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-slate-400">No records found</div>
            )}
          </div>
        </aside>

        {/* Column 3: Main Activity Form */}
        <main className="flex-1 overflow-y-auto min-h-0 bg-white">

          {/* Scan bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 shrink-0">
            <div className="flex items-center gap-2 text-slate-500">
              <Icon name="scan" size={16} />
              <span className="text-sm">{L("scanHint")}</span>
            </div>
            <Btn variant="outline" size="sm" onClick={() => setScanOpen(true)}>
              <Icon name="scan" size={15} />{L("scanButton")}
            </Btn>
          </div>

          {/* Error banner */}
          {Object.values(errors).some(v => v) && (
            <div className="flex items-start gap-3 px-4 py-3 bg-red-50 border-b border-red-200">
              <Icon name="alert-triangle" size={17} className="text-red-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-700 text-red-700">{L("errorBanner")}</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  {Object.entries(errors).filter(([, v]) => v).map(([k, v]) => (
                    <li key={k} className="text-sm text-red-700">{v}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="p-4 space-y-4">

            {/* Row 1: Dates + Client + Order Number */}
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("orderDateLabel")}</label>
                <input type="date" value={form.orderDate}
                  onChange={e => { setForm(prev => ({ ...prev, orderDate: e.target.value })); setErrors(prev => ({ ...prev, deliveryDate: e.target.value && form.deliveryDate && e.target.value > form.deliveryDate ? "Delivery date must be on or after order date." : "" })); }}
                  className={inputCls(!!errors.orderDate)} />
                {errors.orderDate && <p className="text-xs text-red-600 mt-0.5">{errors.orderDate}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("deliveryDateLabel")}</label>
                <input type="date" value={form.deliveryDate}
                  onChange={e => { setForm(prev => ({ ...prev, deliveryDate: e.target.value })); setErrors(prev => ({ ...prev, deliveryDate: e.target.value && form.orderDate && e.target.value < form.orderDate ? "Delivery date must be on or after order date." : "" })); }}
                  className={inputCls(!!errors.deliveryDate)} />
                {errors.deliveryDate && <p className="text-xs text-red-600 mt-0.5">{errors.deliveryDate}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("client")}</label>
                <div className="relative">
                  <select value={form.client} onChange={e => sf("client")(e.target.value)}
                    className={inputCls(!!errors.client) + " pr-9 appearance-none"}>
                    {["", ...clients.map(c => c.name)].map(o => <option key={o} value={o}>{o || L("selectPlaceholder")}</option>)}
                  </select>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
                {errors.client && <p className="text-xs text-red-600 mt-0.5">{errors.client}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("orderNumber")}</label>
                <div className="relative">
                  <input value={form.orderNumber} onChange={e => sf("orderNumber")(e.target.value)} maxLength={50}
                    className={inputCls(!!errors.orderNumber) + " pr-9"} />
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
                {errors.orderNumber && <p className="text-xs text-red-600 mt-0.5">{errors.orderNumber}</p>}
              </div>
            </div>

            {/* Row 2: Product + Product Number + Quantity + Amount */}
            <div className="grid grid-cols-[1.2fr_1fr_1fr_1.2fr] gap-3">
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("productName")}</label>
                <div className="relative">
                  <select value={form.productName} onChange={e => setProductByName(e.target.value)}
                    className={inputCls(!!errors.productName) + " pr-9 appearance-none"}>
                    {["", ...products.filter(p => !form.client || p.clientName === form.client).map(p => p.productName)].map(o => <option key={o} value={o}>{o || L("selectPlaceholder")}</option>)}
                  </select>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
                {errors.productName && <p className="text-xs text-red-600 mt-0.5">{errors.productName}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("productNumber")}</label>
                <div className="relative">
                  <select
                    value={products.find(p => p.productName === form.productName)?.productNumber ?? ""}
                    onChange={e => {
                      const p = products.find(x => x.productNumber === e.target.value);
                      setProductByName(p?.productName ?? "");
                    }}
                    className={inputCls() + " pr-9 appearance-none"}>
                    {["", ...products.filter(p => !form.client || p.clientName === form.client).map(p => p.productNumber)].map(o => <option key={o} value={o}>{o || L("selectPlaceholder")}</option>)}
                  </select>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("quantity")}</label>
                <input type="number" value={form.quantity === 0 ? "" : form.quantity}
                  onChange={e => {
                    const c = e.target.value.replace(/^0+(?=\d)/, "");
                    const qty = c === "" ? 0 : parseInt(c, 10);
                    const p = products.find(pt => pt.productName === form.productName);
                    const unitPrice = p && p.unitPrice !== "" ? Number(p.unitPrice) : 0;
                    setForm(prev => ({ ...prev, quantity: qty, orderAmount: qty * unitPrice }));
                    setErrors(prev => ({ ...prev, quantity: "", orderAmount: "" }));
                  }}
                  className={inputCls(!!errors.quantity)} />
                {errors.quantity && <p className="text-xs text-red-600 mt-0.5">{errors.quantity}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">
                  {L("orderAmount")}
                  <span className="ml-1.5 text-xs font-600 text-blue-400">({L("autoBadge")})</span>
                </label>
                <div className="flex gap-1.5">
                  <input type="number" value={form.orderAmount === 0 ? "" : form.orderAmount}
                    onChange={e => { const c = e.target.value.replace(/^0+(?=\d)/, ""); setForm(prev => ({ ...prev, orderAmount: c === "" ? 0 : parseInt(c, 10) })); setErrors(prev => ({ ...prev, orderAmount: "" })); }}
                    className={`flex-1 min-w-0 px-3 py-2 text-base border rounded-sm bg-white focus:outline-none focus:ring-2 transition-colors ${errors.orderAmount ? "border-red-400" : "border-slate-300 focus:border-[#1a3458] focus:ring-[#1a3458]/20"}`} />
                  <span className="flex items-center text-base font-700 text-slate-600 shrink-0">{L("yenUnit")}</span>
                </div>
                {errors.orderAmount && <p className="text-xs text-red-600 mt-0.5">{errors.orderAmount}</p>}
              </div>
            </div>

            {/* Row 3: Order Contact */}
            <div>
              <label className="block text-sm font-700 text-slate-600 mb-1">
                {L("orderContact")}
                <span className="ml-2 text-xs text-slate-400 font-400">{form.orderContact.length}/500</span>
              </label>
              <textarea value={form.orderContact} rows={2}
                onChange={e => { setForm(prev => ({ ...prev, orderContact: e.target.value })); setErrors(prev => ({ ...prev, orderContact: "" })); }}
                className={`w-full px-3 py-2 text-base border rounded-sm resize-none focus:outline-none focus:ring-2 transition-colors ${errors.orderContact ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : "border-slate-300 focus:border-[#1a3458] focus:ring-[#1a3458]/20"}`} />
              {errors.orderContact && <p className="text-xs text-red-600 mt-0.5">{errors.orderContact}</p>}
            </div>

            {/* Row 4: Man-hours Math Matrix -> [Required (min)] - [Worked (min)] = [Remaining (min)] */}
            <div className="border border-slate-200 rounded-sm p-3 bg-white">
              <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-center">
                <div>
                  <label className="block text-sm font-700 text-[#1a3458] mb-2">{L("requiredManhours")} ({L("minUnit")})</label>
                  <input type="number" value={form.requiredManhours === 0 ? "" : form.requiredManhours} readOnly
                    className="w-full px-3 py-2 text-base border border-slate-200 rounded-sm bg-slate-50 text-slate-500 cursor-default" />
                </div>
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">-</div>
                <div>
                  <label className="block text-sm font-700 text-[#1a3458] mb-2">{L("workedManhours")} ({L("minUnit")})</label>
                  <input type="number" value={form.workedManhours === 0 ? "" : form.workedManhours}
                    onChange={e => { const c = e.target.value.replace(/^0+(?=\d)/, ""); const val = c === "" ? 0 : parseInt(c, 10); setForm(prev => ({ ...prev, workedManhours: val })); setErrors(prev => ({ ...prev, workedManhours: val > form.requiredManhours ? "Worked cannot exceed required." : "" })); }}
                    className={inputCls(!!errors.workedManhours)} />
                  {errors.workedManhours && <p className="text-xs text-red-600 mt-1">{errors.workedManhours}</p>}
                </div>
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">=</div>
                <div>
                  <label className="block text-sm font-700 text-[#1a3458] mb-2">{L("remainingManhours")} ({L("minUnit")})</label>
                  <input type="number" value={remaining} readOnly
                    className="w-full px-3 py-2 text-base border border-slate-200 rounded-sm bg-slate-50 text-slate-500 cursor-default" />
                </div>
              </div>
            </div>

            {/* Row 5: Schedule Math Matrix -> [Until Delivery] - [Required] = [Margin] */}
            <div className="border border-slate-200 rounded-sm p-3 bg-white">
              <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-center">
                <TimeStack titleJa={L("unitDelivery")} titleEn={L("unitDelivery")} values={deliveryDHM} lang={lang} />
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">-</div>
                <TimeStack titleJa={L("unitRequired")} titleEn={L("unitRequired")} values={requiredDHM} lang={lang} />
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">=</div>
                <TimeStack titleJa={L("unitMargin")} titleEn={L("unitMargin")} values={marginDHM} lang={lang} />
              </div>
            </div>

            {/* Row 6: Production End Date + Until End (separate, below the schedule matrix) */}
            <div className="border border-slate-200 rounded-sm p-3 bg-slate-50">
              <div className="grid grid-cols-2 gap-6 items-start">
                <div>
                  <label className="block text-sm font-700 text-slate-600 mb-1">{L("productionEndDate")}</label>
                  <input type="date" value={form.productionEndDate}
                    onChange={e => { setForm(prev => ({ ...prev, productionEndDate: e.target.value })); const err = e.target.value && form.orderDate && e.target.value < form.orderDate ? "Cannot be earlier than the order date." : e.target.value && form.deliveryDate && e.target.value > form.deliveryDate ? "Cannot be later than the delivery date." : ""; setErrors(prev => ({ ...prev, productionEndDate: err })); }}
                    className={inputCls(!!errors.productionEndDate)} />
                  {errors.productionEndDate && <p className="text-xs text-red-600 mt-0.5">{errors.productionEndDate}</p>}
                </div>
                <div>
                  <TimeStack titleJa={L("unitEnd")} titleEn={L("unitEnd")} values={untilEndDHM} lang={lang} />
                </div>
              </div>
            </div>

            {/* Row 7: Progress Status + Finish Task + Tasks */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("progressStatus")}</label>
                <div className="relative">
                  <select value={form.progress} onChange={e => sf("progress")(e.target.value)}
                    className={inputCls() + " pr-9 appearance-none"}>
                    {PROGRESS_OPTIONS.map(o => (
                      <option key={o} value={o}>{lang === "ja" ? PROGRESS_JA[o] : o}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-2">{L("finishTask")}</label>
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={form.finishTask}
                    onChange={e => setForm(prev => ({ ...prev, finishTask: e.target.checked }))}
                    className="w-5 h-5 accent-[#1a3458] cursor-pointer" />
                  <span className={`text-base font-700 ${form.finishTask ? "text-emerald-700" : "text-slate-400"}`}>
                    {form.finishTask ? `✓ ${L("done")}` : L("pending")}
                  </span>
                </label>
              </div>
              <div className="flex flex-col">
                <span className="block text-sm font-700 text-slate-600 mb-1">{L("tasksButton")}</span>
                <button type="button" onClick={() => onNavigate("checklist", undefined, form.id)}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 text-base font-600 border border-slate-300 rounded-sm bg-white hover:bg-slate-50 text-slate-700 cursor-pointer transition-colors">
                  {L("tasksButton")}
                </button>
              </div>
            </div>

            {/* Row 8: Contact toggle + Required Arrangements dropdown */}
            <div className="grid grid-cols-2 gap-3">
              <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-sm flex items-center justify-between">
                <span className="text-sm font-700 text-slate-700 shrink-0">{L("contact")}</span>
                <div className="ml-auto">
                  <ToggleSwitch checked={form.hasContact} onChange={v => setForm(prev => ({ ...prev, hasContact: v }))}
                    offLabel={L("contactOff")} onLabel={L("toggleOn")} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("contactOn")}</label>
                <div className="relative">
                  <select value={arrangement} onChange={e => setArrangement(e.target.value)}
                    className="w-full px-3 py-2 pr-9 text-base border border-slate-300 rounded-sm bg-white appearance-none focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 cursor-pointer">
                    <option value="" disabled>{L("selectPlaceholder")}</option>
                    {ARRANGEMENT_OPTIONS.map(o => (
                      <option key={o} value={o}>{lang === "ja" ? ARRANGEMENT_JA[o] : o}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">▾</span>
                </div>
              </div>
            </div>

            {/* Row 9: Contact Contents textarea */}
            <div>
              <label className="block text-sm font-700 text-slate-600 mb-1">{L("contactContents")}</label>
              <textarea value={form.contactContents} rows={4}
                onChange={e => setForm(prev => ({ ...prev, contactContents: e.target.value }))}
                className="w-full px-3 py-2 text-base border border-slate-300 rounded-sm resize-none focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 transition-colors" />
            </div>
          </div>
        </main>
      </div>

      {/* Bottom action bar */}
      <footer className="flex items-center gap-3 px-5 py-3 bg-[#1a3458] shrink-0">
        <Btn variant="ghost" size="lg" onClick={() => onNavigate("search-billing")}>
          <Icon name="search" size={16} /><span>{L("searchBilling")}</span>
        </Btn>
        <div className="flex-1" />
        <Btn variant="ghost" size="lg" onClick={handleNew}>
          <Icon name="plus" size={16} /><span>{L("newButton")}</span>
        </Btn>
        <Btn variant="action" size="lg" onClick={handleSave}>
          <Icon name="save" size={16} /><span>{L("saveButton")}</span>
        </Btn>
        <Btn variant="danger" size="lg" onClick={handleDelete}>
          <Icon name="trash" size={16} /><span>{L("deleteButton")}</span>
        </Btn>
      </footer>
    </AppShell>
  );
}

// ---- Page 2: Search & billing ----

function SearchBillingPage({ orders, setOrders, clients, products, onNavigate, lang, setLang }: {
  orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  clients: Client[]; products: Product[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  lang: Lang; setLang: (l: Lang) => void;
}) {
  const [fromDate, setFromDate] = useState("2025-10-01");
  const [toDate, setToDate] = useState("2025-11-07");
  const [clientFilter, setClientFilter] = useState<Record<string, boolean>>({});
  const [statusFilter, setStatusFilter] = useState<Record<string, boolean>>(
    Object.fromEntries(PROGRESS_OPTIONS.map(p => [p, true]))
  );

  const productByKey = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach(p => m.set(`${p.clientName}|${p.productName}`, p));
    return m;
  }, [products]);

  const monthAgo = () => {
    const d = new Date(today + "T00:00:00");
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  };

  // Right edit panel state
  const blankSBForm = (): OrderRecord => ({
    id: `o${Date.now()}`, orderDate: today, deliveryDate: today,
    client: "", orderNumber: "", productName: "", quantity: 1, orderAmount: 0,
    progress: "Order request", requiredManhours: 0, workedManhours: 0,
    productionEndDate: "", orderContact: "", contactContents: "", finishTask: false, hasContact: false,
    completedTasks: [],
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelForm, setPanelForm] = useState<OrderRecord>(blankSBForm());
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const selectOrder = (o: OrderRecord) => { setSelectedId(o.id); setPanelForm({ ...o }); setDeleteConfirm(null); };
  const resetSelection = () => { setSelectedId(null); setPanelForm(blankSBForm()); setDeleteConfirm(null); };

  const handleSave = async () => {
    if (!panelForm.client || !panelForm.productName || !panelForm.deliveryDate) return;
    setOrders(prev => prev.map(o => o.id === panelForm.id ? panelForm : o));
    await upsertOrder(panelForm).catch(err => alert(`Failed to save order: ${err.message}`));
  };

  const handleDelete = async (id: string) => {
    setOrders(prev => prev.filter(o => o.id !== id));
    setDeleteConfirm(null);
    if (panelForm.id === id) resetSelection();
    await deleteOrder(id).catch(err => alert(`Failed to delete order: ${err.message}`));
  };

  const spf = (k: keyof OrderRecord) => (e: string) => setPanelForm(prev => ({ ...prev, [k]: e }));
  const npf = (k: keyof OrderRecord) => (e: string) => {
    const clean = e.replace(/^0+(?=\d)/, "");
    setPanelForm(prev => ({ ...prev, [k]: clean === "" ? 0 : parseInt(clean, 10) }));
  };

  const filtered = orders.filter(o => {
    const clientOk = !Object.values(clientFilter).some(Boolean) || clientFilter[o.client];
    const dateOk = (!fromDate || !toDate) || (o.deliveryDate >= fromDate && o.deliveryDate <= toDate);
    return clientOk && statusFilter[o.progress] && dateOk;
  }).sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate));

  const productInfo = (o: OrderRecord) =>
    productByKey.get(`${o.client}|${o.productName}`) ?? null;

  return (
    <AppShell onNavigate={onNavigate} title={t("searchBilling", lang)} lang={lang} setLang={setLang}>
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-56 bg-white border-r-2 border-slate-200 overflow-y-auto shrink-0 flex flex-col">

          {/* Search Period */}
          <div className="px-3 pt-3 pb-3 border-b border-slate-200">
            <p className="text-xs font-700 text-white bg-[#1a3458] px-2 py-1 mb-2 rounded-sm">{t("searchPeriod", lang)}</p>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={() => { setFromDate(today); setToDate(today); }}
                className="px-2 py-1.5 text-sm font-600 text-[#1a3458] bg-white border-2 border-slate-300 rounded-sm hover:border-[#1a3458] hover:bg-blue-50 transition-colors cursor-pointer">
                {t("sameDay", lang)}
              </button>
              <button onClick={() => { setFromDate(monthAgo()); setToDate(today); }}
                className="px-2 py-1.5 text-sm font-600 text-[#1a3458] bg-white border-2 border-slate-300 rounded-sm hover:border-[#1a3458] hover:bg-blue-50 transition-colors cursor-pointer">
                {t("oneMonth", lang)}
              </button>
            </div>

            <label className="flex items-center gap-2 mb-3">
              <span className="w-6 text-xs font-700 text-slate-500 shrink-0">{t("fromLabel", lang)}</span>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 text-sm border-2 border-slate-300 rounded-sm bg-white focus:outline-none focus:border-[#1a3458]" />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-6 text-xs font-700 text-slate-500 shrink-0">{t("toLabel", lang)}</span>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
                className="flex-1 min-w-0 px-2 py-1.5 text-sm border-2 border-slate-300 rounded-sm bg-white focus:outline-none focus:border-[#1a3458]" />
            </label>
          </div>

          {/* Client */}
          <div className="px-3 pt-3 pb-3 border-b border-slate-200">
            <p className="text-xs font-700 text-white bg-[#0d7377] px-2 py-1 mb-2 rounded-sm">{t("clientSection", lang)}</p>
            <div className="space-y-1">
              {clients.map(c => (
                <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer text-slate-700">
                  <input type="checkbox" checked={!!clientFilter[c.name]}
                    onChange={e => setClientFilter(prev => ({ ...prev, [c.name]: e.target.checked }))}
                    className="w-4 h-4 accent-[#1a3458] cursor-pointer shrink-0" />
                  <span className="truncate">{c.name.split(",")[0]}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Status */}
          <div className="px-3 pt-3 pb-3">
            <p className="text-xs font-700 text-white bg-slate-600 px-2 py-1 mb-2 rounded-sm">{t("statusSection", lang)}</p>
            <div className="space-y-1.5">
              {PROGRESS_OPTIONS.map(p => (
                <label key={p} className="flex items-center gap-1.5 text-sm cursor-pointer text-slate-700">
                  <input type="checkbox" checked={!!statusFilter[p]}
                    onChange={e => setStatusFilter(prev => ({ ...prev, [p]: e.target.checked }))}
                    className="w-4 h-4 accent-[#1a3458] cursor-pointer shrink-0" />
                  <span className="truncate">{lang === "ja" ? PROGRESS_JA[p] : p}</span>
                </label>
              ))}
            </div>
            <p className="text-sm text-slate-600 font-600 mt-3 pt-2 border-t border-slate-100">
              <span className="text-lg font-700 text-[#1a3458]">{filtered.length}</span>{lang === "ja" ? "件" : "items"}
            </p>
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto">
          <div className="flex flex-col">
            {filtered.map(o => {
              const prod = productInfo(o);
              const partNo = prod ? prod.productNumber : "-";
              const unitPrice = prod ? prod.unitPrice : (o.quantity > 0 ? Math.round(o.orderAmount / o.quantity) : 0);
              return (
                <div key={o.id} onClick={() => selectOrder(o)}
                  className={`flex items-center gap-4 px-4 py-3 border-b border-slate-200 hover:bg-slate-50 transition-colors cursor-pointer ${selectedId === o.id ? "bg-blue-50" : ""}`}>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-3">
                      <StatusBadge status={o.progress} small lang={lang} />
                      <span className="text-sm font-mono text-slate-500 whitespace-nowrap">({t("dlvPrefix", lang)}) {o.deliveryDate}</span>
                    </div>
                    <p className="text-base font-600 text-slate-800 truncate">{o.productName}</p>
                    <p className="text-xs text-slate-500">
                      {t("orderNoPrefix", lang)}: <span className="font-mono">{o.orderNumber}</span>
                      <span className="mx-1.5 text-slate-300">|</span>
                      {t("partNoPrefix", lang)}: <span className="font-mono">{partNo}</span>
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className="text-right">
                      <span className="block text-xs font-700 text-slate-400">{t("taxExclAmount", lang)}</span>
                      <span className="block text-lg font-700 text-slate-900 font-mono leading-tight">¥{o.orderAmount.toLocaleString()}</span>
                    </div>
                    <span className="text-xs text-slate-500 whitespace-nowrap">
                      {t("unitPriceLabel", lang)} <span className="font-mono">¥{unitPrice.toLocaleString()}</span>
                      <span className="mx-1.5 text-slate-300">|</span>
                      {t("qtyLabel", lang)} <span className="font-mono">{lang === "ja" ? `${o.quantity}${t("qtyUnit", lang)}` : `${o.quantity} ${t("qtyUnit", lang)}`}</span>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        {/* Column 3: Right Edit Panel -- always visible, never overlays */}
        <aside className="w-80 bg-white border-l-2 border-slate-200 shrink-0 overflow-hidden flex flex-col">
          {selectedId === null ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="w-14 h-14 flex items-center justify-center rounded-full bg-slate-100 text-slate-300 shrink-0">
                <Icon name="file-text" size={26} />
              </div>
              <p className="text-sm text-slate-500">
                {lang === "ja" ? "一覧から注文を選択すると詳細を表示・編集できます。" : "Select an order from the list to view or edit details."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full min-h-0">
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
                <span className="text-base font-700 text-slate-800">{lang === "ja" ? "受注詳細" : "Order Details"}</span>
                <button onClick={resetSelection} className="p-1.5 rounded hover:bg-slate-100 text-slate-400 hover:text-slate-700 cursor-pointer transition-colors" aria-label="Close">
                  <Icon name="x" size={17} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <FieldBox label={t("orderDateLabel", lang)}>
                    <TextInput type="date" value={panelForm.orderDate} onChange={spf("orderDate")} />
                  </FieldBox>
                  <FieldBox label={t("deliveryDateLabel", lang)}>
                    <TextInput type="date" value={panelForm.deliveryDate} onChange={spf("deliveryDate")} />
                  </FieldBox>
                </div>
                <FieldBox label={t("client", lang)}>
                  <SelectInput value={panelForm.client} onChange={spf("client")}
                    options={["", ...clients.map(c => c.name)]} />
                </FieldBox>
                <FieldBox label={t("orderNumber", lang)}>
                  <TextInput value={panelForm.orderNumber} onChange={spf("orderNumber")} maxLength={50} />
                </FieldBox>
                <FieldBox label={t("productName", lang)}>
                  <SelectInput value={panelForm.productName} onChange={spf("productName")}
                    options={["", ...products.filter(p => !panelForm.client || p.clientName === panelForm.client).map(p => p.productName)]} />
                </FieldBox>
                <div className="grid grid-cols-2 gap-3">
                  <FieldBox label={t("quantity", lang)}>
                    <TextInput type="number" value={panelForm.quantity === 0 ? "" : panelForm.quantity} onChange={npf("quantity")} />
                  </FieldBox>
                  <FieldBox label={`${t("orderAmount", lang)} (${t("yenUnit", lang)})`}>
                    <TextInput type="number" value={panelForm.orderAmount === 0 ? "" : panelForm.orderAmount} onChange={npf("orderAmount")} />
                  </FieldBox>
                </div>
                <FieldBox label={t("progressStatus", lang)}>
                  <select value={panelForm.progress} onChange={e => setPanelForm(prev => ({ ...prev, progress: e.target.value }))}
                    className="w-full px-3 py-2 text-base border border-slate-300 rounded-sm bg-white focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 transition-colors">
                    {PROGRESS_OPTIONS.map(o => (
                      <option key={o} value={o}>{lang === "ja" ? PROGRESS_JA[o] : o}</option>
                    ))}
                  </select>
                </FieldBox>
                <FieldBox label={t("orderContact", lang)}>
                  <textarea value={panelForm.orderContact} rows={2}
                    onChange={e => setPanelForm(prev => ({ ...prev, orderContact: e.target.value }))}
                    className="w-full px-3 py-2 text-base border border-slate-300 rounded-sm resize-none focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 transition-colors" />
                </FieldBox>
              </div>
              <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200 shrink-0">
                {deleteConfirm === panelForm.id ? (
                  <>
                    <button onClick={() => handleDelete(panelForm.id)}
                      className="px-3 py-2 text-sm bg-red-600 text-white rounded-sm font-600 hover:bg-red-700 cursor-pointer transition-colors">
                      {lang === "ja" ? "削除する" : "Confirm delete"}
                    </button>
                    <button onClick={() => setDeleteConfirm(null)}
                      className="px-3 py-2 text-sm bg-slate-100 text-slate-700 rounded-sm font-600 hover:bg-slate-200 cursor-pointer transition-colors">
                      {lang === "ja" ? "キャンセル" : "Cancel"}
                    </button>
                  </>
                ) : (
                  <button onClick={() => setDeleteConfirm(panelForm.id)}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-sm cursor-pointer transition-colors">
                    <Icon name="trash" size={14} />{t("deleteButton", lang)}
                  </button>
                )}
                <div className="flex gap-2 ml-auto">
                  <button onClick={resetSelection}
                    className="px-4 py-2 text-sm bg-slate-100 text-slate-700 rounded-sm font-600 hover:bg-slate-200 cursor-pointer transition-colors">
                    {lang === "ja" ? "キャンセル" : "Cancel"}
                  </button>
                  <button onClick={handleSave}
                    disabled={!panelForm.client || !panelForm.productName || !panelForm.deliveryDate}
                    className="px-4 py-2 text-sm bg-[#1a3458] text-white rounded-sm font-600 hover:bg-[#112240] cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                    {t("saveButton", lang)}
                  </button>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>

      <footer className="flex items-center gap-3 px-5 py-3 bg-[#1a3458] shrink-0">
        <Btn variant="ghost" size="md" className="flex-1 justify-center whitespace-nowrap"><Icon name="printer" size={15} />{t("prePrepPrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="flex-1 justify-center whitespace-nowrap" onClick={() => onNavigate("delivery-slip", "single")}><Icon name="truck" size={15} />{t("singleSlipPrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="flex-1 justify-center whitespace-nowrap" onClick={() => onNavigate("delivery-slip", "multiple")}><Icon name="truck" size={15} />{t("multipleSlipPrint", lang)}</Btn>
        <Btn variant="action" size="md" className="flex-1 justify-center whitespace-nowrap" onClick={() => onNavigate("invoice")}><Icon name="file-invoice" size={15} />{t("invoicePrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="flex-1 justify-center whitespace-nowrap"><Icon name="file-text" size={15} />{t("csvCreate", lang)}</Btn>
      </footer>
    </AppShell>
  );
}

// ---- Page 3: Invoice ----

function InvoicePage({ orders, clients, lang, setLang, onNavigate }: {
  orders: OrderRecord[]; clients: Client[]; lang: Lang; setLang: (l: Lang) => void; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
}) {
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = 6;
  const [billingDate, setBillingDate] = useState("2025-11-01");
  const [deadlineDate, setDeadlineDate] = useState("2025-12-01");
  const [dateField, setDateField] = useState<"billing" | "deadline" | null>(null);
  const [calCursor, setCalCursor] = useState(new Date(2025, 10, 1));
  const items = orders.slice(0, 3);
  const subtotal = items.reduce((s, o) => s + o.orderAmount, 0);
  const tax = Math.round(subtotal * 0.1);
  const billed = subtotal + tax;
  const client = clients[0];

  const fmtDate = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return lang === "ja"
      ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };
  const billMonth = new Date(billingDate + "T00:00:00");
  const subject = lang === "ja"
    ? `${billMonth.getMonth() + 1}月請求分`
    : `${billMonth.toLocaleDateString("en-US", { month: "long" })} billing portion`;

  const openCalendar = (f: "billing" | "deadline") => {
    const base = new Date((f === "billing" ? billingDate : deadlineDate) + "T00:00:00");
    setDateField(f);
    setCalCursor(new Date(base.getFullYear(), base.getMonth(), 1));
  };

  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const dayLabels = lang === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const calTitle = lang === "ja"
    ? `${y}年${m + 1}月`
    : calCursor.toLocaleDateString("en-US", { year: "numeric", month: "long" });

  const selectDay = (d: number) => {
    const iso = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (dateField === "billing") setBillingDate(iso); else setDeadlineDate(iso);
    setDateField(null);
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("invoiceTitle", lang)} showBack backTarget="search-billing" backLabel={t("searchBilling", lang)} lang={lang} setLang={setLang}>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-[#f5f6f8] border-b border-slate-200 shrink-0">
        <Btn variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))}><Icon name="chevron-left" size={14} />{t("prevPage", lang)}</Btn>
        <span className="text-sm text-slate-500 font-mono">{t("pageOf", lang).replace("{c}", String(currentPage)).replace("{t}", String(totalPages))}</span>
        <Btn variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>{t("nextPage", lang)}<Icon name="chevron-right" size={14} /></Btn>
        <div className="flex-1" />
        <Btn variant="primary" size="sm" onClick={() => window.print()}><Icon name="printer" size={15} />{t("printButton", lang)}</Btn>
      </div>
      <div className="flex-1 overflow-y-auto flex justify-center p-8 bg-slate-300">
        <div className="w-full max-w-2xl bg-white shadow-md p-10">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-700 text-slate-800 inline-block pb-2 border-b-2 border-slate-800">{t("invoiceTitle", lang)}</h2>
          </div>

          <div className="flex justify-between items-start gap-6 mb-8">
            <div className="flex-1 min-w-0">
              <div className="border-2 border-slate-300 rounded-sm px-4 py-3">
                <p className="text-lg font-700 text-slate-800 leading-snug">{client?.name}{lang === "ja" ? " 御中" : ""}</p>
                <p className="text-sm text-slate-500 mt-2 pt-2 border-t border-dashed border-slate-200">{client?.address}</p>
              </div>
              <div className="mt-4 bg-blue-50 border border-blue-100 rounded-sm px-4 py-2.5">
                <p className="text-base font-600 text-slate-800">{t("subjectPrefix", lang)} {subject}</p>
              </div>
            </div>

            <div className="w-64 shrink-0 relative">
              <div className="border border-slate-300 rounded-sm px-4 py-3 text-right">
                <p className="text-lg font-700 text-[#1a3458]">{t("sendersCompany", lang)}</p>
                <p className="text-xs text-slate-400 mt-1">kiyometaGoGo@kiyometa.onmicrosoft.com</p>
              </div>
              <div className="mt-3 space-y-2">
                <div>
                  <p className="text-xs font-600 text-slate-500 mb-1">{t("billingDateLabel", lang)}</p>
                  <button type="button" onClick={() => openCalendar("billing")}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-base bg-white border border-slate-300 rounded-sm cursor-pointer hover:border-[#1a3458] transition-colors">
                    <span className="font-mono text-sm">{fmtDate(billingDate)}</span>
                    <Icon name="calendar" size={15} className="text-slate-400" />
                  </button>
                </div>
                <div>
                  <p className="text-xs font-600 text-slate-500 mb-1">{t("paymentDeadline", lang)}</p>
                  <button type="button" onClick={() => openCalendar("deadline")}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-base bg-white border border-slate-300 rounded-sm cursor-pointer hover:border-[#1a3458] transition-colors">
                    <span className="font-mono text-sm">{fmtDate(deadlineDate)}</span>
                    <Icon name="calendar" size={15} className="text-slate-400" />
                  </button>
                </div>
              </div>
              {dateField && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setDateField(null)} />
                  <div className="absolute right-0 top-[150px] z-50 w-64 bg-white border border-slate-200 rounded-sm shadow-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-[#1a3458] text-white">
                      <button type="button" onClick={() => setCalCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))} className="p-1 rounded hover:bg-white/20 cursor-pointer transition-colors"><Icon name="chevron-left" size={14} /></button>
                      <span className="text-sm font-600">{calTitle}</span>
                      <button type="button" onClick={() => setCalCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))} className="p-1 rounded hover:bg-white/20 cursor-pointer transition-colors"><Icon name="chevron-right" size={14} /></button>
                    </div>
                    <div className="p-3 pb-2">
                      <div className="grid grid-cols-7 gap-1 mb-1">
                        {dayLabels.map(d => <span key={d} className="text-center text-xs font-600 text-slate-400">{d}</span>)}
                      </div>
                      <div className="grid grid-cols-7 gap-1">
                        {cells.map((d, i) => d === null
                          ? <span key={`e-${i}`} />
                          : <button key={`d-${i}`} type="button" onClick={() => selectDay(d)}
                              className="text-center text-sm py-1 rounded-sm hover:bg-blue-50 cursor-pointer transition-colors">{d}</button>)}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-blue-50">
                <th className="text-left px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200">{t("totalAmount", lang)}</th>
                <th className="text-left px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200">{t("taxRate", lang)}</th>
                <th className="text-left px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200">{t("taxAmount", lang)}</th>
                <th className="text-left px-3 py-2.5 text-sm font-700 text-white bg-[#1a3458] border border-[#1a3458]">{t("billedAmount", lang)}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-3 py-2.5 font-mono font-600 text-slate-800 border border-slate-200">¥{subtotal.toLocaleString()}</td>
                <td className="px-3 py-2.5 font-mono text-slate-700 border border-slate-200">10%</td>
                <td className="px-3 py-2.5 font-mono text-slate-700 border border-slate-200">¥{tax.toLocaleString()}</td>
                <td className="px-3 py-2.5 font-mono font-700 text-[#0d7377] border border-slate-200">¥{billed.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          <table className="w-full border-collapse text-base mt-6">
            <thead>
              <tr className="bg-blue-50">
                <th className="text-left px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200">{t("itemLabel", lang)}</th>
                <th className="text-right px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200 w-28">{t("unitPriceLabel", lang)}</th>
                <th className="text-right px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200 w-20">{t("qtyLabel", lang)}</th>
                <th className="text-right px-3 py-2.5 text-sm font-600 text-slate-600 border border-slate-200 w-32">{t("invoiceAmount", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(o => (
                <tr key={o.id} className="bg-white">
                  <td className="px-3 py-2.5 text-slate-800 border-b border-slate-100">{o.productName}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-sm text-slate-600 border-b border-slate-100">¥{(o.orderAmount / o.quantity).toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right text-slate-700 border-b border-slate-100">{o.quantity}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-600 text-slate-800 border-b border-slate-100">¥{o.orderAmount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-center text-xs text-slate-300 mt-8">{t("pageOf", lang).replace("{c}", String(currentPage)).replace("{t}", String(totalPages))}</p>
        </div>
      </div>
    </AppShell>
  );
}

// ---- Page 4: Client master ----

function ClientMasterPage({ clients, setClients, products, scanRouting, setScanRouting, lang, setLang, onNavigate }: {
  clients: Client[]; setClients: React.Dispatch<React.SetStateAction<Client[]>>;
  products: Product[];
  scanRouting: ScanRouting; setScanRouting: (s: ScanRouting) => void;
  lang: Lang; setLang: (l: Lang) => void;
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
}) {
  const isScanRouted = scanRouting.stage === "need-client" && scanRouting.data !== null;
  const sd = scanRouting.data;

  const blankForm = (): Client => ({ id: `c${Date.now()}`, name: sd && isScanRouted ? sd.client : "", phone: sd && isScanRouted ? sd.clientPhone : "", email: "", postalCode: sd && isScanRouted ? sd.clientPostalCode : "", address: sd && isScanRouted ? sd.clientAddress : "" });

  const [selectedId, setSelectedId] = useState(isScanRouted ? "" : clients[0]?.id ?? "");
  const [form, setForm] = useState<Client>(isScanRouted ? blankForm() : clients[0] ?? blankForm());
  const [isNew, setIsNew] = useState(isScanRouted);
  const [dirty, setDirty] = useState(isScanRouted);
  const [search, setSearch] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});

  const filteredClients = clients.filter(c => !search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase()));

  const sf = (v: keyof Client) => (e: string) => {
    setForm(prev => ({ ...prev, [v]: e }));
    setErrors(prev => ({ ...prev, [v]: "" }));
    setDirty(true);
  };

  const handleNew = () => {
    setForm({ id: `c${Date.now()}`, name: "", phone: "", email: "", postalCode: "", address: "" });
    setIsNew(true); setSelectedId(""); setErrors({}); setDirty(true);
  };

  const handleSave = async () => {
    const errs = validateClient(form, clients, isNew);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    let updated: Client[];
    let saved: Client;
    if (isNew) {
      const record = { ...form, id: genUUID() };
      updated = clients.some(c => c.id === record.id) ? clients : [...clients, record];
      setClients(updated);
      setForm(record);
      setSelectedId(record.id);
      setIsNew(false);
      saved = record;
    } else {
      updated = clients.map(c => c.id === form.id ? form : c);
      setClients(updated);
      saved = form;
    }
    setErrors({});
    setDirty(false);
    await upsertClient(saved).catch(err => alert(`Failed to save client: ${err.message}`));

    // Continue scan routing
    if (isScanRouted && sd) {
      const productExists = products.some(p => p.productName === sd.productName && p.clientName === sd.client);
      if (!productExists) {
        setScanRouting({ stage: "need-product", data: sd });
        onNavigate("product-master");
      } else {
        setScanRouting({ stage: "filling", data: sd });
        onNavigate("order-entry");
      }
    }
  };

  const handlePostalSearch = () => {
    const e: FormErrors = {};
    if (!POSTAL_RE.test(form.postalCode)) {
      e.postalCode = "Format must be: 3 digits, hyphen, 4 digits (e.g. 393-0011).";
      setErrors(prev => ({ ...prev, ...e }));
      return;
    }
    // Mock API response
    setForm(prev => ({ ...prev, address: t("addressAutoFill", lang).replace("{postal}", prev.postalCode) }));
    setDirty(true);
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("clientMaster", lang)} showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      {isScanRouted && (
        <ScanBanner message={`Client "${sd?.client}" was not found in the Client Master. Please review the pre-filled details below and click Save to continue the scanned order import.`} />
      )}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-60 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
          <div className="p-3 border-b border-slate-200 shrink-0">
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-2 border-slate-300 rounded-sm bg-white transition-colors">
              <Icon name="search" size={15} className="text-slate-400 shrink-0" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("searchClients", lang)}
                className="w-full bg-transparent text-base placeholder:text-slate-400 focus:outline-none" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredClients.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-400 text-center">{t("noClientsFound", lang)}</div>
            ) : filteredClients.map(c => (
              <button key={c.id} onClick={() => { setForm(c); setSelectedId(c.id); setIsNew(false); setErrors({}); setDirty(false); }}
                className={`w-full text-left px-4 py-3.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors ${selectedId === c.id ? "bg-blue-50 border-l-4 border-l-[#1a3458]" : "border-l-4 border-l-transparent"}`}>
                <div className="font-600 text-base text-slate-800 truncate">{c.name}</div>
                <div className="text-sm text-slate-400 mt-0.5 font-mono">〒 {c.postalCode}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 p-7 overflow-y-auto">
          {Object.values(errors).some(v => v) && (
            <div className="flex items-start gap-3 px-4 py-3 mb-4 bg-red-50 border border-red-200 rounded-sm max-w-lg">
              <Icon name="alert-triangle" size={17} className="text-red-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm text-red-700">{t("errorBanner", lang)}</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  {Object.entries(errors).filter(([, v]) => v).map(([k, v]) => (
                    <li key={k} className="text-sm text-red-700">{v}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <div className="max-w-lg">
            <div className="flex items-center gap-2 mb-5">
              <h2 className="text-lg font-700 text-slate-800">
                {isNew ? t("newClient", lang) : dirty ? `${t("editingPrefix", lang)}: ${form.name}` : t("clientDetails", lang)}
              </h2>
              {dirty && <span className="w-2.5 h-2.5 rounded-full bg-orange-500 animate-pulse shrink-0" />}
            </div>
            <div className="bg-white border border-slate-200 rounded-sm p-6 space-y-4">
              <FieldBox label={t("clientNameLabel", lang)} error={errors.name}>
                <TextInput value={form.name} onChange={sf("name")} hasError={!!errors.name} maxLength={100} />
                <p className="text-xs text-slate-400 mt-0.5 text-right">{form.name.length}/100</p>
              </FieldBox>
              <FieldBox label={t("phoneNumber", lang)} error={errors.phone}>
                <TextInput value={form.phone} onChange={sf("phone")} hasError={!!errors.phone} maxLength={20} placeholder="e.g. 0266-28-0105" />
                <p className="text-xs text-slate-400 mt-0.5">{lang === "ja" ? "数字とハイフンのみ、最大20文字" : "Digits and hyphens only, max 20 characters"}</p>
              </FieldBox>
              <FieldBox label={t("emailAddress", lang)}>
                <TextInput type="email" value={form.email} onChange={sf("email")} placeholder="info@example.com" />
              </FieldBox>
              <FieldBox label={t("postalCodeLabel", lang)} error={errors.postalCode}>
                <div className="flex gap-2">
                  <TextInput value={form.postalCode} onChange={sf("postalCode")} hasError={!!errors.postalCode} placeholder="e.g. 393-0011" />
                  <Btn variant="outline" size="sm" onClick={handlePostalSearch}><Icon name="search" size={14} /></Btn>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{lang === "ja" ? "形式: 3桁-4桁" : "Format: 3 digits, hyphen, 4 digits"}</p>
              </FieldBox>
              <FieldBox label={t("addressLabel", lang)} error={errors.address}>
                <TextInput value={form.address} onChange={sf("address")} hasError={!!errors.address} maxLength={255} />
                <p className="text-xs text-slate-400 mt-0.5 text-right">{form.address.length}/255</p>
              </FieldBox>
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center gap-3 px-5 py-3 bg-[#1a3458] shrink-0">
        <Btn variant="ghost" size="lg" onClick={handleNew}><Icon name="plus" size={15} />{t("newButton", lang)}</Btn>
        <div className="flex-1" />
        <Btn variant="action" size="lg" onClick={handleSave} disabled={!dirty || Object.values(errors).some(v => v)}><Icon name="save" size={15} />{isScanRouted ? t("saveAndContinue", lang) : t("saveButton", lang)}</Btn>
        <Btn variant="danger" size="lg" disabled={isNew} onClick={() => { const deletedId = form.id; setClients(prev => prev.filter(c => c.id !== deletedId)); setIsNew(false); setDirty(false); if (clients[0]) { setForm(clients[0]); setSelectedId(clients[0].id); } deleteClient(deletedId).catch(err => alert(`Failed to delete client: ${err.message}`)); }}>
          <Icon name="trash" size={15} />{t("deleteButton", lang)}
        </Btn>
      </footer>
    </AppShell>
  );
}

// ---- Page 5: Product master ----

function ProductMasterPage({ products, setProducts, clients, scanRouting, setScanRouting, lang, setLang, onNavigate }: {
  products: Product[]; setProducts: React.Dispatch<React.SetStateAction<Product[]>>;
  clients: Client[];
  scanRouting: ScanRouting; setScanRouting: (s: ScanRouting) => void;
  lang: Lang; setLang: (l: Lang) => void;
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
}) {
  const isScanRouted = scanRouting.stage === "need-product" && scanRouting.data !== null;
  const sd = scanRouting.data;

  const blankForm = (): Product => ({
    id: `p${Date.now()}`,
    clientName: sd && isScanRouted ? sd.client : "",
    productName: sd && isScanRouted ? sd.productName : "",
    productNumber: sd && isScanRouted ? sd.productNumber : "",
    unitPrice: sd && isScanRouted ? sd.unitPrice : "",
    tasks: makeTasks(54),
    drawings: makeDrawings(4),
  });

  const [selectedId, setSelectedId] = useState(isScanRouted ? "" : products[0]?.id ?? "");
  const [form, setForm] = useState<Product>(isScanRouted ? blankForm() : products[0] ?? blankForm());
  const [isNew, setIsNew] = useState(isScanRouted);
  const [dirty, setDirty] = useState(isScanRouted);
  const [errors, setErrors] = useState<FormErrors>({});
  const [search, setSearch] = useState("");
  const [drawingIndex, setDrawingIndex] = useState<number | null>(null);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const [showCalcInfo, setShowCalcInfo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const taskErrors = Object.entries(errors).filter(([k, v]) => k.startsWith("task_") && v);
  const filtered = products.filter(p => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return p.productName.toLowerCase().includes(q) || p.productNumber.toLowerCase().includes(q);
  });
  const totalTime = form.tasks.reduce((s, t) => s + (t.time === "" ? 0 : Number(t.time)), 0);

  const sf = (v: keyof Product) => (e: string) => {
    setForm(prev => ({ ...prev, [v]: e }));
    setErrors(prev => ({ ...prev, [v]: "" }));
    setDirty(true);
  };

  const handleNew = () => {
    setForm({ id: `p${Date.now()}`, clientName: "", productName: "", productNumber: "", unitPrice: "", tasks: makeTasks(54), drawings: makeDrawings(4) });
    setIsNew(true); setSelectedId(""); setErrors({}); setDirty(true);
  };

  const handleDrawingClick = (i: number) => {
    setDrawingIndex(i);
    fileRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && drawingIndex !== null) {
      const reader = new FileReader();
      reader.onload = () => {
        setForm(prev => {
          const drawings = [...prev.drawings];
          drawings[drawingIndex] = String(reader.result);
          return { ...prev, drawings };
        });
        setDirty(true);
      };
      reader.readAsDataURL(file);
    }
    e.target.value = "";
  };

  const removeDrawing = (i: number) => {
    setForm(prev => {
      const drawings = [...prev.drawings];
      drawings[i] = "";
      return { ...prev, drawings };
    });
    setDirty(true);
  };

  const addDrawingSlots = () => {
    setForm(prev => ({ ...prev, drawings: [...prev.drawings, "", "", "", ""] }));
    setDirty(true);
  };

  const handleSave = async () => {
    const errs = validateProduct(form, products, isNew);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    const record = isNew ? { ...form, id: genUUID() } : form;
    if (isNew) {
      setProducts(prev => prev.some(p => p.id === record.id) ? prev : [...prev, record]);
      setForm(record);
      setSelectedId(record.id);
      setIsNew(false);
    } else {
      setProducts(prev => prev.map(p => p.id === record.id ? record : p));
    }
    setErrors({});
    setDirty(false);

    try {
      // upsertProduct uploads any new data: URI drawings to Storage and
      // returns the record with hosted URLs in their place.
      const saved = await upsertProduct(record);
      setProducts(prev => prev.map(p => p.id === saved.id ? saved : p));
      setForm(prev => prev.id === saved.id ? saved : prev);
    } catch (err) {
      alert(`Failed to save product: ${err instanceof Error ? err.message : err}`);
    }

    // Continue scan routing
    if (isScanRouted && sd) {
      setScanRouting({ stage: "filling", data: sd });
      onNavigate("order-entry");
    }
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("productMaster", lang)} showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      {isScanRouted && (
        <ScanBanner message={`Product "${sd?.productName}" (${sd?.productNumber}) was not found in the Product Master. Please review the pre-filled details below and click Save to continue the scanned order import.`} />
      )}
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-60 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
          <div className="p-3 border-b border-slate-200 shrink-0">
            <div className="flex items-center gap-2 px-3.5 py-2.5 border-2 border-slate-300 rounded-sm bg-white transition-colors">
              <Icon name="search" size={15} className="text-slate-400 shrink-0" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("searchItemPlaceholder", lang)}
                className="w-full bg-transparent text-base placeholder:text-slate-400 focus:outline-none" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-400 text-center">{t("noProductsFound", lang)}</div>
            ) : filtered.map(p => (
              <button key={p.id} onClick={() => { setForm(p); setSelectedId(p.id); setIsNew(false); setErrors({}); setDirty(false); }}
                className={`w-full text-left px-4 py-3.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors ${selectedId === p.id ? "bg-blue-50 border-l-4 border-l-[#1a3458]" : "border-l-4 border-l-transparent"}`}>
                <div className="font-600 text-base text-slate-800 truncate">{p.productName}</div>
                <div className="text-sm text-slate-400 font-mono truncate">{p.productNumber}</div>
                <div className="text-sm text-[#0d7377] mt-0.5">{p.unitPrice === "" ? "-" : `¥${Number(p.unitPrice).toLocaleString()}`}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex-1 overflow-y-auto p-5">
          {(Object.entries(errors).some(([k, v]) => v && !k.startsWith("task_")) || taskErrors.length > 0) && (
            <div className="flex items-start gap-3 px-4 py-3 mb-4 bg-red-50 border border-red-200 rounded-sm">
              <Icon name="alert-triangle" size={17} className="text-red-600 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm text-red-700">{t("errorBanner", lang)}</p>
                <ul className="list-disc list-inside mt-1 space-y-0.5">
                  {Object.entries(errors).filter(([k, v]) => v && !k.startsWith("task_")).map(([k, v]) => (
                    <li key={k} className="text-sm text-red-700">{v}</li>
                  ))}
                  {taskErrors.map(([k, v]) => (
                    <li key={k} className="text-sm text-red-700">{v}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-sm p-5 space-y-5">
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
            <div className="grid grid-cols-2 gap-4">
              <FieldBox label={t("clientNameLabel", lang)}>
                <SelectInput value={form.clientName} onChange={sf("clientName")} placeholder={t("selectPlaceholder", lang)} options={["", ...clients.map(c => c.name)]} />
              </FieldBox>
              <FieldBox label={t("productNameLabel", lang)} error={errors.productName}>
                <TextInput value={form.productName} onChange={sf("productName")} hasError={!!errors.productName} maxLength={100} />
                <p className="text-xs text-slate-400 mt-0.5 text-right">{form.productName.length}/100</p>
              </FieldBox>
              <FieldBox label={t("productNumberLabel", lang)} error={errors.productNumber}>
                <TextInput value={form.productNumber} onChange={sf("productNumber")} hasError={!!errors.productNumber} maxLength={50} placeholder="e.g. NHD-F1772-11" />
                <p className="text-xs text-slate-400 mt-0.5">{lang === "ja" ? "英数字・取引先ごとに一意・最大50文字" : "Alphanumeric, unique per client, max 50 characters"}</p>
              </FieldBox>
              <FieldBox label={t("unitPriceYen", lang)} error={errors.unitPrice}>
                <TextInput type="number" value={form.unitPrice === 0 ? "" : form.unitPrice} onChange={e => { const cleanVal = e.replace(/^0+(?=\d)/, ""); setForm(prev => ({ ...prev, unitPrice: cleanVal === "" ? 0 : parseInt(cleanVal, 10) })); setErrors(prev => ({ ...prev, unitPrice: "" })); setDirty(true); }} hasError={!!errors.unitPrice} />
                <p className="text-xs text-slate-400 mt-0.5">{lang === "ja" ? "整数 0〜99,999,999" : "Whole number, 0 to 99,999,999"}</p>
              </FieldBox>
            </div>

            <div>
              <p className="text-sm font-600 text-slate-500 mb-2">{t("drawings", lang).replace("{n}", String(form.drawings.length))}</p>
              <div className="grid grid-cols-4 gap-3">
                {form.drawings.map((d, i) => (
                  d ? (
                    <div key={i} className="relative aspect-video border-2 border-[#1a3458] rounded-sm overflow-hidden group">
                      <img src={d} alt={`${t("drawingLabel", lang)} ${i + 1}`} className="w-full h-full object-cover" />
                      <button onClick={() => removeDrawing(i)} title={t("deleteButton", lang)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-white/90 text-red-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ) : (
                    <button key={i} onClick={() => handleDrawingClick(i)}
                      className="aspect-video border-2 border-dashed border-slate-300 rounded-sm flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-[#1a3458] hover:bg-[#f5f6f8] transition-colors">
                      <Icon name="image" size={22} className="text-slate-300" />
                      <span className="text-xs text-slate-400">{t("drawingLabel", lang)} {i + 1}</span>
                      <span className="text-xs text-slate-400 text-center px-2 leading-snug">{t("addImage", lang)}</span>
                    </button>
                  )
                ))}
              </div>
              <button onClick={addDrawingSlots} className="mt-3 flex items-center gap-1.5 text-sm text-[#0d7377] hover:text-[#1a3458] cursor-pointer transition-colors">
                <Icon name="plus" size={14} />{t("addDrawingSlots", lang)}
              </button>
            </div>

            <div className="relative flex items-center gap-3 px-4 py-3 bg-[#f5f6f8] border border-slate-200 rounded-sm">
              <span className="text-sm font-600 text-slate-600">{t("totalRequiredTime", lang)}</span>
              <button type="button" onClick={() => setShowCalcInfo(v => !v)}
                className="text-slate-400 hover:text-[#1a3458] cursor-pointer transition-colors shrink-0"
                aria-label={t("autoCalcInfo", lang)}>
                <Icon name="info" size={15} />
              </button>
              <span className="text-2xl font-700 text-[#1a3458] font-mono">{totalTime.toFixed(1)}</span>
              <span className="text-sm text-slate-400">({t("autoCalculated", lang)})</span>
              <span className="text-sm text-slate-500">{t("minPerUnit", lang)}</span>
              {showCalcInfo && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowCalcInfo(false)} />
                  <div className="absolute left-3 top-full mt-2 z-50 w-72 bg-white border border-slate-200 rounded-sm shadow-lg px-4 py-3 text-sm text-slate-600">
                    {t("autoCalcInfo", lang)}
                  </div>
                </>
              )}
            </div>

            <div>
              <p className="text-sm font-600 text-slate-500 mb-2">{t("manufacturingTasks", lang)}</p>
              <div className="task-scroll border border-slate-200 rounded-sm max-h-[420px] overflow-y-scroll overscroll-contain">
                <table className="w-full border-collapse text-base">
                  <thead className="bg-[#f5f6f8] sticky top-0 z-10">
                    <tr className="border-b border-slate-200">
                      <th className="text-center px-3 py-2 text-sm font-600 text-slate-400 w-14">{t("taskNoHeader", lang)}</th>
                      <th className="text-left px-3 py-2 text-sm font-600 text-slate-500">{t("taskContent", lang)}</th>
                      <th className="text-right px-3 py-2 text-sm font-600 text-slate-500 w-36">{t("taskTime", lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.tasks.map((t, i) => (
                      <tr key={i} className={`border-b border-slate-100 last:border-0 transition-colors ${focusedRow === i ? "bg-slate-50" : ""}`}>
                        <td className="px-3 py-1.5 text-center text-sm text-slate-300 font-mono">{i + 1}</td>
                        <td className="px-3 py-1.5">
                          <input value={t.content} maxLength={100}
                            onFocus={() => setFocusedRow(i)}
                            onChange={e => {
                              const tasks = form.tasks.map((x, j) => j === i ? { ...x, content: e.target.value } : x);
                              setForm(prev => ({ ...prev, tasks }));
                              setErrors(prev => ({ ...prev, [`task_content_${i}`]: "" }));
                              setDirty(true);
                            }}
                            className={`w-full px-2 py-1 text-base border rounded-sm focus:outline-none focus:border-[#1a3458] transition-colors ${errors[`task_content_${i}`] ? "border-red-400" : "border-slate-200"}`} />
                          {errors[`task_content_${i}`] && <p className="text-xs text-red-600 mt-1">{errors[`task_content_${i}`]}</p>}
                        </td>
                        <td className="px-3 py-1.5">
                          <input type="number" step="0.1" min="0" max="999.9" value={t.time}
                            onFocus={() => setFocusedRow(i)}
                            onChange={e => {
                              // Strip leading zeros before decimal (01.5 -> 1.5) but keep 0.5 valid
                              const raw = e.target.value.replace(/^0+(?=[1-9])/, "");
                              const parsed = raw === "" ? ("" as const) : parseFloat(raw);
                              const tasks: ProductTask[] = form.tasks.map((x, j) => j === i ? { ...x, time: isNaN(parsed as number) ? 0 : parsed } : x);
                              setForm(prev => ({ ...prev, tasks }));
                              setErrors(prev => ({ ...prev, [`task_time_${i}`]: "" }));
                              setDirty(true);
                            }}
                            className={`w-full px-2 py-1 text-base border rounded-sm text-right font-mono focus:outline-none focus:border-[#1a3458] transition-colors ${errors[`task_time_${i}`] ? "border-red-400" : "border-slate-200"}`} />
                          {errors[`task_time_${i}`] && <p className="text-xs text-red-600 mt-1">{errors[`task_time_${i}`]}</p>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </div>

      <footer className="flex items-center gap-3 px-5 py-3 bg-[#1a3458] shrink-0">
        <Btn variant="ghost" size="lg" onClick={handleNew}><Icon name="plus" size={15} />{t("newButton", lang)}</Btn>
        <div className="flex-1" />
        <Btn variant="action" size="lg" onClick={handleSave} disabled={!dirty || Object.values(errors).some(v => v)}><Icon name="save" size={15} />{isScanRouted ? t("saveAndContinue", lang) : t("saveButton", lang)}</Btn>
        <Btn variant="danger" size="lg" disabled={isNew} onClick={() => { const deletedId = form.id; setProducts(prev => prev.filter(p => p.id !== deletedId)); setIsNew(false); setDirty(false); if (products[0]) { setForm(products[0]); setSelectedId(products[0].id); } deleteProduct(deletedId).catch(err => alert(`Failed to delete product: ${err.message}`)); }}>
          <Icon name="trash" size={15} />{t("deleteButton", lang)}
        </Btn>
      </footer>
    </AppShell>
  );
}

// ---- Page 6: Delivery slip ----

function DeliverySlipPage({ mode, orders, lang, setLang, onNavigate }: {
  mode: DeliverySlipMode; orders: OrderRecord[]; lang: Lang; setLang: (l: Lang) => void; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
}) {
  const items = mode === "single" ? orders.slice(3, 4) : orders.slice(3, 5);
  const total = items.reduce((s, o) => s + o.orderAmount, 0);
  const tax = Math.round(total * 0.1);
  const today = new Date();
  const todayStr = lang === "ja"
    ? `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`
    : today.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const ph = {
    inCharge: lang === "ja" ? "氏名" : "Name",
    conditions: lang === "ja" ? "条件" : "Conditions",
    terms: lang === "ja" ? "条件" : "Terms",
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("deliverySlipTitle", lang)} showBack backTarget="search-billing" backLabel={t("searchBilling", lang)} lang={lang} setLang={setLang}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#f5f6f8] border-b border-slate-200 shrink-0">
        <Btn variant="outline" size="sm" onClick={() => onNavigate("search-billing")}><Icon name="chevron-left" size={14} />{t("returnButton", lang)}</Btn>
        <div className="flex-1" />
        <Btn variant="primary" size="sm" onClick={() => window.print()}><Icon name="printer" size={15} />{t("printButton", lang)}</Btn>
      </div>
      <div className="flex-1 overflow-y-auto flex justify-center p-8 bg-slate-300">
        <div className="w-full max-w-2xl bg-white shadow-md p-10">
          <h2 className="text-3xl font-700 text-slate-800 pb-2 border-b-2 border-slate-800 inline-block mb-2">{t("deliverySlipTitle", lang)}</h2>
          <p className="text-sm text-slate-500 mb-6"><span className="font-600 text-slate-600">{t("deliveryDateLabel", lang)}:</span><span className="ml-2 font-mono">{todayStr}</span></p>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <FieldBox label={t("inCharge", lang)}><TextInput value="" placeholder={ph.inCharge} onChange={() => {}} /></FieldBox>
            <FieldBox label={t("deliveryConditions", lang)}><TextInput value="" placeholder={ph.conditions} onChange={() => {}} /></FieldBox>
            <FieldBox label={t("paymentTerms", lang)}><TextInput value="" placeholder={ph.terms} onChange={() => {}} /></FieldBox>
          </div>
          <table className="w-full border-collapse text-base mb-6">
            <thead>
              <tr className="border-b-2 border-slate-200">
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-left">{t("orderNoLabel", lang)}</th>
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-left">{t("productNameLabel", lang)}</th>
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-left">{t("deliveryLabel", lang)}</th>
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-right">{t("qtyLabel", lang)}</th>
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-right">{t("unitPriceLabel", lang)}</th>
                <th className="px-3 py-2 text-sm font-600 text-slate-500 text-right">{t("invoiceAmount", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(o => (
                <tr key={o.id} className="border-b border-slate-100">
                  <td className="px-3 py-2.5 font-mono text-sm text-slate-600">{o.orderNumber}</td>
                  <td className="px-3 py-2.5 text-slate-800">{o.productName}</td>
                  <td className="px-3 py-2.5 font-mono text-sm text-slate-600">{o.deliveryDate}</td>
                  <td className="px-3 py-2.5 text-right text-slate-700">{o.quantity}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-sm text-slate-600">¥{(o.orderAmount / o.quantity).toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right font-mono font-600 text-slate-800">¥{o.orderAmount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex flex-col items-end gap-1 text-base">
            <div className="flex gap-8"><span className="text-slate-500">{t("totalAmount", lang)}</span><span className="font-mono font-600 w-28 text-right">¥{total.toLocaleString()}</span></div>
            <div className="flex gap-8"><span className="text-slate-500">{t("taxRate", lang)}</span><span className="w-28 text-right">10%</span></div>
            <div className="flex gap-8"><span className="text-slate-500">{t("consumptionTax", lang)}</span><span className="font-mono w-28 text-right">¥{tax.toLocaleString()}</span></div>
            <div className="flex gap-8 border-t border-slate-200 pt-2 mt-1">
              <span className="font-700">{t("taxIncludedAmount", lang)}</span>
              <span className="font-mono font-700 text-[#1a3458] w-28 text-right">¥{(total + tax).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

// ---- Page 7: Schedule & capacity ----

function SchedulePage({ orders, setOrders, products, onNavigate, lang, setLang }: {
  orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  products: Product[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; lang: Lang; setLang: (l: Lang) => void;
}) {
  const [currentDate, setCurrentDate] = useState(new Date("2025-11-01"));
  const [headcount, setHeadcount] = useState(3);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"1W" | "2W" | "3W" | "6W">("6W");
  const [statusFilter, setStatusFilter] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(SCHEDULE_STATUS_COLORS).map(k => [k, true]))
  );
  const [panelForm, setPanelForm] = useState<OrderRecord | null>(null);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const productByKey = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach(p => m.set(`${p.clientName}|${p.productName}`, p));
    return m;
  }, [products]);

  const clearSelection = () => { setSelectedId(null); setPanelForm(null); setSaved(false); setDirty(false); };

  const selectBlock = (o: OrderRecord) => { setSelectedId(o.id); setPanelForm({ ...o }); setSaved(false); setDirty(false); };

  const toggleStatus = (status: string) => {
    setStatusFilter(prev => ({ ...prev, [status]: !prev[status] }));
    clearSelection();
  };

  const changeMonth = (delta: number) => {
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1));
    clearSelection();
  };

  const toISO = (d: Date) => {
    const dd = new Date(d);
    dd.setMinutes(dd.getMinutes() - dd.getTimezoneOffset());
    return dd.toISOString().split("T")[0];
  };

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const prevDays = new Date(year, month, 0).getDate();

  const calendarDays: { day: number; isCurrentMonth: boolean; dateStr: string }[] = [];
  for (let i = 0; i < firstDay; i++) {
    const d = prevDays - firstDay + i + 1;
    calendarDays.push({ day: d, isCurrentMonth: false, dateStr: toISO(new Date(year, month - 1, d)) });
  }
  for (let i = 1; i <= daysInMonth; i++) calendarDays.push({ day: i, isCurrentMonth: true, dateStr: toISO(new Date(year, month, i)) });
  const pad = 42 - calendarDays.length;
  for (let i = 1; i <= pad; i++) calendarDays.push({ day: i, isCurrentMonth: false, dateStr: toISO(new Date(year, month + 1, i)) });

  const gridRows = viewMode === "1W" ? 1 : viewMode === "2W" ? 2 : viewMode === "3W" ? 3 : 6;
  const visibleDays = calendarDays.slice(0, gridRows * 7);
  const weekdayLabels = lang === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthLabel = lang === "ja"
    ? `${year}年${String(month + 1).padStart(2, "0")}月`
    : currentDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const form = panelForm;
  const remainingMins = form ? (form.requiredManhours - form.workedManhours) : 0;
  const marginDays = form?.deliveryDate
    ? Math.round((new Date(form.deliveryDate + "T00:00:00").getTime() - Date.now()) / 86400000)
    : null;
  const prodInfo = form ? productByKey.get(`${form.client}|${form.productName}`) ?? null : null;

  const spf = (k: keyof OrderRecord) => (e: string) => { setPanelForm(prev => prev ? { ...prev, [k]: e } : prev); setDirty(true); };
  const npf = (k: "requiredManhours" | "workedManhours") => (e: string) => {
    const clean = e.replace(/^0+(?=\d)/, "");
    const val = clean === "" ? 0 : parseInt(clean, 10);
    setPanelForm(prev => prev ? { ...prev, [k]: val } : prev);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!form || !dirty) return;
    setOrders(prev => prev.map(o => o.id === form.id ? form : o));
    setDirty(false);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
    await upsertOrder(form).catch(err => alert(`Failed to save order: ${err.message}`));
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("scheduleTitle", lang)} showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      <div className="flex flex-1 overflow-hidden min-h-0 bg-[#f5f6f8]">
        <aside className="w-48 flex flex-col bg-[#1a3458] border-r border-slate-200 shrink-0 p-2 gap-2 overflow-y-auto min-h-0">
          <p className="mt-1 px-2 text-xs font-700 text-white/60 shrink-0">{t("scheduleFilter", lang)}</p>
          <div className="flex flex-col gap-1.5">
            {Object.entries(SCHEDULE_STATUS_COLORS).map(([status, colorClass]) => {
              const active = statusFilter[status];
              return (
                <button key={status} type="button" onClick={() => toggleStatus(status)}
                  className={`px-2 py-2 text-xs font-600 text-center rounded-sm transition-opacity border cursor-pointer ${colorClass} ${active ? "opacity-100" : "opacity-40"}`}>
                  {status}
                </button>
              );
            })}
          </div>
        </aside>

        <main className="flex-1 flex flex-col min-h-0 bg-white">
          <div className="flex items-center justify-between px-4 py-2 bg-[#f0f4f8] border-b border-slate-200 shrink-0">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 bg-slate-800 text-white px-3 py-1 rounded-sm text-sm">
                <span className="font-600 whitespace-nowrap">{t("remainingHeads", lang)}</span>
                <input type="number" min={0} value={headcount} onChange={e => setHeadcount(Number(e.target.value))}
                  className="w-12 px-1 text-black bg-white rounded-sm text-center focus:outline-none focus:ring-2 focus:ring-[#1a3458]" />
                <span className="whitespace-nowrap">{t("headsUnit", lang)}</span>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => changeMonth(-1)} aria-label={lang === "ja" ? "前月" : "Previous month"}
                className="p-1 rounded-sm hover:bg-slate-200 cursor-pointer transition-colors"><Icon name="chevron-left" size={20} /></button>
              <h2 className="text-xl font-700 text-slate-800 w-44 text-center whitespace-nowrap">{monthLabel}</h2>
              <button type="button" onClick={() => changeMonth(1)} aria-label={lang === "ja" ? "翌月" : "Next month"}
                className="p-1 rounded-sm hover:bg-slate-200 cursor-pointer transition-colors"><Icon name="chevron-right" size={20} /></button>
            </div>
            <div className="flex bg-[#1a3458] text-white rounded-sm overflow-hidden">
              {(["1W", "2W", "3W", "6W"] as const).map(mode => (
                <button key={mode} type="button" onClick={() => setViewMode(mode)}
                  className={`px-3 py-1 text-sm font-600 border-r border-white/20 last:border-0 cursor-pointer transition-colors ${viewMode === mode ? "bg-blue-600" : "hover:bg-blue-900"}`}>
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-7 border-b-2 border-slate-200 shrink-0">
            {weekdayLabels.map((day, i) => (
              <div key={day} className={`text-center py-1.5 text-sm font-600 text-white ${i === 0 ? "bg-red-600" : i === 6 ? "bg-blue-600" : "bg-slate-700"} border-r border-white/20 last:border-0`}>
                {day}
              </div>
            ))}
          </div>

          <div className="flex-1 grid grid-cols-7 overflow-y-auto min-h-0"
            style={{ gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))` }}>
            {visibleDays.map((calDay, i) => {
              const dayOrders = orders.filter(o => o.deliveryDate === calDay.dateStr && statusFilter[o.progress]);
              return (
                <div key={i} className={`flex flex-col border-r border-b border-slate-200 p-1 ${calDay.isCurrentMonth ? "bg-white" : "bg-slate-50"} overflow-hidden`}>
                  <span className={`text-xs font-700 mb-1 leading-none ${!calDay.isCurrentMonth ? "text-slate-400" : i % 7 === 0 ? "text-red-600" : i % 7 === 6 ? "text-blue-600" : "text-slate-700"}`}>
                    {calDay.day}
                  </span>
                  <div className="flex flex-col gap-1 overflow-y-auto min-h-0 pr-0.5">
                    {dayOrders.map(o => {
                      const bg = SCHEDULE_STATUS_COLORS[o.progress] || "bg-slate-200 text-slate-800 border-slate-300";
                      const isSelected = selectedId === o.id;
                      return (
                        <div key={o.id} onClick={() => selectBlock(o)}
                          className={`text-[10px] leading-tight p-1 rounded-sm border cursor-pointer truncate select-none ${bg} ${isSelected ? "ring-2 ring-slate-900" : ""}`}
                          title={`${o.productName} - ${o.client}`}>
                          <span className="font-700">{o.requiredManhours}{t("minUnit", lang)}</span> {o.productName}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </main>

        <aside className="w-80 bg-white border-l-2 border-slate-200 shrink-0 overflow-hidden flex flex-col min-h-0">
          <div className="px-4 py-3 bg-[#f5f6f8] border-b border-slate-200 shrink-0 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className="text-base font-700 text-slate-800">{t("orderDetailsHeader", lang)}</span>
              {dirty && <span className="w-2.5 h-2.5 rounded-full bg-orange-500 animate-pulse shrink-0" role="status" />}
            </span>
            {form && (
              <button type="button" onClick={clearSelection} aria-label="Close" className="p-1.5 rounded-sm hover:bg-slate-200 text-slate-400 hover:text-slate-700 cursor-pointer transition-colors">
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
          {!form ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="w-14 h-14 flex items-center justify-center rounded-full bg-slate-100 text-slate-300 shrink-0">
                <Icon name="calendar" size={26} />
              </div>
              <p className="text-sm text-slate-500">{t("selectBlockHint", lang)}</p>
            </div>
          ) : (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <FieldBox label={t("orderDateLabel", lang)}>
                    <TextInput type="date" value={form.orderDate} onChange={spf("orderDate")} />
                  </FieldBox>
                  <FieldBox label={t("deliveryDateLabel", lang)}>
                    <TextInput type="date" value={form.deliveryDate} onChange={spf("deliveryDate")} />
                  </FieldBox>
                </div>
                <FieldBox label={t("client", lang)}>
                  <TextInput value={form.client} readOnly />
                </FieldBox>
                <div className="grid grid-cols-2 gap-3">
                  <FieldBox label={t("orderNumber", lang)}>
                    <TextInput value={form.orderNumber} onChange={spf("orderNumber")} maxLength={50} />
                  </FieldBox>
                  <FieldBox label={t("productNumberLabel", lang)}>
                    <TextInput value={prodInfo?.productNumber ?? "-"} readOnly className="font-mono" />
                  </FieldBox>
                </div>
                <FieldBox label={t("productNameLabel", lang)}>
                  <TextInput value={form.productName} readOnly />
                </FieldBox>

                <div className="p-3 bg-blue-50 border border-blue-200 rounded-sm space-y-2">
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                    <div>
                      <span className="block text-[10px] font-600 text-slate-500 mb-0.5">{t("requiredManhours", lang)} ({t("minUnit", lang)})</span>
                      <input type="number" value={form.requiredManhours === 0 ? "" : form.requiredManhours} onChange={e => npf("requiredManhours")(e.target.value)}
                        className="w-full px-1 py-1.5 text-sm text-right font-mono bg-white border border-slate-300 rounded-sm focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20" />
                    </div>
                    <span className="text-2xl font-900 text-[#1a3458] select-none leading-none pb-1">-</span>
                    <div>
                      <span className="block text-[10px] font-600 text-slate-500 mb-0.5">{t("workedManhours", lang)} ({t("minUnit", lang)})</span>
                      <input type="number" value={form.workedManhours === 0 ? "" : form.workedManhours} onChange={e => npf("workedManhours")(e.target.value)}
                        className="w-full px-1 py-1.5 text-sm text-right font-mono bg-white border border-slate-300 rounded-sm focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2 border-t border-blue-200">
                    <span className="text-xs font-700 text-slate-700">{t("remainingManhours", lang)}</span>
                    <span className="font-mono font-700 text-lg leading-none text-[#1a3458]">{remainingMins} <span className="text-sm font-600">{t("minUnit", lang)}</span></span>
                  </div>
                </div>

                <FieldBox label={t("deliveryMargin", lang)}>
                  <TextInput value={marginDays === null ? "-" : `${marginDays} ${t("dayUnit", lang)}`} readOnly />
                </FieldBox>
              </div>
              <div className="px-4 py-3 border-t border-slate-200 shrink-0 flex items-center gap-2">
                {saved && (
                  <span className="flex items-center gap-1 text-sm font-600 text-emerald-700">
                    <Icon name="check" size={14} />{t("saved", lang)}
                  </span>
                )}
                <div className="flex-1" />
                <Btn variant="primary" size="md" className="w-40 justify-center" onClick={handleSave} disabled={!dirty}>
                  <Icon name="save" size={15} />{t("saveButton", lang)}
                </Btn>
              </div>
            </>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

// ---- Page 8: Task checklist ----

function ChecklistPage({ orderId, orders, setOrders, products, onNavigate, lang, setLang }: {
  orderId: string | null; orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  products: Product[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; lang: Lang; setLang: (l: Lang) => void;
}) {
  const order = orders.find(o => o.id === orderId);
  const product = products.find(p => p.clientName === order?.client && p.productName === order?.productName);

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#f5f6f8]">
        <p className="mb-4 text-slate-500">{t("orderNotFound", lang)}</p>
        <Btn variant="primary" onClick={() => onNavigate("order-entry")}>{t("returnButton", lang)}</Btn>
      </div>
    );
  }

  const tasks = product?.tasks || Array(54).fill({ content: "", time: "" });
  const completed = order.completedTasks || Array(54).fill(false);

  const toggleTask = (index: number) => {
    const newCompleted = [...completed];
    newCompleted[index] = !newCompleted[index];
    const updated = { ...order, completedTasks: newCompleted };
    setOrders(prev => prev.map(o => o.id === order.id ? updated : o));
    upsertOrder(updated).catch(err => alert(`Failed to save task progress: ${err.message}`));
  };

  const handleSaveAndReturn = () => {
    onNavigate("order-entry");
  };

  const productNumber = product?.productNumber || "-";

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <header className="flex items-center justify-between px-4 py-2 bg-[#1a3458] shrink-0">
        <div className="flex gap-2">
          <button onClick={() => onNavigate("order-entry")} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("returnButton", lang)}</button>
          <button onClick={handleSaveAndReturn} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("saveAndReturn", lang)}</button>
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("saveButton", lang)}</button>
          <button onClick={() => window.print()} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("printButton", lang)}</button>
          <button className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("toCad", lang)}</button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 pt-5">
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="border border-slate-400 rounded-sm flex flex-col h-full">
            <div className="flex border-b border-slate-400">
              <div className="w-24 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("client", lang)}</div>
              <div className="px-2 py-1 text-sm">{order.client}</div>
            </div>
            <div className="flex flex-1">
              <div className="w-24 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("productName", lang)}</div>
              <div className="px-2 py-1 text-sm">{order.productName}</div>
            </div>
          </div>
          <div className="border border-slate-400 rounded-sm flex flex-col h-full">
            <div className="flex border-b border-slate-400">
              <div className="w-24 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("orderDateLabel", lang)}</div>
              <div className="px-2 py-1 text-sm">{order.orderDate.replace(/-/g, "/")}</div>
            </div>
            <div className="flex border-b border-slate-400">
              <div className="w-24 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("orderNumber", lang)}</div>
              <div className="px-2 py-1 text-sm">{order.orderNumber}</div>
            </div>
            <div className="flex flex-1">
              <div className="w-24 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("productNumber", lang)}</div>
              <div className="px-2 py-1 text-sm">{productNumber}</div>
            </div>
          </div>
          <div className="border border-slate-400 rounded-sm flex flex-col h-full">
            <div className="flex border-b border-slate-400">
              <div className="w-20 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("deliveryDateLabel", lang)}</div>
              <div className="px-2 py-1 text-sm flex-1 text-center">{order.deliveryDate.replace(/-/g, "/")}</div>
            </div>
            <div className="flex flex-1">
              <div className="w-20 bg-slate-100 px-2 py-1 text-sm font-600 border-r border-slate-400 flex items-center">{t("quantity", lang)}</div>
              <div className="px-2 py-1 text-sm flex-1 text-center">{order.quantity}</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-x-8 gap-y-3">
          {tasks.map((task, i) => (
            <label key={i} className="flex items-start gap-3 py-1 cursor-pointer hover:bg-slate-50">
              <span className="w-16 text-sm text-slate-700 shrink-0">{t("taskLabelPrefix", lang)}{i + 1}</span>
              <input type="checkbox" checked={!!completed[i]} onChange={() => toggleTask(i)} className="w-5 h-5 accent-[#1a3458] cursor-pointer shrink-0 border-slate-400 mt-0.5" />
              <span className="text-sm text-slate-800">{task.content}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- Root ----

export default function App() {
  const [page, setPage] = useState<Page>("home");
  const [deliveryMode, setDeliveryMode] = useState<DeliverySlipMode>("single");
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [dataState, setDataState] = useState<"loading" | "ready" | "error">("loading");
  const [dataError, setDataError] = useState("");
  const [scanRouting, setScanRouting] = useState<ScanRouting>({ stage: "idle", data: null });
  const [lang, setLang] = useState<"ja" | "en">("ja");
  const [checklistOrderId, setChecklistOrderId] = useState<string | null>(null);

  useEffect(() => {
    fetchAll()
      .then(data => {
        setClients(data.clients);
        setProducts(data.products);
        setOrders(data.orders);
        setDataState("ready");
      })
      .catch(err => {
        setDataError(err instanceof Error ? err.message : "Failed to load data from Supabase.");
        setDataState("error");
      });
  }, []);

  const navigate = (p: Page, mode?: DeliverySlipMode, orderId?: string) => {
    if (mode) setDeliveryMode(mode);
    if (orderId) setChecklistOrderId(orderId);
    setPage(p);
  };

  const sharedScan = { scanRouting, setScanRouting };
  // Deduplicate by id to guard against React Strict Mode double-updater runs
  const dedupedOrders = useMemo(() => {
    const seen = new Set<string>();
    return orders.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; });
  }, [orders]);

  if (dataState === "loading") {
    return (
      <div className="flex items-center justify-center h-full bg-[#f5f6f8] text-slate-400 text-sm" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        Loading...
      </div>
    );
  }

  if (dataState === "error") {
    return (
      <div className="flex items-center justify-center h-full bg-[#f5f6f8] p-8" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        <div className="max-w-md flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-sm">
          <Icon name="alert-triangle" size={17} className="text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{dataError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden" style={{ fontFamily: "'Work Sans', system-ui, sans-serif", fontSize: "16px" }}>
      {page === "home"           && <HomePage orders={dedupedOrders} onNavigate={navigate} lang={lang} setLang={setLang} />}
      {page === "order-entry"    && <OrderEntryPage orders={dedupedOrders} setOrders={setOrders} clients={clients} products={products} onNavigate={navigate} lang={lang} setLang={setLang} {...sharedScan} />}
      {page === "search-billing" && <SearchBillingPage orders={dedupedOrders} setOrders={setOrders} clients={clients} products={products} onNavigate={navigate} lang={lang} setLang={setLang} />}
      {page === "invoice"        && <InvoicePage orders={dedupedOrders} clients={clients} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "client-master"  && <ClientMasterPage clients={clients} setClients={setClients} products={products} scanRouting={scanRouting} setScanRouting={setScanRouting} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "product-master" && <ProductMasterPage products={products} setProducts={setProducts} clients={clients} scanRouting={scanRouting} setScanRouting={setScanRouting} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "delivery-slip"  && <DeliverySlipPage mode={deliveryMode} orders={dedupedOrders} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "schedule"       && <SchedulePage orders={dedupedOrders} setOrders={setOrders} products={products} onNavigate={navigate} lang={lang} setLang={setLang} />}
      {page === "checklist"      && <ChecklistPage orderId={checklistOrderId} onNavigate={navigate} orders={dedupedOrders} products={products} lang={lang} setLang={setLang} setOrders={setOrders} />}
    </div>
  );
}
