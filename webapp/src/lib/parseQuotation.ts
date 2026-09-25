import type { OcrLine } from "./ocrClient";

export type ScanTemplate = "unnamed" | "order-sheet" | "purchase-order";

export interface ParsedQuotation {
  template: ScanTemplate;
  title: string;
  debug: string;
  data: {
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
  };
  fields: { label: string; source: string; target: string; page: string }[];
}

interface Ranked {
  raw: string;
  nx: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  page: number;
}

const PAGE_OFFSET = 20000;

const KANJI_CANON: Record<string, string> = {
  额: "額", 发: "発", 凳: "発", 毙: "発", 纳: "納", 单: "単", 书: "書", 价: "価",
  种: "種", 检: "検", 际: "際", 备: "備", 処: "処", 认: "認", 课: "課",
  収: "受", 早: "早", 呉: "呉", 达: "込",
  迟: "込",
  凭: "発",
  凸: "出",
  鼎: "尻",
};

function norm(s: string): string {
  let t = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  t = t.replace(/\u3000/g, "");
  let out = "";
  for (const ch of t) out += KANJI_CANON[ch] ?? ch;
  return out.replace(/[\s　]/g, "");
}

function sameRow(a: Ranked, b: Ranked): boolean {
  const h = Math.max(8, a.y1 - a.y0, b.y1 - b.y0);
  return Math.abs((b.y0 + b.y1) / 2 - (a.y0 + a.y1) / 2) <= h * 0.8;
}

function mergeRows(ranked: Ranked[]): Ranked[] {
  const rows: Ranked[][] = [];
  for (const l of ranked) {
    let placed = false;
    for (const row of rows) {
      if (sameRow(row[0], l)) {
        row.push(l);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([l]);
  }

  const out: Ranked[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x0 - b.x0);
    let cur = row[0];
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].x0 - cur.x1;
      const h = Math.max(8, cur.y1 - cur.y0, row[i].y1 - row[i].y0);
      if (gap <= Math.max(14, h * 0.6)) {
        const raw = cur.raw + " " + row[i].raw;
        cur = {
          raw,
          nx: norm(raw),
          x0: cur.x0,
          y0: Math.min(cur.y0, row[i].y0),
          x1: row[i].x1,
          y1: Math.max(cur.y1, row[i].y1),
          score: Math.min(cur.score, row[i].score),
          page: cur.page,
        };
      } else {
        out.push(cur);
        cur = row[i];
      }
    }
    out.push(cur);
  }
  return out;
}

function findValue(lines: Ranked[], anchor: Ranked, opts?: { numeric?: boolean; preferCjk?: boolean }): Ranked | null {
  const others = lines.filter((l) => l !== anchor);
  const aw = Math.max(20, anchor.x1 - anchor.x0);

  const ys = lines.map((l) => l.y0).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < ys.length; i++) {
    const g = ys[i] - ys[i - 1];
    if (g > 0 && g < 500) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[gaps.length >> 1] : 50;
  const win = Math.min(Math.max(pitch * 5, 110), 260);

  const centerY = (l: Ranked) => (l.y0 + l.y1) / 2;
  const alignX = (l: Ranked) => l.x0 <= anchor.x1 + aw * 1.5 && l.x1 >= anchor.x0 - aw;

  const valueLike = (l: Ranked): boolean => {
    if (/^[（(][^（()）)]*[）)]$/.test(l.raw.trim()) && !/[A-Za-z0-9]/.test(l.raw)) return false;
    if (!isPlausible(l.raw)) return false;
    if (opts?.numeric) {
      if (!/[0-9０-９]/.test(l.raw)) return false;
      if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(l.raw)) return false;
      if (/[A-Za-z]/.test(l.raw)) return false;
      if (/\d{1,2}[\/／]\d{1,2}(?:[\/／]\d{2,4})?/.test(l.raw)) return false;
      if (/^\d{3}-\d{4}$/.test(l.raw)) return false;
      if (/^\d{2,4}-\d{2,4}-\d{3,4}$/.test(l.raw)) return false;
      return true;
    }
    return true;
  };

  const dist = (l: Ranked): number => {
    const d = Math.abs(centerY(l) - centerY(anchor));
    return opts?.preferCjk && /[\u3040-\u30ff\u4e00-\u9fff]/.test(l.raw) ? d - 24 : d;
  };

  const cands = others
    .filter((l) => valueLike(l) && alignX(l) && Math.abs(centerY(l) - centerY(anchor)) <= win)
    .sort((a, b) => dist(a) - dist(b) || b.x0 - a.x0);
  return cands[0] ?? null;
}

