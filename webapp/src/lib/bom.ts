import type { BomItem } from "./operations";

export interface BomTreeRow {
  row: BomItem;
  depth: number;
  requiredQuantity: number;
}

export interface BomSummaryRow {
  inventoryItemId: string;
  requiredQuantity: number;
}

export interface LinkableProduct {
  id: string;
  productName: string;
  productNumber: string;
}

export interface LinkableInventoryItem {
  id: string;
  itemCode: string;
  itemName: string;
  category: string;
  procurementType: string;
  active?: boolean;
}

function normalizedIdentity(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function wouldCreateProductCycle(rows: readonly BomItem[], parentProductId: string, componentProductId: string): boolean {
  if (!parentProductId || !componentProductId || parentProductId === componentProductId) return true;
  const childrenByProduct = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.componentProductId) continue;
    const children = childrenByProduct.get(row.productId) ?? [];
    children.push(row.componentProductId);
    childrenByProduct.set(row.productId, children);
  }
  const pending = [componentProductId];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === parentProductId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(childrenByProduct.get(current) ?? []));
  }
  return false;
}

export function compatibleSubassemblyProducts(
  rows: readonly BomItem[],
  products: readonly LinkableProduct[],
  items: readonly LinkableInventoryItem[],
  parentProductId: string,
  inventoryItemId: string,
): LinkableProduct[] {
  const item = items.find(candidate => candidate.id === inventoryItemId);
  if (!item || item.active === false || !["component", "finished_good"].includes(item.category) || item.procurementType !== "make") return [];

  const itemCode = normalizedIdentity(item.itemCode);
  const codeMatches = products.filter(product => normalizedIdentity(product.productNumber) === itemCode);
  const productMatches = codeMatches.length
    ? codeMatches
    : products.filter(product => normalizedIdentity(product.productName) === normalizedIdentity(item.itemName));
  // A stock part must resolve to exactly one product master record. Ambiguous
  // names/codes are not guessed; the master data needs an explicit correction.
  if (productMatches.length !== 1) return [];
  const component = productMatches[0];
  return component.id !== parentProductId && !wouldCreateProductCycle(rows, parentProductId, component.id)
    ? [component]
    : [];
}

function branchKey(productId: string, parentBomNo: string): string {
  return `${productId}\u0000${parentBomNo}`;
}

function groupBranches(rows: readonly BomItem[]): Map<string, BomItem[]> {
  const grouped = new Map<string, BomItem[]>();
  for (const row of rows) {
    const key = branchKey(row.productId, row.parentBomNo);
    const branch = grouped.get(key);
    if (branch) branch.push(row); else grouped.set(key, [row]);
  }
  return grouped;
}

export function buildBomTree(rows: readonly BomItem[], productId: string): BomTreeRow[] {
  const branches = groupBranches(rows);
  const result: BomTreeRow[] = [];

  const walkProduct = (currentProductId: string, multiplier: number, depth: number, productsInPath: ReadonlySet<string>) => {
    if (productsInPath.has(currentProductId)) return;
    const nextPath = new Set(productsInPath).add(currentProductId);
    walkBranch(currentProductId, "", multiplier, depth, nextPath);
  };
  const walkBranch = (currentProductId: string, parentBomNo: string, multiplier: number, depth: number, productsInPath: ReadonlySet<string>) => {
    for (const row of branches.get(branchKey(currentProductId, parentBomNo)) ?? []) {
      const requiredQuantity = multiplier * row.quantityPerUnit;
      result.push({ row, depth, requiredQuantity });
      walkBranch(currentProductId, row.bomNo, requiredQuantity, depth + 1, productsInPath);
      if (row.componentProductId) walkProduct(row.componentProductId, requiredQuantity, depth + 1, productsInPath);
    }
  };

  walkProduct(productId, 1, 0, new Set());
  return result;
}

export function summarizeBom(rows: readonly BomItem[], productId: string): BomSummaryRow[] {
  const branches = groupBranches(rows);
  const totals = new Map<string, number>();

  const walkProduct = (currentProductId: string, multiplier: number, productsInPath: ReadonlySet<string>) => {
    if (productsInPath.has(currentProductId)) return;
    const nextPath = new Set(productsInPath).add(currentProductId);
    walkBranch(currentProductId, "", multiplier, nextPath);
  };
  const walkBranch = (currentProductId: string, parentBomNo: string, multiplier: number, productsInPath: ReadonlySet<string>) => {
    for (const row of branches.get(branchKey(currentProductId, parentBomNo)) ?? []) {
      const requiredQuantity = multiplier * row.quantityPerUnit;
      const nestedRows = branches.get(branchKey(currentProductId, row.bomNo)) ?? [];
      const linkedRows = row.componentProductId
        ? branches.get(branchKey(row.componentProductId, "")) ?? []
        : [];
      if (nestedRows.length > 0) walkBranch(currentProductId, row.bomNo, requiredQuantity, productsInPath);
      if (row.componentProductId && linkedRows.length > 0) walkProduct(row.componentProductId, requiredQuantity, productsInPath);
      if (nestedRows.length === 0 && linkedRows.length === 0) {
        totals.set(row.inventoryItemId, (totals.get(row.inventoryItemId) ?? 0) + requiredQuantity);
      }
    }
  };

  walkProduct(productId, 1, new Set());
  return Array.from(totals, ([inventoryItemId, requiredQuantity]) => ({ inventoryItemId, requiredQuantity }));
}
