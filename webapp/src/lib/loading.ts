import { useEffect, useState } from "react";

let pendingRequests = 0;
const listeners = new Set<(active: boolean) => void>();

function publish() {
  const active = pendingRequests > 0;
  listeners.forEach(listener => listener(active));
}

export async function loadingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  pendingRequests += 1;
  publish();
  try {
    return await fetch(input, init);
  } finally {
    pendingRequests = Math.max(0, pendingRequests - 1);
    publish();
  }
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