function inlineValue(line: Ranked, keywords: string[]): string {
  const kws = keywords.map(norm);
  const tokens = line.raw.split(/\s+/).filter(Boolean);
  const rest = tokens.filter((t) => {
    const tn = norm(t);
    return !kws.some((k) => tn.includes(k));
  });
  if (!rest.length) return "";
  const last = rest[rest.length - 1].replace(/^[:\-－：「」()（）【】\[\]]+|[:\-－：「」()（）【】\[\]]+$/g, "");
  return isPlausible(last) ? last : "";
}

function isPlausible(v: string): boolean {
  if (!v) return false;
  return /[0-9A-Za-z]/.test(v) || v.length >= 2;
}

function extractPostal(raw: string): string {
  const m = raw.match(/〒?\s*(\d{3})\s*-?\s*(\d{4})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

function extractPhone(raw: string): string {
  const m = raw.match(/\d{2,4}-?\d{2,4}-?\d{3,4}/);
  return m ? m[0] : "";
}

function parseNumber(raw: string): number {
  const t = raw.replace(/[￥¥,,\s％%円]/g, "");
  const n = parseFloat(t.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function parseIntValue(raw: string): number {
  const m = raw.replace(/[￥¥,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function two(y: string | number): string {
  return String(y).padStart(2, "0");
}

function parseDateToken(raw: string, refYear?: number): string {
  const t = raw.replace(/[年.\-ー]/g, "/").replace(/[日号]/g, "");
  const toIso = (y: number, m: string, d: string): string => {
    const mo = Number(m);
    const da = Number(d);
    if (!y || mo < 1 || mo > 12 || da < 1 || da > 31) return "";
    return `${y}-${two(mo)}-${two(da)}`;
  };
  let m = t.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return toIso(Number(m[1]), m[2], m[3]);
  m = t.match(/(\d{2})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return toIso(2000 + Number(m[1]), m[2], m[3]);
  m = t.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return toIso(refYear ?? new Date().getFullYear(), m[1], m[2]);
  return "";
}

function cleanCode(raw: string, keywords: string[]): string {
  let s = raw;
  for (const kw of keywords) s = s.split(kw).join(" ");
  return s.replace(/^\s*[:\-－=:：]+\s*/, "").replace(/\s+[:\-－=:：]+\s*$/, "").trim();
}

interface AnchorDef {
  key: "orderNumber" | "productNumber" | "productName" | "quantity" | "unitPrice" | "orderAmount" | "orderDate" | "deliveryDate";
  keywords: string[];
  numeric?: boolean;
}

const ORDER_SHEET_ANCHORS: AnchorDef[] = [
  { key: "orderDate", keywords: ["発注日", "注文日", "発注年月日", "注文年月日", "注日"] },
  { key: "deliveryDate", keywords: ["納期", "納入期日", "希望納期"] },
  { key: "orderNumber", keywords: ["注文No", "注文番号", "注文NO"] },
  { key: "productNumber", keywords: ["図面番号", "面番号", "製番", "図番"] },
  { key: "productName", keywords: ["品名", "部品名", "製品名", "品目名"] },
  { key: "quantity", keywords: ["数量", "注文数量"], numeric: true },
  { key: "unitPrice", keywords: ["単価", "単俩", "单俩", "單価", "注文単価"], numeric: true },
  { key: "orderAmount", keywords: ["合計金額", "税込合計金額"], numeric: true },
];

const PURCHASE_ORDER_ANCHORS: AnchorDef[] = [
  { key: "orderDate", keywords: ["発注日", "注文日", "注文年月日", "発注年月日", "発注日付", "注日"] },
  { key: "deliveryDate", keywords: ["指定納入日", "納入日", "納期"] },
  { key: "orderNumber", keywords: ["注文番号", "注文No", "注文NO"] },
  { key: "productNumber", keywords: ["品目", "品目コード", "品番", "製番"] },
  { key: "productName", keywords: ["品名", "品目名", "製品名", "部品名"] },
  { key: "quantity", keywords: ["発注数量", "注文数量", "注数量", "数量"], numeric: true },
  { key: "unitPrice", keywords: ["発注単価", "納入単価", "発注単", "納入単", "注単", "単価", "单俩"], numeric: true },
  { key: "orderAmount", keywords: ["発注金額", "納入金額", "合計金額", "税込合計金額"], numeric: true },
];

export interface ParseOptions {
  knownProductNames?: string[];
}

const PROCESS_NAME_RE = /(外注加工|酸洗|ドブ|どぶ|洗浄|メッキ|熱処理|塗装|化成処理|仕上げ|check印)/;

export function parseQuotation(ocrLines: OcrLine[], opts?: ParseOptions): ParsedQuotation {
  const ranked: Ranked[] = ocrLines
    .filter((l) => l.score >= 0.4 && l.text.trim().length > 0)
    .map((l) => ({
      raw: l.text.trim(),
      nx: norm(l.text),
      x0: l.x0,
      y0: l.y0 + (l.page ?? 0) * PAGE_OFFSET,
      x1: l.x1,
      y1: l.y1 + (l.page ?? 0) * PAGE_OFFSET,
      score: l.score,
      page: l.page ?? 0,
    }));

  const allText = ranked.map((l) => l.nx).join("");
  let template: ScanTemplate = "unnamed";
  let templateWhy = "title keyword not detected";
  if (allText.includes("注文書") || allText.includes("注文书")) { template = "order-sheet"; templateWhy = "title 注文書 detected"; }
  else if (allText.includes("発注書") || allText.includes("納入書")) { template = "purchase-order"; templateWhy = "title 発注書/納入書 detected"; }
  if (template === "unnamed") { template = "order-sheet"; templateWhy += " -> assumed standard order sheet"; }

  const anchors = template === "purchase-order" ? PURCHASE_ORDER_ANCHORS : ORDER_SHEET_ANCHORS;

  const trace: string[] = [];
  trace.push(`template: ${templateLabel(template).toLowerCase()} (${templateWhy})`);
  trace.push(`ocr lines: ${ranked.length}`);

  const rawValues: Record<string, string> = {};
  let orderDateHitPage = 0;

  for (const def of anchors) {
    const page0 = ranked.filter((l) => l.page === 0);
    const bestHit = (pool: Ranked[]): Ranked | null => {
      let hit: Ranked | null = null;
      let bestLen = 0;
      for (const l of pool) {
        let len = 0;
        for (const kw of def.keywords) if (l.nx.includes(norm(kw))) len = Math.max(len, kw.length);
        if (len > bestLen) {
          bestLen = len;
          hit = l;
        }
      }
      return hit;
    };
    let hit = bestHit(page0);
    if (!hit) hit = bestHit(ranked);
    if (!hit) continue;
    if (def.key === "orderDate") orderDateHitPage = hit.page;
    const inline = inlineValue(hit, def.keywords);
    const candidate = findValue(ranked, hit, { numeric: def.numeric, preferCjk: def.key === "productName" });
    if (typeof process !== "undefined" && process.env?.KIO_OCR_DEBUG) {
      const cand = candidate ? `y=${candidate.y0} x=${candidate.x0} "${candidate.raw}"` : "none";
      /* eslint-disable no-console */
      console.error(`[anchor] ${def.key}: anchor "${hit.raw}" at y=${hit.y0} x=${hit.x0} -> right/below: ${cand} (inline: ${inline || "none"})`);
      /* eslint-enable no-console */
    }
    let pick = inline || (candidate && isPlausible(candidate.raw.replace(/[（）()]/g, "")) ? candidate.raw : "");
    if (def.key === "productName" && /^[（(][^（）()）)]{1,8}[）)]$/.test((candidate?.raw ?? "").trim()) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(candidate?.raw ?? "")) pick = "";
    if (def.key === "productName" && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(pick) && /[0-9０-９]/.test(pick)) pick = "";
    if (pick) rawValues[def.key] = pick;
    trace.push(
      `${def.key}: ${pick
        ? `OK -> ${pick}`
        : `(not found) hint="${hit.raw}"${inline ? ` inline="${inline}"` : ""}${candidate ? ` candidate="${candidate.raw}"` : ""}`}`,
    );
  }

  const page0Date = fallbackOrderDate(ranked);
  const orderDateLabel = rawValues.orderDate ? parseDateToken(rawValues.orderDate) : "";
  const orderDate = orderDateHitPage > 0 && page0Date ? page0Date : orderDateLabel || page0Date;
  const refYear = orderDate
    ? parseInt(orderDate.slice(0, 4), 10)
    : new Date().getFullYear();
  trace.push(`orderDate: ${orderDate || "(none)"}${orderDateHitPage > 0 && page0Date ? " (page0 date preferred)" : ""}`);
  trace.push(`deliveryDate: ${rawValues.deliveryDate ? parseDateToken(rawValues.deliveryDate, refYear) || "invalid" : "(none)"}`);
  const deliveryDate = rawValues.deliveryDate
    ? parseDateToken(rawValues.deliveryDate, refYear)
    : "";

  const orderNumber =
    cleanCode(rawValues.orderNumber ?? "", ["注文番号", "注文No", "注文NO"]) ||
    fallbackToken(ranked, /[A-Z]{1,3}\d{4,}|(?:^|[*\s])\d{5,}/);

  const clientInfo = findClient(ranked);

  let quantity = rawValues.quantity ? parseIntValue(rawValues.quantity) : 0;
  const unitPrice = rawValues.unitPrice ? parseNumber(rawValues.unitPrice) : 0;
  const orderAmount = rawValues.orderAmount ? parseNumber(rawValues.orderAmount) : 0;

  let productNumber = cleanCode(rawValues.productNumber ?? "", anchorKeywords(template, "productNumber"));
  if (!productNumber) {
    const drawingRe = /\b[A-Z]{2,5}-[A-Z]?\d{3,7}-\d{1,3}\b/;
    for (const l of ranked) {
      const m = l.raw.match(drawingRe);
      if (m) {
        productNumber = m[0];
        trace.push(`productNumber: drawing-number regex fallback -> ${productNumber}`);
        break;
      }
    }
  }

  const pickedName = cleanCode(rawValues.productName ?? "", anchorKeywords(template, "productName"));
  let productName = "";
  if (pickedName && !PROCESS_NAME_RE.test(pickedName)) {
    if (/^[（(][^（()）)]+[）)]$/.test(pickedName.trim())) {
      const pnCandidate = rawValues.productName ? ranked.find((l) => l.raw.includes(rawValues.productName!.trim())) : null;
      if (pnCandidate) {
        const rowBand = ranked.filter(
          (l) =>
            l !== pnCandidate &&
            Math.abs((l.y0 + l.y1) / 2 - (pnCandidate.y0 + pnCandidate.y1) / 2) < 60 &&
            l.x0 <= pnCandidate.x0 + 40 &&
            l.x1 >= pnCandidate.x0 - 40 &&
            /[\u3040-\u30ff\u4e00-\u9fff]/.test(l.raw) &&
            !PROCESS_NAME_RE.test(l.raw) &&
            !/[都道府県郡市町村区]/.test(l.raw) &&
            !/(株式会社|合同会社|有限会社|御中)/.test(l.raw),
        );
        if (rowBand.length) {
          productName = rowBand[0].raw + " " + pickedName;
          trace.push(`productName: joined CJK prefix "${rowBand[0].raw}" + suffix "${pickedName}" -> "${productName}"`);
        } else {
          productName = pickedName;
        }
      } else {
        productName = pickedName;
      }
    } else {
      productName = pickedName;
    }
  } else if (pickedName && PROCESS_NAME_RE.test(pickedName)) {
    trace.push(`productName: "${pickedName}" looks like a process step, not an item name -> dropped`);
  } else if (!productName) {
    const scanned = scanKnownProductName(ranked, opts?.knownProductNames ?? []);
    if (scanned) {
      productName = scanned.name;
      trace.push(`productName: master name "${scanned.name}" found anywhere on the form (reading "${scanned.hit.raw}") -> used directly`);
    }
  }

  const data = {
    orderDate,
    deliveryDate,
    client: clientInfo.name,
    orderNumber,
    productName,
    quantity,
    orderAmount,
    clientPhone: clientInfo.phone,
    clientAddress: clientInfo.address,
    clientPostalCode: clientInfo.postalCode,
    productNumber,
    unitPrice,
  };

  const fields = buildFields(template, data, rawValues);
  trace.push(`client: ${clientInfo.name || "(none)"}${clientInfo.phone ? ` / tel ${clientInfo.phone}` : ""}`);
  trace.push(`filled for the order form: orderDate=${data.orderDate} deliveryDate=${data.deliveryDate} client=${data.client} orderNumber=${data.orderNumber} productName=${data.productName} quantity=${data.quantity} orderAmount=${data.orderAmount}`);
  trace.push(`routing data: productNumber=${data.productNumber} unitPrice=${data.unitPrice} postal=${data.clientPostalCode} address=${data.clientAddress} phone=${data.clientPhone}`);
  return { template, title: templateLabel(template), data, fields, debug: trace.join("\n") };
}

function fallbackOrderDate(ranked: Ranked[]): string {
  const dates = ranked
    .filter((l) => /^\d{1,4}[\/年\-.]?\d{1,2}[\/月\-.]?\d{0,2}/.test(norm(l.raw)))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const d of dates) {
    const iso = parseDateToken(d.raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso) && d.y0 < 10000) return iso;
  }
  return "";
}

function fallbackToken(ranked: Ranked[], re: RegExp): string {
  for (const l of ranked) {
    const m = l.raw.match(re);
    if (m) return m[0].replace(/[*\s]/g, "");
  }
  return "";
}

function anchorKeywords(template: ScanTemplate, key: AnchorDef["key"]): string[] {
  const list = template === "purchase-order" ? PURCHASE_ORDER_ANCHORS : ORDER_SHEET_ANCHORS;
  return list.find((a) => a.key === key)?.keywords ?? [];
}

function scanKnownProductName(ranked: Ranked[], knownNames: string[]): { name: string; hit: Ranked } | null {
  const known = [...new Set((knownNames ?? []).map((n) => n.trim()).filter(Boolean))];
  known.sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const k of known) {
    if (PROCESS_NAME_RE.test(k)) continue;
    const hit = ranked.find((l) => l.nx.includes(norm(k)));
    if (hit) return { name: k, hit };
  }
  return null;
}

const CLIENT_CANON: { test: RegExp; name: string }[] = [
  { test: /伸和/, name: "伸和テクノス株式会社" },
  { test: /マスダ|マスタ|マス夕|マス入|マ又ダ|ますダ|ます夕|ます入|增田|増田|^\(?株\)?\s*マ/, name: "(株)マスダ シートメタル課" },
];

export function normalizeClientName(raw: string): string {
  let s = (raw || "").trim();
  s = s.replace(/[／\/]/g, "").replace(/\s+/g, " ");
  s = s.replace(/^[（(]株[）)]/, "株式会社");
  for (const c of CLIENT_CANON) if (c.test.test(s)) return c.name;
  return s.replace(/[／\/]$/, "").trim();
}

function findClient(ranked: Ranked[]) {
  const merged = mergeRows(ranked);
  const recipient = merged.find((l) => l.nx.includes("御中") || l.nx.includes("様"));
  const companies = merged.filter(
    (l) => /(株式会社|(?:\(|（)株|合同会社|有限会社)/.test(l.raw),
  );
  const basePage = companies.length ? Math.min(...companies.map((c) => c.page)) : 0;
  const ownPage = companies.filter((c) => c.page === basePage);
  const candidates = ownPage.filter(
    (c) => !recipient || lineDist(c, recipient) > 40,
  );

  let best: Ranked | null = null;
  let name = "";
  if (candidates.length) {
    let bestDist = Infinity;
    for (const c of candidates) {
      const addressDist = nearestDistance(merged, c, (l) => isAddressLine(l));
      const telDist = nearestDistance(merged, c, (l) => extractPhone(l.raw).length > 0);
      const postalDist = nearestDistance(merged, c, (l) => extractPostal(l.raw).length > 0);
      const score = Math.min(
        addressDist ?? 1e9,
        Math.min(telDist ?? 1e9, postalDist ?? 1e9),
      );
      if (score < bestDist) {
        bestDist = score;
        best = c;
      }
    }
    let rawName = best ? best.raw.replace(/[／\/]\s*$/g, "").trim() : "";
    if (rawName.length > 40) {
      rawName = (best?.raw.split(/\s+/)[0] ?? "").replace(/[／/]\s*$/g, "").trim();
    }
    name = normalizeClientName(rawName);
    if (name.length <= 4) {
      const whole = merged.map((l) => l.raw).join(" ");
      for (const c of CLIENT_CANON) {
        if (c.test.test(whole)) {
          name = c.name;
          break;
        }
      }
    }
  }

  let postalCode = "";
  let address = "";
  let phone = "";
  if (best) {
    const b = best;
    const nearest = (pred: (l: Ranked) => boolean) => {
      const samePage = ranked.filter((l) => l !== b && l.page === b.page && pred(l));
      const pool = samePage.length ? samePage : [];
      return pool.sort((a, p) => lineDist(b, a) - lineDist(b, p))[0];
    };

    const postalLine = nearest((l) => extractPostal(l.raw).length > 0);
    postalCode = postalLine ? extractPostal(postalLine.raw) : "";

    const addrLine = nearest((l) => isAddressLine(l));
    address = addrLine
      ? addrLine.raw
          .replace(/^[〒\s]*\d{3}-\d{4}\s*/, "")
          .replace(/^\d{7}$/, "")
          .trim()
      : "";

    const telLine = nearest((l) => extractPhone(l.raw).length > 0);
    phone = telLine ? extractPhone(telLine.raw) : "";
  } else {
    const postalLine = ranked.find((l) => extractPostal(l.raw).length > 0);
    postalCode = postalLine ? extractPostal(postalLine.raw) : "";

    const addrLine = ranked.find((l) => isAddressLine(l));
    address = addrLine
      ? addrLine.raw
          .replace(/^[〒\s]*\d{3}-\d{4}\s*/, "")
          .replace(/^\d{7}$/, "")
          .trim()
      : "";

    const telLine = ranked.find((l) => extractPhone(l.raw).length > 0);
    phone = telLine ? extractPhone(telLine.raw) : "";
  }

  return { name, phone, address, postalCode };
}

function isAddressLine(l: Ranked): boolean {
  return /^(?:〒\s*\d{3}-\d{4}\s*)?.*[都道府県郡市町村区]/.test(l.raw) && /\d/.test(l.raw);
}

function lineDist(a: Ranked, b: Ranked): number {
  return Math.abs(b.x0 - a.x0) + Math.abs(b.y0 - a.y0);
}

function nearestDistance(lines: Ranked[], anchor: Ranked, pred: (l: Ranked) => boolean): number | null {
  let best: number | null = null;
  for (const l of lines) {
    if (l === anchor || !pred(l)) continue;
    const d = lineDist(anchor, l);
    if (best === null || d < best) best = d;
  }
  return best;
}

const FIELD_SPEC = (data: ParsedQuotation["data"], rawValues: Record<string, string>) => [
  { label: "Order date", source: data.orderDate, target: "Order entry: order date", page: "P1" },
  { label: "Delivery date", source: data.deliveryDate, target: "Order entry: delivery date", page: "P1" },
  { label: "Client", source: data.client, target: "Order entry: client / Client master: name", page: "P1+P4" },
  { label: "Order no.", source: data.orderNumber, target: "Order entry: order number", page: "P1" },
  { label: "Drawing no.", source: data.productNumber, target: "Product master: product number", page: "P5" },
  { label: "Product name", source: data.productName, target: "Order entry: product name / Product master: name", page: "P1+P5" },
  { label: "Quantity", source: String(data.quantity), target: "Order entry: quantity", page: "P1" },
  { label: "Unit price", source: Number.isFinite(data.unitPrice) ? String(data.unitPrice) : rawValues.unitPrice ?? "", target: "Product master: unit price", page: "P5" },
  { label: "Total", source: Number.isFinite(data.orderAmount) ? String(data.orderAmount) : rawValues.orderAmount ?? "", target: "Order entry: order amount", page: "P1" },
  { label: "Postal code", source: data.clientPostalCode, target: "Client master: postal code", page: "P4" },
  { label: "Address", source: data.clientAddress, target: "Client master: address", page: "P4" },
  { label: "Phone", source: data.clientPhone, target: "Client master: phone number", page: "P4" },
];

function buildFields(template: ScanTemplate, data: ParsedQuotation["data"], rawValues: Record<string, string>) {
  return FIELD_SPEC(data, rawValues);
}

function templateLabel(template: ScanTemplate): string {
  switch (template) {
    case "purchase-order":
      return "Purchase order (発注書), Masuda style";
    case "order-sheet":
      return "Order sheet (注文書), Shinwa style";
    default:
      return "Scanned quotation";
  }
}