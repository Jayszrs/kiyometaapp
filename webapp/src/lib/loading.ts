import { useEffect, useState } from "react";

// Every long-running operation funnels through this one counter, so the single
// popup in components/LoadingDialog can stand in for all of them: network
// traffic wrapped by loadingFetch, plus component-level scopes registered with
// useLoadingScope (lazy route chunks, the session boot check).
let pendingRequests = 0;
const listeners = new Set<(active: boolean) => void>();

function publish() {
  const active = pendingRequests > 0;
  listeners.forEach(listener => listener(active));
}

export function beginLoading() {
  pendingRequests += 1;
  publish();
}

export function endLoading() {
  pendingRequests = Math.max(0, pendingRequests - 1);
  publish();
}

export async function loadingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const background = url.includes("/rpc/submit_order_once");
  const controller = new AbortController();
  const callerSignal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
  const cancel = () => controller.abort();
  callerSignal?.addEventListener("abort", cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  const timer = window.setTimeout(cancel, 20000);
  if (!background) beginLoading();
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", cancel);
    if (!background) endLoading();
  }
}

// Registers a non-network unit of work against the same counter. Lets a screen
// that isn't a fetch (a lazy route chunk, the auth boot check) drive the shared
// popup instead of painting its own "loading…" text.
export function useLoadingScope(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    beginLoading();
    return endLoading;
  }, [active]);
}

export function useGlobalLoading(): boolean {
  const [active, setActive] = useState(pendingRequests > 0);
  useEffect(() => {
    listeners.add(setActive);
    setActive(pendingRequests > 0);
    return () => { listeners.delete(setActive); };
  }, []);
  return active;
}
