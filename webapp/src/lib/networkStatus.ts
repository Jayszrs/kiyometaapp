export const NETWORK_STATUS_EVENT = "kiyometa-network-status";

export function isConnectivityError(error: unknown): boolean {
  if (!navigator.onLine) return true;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  return /failed to fetch|network ?error|network request failed|fetch failed|load failed|timeout|timed out|aborted|offline|err_internet|err_name_not_resolved|dns/i.test(message);
}

export function reportConnectivityError(error: unknown): void {
  if (!isConnectivityError(error)) return;
  window.dispatchEvent(new CustomEvent(NETWORK_STATUS_EVENT, { detail: { online: false } }));
}

