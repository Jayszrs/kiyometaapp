import type { OcrLine } from "./ocrClient";

export type ScanTemplate = "unnamed" | "order-sheet" | "purchase-order";
export interface ScanFillData {
  orderDate: string;
  deliveryDate: string;
  client: string;
  orderNumber: string;
  productName: string;
  quantity: number;
  orderAmount: number;
  clientPhone: string;
  clientAddress: string;
  clientPostalCode: string;
  productNumber: string;
  unitPrice: number;
  processName: string;
}
type Key = keyof ScanFillData;
export interface ParsedQuotation {
  template: ScanTemplate;
  title: string;
  debug: string;
  data: ScanFillData;
  warnings: string[];
  fields: { key: Key; label: string; source: string; target: string; page: string;
    sourceLabel: string; confidence: number; status: "found" | "missing" | "review" }[];
}
type Box = OcrLine & { page: number };
type FieldKey = Key | "ignore";
interface Definition { key: FieldKey; aliases: string[] }

// One vocabulary for every layout. Longer labels win over embedded short labels:
// e.g. 税込合計金額 must never be interpreted as 合計金額.
const DEFINITIONS: Definition[] = [
  { key: "ignore", aliases: ["税込合計金額", "税込金額", "消費税額", "消費税", "税率", "税額", "発注先住所", "納入者コード", "仕入先コード", "納入場所", "納入先", "発注先", "宛先", "お支払い条件", "支払条件", "担当者", "担当", "備考", "単位", "ページ", "FAX", "次工程", "工程", "残数", "検収日", "検収担当", "支給予定日", "注文書", "発注書"] },
  { key: "orderDate", aliases: ["発注年月日", "注文年月日", "発注日付", "注文日付", "発注日", "注文日", "見積日", "発行日"] },
  { key: "deliveryDate", aliases: ["指定納入日", "納入期日", "希望納期", "納入予定日", "納入日", "納期"] },
  { key: "orderNumber", aliases: ["注文番号", "発注番号", "注文No.", "注文No", "発注No.", "発注No", "見積番号"] },
  { key: "productNumber", aliases: ["図面番号", "品目コード", "製品番号", "部品番号", "品番", "図番", "製番"] },
  { key: "productName", aliases: ["部品名", "製品名", "品目名", "商品名", "品名"] },
  { key: "quantity", aliases: ["発注数量", "注文数量", "納入数量", "納入数", "数量"] },
  { key: "unitPrice", aliases: ["発注単価", "注文単価", "納入単価", "単価"] },
  { key: "orderAmount", aliases: ["税抜合計金額", "合計金額(税抜)", "税抜金額", "合計金額", "発注金額", "注文金額", "納入金額", "小計"] },
  { key: "processName", aliases: ["処理名", "工程名", "加工名", "名称"] },
  { key: "client", aliases: ["発注元会社名", "注文元会社名", "発注元", "注文元", "発行者"] },
  { key: "clientPostalCode", aliases: ["郵便番号", "郵便"] },
  { key: "clientAddress", aliases: ["発注元住所", "会社住所", "所在地", "住所"] },
  { key: "clientPhone", aliases: ["電話番号", "電話", "TEL"] },
];
const LABELS: Record<Key, [string, string]> = {
  orderDate: ["Order date", "Order entry: order date"],
  deliveryDate: ["Delivery date", "Order entry: delivery date"],
  client: ["Client", "Order entry: client / Client master: name"],
  orderNumber: ["Order no.", "Order entry: order number"],
  productNumber: ["Drawing / item no.", "Product master: product number"],
  productName: ["Product name", "Order entry: product name / Product master: name"],
  quantity: ["Quantity", "Order entry: quantity"],
  unitPrice: ["Unit price", "Product master: unit price"],
  orderAmount: ["Amount (excl. tax)", "Order entry: order amount"],
  processName: ["Process", "Product master: tasks"],
  clientPostalCode: ["Postal code", "Client master: postal code"],
  clientAddress: ["Address", "Client master: address"],
  clientPhone: ["Phone", "Client master: phone number"],
};
const LABELS_JA: Record<Key, string> = {
  orderDate: "受注日", deliveryDate: "納期", client: "取引先", orderNumber: "注文番号",
  productNumber: "図面 / 品目番号", productName: "製品名", quantity: "数量", unitPrice: "単価",
  orderAmount: "金額 (税抜)", processName: "工程", clientPostalCode: "郵便番号",
  clientAddress: "住所", clientPhone: "電話番号",
};
const fieldName = (key: Key, lang: "ja" | "en"): string => lang === "ja" ? LABELS_JA[key] : LABELS[key][0];
const keys = Object.keys(LABELS) as Key[];
const numeric = new Set<Key>(["quantity", "unitPrice", "orderAmount"]);
const canon: Record<string, string> = { 额: "額", 发: "発", 纳: "納", 单: "単", 书: "書", 价: "価", 俩: "価", 單: "単" };
function clean(s: string): string {
  return s.normalize("NFKC").replace(/[‐‑‒–—−－]/g, "-").replace(/\s+/g, " ").trim();
}
function labelText(s: string): string { return [...s].map(c => canon[c] ?? c).join(""); }
function compact(s: string): string { return clean(s).replace(/\s/g, "").toLowerCase(); }
function height(b: Box): number { return Math.max(1, b.y1 - b.y0); }
function cy(b: Box): number { return (b.y0 + b.y1) / 2; }
function sameRow(a: Box, b: Box): boolean {
  return a.page === b.page && Math.abs(cy(a) - cy(b)) <= Math.min(height(a), height(b)) * 0.65;
}
function distance(a: Box, b: Box): number {
  return Math.max(0, a.x0 - b.x1, b.x0 - a.x1) + Math.abs(cy(a) - cy(b));
}
function union(a: Box, b: Box, text: string): Box {
  return { ...a, text, x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), score: Math.min(a.score, b.score) };
}
function part(b: Box, start: number, end: number): Box {
  const unit = (b.x1 - b.x0) / Math.max(1, b.text.length);
  return { ...b, text: b.text.slice(start, end), x0: b.x0 + start * unit, x1: b.x0 + end * unit };
}
interface Anchor extends Box { key: FieldKey; label: string; inline?: Box }
const patterns = DEFINITIONS.flatMap(d => d.aliases.map(alias => ({ key: d.key, alias,
  re: new RegExp([...alias].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "gi") })));
