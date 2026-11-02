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
