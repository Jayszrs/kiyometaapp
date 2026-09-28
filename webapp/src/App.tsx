import { lazy, Suspense, useState, useMemo, useEffect, useRef } from "react";
import { useAuth } from "./lib/auth";
import { fetchAll, upsertOrder, deleteOrder, upsertClient, deleteClient, upsertProduct, deleteProduct, signProductDrawings } from "./lib/db";
import { genUUID } from "./lib/uuid";
import { runOcr, sendOcrLog } from "./lib/ocrClient";
import { parseQuotation, type ParsedQuotation, type ScanFillData } from "./lib/parseQuotation";
import { findClientMatch, findProductMatch } from "./lib/scanMatching";
import UndoButton from "./components/UndoButton";
import { Icon } from "./components/Icon";
import {
  deleteBomItem,
  fetchProductMaterialData,
  saveBomItem,
  type BomItem,
  type InventoryItem,
} from "./lib/operations";

const InventoryPage = lazy(() => import("./InventoryPage"));
const ManagementPage = lazy(() => import("./ManagementPage"));
const ProfilePage = lazy(() => import("./ProfilePage"));

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
  | "checklist"
  | "inventory"
  | "management"
  | "profile";

type DeliverySlipMode = "single" | "multiple";

type ScanStage = "idle" | "need-client" | "need-product" | "filling";

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
  // drawings holds what the <img> renders: a data URI while a file is being
  // picked, otherwise a short lived signed URL, or "" for an empty slot.
  // drawingPaths holds the durable Storage key for the same slots, index
  // aligned, and is the only part worth persisting. Keeping them separate is
  // what stops a save from writing an expired URL to the database.
  drawings: string[];
  drawingPaths: string[];
}

type FormErrors = Record<string, string>;

// ---- Icons ----

export { AppShell, Icon };
export type { Page, DeliverySlipMode, Lang };


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

// A value of only spaces is truthy, so it would pass every `!field` check above
// and reach the database as a blank-looking name. Text is trimmed once, before
// validation and before the write. trim() also removes ideographic (U+3000) and
// no-break spaces, which Japanese keyboards produce readily.
function cleanOrder(o: OrderRecord): OrderRecord {
  return {
    ...o,
    client: o.client.trim(),
    orderNumber: o.orderNumber.trim(),
    productName: o.productName.trim(),
    orderContact: o.orderContact.trim(),
    contactContents: o.contactContents.trim(),
  };
}

function cleanClient(c: Client): Client {
  return {
    ...c,
    name: c.name.trim(),
    phone: c.phone.trim(),
    email: c.email.trim(),
    postalCode: c.postalCode.trim(),
    address: c.address.trim(),
  };
}

