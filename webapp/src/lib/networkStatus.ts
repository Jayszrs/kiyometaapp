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

export function friendlyNetworkMessage(error: unknown, lang: "ja" | "en"): string {
  if (isConnectivityError(error)) {
    reportConnectivityError(error);
    return lang === "ja"
      ? "ネットワークに接続できないため、この操作を完了できません。接続を確認して再試行してください。"
      : "This could not be completed because the network is unavailable. Check the connection and try again.";
  }
  return error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
}

