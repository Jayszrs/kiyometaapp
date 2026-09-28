// Order status is a state machine, not a free-text list.
//
// The database enforces the same rules (enforce_order_progress_transition in
// migration 011) because the browser is not a trust boundary. This module is
// the shared vocabulary: the UI uses it to offer only legal next states and to
// explain a rejection, so a refused save reads as a business rule rather than
// as a database error.
//
//   Order request -> Receipt -> In preparation -> Preparation complete
//                -> In production -> Complete -> Shipped
//
// Cancelled is reachable from any state before Shipped, is terminal, and
// reverses the order's material consumption exactly once. Shipped is terminal.
// Moving backwards is only allowed while nothing has been issued for the order,
// because a backward move posts a material reversal and reversing a completed
// order would return stock the customer already received.

export const PROGRESS_ORDER = [
  "Order request",
  "Receipt",
  "In preparation",
  "Preparation complete",
  "In production",
  "Complete",
  "Shipped",
] as const;

export const PROGRESS_CANCELLED = "Cancelled";

export type Progress = (typeof PROGRESS_ORDER)[number] | typeof PROGRESS_CANCELLED;

const RANK: Record<string, number> = {
  "Order request": 1,
  Receipt: 2,
  "In preparation": 3,
  "Preparation complete": 4,
  "In production": 5,
  Complete: 6,
  Shipped: 7,
  Cancelled: 0,
};

export function isProgress(value: string): value is Progress {
  return Object.prototype.hasOwnProperty.call(RANK, value);
}

// True when the order has ever been in a state that consumes materials, which
// is what makes a backward move unsafe. Mirrors inventory_stock_applied.
export function consumesMaterials(progress: string): boolean {
  return (RANK[progress] ?? 0) >= RANK["In production"];
}

// Forward jumps are legal. A two-person shop can finish a small order without
// anyone ticking each box in turn, and the database trigger agrees: it only
// constrains terminal states, cancellation, Complete, and backward moves. This
// module must not be stricter than the trigger, or the select would offer a
// move the save then refuses.
//
// Backward moves are the exception. Reverting progress makes the BOM trigger
// post a material reversal, so the rule is: once materials have been issued
// for this order, a backward move is refused and the order must be cancelled
// instead. Before that, reopening an order is a normal correction.
export function canTransition(from: string, to: string, materialsIssued: boolean): boolean {
  if (from === to) return true;
  if (from === "Shipped" || from === PROGRESS_CANCELLED) return false;
  if (to === PROGRESS_CANCELLED) return true;
  if (from === "Complete" && to !== "Shipped") return false;
  if ((RANK[to] ?? -1) < (RANK[from] ?? 0) && materialsIssued) return false;
  return true;
}

// The states a select should offer for the given order. Keeping the current
// value first means a form that has not changed its status still shows it, and
// every other entry is a legal move, so a blocked transition cannot be picked
// in the first place.
export function allowedTransitions(current: string, materialsIssued: boolean): string[] {
  return [current, ...PROGRESS_ORDER, PROGRESS_CANCELLED].filter(
    (value, index, all) => all.indexOf(value) === index && canTransition(current, value, materialsIssued),
  );
}

export function transitionRejection(from: string, to: string, materialsIssued: boolean): string | null {
  if (canTransition(from, to, materialsIssued)) return null;
  if (from === "Shipped") return `Order ${from} has shipped and can no longer be reopened.`;
  if (from === PROGRESS_CANCELLED) return `Order is ${from} and can no longer change status.`;
  if (from === "Complete" && to !== "Shipped") return "A completed order can only move to Shipped or Cancelled.";
  return `Cannot move back from ${from} to ${to} because materials have already been issued. Cancel the order instead.`;
}