function cleanProduct(p: Product): Product {
  return {
    ...p,
    clientName: p.clientName.trim(),
    productName: p.productName.trim(),
    productNumber: p.productNumber.trim(),
    tasks: p.tasks.map(t => ({ ...t, content: t.content.trim() })),
  };
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

export function TextInput({ value, onChange, type = "text", placeholder = "", className = "", readOnly = false, hasError = false, maxLength, step, name }: {
  value: string | number; onChange?: (v: string) => void; type?: string;
  placeholder?: string; className?: string; readOnly?: boolean;
  hasError?: boolean; maxLength?: number; step?: string; name?: string;
}) {
  const border = hasError
    ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
    : "border-slate-300 focus:border-[#1a3458] focus:ring-[#1a3458]/20";
  return (
    <input type={type} value={value} readOnly={readOnly} placeholder={placeholder} name={name}
      maxLength={maxLength} step={step}
      onClick={event => { if (type === "date" && !readOnly) event.currentTarget.showPicker?.(); }}
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

export function Btn({ children, onClick, variant = "outline", size = "md", disabled = false, className = "", ariaLabel }: {
  children: React.ReactNode; onClick?: () => void;
  variant?: BtnVariant; size?: "sm" | "md" | "lg"; disabled?: boolean; className?: string; ariaLabel?: string;
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
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}
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

function AppShell({ children, onNavigate, showBack = false, backTarget = "home" as Page, backLabel = "Home", title, lang, setLang, noPrint = false, activePage }: {
  children: React.ReactNode; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  showBack?: boolean; backTarget?: Page; backLabel?: string; title?: string;
  noPrint?: boolean; activePage?: Page;
  lang?: "ja" | "en"; setLang?: (l: "ja" | "en") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex flex-col h-full bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <NavDrawer open={menuOpen} onClose={() => setMenuOpen(false)} onNavigate={onNavigate} lang={lang} activePage={activePage} />
      <header className={`app-header flex items-center gap-1 px-3 py-2 sm:px-4 bg-[#1a3458] text-white shrink-0 ${noPrint ? "print:hidden" : ""}`}>
        {/* The hamburger used to be swapped out for the back arrow, so entering
            a submenu locked the operator out of the whole navigation. Both are
            now always reachable, with the hamburger held at the far left
            because it is the control they reach for most often. */}
        <button onClick={() => setMenuOpen(true)} title="Menu" aria-label="Menu" className="header-control is-button">
          <Icon name="menu" size={20} />
        </button>
        {showBack && (
          <button onClick={() => onNavigate(backTarget)} title={backLabel} aria-label={backLabel} className="header-control is-button">
            <Icon name="arrow-left" size={20} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <img src="/app-logo.png" alt="Kiyometa" className="h-7 w-7 shrink-0 rounded object-cover" />
          <div className="min-w-0">
            <span className="block truncate text-base font-600">{title ?? "Kiyometa Order Management"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {lang !== undefined && setLang && (
            <div className="header-control header-language">
              <ToggleSwitch
                checked={lang === "en"}
                onChange={v => setLang(v ? "en" : "ja")}
                offLabel="日本語"
                onLabel="English"
                dark
              />
            </div>
          )}
          <UndoButton />
          <UserMenuButton onNavigate={onNavigate} />
        </div>
      </header>
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
}

function UserMenuButton({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { profile, signOut } = useAuth();
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* The operator keeps their username in the header, inside a wrapper so
          it never reads as text floating next to an icon. The person icon sits
          in a circle within the same control. */}
      <div className="header-control" title={`My profile (@${profile.username})`}>
        <button onClick={() => onNavigate("profile")} className="gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15">
            <Icon name="user" size={14} />
          </span>
          <span className="hidden max-w-[10rem] truncate text-sm font-600 md:inline">{profile.username}</span>
        </button>
      </div>
      <div className="header-control" title="Sign out">
        <button onClick={signOut} aria-label="Sign out">
          <Icon name="log-out" size={17} />
        </button>
      </div>
    </div>
  );
}

function NavDrawer({ open, onClose, onNavigate, lang = "en", activePage }: { open: boolean; onClose: () => void; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; lang?: Lang; activePage?: Page }) {
  const { profile } = useAuth();
  if (!open) return null;
  const items = [
    { key: "navHome" as const, page: "home" as Page, icon: "home" },
    { key: "navOrderEntry" as const, page: "order-entry" as Page, icon: "file-text" },
    { key: "navSearchBilling" as const, page: "search-billing" as Page, icon: "search" },
    { key: "navClientMaster" as const, page: "client-master" as Page, icon: "users" },
    { key: "navProductMaster" as const, page: "product-master" as Page, icon: "package" },
    { key: "navSchedule" as const, page: "schedule" as Page, icon: "calendar" },
    { key: "navInventory" as const, page: "inventory" as Page, icon: "database" },
    { key: "navProfile" as const, page: "profile" as Page, icon: "user" },
    ...(profile.role === "administrator"
      ? [{ key: "navManagement" as const, page: "management" as Page, icon: "shield" }]
      : []),
  ];
  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
       <nav className="relative h-full w-[min(18rem,88vw)] bg-white flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 bg-[#1a3458] text-white">
          <span className="font-600 text-base">{t("navTitle", lang)}</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20 cursor-pointer" aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="flex-1 py-2">
          {items.map(item => (
            <button key={item.key} onClick={() => { onNavigate(item.page); onClose(); }}
              className={`w-full flex items-center gap-4 px-5 py-3 text-left border-b border-slate-100 cursor-pointer transition-colors ${item.page === activePage ? "bg-[#1a3458]/10 hover:bg-[#1a3458]/15" : "hover:bg-slate-50"}`}>
              <span className={`flex items-center justify-center w-9 h-9 rounded text-white shrink-0 ${item.page === activePage ? "bg-[#0d7377]" : "bg-[#1a3458]"}`}>
                <Icon name={item.icon} size={16} />
              </span>
              <span className={`text-base ${item.page === activePage ? "font-700 text-[#1a3458]" : "font-600 text-slate-800"}`}>{t(item.key, lang)}</span>
            </button>
          ))}
        </div>
        {/* The operator identity needs a wrapper with room, not a label squeezed
            next to an icon in the header. Sitting at the end of the drawer it
            reads as who this session belongs to. */}
        <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#1a3458] text-white">
              <Icon name="user" size={16} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-700 text-slate-800">{profile.username}</p>
              <p className="text-xs text-slate-500">{profile.role === "administrator" ? "Administrator" : "Operator"}</p>
            </div>
          </div>
        </div>
      </nav>
    </div>
  );
}

// ---- Scan modal ----

const LOADING_STEP_KEYS = ["scanStepScanning", "scanStepRetrieving", "scanStepCleaning", "scanStepMaster"] as const;

const SCAN_FIELD_LABEL: Record<string, keyof typeof LABELS> = {
  orderDate: "scanFldOrderDate",
  deliveryDate: "scanFldDeliveryDate",
  client: "scanFldClient",
  orderNumber: "scanFldOrderNumber",
  productNumber: "scanFldProductNo",
  productName: "scanFldProductName",
  quantity: "scanFldQuantity",
  unitPrice: "scanFldUnitPrice",
  orderAmount: "scanFldAmount",
  processName: "scanFldProcess",
  clientPostalCode: "scanFldPostal",
  clientAddress: "scanFldAddress",
  clientPhone: "scanFldPhone",
};

function ScanModal({ clients, products, onClose, onApply, lang }: {
  clients: Client[];
  products: Product[];
  onClose: () => void;
  onApply: (data: ScanFillData, clientExists: boolean, productExists: boolean) => void;
  lang: Lang;
}) {
  const [custom, setCustom] = useState<ParsedQuotation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editedData, setEditedData] = useState<ScanFillData | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const [loadingStep, setLoadingStep] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setLoadingStep(0);
    const interval = setInterval(() => {
      setLoadingStep(s => Math.min(s + 1, LOADING_STEP_KEYS.length - 1));
    }, 1500);
    return () => clearInterval(interval);
  }, [busy]);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setCustom(null);
    setEditedData(null);
    try {
      const lines = await runOcr(file);
      const parsed = parseQuotation(lines, lang);
      void sendOcrLog(`--- quotation: ${file.name} (${lines.length} OCR lines, ${parsed.template}) ---\n${parsed.debug}`);
      if (!parsed.fields.some(f => f.status !== "missing")) {
        setError(t("scanErrNoFields", lang));
        return;
      }
      setCustom(parsed);
      const matchedClient = findClientMatch(clients, parsed.data.client);
      const client = matchedClient?.name ?? parsed.data.client;
      const matchedProduct = findProductMatch(products, client, parsed.data.productName, parsed.data.productNumber);
      setEditedData({
        ...parsed.data,
        client,
        // Prefer the master-stored name when OCR leaves the part-name blank.
        productName: parsed.data.productName || matchedProduct?.productName || "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("scanErrUnreachable", lang));
    } finally {
      setBusy(false);
    }
  };

  const clearCustom = () => {
    setCustom(null);
    setError(null);
    setEditedData(null);
  };

  const setField = (key: keyof ScanFillData, val: string) => {
    setEditedData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        [key]: (key === "quantity" || key === "orderAmount" || key === "unitPrice") ? (Number(val.normalize("NFKC").replace(/[,¥￥\s]/g, "")) || 0) : val,
      };
    });
  };

  const matchedClient = editedData ? findClientMatch(clients, editedData.client) : undefined;
  const clientExists = !!matchedClient;
  const productExists = editedData
    ? !!findProductMatch(products, matchedClient?.name ?? editedData.client, editedData.productName, editedData.productNumber)
    : false;

return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-4xl bg-white rounded-sm shadow-2xl flex flex-col max-h-[88vh] border border-slate-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <Icon name="scan" size={20} className="text-[#1a3458]" />
            <h2 className="text-lg font-700 text-slate-800">{t("scanModalTitle", lang)}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 cursor-pointer transition-colors">
            <Icon name="close" size={18} className="text-slate-500" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-72 shrink-0 border-r border-slate-200 bg-slate-50 flex flex-col">
            <div className="px-4 py-4 space-y-3">
              <div className="flex items-center gap-2">
                {busy && <Icon name="loader" size={14} className="text-[#1a3458] animate-spin" />}
                <p className="text-sm font-600 text-slate-600">
                  {busy ? t("workingOnDoc", lang) : t("captureHeading", lang)}
                </p>
              </div>
              <input hidden type="file" ref={uploadRef} accept="image/*,.pdf" onChange={handleFile} />
              <input hidden type="file" ref={cameraRef} accept="image/*" capture="environment" onChange={handleFile} />
              <div className="grid grid-cols-1 gap-2">
                <Btn variant="outline" onClick={() => uploadRef.current?.click()} disabled={busy}>
                  <Icon name="upload" size={15} /> {t("scanUploadDoc", lang)}
                </Btn>
                <Btn variant="outline" onClick={() => cameraRef.current?.click()} disabled={busy}>
                  <Icon name="camera" size={15} /> {t("scanTakePhoto", lang)}
                </Btn>
              </div>
              {error && (
                <p className="flex items-start gap-1.5 text-sm text-red-700">
                  <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" /> {error}
                </p>
              )}
              {busy && (
                <div className="pt-1 space-y-1.5">
                  {LOADING_STEP_KEYS.map((key, i) => (
                    <div key={key} className={`flex items-center gap-2 text-sm ${i <= loadingStep ? "text-slate-700" : "text-slate-400"}`}>
                      {i < loadingStep ? (
                        <Icon name="check" size={14} className="text-green-600 shrink-0" />
                      ) : i === loadingStep ? (
                        <Icon name="loader" size={14} className="text-[#1a3458] animate-spin shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0" />
                      )}
                      <span className={i === loadingStep ? "font-600" : ""}>{t(key, lang)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {custom && (
              <div className="px-4 py-4 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-600 text-slate-700 min-w-0">
                    {t("scanParsedAs", lang)} <span className="font-700 text-[#1a3458]">{custom.title}</span>
                  </p>
                  <button onClick={clearCustom} className="flex items-center gap-1 shrink-0 text-xs font-600 text-slate-500 border border-slate-300 rounded-sm px-2 py-1 hover:text-red-700 hover:border-red-300 cursor-pointer transition-colors">
                    <Icon name="close" size={12} /> {t("scanDiscard", lang)}
                  </button>
                </div>

                <div className="flex flex-col gap-1.5 text-sm">
                  <span className={`flex items-center gap-1.5 ${clientExists ? "text-green-700" : "text-amber-700"}`}>
                    <Icon name={clientExists ? "check" : "alert-triangle"} size={14} />
                    {t(clientExists ? "scanClientFound" : "scanClientNotFound", lang)}
                  </span>
                  <span className={`flex items-center gap-1.5 ${productExists ? "text-green-700" : "text-amber-700"}`}>
                    <Icon name={productExists ? "check" : "alert-triangle"} size={14} />
                    {t(productExists ? "scanProductFound" : "scanProductNotFound", lang)}
                  </span>
                </div>

                {custom.warnings.length > 0 && (
                  <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-sm px-3 py-2 space-y-1">
                    {custom.warnings.map(warning => <p key={warning}>{warning}</p>)}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto min-w-0">
            {!custom ? (
              busy ? (
                <div className="h-full flex flex-col items-center justify-center gap-6 px-8">
                  <div className="w-full max-w-sm">
                    <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-[#1a3458] rounded-full transition-all duration-1000 ease-linear"
                        style={{ width: `${((loadingStep + 1) / LOADING_STEP_KEYS.length) * 100}%` }} />
                    </div>
                    <div className="mt-4 flex flex-col gap-2">
                      {LOADING_STEP_KEYS.map((key, i) => (
                        <div key={key} className={`flex items-center gap-2.5 text-sm ${i < loadingStep ? "text-slate-500" : i === loadingStep ? "font-600 text-[#1a3458]" : "text-slate-400"}`}>
                          {i < loadingStep ? (
                            <Icon name="check" size={15} className="text-green-600 shrink-0" />
                          ) : i === loadingStep ? (
                            <Icon name="loader" size={15} className="text-[#1a3458] animate-spin shrink-0" />
                          ) : (
                            <span className="w-4 h-4 rounded-full border border-slate-300 shrink-0" />
                          )}
                          {t(key, lang)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-5 px-8 text-center">
                  <Icon name="scan" size={52} className="text-slate-200" />
                  <div className="space-y-1.5">
                    <p className="text-base font-600 text-slate-600">{t("scanNoDocTitle", lang)}</p>
                    <p className="text-sm text-slate-400">{t("scanNoDocBody", lang)}</p>
                  </div>
                </div>
              )
            ) : (
              <div className="grid grid-cols-2 gap-x-5 gap-y-4 p-5">
                {custom.fields.map((f, i) => {
                  const dataKey = f.key;
                  const value = editedData?.[dataKey];
                  const val = f.status === "missing" && value === 0 ? "" : String(value ?? f.source);
                  return (
                    <div key={i} className="flex flex-col gap-1">
                      <label className="text-sm font-600 text-slate-700">
                        {SCAN_FIELD_LABEL[f.key] ? t(SCAN_FIELD_LABEL[f.key], lang) : f.label}
                      </label>
                      {dataKey ? (
                        <input
                          type={dataKey === "orderDate" || dataKey === "deliveryDate" ? "date" : ["quantity", "unitPrice", "orderAmount"].includes(dataKey) ? "number" : "text"}
                          step="any"
                          value={val}
                          placeholder={f.status === "missing" ? t("scanNotFound", lang) : undefined}
                          onChange={e => setField(dataKey, e.target.value)}
                          className="w-full px-2.5 py-1.5 text-sm font-mono border border-slate-200 rounded-sm focus:outline-none focus:border-[#1a3458] focus:ring-2 focus:ring-[#1a3458]/20 bg-white transition-colors"
                        />
                      ) : (
                        <span className="text-sm font-mono text-slate-400">{f.source}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 px-5 py-4 border-t border-slate-200">
          <Btn variant="outline" onClick={onClose}>Cancel</Btn>
          <div className="flex-1" />
          {custom && (
            <Btn variant="primary" size="lg" onClick={() => editedData && onApply(editedData, clientExists, productExists)}>
              <Icon name="check" size={16} />
              {clientExists && productExists ? t("scanApply", lang) : t("scanGuidedImport", lang)}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Page: Home ----

function HomePage({ orders, onNavigate, onOpenScan, lang, setLang }: { orders: OrderRecord[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; onOpenScan: () => void; lang: Lang; setLang: (l: Lang) => void }) {
  const { profile } = useAuth();
  const nowJst = new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
  const dateStr = new Date(nowJst).toLocaleDateString(lang === "ja" ? "ja-JP" : "en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const jstHour = new Date(nowJst).getHours();
  const greetingKey = jstHour < 11 ? "greetingMorning" : jstHour < 18 ? "greetingDay" : "greetingEvening";
  const inProd = orders.filter(o => o.progress === "In production").length;
  const shipped = orders.filter(o => o.progress === "Shipped").length;

  // Every module in the drawer belongs here too. Schedule had been left out of
  // this list, so the sections grid silently offered only 7 of the 8 modules.
  const quickNav = [
    { label: t("orderEntry", lang), desc: "Create and manage orders", page: "order-entry" as Page, icon: "file-text" },
    { label: t("searchBilling", lang), desc: "Search orders, print invoices and delivery slips", page: "search-billing" as Page, icon: "search" },
    { label: t("clientMaster", lang), desc: "View and edit client information", page: "client-master" as Page, icon: "users" },
    { label: t("productMaster", lang), desc: "View and edit product specifications", page: "product-master" as Page, icon: "package" },
    { label: t("navSchedule", lang), desc: "Production plan and due dates", page: "schedule" as Page, icon: "calendar" },
    { label: t("navInventory", lang), desc: "Materials, purchasing, and stock mutations", page: "inventory" as Page, icon: "database" },
    { label: t("navProfile", lang), desc: "Photo and employee details", page: "profile" as Page, icon: "user" },
    ...(profile.role === "administrator" ? [
      { label: t("navManagement", lang), desc: "Employee access and activity history", page: "management" as Page, icon: "shield" },
    ] : []),
  ];

  return (
    <AppShell onNavigate={onNavigate} title={t("appTitle", lang)} activePage="home" lang={lang} setLang={setLang}>
      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 pb-5 pt-6 sm:flex-row sm:items-end sm:justify-between sm:px-8 sm:pt-7">
            <div>
              <h1 className="text-2xl font-700 text-[#1a3458]">{t(greetingKey, lang)}</h1>
              <p className="text-base text-slate-500 mt-1">{dateStr}</p>
            </div>
            <p className="text-sm text-slate-500 sm:text-right">
              <span className="font-600 text-slate-700">{inProd}</span>{t("inProdSuffix", lang)},{" "}
              <span className="font-600 text-slate-700">{shipped}</span>{t("shippedSuffix", lang)}
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-5xl space-y-6 px-4 py-5 sm:px-8 sm:py-6">

          {/* Row 1: Quick actions */}
          <div className="grid grid-cols-1 gap-3 min-[390px]:grid-cols-2">
            <button onClick={() => onNavigate("order-entry")}
              className="flex items-center gap-3 px-5 py-4 bg-[#1a3458] text-white rounded-sm hover:bg-[#112240] transition-colors cursor-pointer">
              <Icon name="plus" size={20} className="text-blue-200 shrink-0" />
              <span className="font-700 text-base">{t("newOrder", lang)}</span>
            </button>
            <button onClick={onOpenScan}
              className="flex items-center gap-3 px-5 py-4 bg-white border border-slate-200 rounded-sm hover:border-[#1a3458] transition-colors cursor-pointer group">
              <Icon name="scan" size={20} className="text-slate-400 group-hover:text-[#1a3458] transition-colors shrink-0" />
              <span className="font-700 text-base text-slate-800">{t("scanButton", lang)}</span>
            </button>
          </div>

          {/* Row 2: Sections */}
          <div>
            <p className="text-xs font-700 text-slate-400 mb-2">{t("sectionsHeader", lang)}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
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
            <div className="overflow-hidden rounded-sm border border-slate-200 bg-white">
              <div className="divide-y divide-slate-100 sm:hidden">
                {orders.map(o => (
                  <button key={o.id} type="button" onClick={() => onNavigate("order-entry")}
                    className="block w-full space-y-3 p-4 text-left transition-colors hover:bg-slate-50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words font-700 text-slate-800">{o.productName}</p>
                        <p className="mt-0.5 truncate text-sm text-slate-500">{o.client}</p>
                      </div>
                      <StatusBadge status={o.progress} lang={lang} />
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="text-xs font-600 text-slate-400">{t("amountLabel", lang)}</p>
                        <p className="mt-0.5 font-mono font-700 text-slate-700">¥{o.orderAmount.toLocaleString()}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-600 text-slate-400">{t("deliveryLabel", lang)}</p>
                        <p className="mt-0.5 font-mono text-slate-600">{o.deliveryDate}</p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <table className="hidden w-full border-collapse text-base sm:table">
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
    </AppShell>
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
  appTitle:         { ja: "キヨメタ受注管理",   en: "Kiyometa Order Management" },
  greeting:         { ja: "おはようございます",   en: "Good morning" },
  greetingMorning:  { ja: "おはようございます",   en: "Good morning" },
  greetingDay:      { ja: "こんにちは",          en: "Good afternoon" },
  greetingEvening:  { ja: "こんばんは",          en: "Good evening" },
  navTitle:         { ja: "ナビゲーション",       en: "Navigation" },
  navHome:          { ja: "ホーム",            en: "Home" },
  navOrderEntry:    { ja: "受注入力",           en: "Order entry" },
  navSearchBilling: { ja: "検索・請求",         en: "Search & billing" },
  navClientMaster:  { ja: "取引先マスタ",        en: "Client master" },
  navProductMaster: { ja: "製品マスタ",          en: "Product master" },
  navSchedule:      { ja: "生産計画",           en: "Schedule" },
  navInventory:     { ja: "在庫管理",           en: "Inventory" },
  navProfile:       { ja: "マイプロフィール",   en: "My profile" },
  navManagement:    { ja: "権限管理",           en: "Role management" },
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
  drawingSignFailed:  { ja: "保存済みの画像を読み込めませんでした。触及していない他の項目は保存できます。この製品を開き直すと再試行します。", en: "Stored images could not be loaded. Other untouched fields can still be saved; reopening this product will retry." },
  drawingUnavailable: { ja: "画像を表示できません", en: "Image unavailable" },
  totalRequiredTime:  { ja: "総必要時間",          en: "Total required time" },
  autoCalculated:     { ja: "自動計算",            en: "Auto-calculated" },
  autoCalcInfo:       { ja: "合計時間は下のタスクから自動計算されます。", en: "Total time is automatically calculated from the tasks below." },
  minPerUnit:         { ja: "分/1個",              en: "min / 1 unit" },
  totalCalculation:   { ja: "合計計算",            en: "Total Calculation" },
  manufacturingTasks: { ja: "製造タスク (1-54)",  en: "Manufacturing tasks (1-54)" },
  taskNoHeader:       { ja: "No.",                 en: "No." },
  taskContent:        { ja: "作業内容",            en: "Task Content" },
  taskTime:           { ja: "作業時間（分/1個）",   en: "Task Time (min/unit)" },
  minUnit:            { ja: "分",              en: "min" },
  unitDelivery:       { ja: "納期まで",          en: "Until Delivery" },
  unitRequired:       { ja: "必要工数",          en: "Required Man-hours" },
  unitMargin:         { ja: "納期までの余裕",     en: "Margin until Delivery" },
  unitEnd:            { ja: "終了まで",          en: "Until End" },
  dayHeader:          { ja: "日",              en: "days" },
  hrHeader:           { ja: "時間",             en: "hr" },
  minHeader:          { ja: "分",              en: "min" },
  scanModalTitle:     { ja: "見積書をスキャン",     en: "Scan quotation" },
  captureHeading:     { ja: "見積書撮影",         en: "Capture a quotation" },
  workingOnDoc:       { ja: "処理中",            en: "Working on your document" },
  scanUploadDoc:      { ja: "書類をアップロード",  en: "Upload document" },
  scanTakePhoto:      { ja: "写真を撮る",         en: "Take photo" },
  scanNoDocTitle:     { ja: "まだ書類がありません",  en: "No document captured yet." },
  scanNoDocBody:      { ja: "スキャンしたPDFまたは画像、見積書の写真をアップロードしてください。", en: "Upload a scanned PDF or image, or take a photo of the quotation." },
  scanParsedAs:       { ja: "解析結果",          en: "Parsed as" },
  scanDiscard:        { ja: "破棄",            en: "Discard" },
  scanClientFound:    { ja: "取引先に登録あり",     en: "Client found" },
  scanClientNotFound: { ja: "取引先に未登録",      en: "Client not in master" },
  scanProductFound:   { ja: "製品に登録あり",      en: "Product found" },
  scanProductNotFound:{ ja: "製品に未登録",       en: "Product not in master" },
  scanFieldHeader:    { ja: "項目",            en: "Field" },
  scanValueHeader:    { ja: "値",             en: "Value" },
  scanNotFound:       { ja: "検出なし",          en: "Not found" },
  scanApply:          { ja: "フォームに反映",       en: "Apply to form" },
  scanGuidedImport:   { ja: "登録して続行",       en: "Begin guided import" },
  scanStepScanning:   { ja: "書類をスキャン中...",   en: "Scanning document..." },
  scanStepRetrieving: { ja: "文字を抽出中...",     en: "Retrieving text..." },
  scanStepCleaning:   { ja: "整理・マッチ中...",    en: "Cleaning and matching..." },
  scanStepMaster:     { ja: "マスタと照合中...",   en: "Checking against master data..." },
  scanErrNoFields:    { ja: "項目を抽出できませんでした。より高解像度の画像をお試しください。", en: "Could not extract any fields from the document. Try a higher-resolution image." },
  scanErrUnreachable: { ja: "OCRエラー。認識サービスに接続できません。", en: "OCR failed. Is the recognition service reachable?" },
  scanFldOrderDate:   { ja: "受注日",           en: "Order date" },
  scanFldDeliveryDate:{ ja: "納期",             en: "Delivery date" },
  scanFldClient:      { ja: "取引先",           en: "Client" },
  scanFldOrderNumber: { ja: "注文番号",          en: "Order no." },
  scanFldProductNo:   { ja: "図面 / 品目番号",    en: "Drawing / item no." },
  scanFldProductName: { ja: "製品名",           en: "Product name" },
  scanFldQuantity:    { ja: "数量",             en: "Quantity" },
  scanFldUnitPrice:   { ja: "単価",             en: "Unit price" },
  scanFldAmount:      { ja: "金額 (税抜)",       en: "Amount (excl. tax)" },
  scanFldProcess:     { ja: "工程",             en: "Process" },
  scanFldPostal:      { ja: "郵便番号",          en: "Postal code" },
  scanFldAddress:     { ja: "住所",             en: "Address" },
  scanFldPhone:       { ja: "電話番号",          en: "Phone" },
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
      // The header placement sits inside the shared header-control chip, which
      // owns size, fill and focus; here we only keep the internal spacing. The
      // old focus:outline-none left the control unreachable by keyboard without
      // any replacement indicator.
      className={dark ? "gap-2 w-full" : "flex items-center gap-2 cursor-pointer group"}>
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
            <output
              title="Calculated automatically"
              className="flex min-w-0 flex-1 items-center justify-center rounded-sm border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-base text-slate-600"
            >{v}</output>
          </div>
        );
      })}
    </div>
  );
}

function OrderEntryPage({ orders, setOrders, clients, products, scanRouting, setScanRouting, onNavigate, onOpenScan, lang, setLang }: {
  orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  clients: Client[]; products: Product[];
  scanRouting: ScanRouting; setScanRouting: (s: ScanRouting) => void;
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  onOpenScan: () => void;
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

  // The order entry page always opens on a blank new order; it is only filled
  // when a scanned quotation is applied (or after a guided master import).
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState<OrderRecord>(() => (isFilling && scanRouting.data
    ? { ...blankForm(), orderDate: scanRouting.data.orderDate, deliveryDate: scanRouting.data.deliveryDate, client: scanRouting.data.client, orderNumber: scanRouting.data.orderNumber, productName: scanRouting.data.productName, quantity: scanRouting.data.quantity, orderAmount: scanRouting.data.orderAmount }
    : blankForm()));
  const [isNew, setIsNew] = useState(true);
  const [errors, setErrors] = useState<FormErrors>({});
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
    // Fills the blank form when a scan is applied while this page is already
    // mounted (the mount-time prefill above covers fresh navigations).
    if (scanRouting.stage === "filling" && scanRouting.data) {
      const d = scanRouting.data;
      setForm(prev => ({ ...prev, id: `o${Date.now()}`, orderDate: d.orderDate, deliveryDate: d.deliveryDate, client: d.client, orderNumber: d.orderNumber, productName: d.productName, quantity: d.quantity, orderAmount: d.orderAmount }));
      setIsNew(true); setSelectedId(""); setErrors({});
      setScanRouting({ stage: "idle", data: null });
    }
  }, [scanRouting]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const perUnit = p ? p.tasks.reduce((s, t) => s + (Number(t.time) || 0), 0) : 0;
    const total = perUnit * Math.max(form.quantity || 0, 1);
    const unitPrice = p && p.unitPrice !== "" ? Number(p.unitPrice) : 0;
    setForm(prev => ({ ...prev, productName: name, requiredManhours: total, orderAmount: prev.quantity * unitPrice }));
    setErrors(prev => ({ ...prev, productName: "", requiredManhours: "", orderAmount: "" }));
  };

  const handleNew = () => { setForm(blankForm()); setIsNew(true); setSelectedId(""); setErrors({}); };

  const handleSave = async () => {
    const cleaned = cleanOrder(form);
    setForm(cleaned);
    const errs = validateOrder(cleaned, clients, products);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    const record = isNew ? { ...cleaned, id: newId() } : cleaned;
    try {
      const saved = await upsertOrder(record);
      setOrders(prev => prev.some(o => o.id === saved.id)
        ? prev.map(o => o.id === saved.id ? saved : o)
        : [saved, ...prev]);
      setForm(saved);
      setSelectedId(saved.id);
      setIsNew(false);
    } catch (err) {
      alert(`Failed to save order: ${err instanceof Error ? err.message : err}`);
      return;
    }
    setErrors({});
  };

  const handleDelete = async () => {
    if (!confirm("Delete this order? You can recover it with Undo.")) return;
    const deletedId = form.id;
    try {
      await deleteOrder(deletedId);
    } catch (err) {
      alert(`Failed to delete order: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const rest = orders.filter(o => o.id !== deletedId);
    setOrders(rest);
    if (rest[0]) { setForm(rest[0]); setSelectedId(rest[0].id); }
    else { handleNew(); }
    setErrors({});
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
    <AppShell onNavigate={onNavigate} title="Kiyometa Order Management" activePage="order-entry" showBack backTarget="home" backLabel="Home" lang={lang} setLang={setLang}>

      <div className="responsive-workspace flex flex-1 overflow-hidden min-h-0">

        {/* Column 1: Filter & Sort */}
        <aside className="responsive-panel responsive-panel-filter w-52 flex flex-col bg-white border-r-2 border-slate-200 shrink-0 overflow-y-auto">

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
        <aside className="responsive-panel responsive-panel-list w-56 flex flex-col bg-[#f8f9fb] border-r-2 border-slate-200 shrink-0 overflow-hidden">
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
        <main className="responsive-main flex-1 overflow-y-auto min-h-0 bg-white">

          {/* Scan bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-slate-200 shrink-0">
            <div className="flex items-center gap-2 text-slate-500">
              <Icon name="scan" size={16} />
              <span className="text-sm">{L("scanHint")}</span>
            </div>
            <Btn variant="outline" size="sm" onClick={onOpenScan}>
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("orderDateLabel")}</label>
                <input type="date" value={form.orderDate}
                  onClick={event => event.currentTarget.showPicker?.()}
                  onChange={e => { setForm(prev => ({ ...prev, orderDate: e.target.value })); setErrors(prev => ({ ...prev, deliveryDate: e.target.value && form.deliveryDate && e.target.value > form.deliveryDate ? "Delivery date must be on or after order date." : "" })); }}
                  className={inputCls(!!errors.orderDate)} />
                {errors.orderDate && <p className="text-xs text-red-600 mt-0.5">{errors.orderDate}</p>}
              </div>
              <div>
                <label className="block text-sm font-700 text-slate-600 mb-1">{L("deliveryDateLabel")}</label>
                <input type="date" value={form.deliveryDate}
                  onClick={event => event.currentTarget.showPicker?.()}
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_1.2fr]">
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
                    const perUnitMinutes = p ? p.tasks.reduce((sum, task) => sum + (Number(task.time) || 0), 0) : 0;
                    setForm(prev => ({ ...prev, quantity: qty, orderAmount: qty * unitPrice, requiredManhours: qty * perUnitMinutes }));
                    setErrors(prev => ({ ...prev, quantity: "", orderAmount: "", requiredManhours: "" }));
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
              <div className="responsive-math-grid grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-center">
                <div>
                  <label className="block text-sm font-700 text-[#1a3458] mb-2">{L("requiredManhours")} ({L("minUnit")})</label>
                  <output
                    title="Calculated automatically from product task time × order quantity"
                    className="flex min-h-10 w-full items-center rounded-sm border border-slate-200 bg-slate-50 px-3 py-2 text-base text-slate-500">{form.requiredManhours || 0}</output>
                  <p className="mt-1 text-xs text-slate-400">Auto: product time × quantity</p>
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
                  <output
                    title="Calculated automatically from required time minus worked time"
                    className="flex min-h-10 w-full items-center rounded-sm border border-slate-200 bg-slate-50 px-3 py-2 text-base text-slate-500">{remaining}</output>
                </div>
              </div>
            </div>

            {/* Row 5: Schedule Math Matrix -> [Until Delivery] - [Required] = [Margin] */}
            <div className="border border-slate-200 rounded-sm p-3 bg-white">
              <div className="responsive-math-grid grid grid-cols-[1fr_auto_1fr_auto_1fr] gap-3 items-center">
                <TimeStack titleJa={L("unitDelivery")} titleEn={L("unitDelivery")} values={deliveryDHM} lang={lang} />
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">-</div>
                <TimeStack titleJa={L("unitRequired")} titleEn={L("unitRequired")} values={requiredDHM} lang={lang} />
                <div className="self-center text-3xl font-900 text-[#1a3458] select-none">=</div>
                <TimeStack titleJa={L("unitMargin")} titleEn={L("unitMargin")} values={marginDHM} lang={lang} />
              </div>
            </div>

            {/* Row 6: Production End Date + Until End (separate, below the schedule matrix) */}
            <div className="border border-slate-200 rounded-sm p-3 bg-slate-50">
              <div className="grid grid-cols-1 gap-6 items-start sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-700 text-slate-600 mb-1">{L("productionEndDate")}</label>
                  <input type="date" value={form.productionEndDate}
                    onClick={event => event.currentTarget.showPicker?.()}
                    onChange={e => { setForm(prev => ({ ...prev, productionEndDate: e.target.value })); const err = e.target.value && form.orderDate && e.target.value < form.orderDate ? "Cannot be earlier than the order date." : e.target.value && form.deliveryDate && e.target.value > form.deliveryDate ? "Cannot be later than the delivery date." : ""; setErrors(prev => ({ ...prev, productionEndDate: err })); }}
                    className={`${inputCls(!!errors.productionEndDate)} cursor-pointer`} />
                  {errors.productionEndDate && <p className="text-xs text-red-600 mt-0.5">{errors.productionEndDate}</p>}
                </div>
                <div>
                  <TimeStack titleJa={L("unitEnd")} titleEn={L("unitEnd")} values={untilEndDHM} lang={lang} />
                </div>
              </div>
            </div>

            {/* Row 7: Progress Status + Finish Task + Tasks */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
      <footer className="grid shrink-0 grid-cols-2 gap-2 bg-[#1a3458] px-3 py-3 sm:flex sm:items-center sm:gap-3 sm:px-5">
        <Btn variant="ghost" size="lg" onClick={() => onNavigate("search-billing")}>
          <Icon name="search" size={16} /><span>{L("searchBilling")}</span>
        </Btn>
        <div className="hidden flex-1 sm:block" />
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
    try {
      const saved = await upsertOrder(panelForm);
      setOrders(prev => prev.map(o => o.id === saved.id ? saved : o));
      setPanelForm(saved);
    } catch (err) {
      alert(`Failed to save order: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteOrder(id);
    } catch (err) {
      alert(`Failed to delete order: ${err instanceof Error ? err.message : err}`);
      return;
    }
    setOrders(prev => prev.filter(o => o.id !== id));
    setDeleteConfirm(null);
    if (panelForm.id === id) resetSelection();
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

  const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const downloadCsv = () => {
    const headers = ["Order date", "Delivery date", "Client", "Order number", "Product", "Quantity", "Amount", "Progress"];
    const lines = [headers, ...filtered.map(order => [
      order.orderDate, order.deliveryDate, order.client, order.orderNumber,
      order.productName, order.quantity, order.orderAmount, order.progress,
    ])].map(row => row.map(csvCell).join(","));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `orders-${today}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const printPreparation = () => {
    const popup = window.open("", "_blank", "width=960,height=720");
    if (!popup) {
      alert("The print window was blocked. Allow pop-ups for this application and try again.");
      return;
    }
    popup.opener = null;
    const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
    const rows = filtered.map(order => `<tr><td>${escape(order.deliveryDate)}</td><td>${escape(order.orderNumber)}</td><td>${escape(order.client)}</td><td>${escape(order.productName)}</td><td class="num">${escape(order.quantity)}</td><td>${escape(order.progress)}</td></tr>`).join("");
    popup.document.write(`<!doctype html><html><head><title>Production preparation</title><style>body{font:14px Arial,sans-serif;color:#172033;padding:32px}h1{font-size:24px;margin:0 0 6px}p{color:#64748b;margin:0 0 24px}table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #cbd5e1;padding:10px 8px;text-align:left}th{background:#f1f5f9;font-size:12px}.num{text-align:right}@media print{body{padding:0}}</style></head><body><h1>Production Preparation List</h1><p>${escape(fromDate)} to ${escape(toDate)} · ${filtered.length} order(s)</p><table><thead><tr><th>Delivery</th><th>Order no.</th><th>Client</th><th>Product</th><th class="num">Qty</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print()<\/script></body></html>`);
    popup.document.close();
  };

  const productInfo = (o: OrderRecord) =>
    productByKey.get(`${o.client}|${o.productName}`) ?? null;

  return (
    <AppShell onNavigate={onNavigate} title={t("searchBilling", lang)} activePage="search-billing" showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      <div className="responsive-workspace flex flex-1 overflow-hidden">
        <aside className="responsive-panel responsive-panel-filter w-56 bg-white border-r-2 border-slate-200 overflow-y-auto shrink-0 flex flex-col">

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

        <main className="responsive-main flex-1 overflow-y-auto">
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
        <aside className="responsive-panel responsive-panel-detail w-80 bg-white border-l-2 border-slate-200 shrink-0 overflow-hidden flex flex-col">
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
                  <Icon name="close" size={17} />
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

      <footer className="grid shrink-0 grid-cols-2 gap-2 bg-[#1a3458] px-3 py-3 min-[390px]:grid-cols-3 lg:flex lg:items-center lg:gap-3 lg:px-5">
        <Btn variant="ghost" size="md" className="justify-center whitespace-nowrap lg:flex-1" onClick={printPreparation}><Icon name="printer" size={15} />{t("prePrepPrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="justify-center whitespace-nowrap lg:flex-1" onClick={() => onNavigate("delivery-slip", "single")}><Icon name="truck" size={15} />{t("singleSlipPrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="justify-center whitespace-nowrap lg:flex-1" onClick={() => onNavigate("delivery-slip", "multiple")}><Icon name="truck" size={15} />{t("multipleSlipPrint", lang)}</Btn>
        <Btn variant="action" size="md" className="justify-center whitespace-nowrap lg:flex-1" onClick={() => onNavigate("invoice")}><Icon name="file-invoice" size={15} />{t("invoicePrint", lang)}</Btn>
        <Btn variant="ghost" size="md" className="col-span-2 justify-center whitespace-nowrap min-[390px]:col-span-1 lg:flex-1" onClick={downloadCsv}><Icon name="file-text" size={15} />{t("csvCreate", lang)}</Btn>
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
    <AppShell onNavigate={onNavigate} title={t("invoiceTitle", lang)} activePage="invoice" showBack backTarget="search-billing" backLabel={t("searchBilling", lang)} lang={lang} setLang={setLang}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 bg-[#f5f6f8] border-b border-slate-200 shrink-0 sm:gap-3 sm:px-4">
        <Btn variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))}><Icon name="chevron-left" size={14} />{t("prevPage", lang)}</Btn>
        <span className="text-sm text-slate-500 font-mono">{t("pageOf", lang).replace("{c}", String(currentPage)).replace("{t}", String(totalPages))}</span>
        <Btn variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}>{t("nextPage", lang)}<Icon name="chevron-right" size={14} /></Btn>
        <div className="flex-1" />
        <Btn variant="primary" size="sm" onClick={() => window.print()}><Icon name="printer" size={15} />{t("printButton", lang)}</Btn>
      </div>
      <div className="flex-1 overflow-y-auto flex justify-center bg-slate-300 p-2 sm:p-8">
        <div className="w-full max-w-2xl overflow-x-auto bg-white p-4 shadow-md sm:p-10">
          <div className="text-center mb-8">
            <h2 className="text-3xl font-700 text-slate-800 inline-block pb-2 border-b-2 border-slate-800">{t("invoiceTitle", lang)}</h2>
          </div>

          <div className="mb-8 flex flex-col items-start justify-between gap-6 sm:flex-row">
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

          <table className="w-full min-w-[540px] border-collapse">
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

          <table className="mt-6 w-full min-w-[540px] border-collapse text-base">
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
    const cleaned = cleanClient(form);
    setForm(cleaned);
    const errs = validateClient(cleaned, clients, isNew);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    const candidate = isNew ? { ...cleaned, id: genUUID() } : cleaned;
    let saved: Client;

    try {
      saved = await upsertClient(candidate);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Failed to save client: ${message}`);
      return;
    }

    setClients(prev => {
      const exists = prev.some(c => c.id === saved.id);
      return exists
        ? prev.map(c => c.id === saved.id ? saved : c)
        : [...prev, saved];
    });
    setForm(saved);
    setSelectedId(saved.id);
    setIsNew(false);
    setErrors({});
    setDirty(false);

    // Continue scan routing
    if (isScanRouted && sd) {
      const productExists = !!findProductMatch(products, sd.client, sd.productName, sd.productNumber);
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

  const handleDelete = async () => {
    if (isNew || !confirm("Delete this client? You can recover it with Undo.")) return;
    const deletedId = form.id;
    try {
      await deleteClient(deletedId);
    } catch (err) {
      alert(`Failed to delete client: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const rest = clients.filter(client => client.id !== deletedId);
    setClients(rest);
    setDirty(false);
    if (rest[0]) {
      setForm(rest[0]);
      setSelectedId(rest[0].id);
      setIsNew(false);
    } else {
      handleNew();
    }
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("clientMaster", lang)} activePage="client-master" showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      {isScanRouted && (
        <ScanBanner message={`Client "${sd?.client}" was not found in the Client Master. Please review the pre-filled details below and click Save to continue the scanned order import.`} />
      )}
      <div className="responsive-workspace flex flex-1 overflow-hidden">
        <aside className="responsive-panel responsive-panel-list w-60 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
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

        <main className="responsive-main flex-1 overflow-y-auto p-4 sm:p-7">
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
                  <Btn variant="outline" size="sm" onClick={handlePostalSearch} ariaLabel="Find address from postal code"><Icon name="search" size={14} /></Btn>
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

      <footer className="grid shrink-0 grid-cols-2 gap-2 bg-[#1a3458] px-3 py-3 min-[390px]:grid-cols-3 sm:flex sm:items-center sm:gap-3 sm:px-5">
        <Btn variant="ghost" size="lg" onClick={handleNew}><Icon name="plus" size={15} />{t("newButton", lang)}</Btn>
        <div className="hidden flex-1 sm:block" />
        <Btn variant="action" size="lg" onClick={handleSave} disabled={!dirty || Object.values(errors).some(v => v)}><Icon name="save" size={15} />{isScanRouted ? t("saveAndContinue", lang) : t("saveButton", lang)}</Btn>
        <Btn variant="danger" size="lg" className="col-span-2 justify-center min-[390px]:col-span-1" disabled={isNew} onClick={() => void handleDelete()}>
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
    tasks: makeTasks(54).map((task, i) => i === 0 && sd && isScanRouted && sd.processName ? { ...task, content: sd.processName } : task),
    drawings: makeDrawings(7),
    drawingPaths: makeDrawings(7),
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
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [allBom, setAllBom] = useState<BomItem[]>([]);
  const [materialItemId, setMaterialItemId] = useState("");
  const [materialQty, setMaterialQty] = useState(1);
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialError, setMaterialError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  // The product-drawings bucket is private, so display URLs are signed per
  // product on open rather than stored. signToken guards against a slow sign
  // for a product the user has already navigated away from landing on the form
  // they are now looking at.
  const signToken = useRef(0);
  const [drawingSignError, setDrawingSignError] = useState("");

  const applySignedDrawings = async (p: Product) => {
    const token = ++signToken.current;
    setForm(p);
    if (!p.drawingPaths.some(Boolean)) return;
    try {
      const urls = await signProductDrawings(p.drawingPaths);
      if (token !== signToken.current) return;
      // Merged into the live form rather than replacing it, so text typed while
      // the sign was in flight is not rolled back. The id check makes this a
      // no-op if the user has since moved to a different product.
      setForm(prev => prev.id === p.id ? { ...prev, drawings: urls } : prev);
      setDrawingSignError("");
    } catch (err) {
      if (token !== signToken.current) return;
      // The keys are intact, so the next open retries. Losing the rows here
      // would be worse than showing an empty slot.
      setDrawingSignError(err instanceof Error ? err.message : String(err));
    }
  };

  // useState cannot await, so the product selected on first render is signed
  // here instead.
  useEffect(() => {
    if (isScanRouted || isNew || !form.drawingPaths.some(Boolean)) return;
    const token = ++signToken.current;
    void signProductDrawings(form.drawingPaths).then(urls => {
      if (token !== signToken.current) return;
      setForm(prev => ({ ...prev, drawings: urls }));
      setDrawingSignError("");
    }).catch(err => {
      if (token !== signToken.current) return;
      setDrawingSignError(err instanceof Error ? err.message : String(err));
    });
    // Intentionally mount-only: later selections go through applySignedDrawings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const taskErrors = Object.entries(errors).filter(([k, v]) => k.startsWith("task_") && v);
  const filtered = products.filter(p => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return p.productName.toLowerCase().includes(q) || p.productNumber.toLowerCase().includes(q);
  });
  const totalTime = form.tasks.reduce((s, t) => s + (t.time === "" ? 0 : Number(t.time)), 0);
  const productMaterials = allBom.filter(row => row.productId === form.id);
  const inventoryById = (id: string) => inventoryItems.find(item => item.id === id);

  const reloadMaterials = async () => {
    const data = await fetchProductMaterialData();
    setInventoryItems(data.items);
    setAllBom(data.bom);
  };

  useEffect(() => {
    void reloadMaterials().catch(error => setMaterialError(error instanceof Error ? error.message : "Failed to load product materials."));
  }, []); // Product/inventory data is refreshed again after every BOM write.

  const addMaterial = async () => {
    if (isNew) {
      setMaterialError("Save the product before adding materials.");
      return;
    }
    if (!materialItemId || materialQty <= 0) return;
    setMaterialBusy(true);
    setMaterialError("");
    try {
      await saveBomItem({
        id: genUUID(), bomNo: "", productId: form.id,
        inventoryItemId: materialItemId, quantityPerUnit: materialQty, notes: "",
      });
      await reloadMaterials();
      setMaterialItemId("");
      setMaterialQty(1);
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : "Failed to add material.");
    } finally {
      setMaterialBusy(false);
    }
  };

  const removeMaterial = async (row: BomItem) => {
    if (!confirm(`Remove ${row.bomNo} from this product? You can recover it with Undo.`)) return;
    setMaterialBusy(true);
    setMaterialError("");
    try {
      await deleteBomItem(row.id);
      await reloadMaterials();
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : "Failed to remove material.");
    } finally {
      setMaterialBusy(false);
    }
  };

  const sf = (v: keyof Product) => (e: string) => {
    setForm(prev => ({ ...prev, [v]: e }));
    setErrors(prev => ({ ...prev, [v]: "" }));
    setDirty(true);
  };

  const handleNew = () => {
    setForm({ id: `p${Date.now()}`, clientName: "", productName: "", productNumber: "", unitPrice: "", tasks: makeTasks(54), drawings: makeDrawings(7), drawingPaths: makeDrawings(7) });
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
          // The slot now holds a new file, so the old Storage key is stale and
          // must go: leaving it would make the next save re-point the row at
          // the drawing that was just replaced.
          const drawingPaths = [...prev.drawingPaths];
          drawingPaths[drawingIndex] = "";
          return { ...prev, drawings, drawingPaths };
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
      const drawingPaths = [...prev.drawingPaths];
      drawingPaths[i] = "";
      return { ...prev, drawings, drawingPaths };
    });
    setDirty(true);
  };

  const addDrawingSlots = () => {
    setForm(prev => ({
      ...prev,
      drawings: [...prev.drawings, "", "", "", ""],
      drawingPaths: [...prev.drawingPaths, "", "", "", ""],
    }));
    setDirty(true);
  };

  const handleSave = async () => {
    const cleaned = cleanProduct(form);
    setForm(cleaned);
    const errs = validateProduct(cleaned, products, isNew);
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    const record = isNew ? { ...cleaned, id: genUUID() } : cleaned;

    try {
      const saved = await upsertProduct(record);
      setProducts(prev => prev.some(p => p.id === saved.id)
        ? prev.map(p => p.id === saved.id ? saved : p)
        : [...prev, saved]);
      // productFromRow comes back with empty display strings because the stored
      // value is a key, not a URL, so the freshly saved drawings have to be
      // signed again or the slots would blank out under the user.
      void applySignedDrawings(saved);
      setSelectedId(saved.id);
      setIsNew(false);
      setErrors({});
      setDirty(false);
    } catch (err) {
      alert(`Failed to save product: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Continue scan routing
    if (isScanRouted && sd) {
      setScanRouting({ stage: "filling", data: sd });
      onNavigate("order-entry");
    }
  };

  const handleDelete = async () => {
    if (isNew || !confirm("Delete this product? You can recover it with Undo.")) return;
    const deletedId = form.id;
    try {
      await deleteProduct(deletedId);
    } catch (err) {
      alert(`Failed to delete product: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const rest = products.filter(product => product.id !== deletedId);
    setProducts(rest);
    setDirty(false);
    if (rest[0]) {
      void applySignedDrawings(rest[0]);
      setSelectedId(rest[0].id);
      setIsNew(false);
    } else {
      handleNew();
    }
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("productMaster", lang)} activePage="product-master" showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      {isScanRouted && (
        <ScanBanner message={`Product "${sd?.productName}" (${sd?.productNumber}) was not found in the Product Master. Please review the pre-filled details below and click Save to continue the scanned order import.`} />
      )}
      <div className="responsive-workspace flex flex-1 overflow-hidden">
        <aside className="responsive-panel responsive-panel-list w-60 bg-white border-r border-slate-200 flex flex-col shrink-0 overflow-hidden">
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
              <button key={p.id} onClick={() => { void applySignedDrawings(p); setSelectedId(p.id); setIsNew(false); setErrors({}); setDirty(false); }}
                className={`w-full text-left px-4 py-3.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors ${selectedId === p.id ? "bg-blue-50 border-l-4 border-l-[#1a3458]" : "border-l-4 border-l-transparent"}`}>
                <div className="font-600 text-base text-slate-800 truncate">{p.productName}</div>
                <div className="text-sm text-slate-400 font-mono truncate">{p.productNumber}</div>
                <div className="text-sm text-[#0d7377] mt-0.5">{p.unitPrice === "" ? "-" : `¥${Number(p.unitPrice).toLocaleString()}`}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="responsive-main flex-1 overflow-y-auto p-4 sm:p-5">
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
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              {drawingSignError && (
                <div className="flex items-start gap-2 px-3 py-2 mb-3 bg-amber-50 border border-amber-200 rounded-sm">
                  <Icon name="alert-triangle" size={15} className="text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-800">
                    {t("drawingSignFailed", lang)}
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {form.drawings.map((d, i) => (
                  d ? (
                    <div key={i} className="relative aspect-video border-2 border-[#1a3458] rounded-sm overflow-hidden group">
                      <img src={d} alt={`${t("drawingLabel", lang)} ${i + 1}`} className="w-full h-full object-cover" />
                      <button onClick={() => removeDrawing(i)} title={t("deleteButton", lang)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-white/90 text-red-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  ) : form.drawingPaths[i] ? (
                    // Stored but not displayable. Shown apart from an empty slot
                    // so a failed or still pending sign is never mistaken for a
                    // drawing that was never there, and so the stored key is not
                    // quietly overwritten by picking a new file for this slot.
                    <div key={i} className="aspect-video border-2 border-amber-300 bg-amber-50 rounded-sm flex flex-col items-center justify-center gap-1 px-2 text-center">
                      <Icon name="image" size={20} className="text-amber-400" />
                      <span className="text-xs text-amber-700">{t("drawingUnavailable", lang)}</span>
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

            <div className="relative flex flex-wrap items-center gap-3 px-4 py-3 bg-[#f5f6f8] border border-slate-200 rounded-sm">
              <span className="text-sm font-600 text-slate-600">{t("totalRequiredTime", lang)}</span>
              <button type="button" onClick={() => setShowCalcInfo(v => !v)}
                className="text-slate-400 hover:text-[#1a3458] cursor-pointer transition-colors shrink-0"
                aria-label={t("autoCalcInfo", lang)}>
                <Icon name="info" size={15} />
              </button>
              <span className="text-2xl font-700 text-[#1a3458] font-mono">{totalTime.toFixed(1)}</span>
              <span className="text-sm text-slate-400">({t("autoCalculated", lang)})</span>
              {showCalcInfo && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowCalcInfo(false)} />
                  <div className="absolute left-3 top-full mt-2 z-50 w-72 bg-white border border-slate-200 rounded-sm shadow-lg px-4 py-3 text-sm text-slate-600">
                    {t("autoCalcInfo", lang)}
                  </div>
                </>
              )}
            </div>

            <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-700 text-[#1a3458]">Materials used by this product (BOM)</h3>
                  <p className="mt-0.5 text-sm text-slate-500">Stock is deducted automatically when an order enters In production.</p>
                </div>
                <button type="button" onClick={() => onNavigate("inventory")} className="rounded border border-slate-300 bg-white px-3 py-2 text-sm font-700 text-slate-700 hover:bg-slate-100">Open inventory</button>
              </div>

              {materialError && <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{materialError}</div>}

              <div className="grid gap-3 border-b border-slate-200 p-4 md:grid-cols-[1fr_150px_auto]">
                <label className="block text-sm font-600 text-slate-600">
                  Inventory material
                  <select value={materialItemId} disabled={isNew || materialBusy} onChange={event => setMaterialItemId(event.target.value)} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-base disabled:bg-slate-100">
                    <option value="">Select material / component</option>
                    {inventoryItems.filter(item => item.category !== "finished_good" && !productMaterials.some(row => row.inventoryItemId === item.id)).map(item => (
                      <option key={item.id} value={item.id}>{item.itemCode} · {item.itemName} · stock {item.availableQty.toLocaleString()} {item.unit}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-600 text-slate-600">
                  Qty per product
                  <input type="number" min="0.001" step="0.001" value={materialQty} disabled={isNew || materialBusy} onChange={event => setMaterialQty(Math.max(0, Number(event.target.value)))} className="mt-1 w-full rounded border border-slate-300 px-3 py-2.5 text-base disabled:bg-slate-100" />
                </label>
                <button type="button" disabled={isNew || materialBusy || !materialItemId || materialQty <= 0} onClick={() => void addMaterial()} className="self-end rounded bg-[#1a3458] px-5 py-2.5 font-700 text-white disabled:cursor-not-allowed disabled:opacity-40">{materialBusy ? "Saving..." : "Add material"}</button>
              </div>

              {isNew ? (
                <p className="p-4 text-sm text-amber-700">Save this product first, then its material requirements can be configured.</p>
              ) : productMaterials.length === 0 ? (
                <p className="p-4 text-sm text-amber-700">No materials configured. This product cannot enter production until its BOM is added.</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {productMaterials.map(row => {
                    const item = inventoryById(row.inventoryItemId);
                    const empty = (item?.availableQty ?? 0) <= 0;
                    const low = !empty && Boolean(item?.needsReorder);
                    return (
                      <div key={row.id} className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center ${empty ? "bg-red-50" : low ? "bg-amber-50" : ""}`}>
                        <div className="min-w-0 flex-1">
                          <p className="font-700 text-slate-800">{item?.itemName ?? "Unknown material"}</p>
                          <p className="font-mono text-xs text-slate-500">{item?.itemCode ?? row.bomNo} · {row.bomNo}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4 text-sm sm:flex sm:items-center sm:gap-7">
                          <div><p className="text-xs font-600 text-slate-400">Per unit</p><p className="font-mono font-700">{row.quantityPerUnit.toLocaleString()} {item?.unit ?? ""}</p></div>
                          <div><p className="text-xs font-600 text-slate-400">Available</p><p className={`font-mono font-700 ${empty ? "text-red-700" : low ? "text-amber-700" : "text-emerald-700"}`}>{item?.availableQty.toLocaleString() ?? "0"} {item?.unit ?? ""}</p></div>
                        </div>
                        <span className={`rounded-full px-2.5 py-1 text-center text-xs font-700 ${empty ? "bg-red-200 text-red-800" : low ? "bg-amber-200 text-amber-800" : "bg-emerald-100 text-emerald-700"}`}>{empty ? "Out of stock" : low ? "Low stock" : "Ready"}</span>
                        <button type="button" disabled={materialBusy} onClick={() => void removeMaterial(row)} className="rounded border border-red-200 px-3 py-2 text-sm font-700 text-red-600 hover:bg-red-50 disabled:opacity-40">Remove</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <div>
              <p className="text-sm font-600 text-slate-500 mb-2">{t("manufacturingTasks", lang)}</p>
              <div className="task-scroll border border-slate-200 rounded-sm max-h-[420px] overflow-y-scroll overscroll-contain">
                <div className="divide-y divide-slate-100 sm:hidden">
                  {form.tasks.map((task, i) => (
                    <div key={i} className={focusedRow === i ? "space-y-3 bg-slate-50 p-3" : "space-y-3 p-3"}>
                      <p className="text-xs font-700 text-slate-400">{t("taskNoHeader", lang)} {i + 1}</p>
                      <label className="block"><span className="mb-1 block text-xs font-600 text-slate-500">{t("taskContent", lang)}</span><input value={task.content} maxLength={100} onFocus={() => setFocusedRow(i)} onChange={e => { const tasks = form.tasks.map((x, j) => j === i ? { ...x, content: e.target.value } : x); setForm(prev => ({ ...prev, tasks })); setErrors(prev => ({ ...prev, [`task_content_${i}`]: "" })); setDirty(true); }} className={`w-full rounded-sm border px-3 py-2 text-base focus:border-[#1a3458] focus:outline-none ${errors[`task_content_${i}`] ? "border-red-400" : "border-slate-200"}`} />{errors[`task_content_${i}`] && <p className="mt-1 text-xs text-red-600">{errors[`task_content_${i}`]}</p>}</label>
                      <label className="block"><span className="mb-1 block text-xs font-600 text-slate-500">{t("taskTime", lang)}</span><input type="number" step="0.1" min="0" max="999.9" value={task.time} onFocus={() => setFocusedRow(i)} onChange={e => { const raw = e.target.value.replace(/^0+(?=[1-9])/, ""); const parsed = raw === "" ? ("" as const) : parseFloat(raw); const tasks: ProductTask[] = form.tasks.map((x, j) => j === i ? { ...x, time: isNaN(parsed as number) ? 0 : parsed } : x); setForm(prev => ({ ...prev, tasks })); setErrors(prev => ({ ...prev, [`task_time_${i}`]: "" })); setDirty(true); }} className={`w-full rounded-sm border px-3 py-2 text-right font-mono text-base focus:border-[#1a3458] focus:outline-none ${errors[`task_time_${i}`] ? "border-red-400" : "border-slate-200"}`} />{errors[`task_time_${i}`] && <p className="mt-1 text-xs text-red-600">{errors[`task_time_${i}`]}</p>}</label>
                    </div>
                  ))}
                </div>
                <table className="hidden w-full border-collapse text-base sm:table">
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

      <footer className="grid shrink-0 grid-cols-2 gap-2 bg-[#1a3458] px-3 py-3 min-[390px]:grid-cols-3 sm:flex sm:items-center sm:gap-3 sm:px-5">
        <Btn variant="ghost" size="lg" onClick={handleNew}><Icon name="plus" size={15} />{t("newButton", lang)}</Btn>
        <div className="hidden flex-1 sm:block" />
        <Btn variant="action" size="lg" onClick={handleSave} disabled={!dirty || Object.values(errors).some(v => v)}><Icon name="save" size={15} />{isScanRouted ? t("saveAndContinue", lang) : t("saveButton", lang)}</Btn>
        <Btn variant="danger" size="lg" className="col-span-2 justify-center min-[390px]:col-span-1" disabled={isNew} onClick={() => void handleDelete()}>
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
  const [inCharge, setInCharge] = useState("");
  const [conditions, setConditions] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
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
    <AppShell onNavigate={onNavigate} title={t("deliverySlipTitle", lang)} activePage="delivery-slip" showBack backTarget="search-billing" backLabel={t("searchBilling", lang)} lang={lang} setLang={setLang}>
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#f5f6f8] border-b border-slate-200 shrink-0">
        <Btn variant="outline" size="sm" onClick={() => onNavigate("search-billing")}><Icon name="chevron-left" size={14} />{t("returnButton", lang)}</Btn>
        <div className="flex-1" />
        <Btn variant="primary" size="sm" onClick={() => window.print()}><Icon name="printer" size={15} />{t("printButton", lang)}</Btn>
      </div>
      <div className="flex-1 overflow-y-auto flex justify-center bg-slate-300 p-2 sm:p-8">
        <div className="w-full max-w-2xl overflow-x-auto bg-white p-4 shadow-md sm:p-10">
          <h2 className="text-3xl font-700 text-slate-800 pb-2 border-b-2 border-slate-800 inline-block mb-2">{t("deliverySlipTitle", lang)}</h2>
          <p className="text-sm text-slate-500 mb-6"><span className="font-600 text-slate-600">{t("deliveryDateLabel", lang)}:</span><span className="ml-2 font-mono">{todayStr}</span></p>
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <FieldBox label={t("inCharge", lang)}><TextInput value={inCharge} placeholder={ph.inCharge} onChange={setInCharge} /></FieldBox>
            <FieldBox label={t("deliveryConditions", lang)}><TextInput value={conditions} placeholder={ph.conditions} onChange={setConditions} /></FieldBox>
            <FieldBox label={t("paymentTerms", lang)}><TextInput value={paymentTerms} placeholder={ph.terms} onChange={setPaymentTerms} /></FieldBox>
          </div>
          <table className="mb-6 w-full min-w-[560px] border-collapse text-base">
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
    try {
      const persisted = await upsertOrder(form);
      setOrders(prev => prev.map(o => o.id === persisted.id ? persisted : o));
      setPanelForm(persisted);
      setDirty(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      alert(`Failed to save order: ${err instanceof Error ? err.message : err}`);
    }
  };

  return (
    <AppShell onNavigate={onNavigate} title={t("scheduleTitle", lang)} activePage="schedule" showBack backTarget="home" backLabel={t("backButton", lang)} lang={lang} setLang={setLang}>
      <div className="responsive-workspace schedule-workspace flex flex-1 overflow-hidden min-h-0 bg-[#f5f6f8]">
        <aside className="responsive-panel responsive-panel-filter w-48 flex flex-col bg-[#1a3458] border-r border-slate-200 shrink-0 p-2 gap-2 overflow-y-auto min-h-0">
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

        <main className="responsive-calendar flex-1 flex flex-col min-h-0 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-[#f0f4f8] px-2 py-2 shrink-0 sm:flex-nowrap sm:px-4">
            <div className="flex items-center gap-1 sm:gap-4">
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
              <h2 className="w-32 whitespace-nowrap text-center text-base font-700 text-slate-800 sm:w-44 sm:text-xl">{monthLabel}</h2>
              <button type="button" onClick={() => changeMonth(1)} aria-label={lang === "ja" ? "翌月" : "Next month"}
                className="p-1 rounded-sm hover:bg-slate-200 cursor-pointer transition-colors"><Icon name="chevron-right" size={20} /></button>
            </div>
            <div className="ml-auto flex w-full overflow-hidden rounded-sm bg-[#1a3458] text-white sm:ml-0 sm:w-auto">
              {(["1W", "2W", "3W", "6W"] as const).map(mode => (
                <button key={mode} type="button" onClick={() => setViewMode(mode)}
                  className={`flex-1 px-3 py-1 text-sm font-600 border-r border-white/20 last:border-0 cursor-pointer transition-colors sm:flex-none ${viewMode === mode ? "bg-blue-600" : "hover:bg-blue-900"}`}>
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
            style={{ gridTemplateRows: `repeat(${gridRows}, auto)` }}>
            {visibleDays.map((calDay, i) => {
              const dayOrders = orders.filter(o => o.deliveryDate === calDay.dateStr && statusFilter[o.progress]);
              return (
                <div key={i} className={`flex flex-col gap-1 border-r border-b border-slate-200 p-1.5 ${calDay.isCurrentMonth ? "bg-white" : "bg-slate-50"} min-h-[4.5rem]`}>
                  <span className={`text-xs font-700 leading-none ${!calDay.isCurrentMonth ? "text-slate-400" : i % 7 === 0 ? "text-red-600" : i % 7 === 6 ? "text-blue-600" : "text-slate-700"}`}>
                    {calDay.day}
                  </span>
                  <div className="flex flex-col gap-1">
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

        <aside className="responsive-panel responsive-panel-detail w-80 bg-white border-l-2 border-slate-200 shrink-0 overflow-hidden flex flex-col min-h-0">
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

function ChecklistPage({ orderId, orders, setOrders, products, onNavigate, lang }: {
  orderId: string | null; orders: OrderRecord[]; setOrders: React.Dispatch<React.SetStateAction<OrderRecord[]>>;
  products: Product[]; onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void; lang: Lang;
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

  const toggleTask = async (index: number) => {
    const newCompleted = [...completed];
    newCompleted[index] = !newCompleted[index];
    const updated = { ...order, completedTasks: newCompleted };
    try {
      const persisted = await upsertOrder(updated);
      setOrders(prev => prev.map(o => o.id === order.id ? persisted : o));
    } catch (err) {
      alert(`Failed to save task progress: ${err instanceof Error ? err.message : err}`);
    }
  };

  const handleSaveAndReturn = () => {
    onNavigate("order-entry");
  };

  const productNumber = product?.productNumber || "-";

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#1a3458] shrink-0 sm:px-4">
        <div className="flex flex-wrap gap-2">
          <button onClick={() => onNavigate("order-entry")} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("returnButton", lang)}</button>
          <button onClick={handleSaveAndReturn} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("saveAndReturn", lang)}</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-emerald-100 px-3 py-1.5 text-xs font-700 text-emerald-700">Auto-saved</span>
          <button onClick={() => window.print()} className="px-4 py-1.5 bg-[#e0f0ff] text-slate-800 text-sm font-600 border border-slate-300 rounded-sm hover:bg-white cursor-pointer">{t("printButton", lang)}</button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3 pt-4 sm:p-4 sm:pt-5">
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
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

        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
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
  const { profile, signOut } = useAuth();
  const [page, setPage] = useState<Page>("home");
  const [deliveryMode, setDeliveryMode] = useState<DeliverySlipMode>("single");
  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [dataState, setDataState] = useState<"loading" | "ready" | "error">("loading");
  const [dataError, setDataError] = useState("");
  const [scanRouting, setScanRouting] = useState<ScanRouting>({ stage: "idle", data: null });
  const [scanOpen, setScanOpen] = useState(false);
  const [lang, setLang] = useState<"ja" | "en">("ja");
  const [checklistOrderId, setChecklistOrderId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let requestInFlight = false;
    let initialLoadComplete = false;
    let refreshPaused = false;

    const refreshData = async () => {
      if (requestInFlight || refreshPaused) return;
      requestInFlight = true;

      try {
        const data = await fetchAll();
        if (cancelled) return;
        setClients(data.clients);
        setProducts(data.products);
        setOrders(data.orders);
        setDataState("ready");
        setDataError("");
        initialLoadComplete = true;
      } catch (err) {
        if (!cancelled && !initialLoadComplete) {
          setDataError(err instanceof Error ? err.message : "Failed to load data from Supabase.");
          setDataState("error");
          refreshPaused = true;
        }
      } finally {
        requestInFlight = false;
      }
    };

    void refreshData();
    const refreshTimer = window.setInterval(() => void refreshData(), 3000);
    const refreshOnFocus = () => void refreshData();
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") void refreshData();
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
    };
  }, []);

  const navigate = (p: Page, mode?: DeliverySlipMode, orderId?: string) => {
    if (mode) setDeliveryMode(mode);
    if (orderId) setChecklistOrderId(orderId);
    setPage(p);
  };

  const openScan = () => setScanOpen(true);

  const handleScanApply = (data: ScanFillData, clientExists: boolean, productExists: boolean) => {
    setScanOpen(false);
    // Use the exact master names so the order always links to existing records
    // when corporate abbreviations or department suffixes differ.
    const client = findClientMatch(clients, data.client)?.name ?? data.client;
    if (!clientExists) { setScanRouting({ stage: "need-client", data: { ...data, client } }); navigate("client-master"); return; }
    if (!productExists) { setScanRouting({ stage: "need-product", data: { ...data, client } }); navigate("product-master"); return; }
    const masterProduct = findProductMatch(products, client, data.productName, data.productNumber);
    setScanRouting({ stage: "filling", data: { ...data, client, productName: masterProduct?.productName ?? data.productName } });
    navigate("order-entry");
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
        <div className="w-full max-w-lg rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <Icon name="alert-triangle" size={20} className="mt-0.5 shrink-0 text-red-600" />
            <div>
              <h1 className="font-700 text-slate-800">Data could not be loaded</h1>
              <p className="mt-1 text-sm leading-6 text-red-700">{dataError}</p>
              <p className="mt-2 text-xs leading-5 text-slate-500">If the console shows 401, sign out and log in again. If it shows 404 for profiles or inventory tables, deploy backend migration 002 first.</p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button onClick={() => void signOut()} className="rounded border border-slate-300 px-4 py-2 text-sm font-700 text-slate-700 hover:bg-slate-50">Sign out</button>
            <button onClick={() => window.location.reload()} className="rounded bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden" style={{ fontFamily: "'Work Sans', system-ui, sans-serif", fontSize: "16px" }}>
      {page === "home"           && <HomePage orders={dedupedOrders} onNavigate={navigate} onOpenScan={openScan} lang={lang} setLang={setLang} />}
      {page === "order-entry"    && <OrderEntryPage orders={dedupedOrders} setOrders={setOrders} clients={clients} products={products} onNavigate={navigate} onOpenScan={openScan} lang={lang} setLang={setLang} {...sharedScan} />}
      {page === "search-billing" && <SearchBillingPage orders={dedupedOrders} setOrders={setOrders} clients={clients} products={products} onNavigate={navigate} lang={lang} setLang={setLang} />}
      {page === "invoice"        && <InvoicePage orders={dedupedOrders} clients={clients} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "client-master"  && <ClientMasterPage clients={clients} setClients={setClients} products={products} scanRouting={scanRouting} setScanRouting={setScanRouting} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "product-master" && <ProductMasterPage products={products} setProducts={setProducts} clients={clients} scanRouting={scanRouting} setScanRouting={setScanRouting} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "delivery-slip"  && <DeliverySlipPage mode={deliveryMode} orders={dedupedOrders} lang={lang} setLang={setLang} onNavigate={navigate} />}
      {page === "schedule"       && <SchedulePage orders={dedupedOrders} setOrders={setOrders} products={products} onNavigate={navigate} lang={lang} setLang={setLang} />}
      {page === "checklist"      && <ChecklistPage orderId={checklistOrderId} onNavigate={navigate} orders={dedupedOrders} products={products} lang={lang} setOrders={setOrders} />}
      {page === "inventory"      && <Suspense fallback={<PageLoading />}><InventoryPage products={products} onNavigate={navigate} lang={lang} setLang={setLang} /></Suspense>}
      {page === "management" && profile.role === "administrator" && <Suspense fallback={<PageLoading />}><ManagementPage onNavigate={navigate} lang={lang} setLang={setLang} /></Suspense>}
      {page === "management" && profile.role !== "administrator" && <Suspense fallback={<PageLoading />}><ProfilePage onNavigate={navigate} lang={lang} setLang={setLang} /></Suspense>}
      {page === "profile"        && <Suspense fallback={<PageLoading />}><ProfilePage onNavigate={navigate} lang={lang} setLang={setLang} /></Suspense>}

      {scanOpen && <ScanModal clients={clients} products={products} onClose={() => setScanOpen(false)} onApply={handleScanApply} lang={lang} />}
    </div>
  );
}

function PageLoading() {
  return <div className="flex h-full items-center justify-center bg-[#f5f6f8] text-sm text-slate-500">Loading module...</div>;
}