function anchorsIn(b: Box): Anchor[] {
  const hits = patterns.flatMap(p => [...labelText(b.text).matchAll(p.re)].map(m => ({ key: p.key, label: p.alias, start: m.index!, end: m.index! + m[0].length })));
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const chosen: typeof hits = [];
  for (const h of hits) if (!chosen.some(c => h.start < c.end && h.end > c.start)) chosen.push(h);
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map((h, i) => {
    const tail = part(b, h.end, chosen[i + 1]?.start ?? b.text.length);
    tail.text = tail.text.replace(/^[\s:：)\]】.]+/, "").trim();
    return { ...part(b, h.start, h.end), key: h.key, label: h.label, inline: tail.text ? tail : undefined };
  });
}
function postal(raw: string): string {
  const m = clean(raw).match(/(?:^|[^\d-])(\d{3})\s*[-ー]?\s*(\d{4})(?![\d-])/);
  return m ? `${m[1]}-${m[2]}` : "";
}
function phone(raw: string): string {
  const t = clean(raw).replace(/[()]/g, "-").replace(/\s/g, "");
  const m = t.match(/(?:^|[^\d-])(0\d{1,3})-(\d{1,4})-(\d{3,4})(?![\d-])/);
  if (m && [10, 11].includes(m.slice(1).join("").length)) return m.slice(1).join("-");
  return t.match(/(?:^|\D)(0\d{9,10})(?!\d)/)?.[1] ?? "";
}
function number(raw: string): number | null {
  const t = clean(raw).replace(/^[¥￥]/, "").replace(/(?:円|個|台|本|枚|式|kg|KG)$/, "").replace(/\s/g, "");
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function date(raw: string, reference?: string): string {
  const t = clean(raw).replace(/\s/g, "").replace(/[年月.\-]/g, "/").replace(/日/g, "");
  const m = t.match(/^(?:(\d{4}|\d{2})\/)?(\d{1,2})\/(\d{1,2})(?:\([月火水木金土日]\))?$/);
  if (!m || (!m[1] && !reference)) return "";
  let y = m[1] ? Number(m[1]) + (m[1].length === 2 ? 2000 : 0) : Number(reference!.slice(0, 4));
  // A yearless January deadline on a December order belongs to the following year.
  if (!m[1] && reference && reference.slice(5, 7) === "12" && Number(m[2]) === 1) y++;
  const mo = Number(m[2]), d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === mo - 1 && check.getUTCDate() === d
    ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : "";
}
const companyRe = /株式会社|\(株\)|有限会社|合同会社|\(有\)/;
const recipientRe = /御中|様|発注先|宛先|納入先/;
const addressRe = /[都道府県郡市町村区].*\d/;
const processRe = /酸洗|洗浄|メッキ|めっき|熱処理|塗装|外注加工/;
export function normalizeClientName(raw: string): string {
  return clean(raw).replace(/\(株\)/g, "株式会社").replace(/\(有\)/g, "有限会社");
}
function valueFor(key: Key, raw: string, reference?: string): string {
  const t = clean(raw).replace(/^[\s:：]+/, "");
  if (!t || anchorsIn({ text: t, x0: 0, y0: 0, x1: 100, y1: 10, score: 1, page: 0 }).length) return "";
  if (numeric.has(key)) return number(t) === null ? "" : String(number(t));
  if (key === "orderDate") return date(t);
  if (key === "deliveryDate") return date(t, reference);
  if (key === "clientPostalCode") return postal(t);
  if (key === "clientPhone") return phone(t);
  if (key === "clientAddress") return addressRe.test(t) ? t.replace(/^〒?\s*\d{3}\s*-?\s*\d{4}\s*/, "") : "";
  if (key === "client") return !recipientRe.test(t) && !addressRe.test(t) && /[A-Za-z\u3040-\u9fff]/.test(t) ? t : "";
  if (key === "orderNumber" || key === "productNumber") {
    const code = t.replace(/\s/g, "").replace(/^\*|\*$/g, "");
    return /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(code) && !date(code) && !/^\d{3}-\d{4}$/.test(code) ? code : "";
  }
  if (key === "productName" || key === "processName") {
    if (companyRe.test(t) || recipientRe.test(t) || addressRe.test(t) || /^(?:\([^()]+\)|[\d .\/-]+|合格|不合格|分納|完納)$/.test(t)) return "";
    if (/^(?=.*\d)[A-Za-z0-9./-]+$/.test(t)) return "";
    if (key === "productName" && processRe.test(t)) return "";
    return t;
  }
  return t;
}
interface Hit { value: string; box: Box; label: string; cost: number; confidence: number; anchor?: Anchor }

export function parseQuotation(ocrLines: OcrLine[], lang: "ja" | "en" = "en"): ParsedQuotation {
  const lines: Box[] = ocrLines.filter(l => l.text?.trim() && l.score >= 0.3 && [l.x0,l.x1,l.y0,l.y1].every(Number.isFinite))
    .map(l => ({ ...l, text: clean(l.text), page: l.page ?? 0 })).sort((a,b) => a.page-b.page || a.y0-b.y0 || a.x0-b.x0);
  // Rejoin OCR fragments only when they form a complete known label. Values and
  // neighbouring table columns retain their own boxes.
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (!sameRow(a,b) || b.x0 < a.x1 || b.x0-a.x1 > height(a)*1.5) continue;
      const joined = a.text + b.text;
      if (DEFINITIONS.some(d => d.aliases.some(k => compact(labelText(joined)) === compact(k)))) {
        lines[i] = union(a,b,joined); lines.splice(j,1); break;
      }
    }
  }
  const anchors = lines.flatMap(anchorsIn);
  const values = lines.filter(l => !anchorsIn(l).length);
  for (const a of anchors) if (a.inline) values.push(a.inline);
  // Preserve multi-token names (タンク (TOP)), separated postcode halves and
  // split currency values, without joining cells through another label.
  const joined: Box[] = [];
  for (const a of values) {
    let cur = a;
    const next = values.filter(b => b !== a && sameRow(a,b) && b.x0 >= a.x1).sort((a,b) => a.x0-b.x0);
    for (const b of next.slice(0,3)) {
      if (b.x0-cur.x1 > height(cur)*1.5 || anchors.some(k => sameRow(cur,k) && k.x0 >= cur.x1 && k.x0 < b.x0)) break;
      // Do not turn separate numeric table cells into one concatenated number.
      if (number(cur.text) !== null && number(b.text) !== null) break;
      cur = union(cur,b,cur.text + " " + b.text); joined.push(cur);
    }
  }
  values.push(...joined);
  const hits: Partial<Record<Key, Hit>> = {};
  const warnings: string[] = [];
  const trace: string[] = [];
  const pick = (key: Key, reference?: string): Hit | undefined => {
    const candidates: Hit[] = [];
    for (const a of anchors.filter(a => a.key === key)) {
      for (const b of values) {
        if (a.page !== b.page) continue;
        const h = Math.max(height(a),height(b));
        const right = sameRow(a,b) && b.x0 >= a.x1-h*0.3 && b.x0-a.x1 <= h*25;
        const below = b.y0 >= a.y1-h*0.2 && b.y0-a.y1 <= h*7 && b.x1 >= a.x0-h*8 && b.x0 <= a.x1+h*6;
        if (!right && !below) continue;
        const item = hits.productNumber;
        if (below && item?.anchor && key !== "productNumber" && sameRow(a,item.anchor) && !sameRow(b,item.box)) continue;
        if (right && anchors.some(k => k !== a && sameRow(a,k) && k.x0 >= a.x1 && k.x0 < b.x0)) continue;
        if (below) {
          if (numeric.has(key) && b.x1 < a.x0-h*0.2) continue;
          const left = anchors.filter(k => k !== a && sameRow(a,k) && k.x0 < a.x0).sort((x,y) => y.x0-x.x0)[0];
          const next = anchors.filter(k => k !== a && sameRow(a,k) && k.x0 > a.x0).sort((x,y) => x.x0-y.x0)[0];
          if ((left && b.x0 < left.x1-h*0.3) || (next && b.x0 >= next.x0-h*0.3)) continue;
          if (anchors.some(k => k !== a && k.page === a.page && k.y0 > a.y1 && k.y1 <= b.y0 && k.x0 <= a.x1 && k.x1 >= a.x0)) continue;
        }
        const value = valueFor(key,b.text,reference);
        if (!value) continue;
        let cost = right ? Math.max(0,b.x0-a.x1)/h*0.12 : 1 + Math.max(0,b.y0-a.y1)/h*0.55 + Math.abs(b.x0-a.x0)/h*0.08;
        if (b === a.inline) cost = -2;
        // Prefer explicit item/drawing codes over manufacturing job numbers.
        if (key === "productNumber" && a.label === "製番") cost += 6;
        if ((key === "quantity" || key === "unitPrice" || key === "orderAmount") && a.label.startsWith("納入")) cost += 4;
        if (key === "orderAmount" && /合計|税抜|小計/.test(a.label)) cost -= 3;
        if ((key === "productName" || key === "processName") && joined.includes(b)) cost -= 0.35;
        cost += (1-b.score)*2;
        candidates.push({ value, box:b, label:a.label, cost, confidence:Math.min(a.score,b.score), anchor:a });
      }
    }
    candidates.sort((a,b) => a.box.page-b.box.page || (a.anchor === b.anchor && !sameRow(a.box,b.box) ? a.box.y0-b.box.y0 : a.cost-b.cost) || a.box.y0-b.box.y0);
    const best = candidates[0];
    if (best && candidates.some(c => c.box.page === best.box.page && c.value !== best.value && Math.abs(c.cost-best.cost) < 0.25)) {
      warnings.push(lang === "ja"
        ? `${fieldName(key, lang)}に複数の候補があります。選択された値を確認してください。`
        : `${fieldName(key, lang)} has multiple nearby values; confirm the selected value.`);
      best.confidence = Math.min(best.confidence,0.6);
    }
    return best;
  };
  hits.productNumber = pick("productNumber");
  for (const key of keys.filter(k => !k.startsWith("client") && k !== "deliveryDate" && k !== "productNumber")) hits[key] = pick(key);
  hits.deliveryDate = pick("deliveryDate",hits.orderDate?.value);

  // Some forms print the issue date without a label at the top. Do not use
  // dates attached to other labels or infer an order date from a deadline.
  if (!hits.orderDate && lines.length) {
    const top = Math.min(...lines.filter(l => l.page === lines[0].page).map(l => l.y0));
    const dates = lines.filter(l => l.page === lines[0].page && l.y0 <= top+height(l)*4 && !!date(l.text)
      && !anchors.some(a => a.page === l.page && distance(a,l)<height(l)*5));
    if (dates.length === 1) {
      hits.orderDate = { value:date(dates[0].text),box:dates[0],label:"Unlabelled document date",cost:0,confidence:0.7 };
      hits.deliveryDate = pick("deliveryDate",hits.orderDate.value);
    }
  }
  const explicitClient = pick("client");
  const companies = values.filter(l => companyRe.test(l.text) || recipientRe.test(l.text));
  const recipients = lines.filter(l => recipientRe.test(l.text));
  const isRecipient = (b:Box) => recipientRe.test(b.text) || recipients.some(r => r.page === b.page && sameRow(r,b) && distance(r,b) < height(b)*5);
  let sender = explicitClient?.box ?? companies.filter(b => !isRecipient(b)).sort((a,b) => a.page-b.page || a.y0-b.y0)[0];
  if (sender && !explicitClient) {
    const company = sender;
    sender = joined.filter(b => b.page === company.page && b.x0 === company.x0 && sameRow(b,company) && !addressRe.test(b.text) && !recipientRe.test(b.text))
      .sort((a,b) => b.text.length-a.text.length)[0] ?? company;
  }
  if (sender) {
    hits.client = explicitClient ?? { value:sender.text,box:sender,label:"Issuing company",cost:0,confidence:sender.score };
    const owns = (b:Box) => b.page === sender.page && distance(sender,b)<Math.max(height(sender),height(b))*25
      && !isRecipient(b) && !companies.some(c => c.page === b.page && isRecipient(c) && distance(c,b) < distance(sender,b));
    for (const key of ["clientPostalCode","clientAddress","clientPhone"] as const) {
      const labelled = pick(key);
      if (labelled && owns(labelled.box)) { hits[key] = labelled; continue; }
      const candidates = values.filter(owns).filter(b => !/^FAX/i.test(b.text) && !anchors.some(a => a.label === "FAX" && a.inline === b))
        .map(b => ({ value:valueFor(key,b.text),box:b,label:"Issuing company contact",cost:distance(sender,b),confidence:b.score }))
        .filter(h => h.value).sort((a,b) => a.cost-b.cost);
      hits[key] = candidates[0];
    }
  }
  const data = Object.fromEntries(keys.map(k => [k,numeric.has(k) ? Number(hits[k]?.value ?? 0) : hits[k]?.value ?? ""])) as unknown as ScanFillData;
  const productCodes = new Set(anchors.filter(a => a.key === "productNumber" && a.label === hits.productNumber?.label).flatMap(a => values.filter(b => b.page === a.page && b.y0 >= a.y1 && b.y0-a.y1 < height(a)*7 && b.x0 >= a.x0-height(a)*8 && b.x0 <= a.x1).map(b => valueFor("productNumber",b.text))).filter(Boolean));
  if (productCodes.size > 1) warnings.push(lang === "ja"
    ? "複数の品目が検出されました。最初の品目のみを読み込みます。各項目が同じ行に属するか確認してください。"
    : "Multiple items detected. This form imports the first item; confirm that all item fields belong to the same row.");
  if (hits.quantity && hits.unitPrice && hits.orderAmount && Math.abs(data.quantity*data.unitPrice-data.orderAmount)>0.01)
    warnings.push(lang === "ja"
      ? "数量 × 単価が金額と一致しません。複数品目、値引き、または異なる合計がないか確認してください。"
      : "Quantity × unit price differs from the amount. Check for multiple items, discounts or a different total.");
  const missing = keys.filter(k => !hits[k]);
  if (missing.length) warnings.push(lang === "ja"
    ? `検出できませんでした: ${missing.map(k => fieldName(k, lang)).join("、")}。値を入力するか、未入力のままにしてください。`
    : `Not found: ${missing.map(k => fieldName(k, lang)).join(", ")}. Enter these values or leave optional fields blank.`);
  const text = compact(lines.map(l => l.text).join(" "));
  const template: ScanTemplate = text.includes("注文書") ? "order-sheet" : text.includes("発注書") ? "purchase-order" : "unnamed";
  const title = template === "order-sheet"
    ? (lang === "ja" ? "注文書" : "Order sheet (注文書)")
    : template === "purchase-order"
      ? (lang === "ja" ? "発注書" : "Purchase order (発注書)")
      : (lang === "ja" ? "見積書 / 発注書" : "Quotation / order document");
  const fields = keys.map(key => {
    const hit = hits[key];
    trace.push(`${key}: ${hit ? `${hit.value} [${hit.label}, page ${hit.box.page+1}, confidence ${hit.confidence.toFixed(2)}]` : "not found"}`);
    return { key,label:LABELS[key][0],target:LABELS[key][1],source:hit ? String(data[key]) : "",page:hit ? `P${hit.box.page+1}` : "",
      sourceLabel:hit?.label ?? "",confidence:hit?.confidence ?? 0,status:!hit ? "missing" as const : hit.confidence<0.75 ? "review" as const : "found" as const };
  });
  return { template,title,data,fields,warnings,debug:trace.concat(warnings).join("\n") };
}
