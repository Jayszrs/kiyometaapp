import { userError } from "./resultCodes";
export const NETWORK_STATUS_EVENT = "kiyometa-network-status";
export const NETWORK_RESTORED_EVENT = "kiyometa-network-restored";

export function isConnectivityError(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error && String((error as { name?: unknown }).name) === "AbortError") return false;
  if (error && typeof error === "object" && "rc" in error) {
    const rc = String((error as { rc?: unknown }).rc ?? "");
    if (rc && !rc.startsWith("NET-")) return false;
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
  if (/127\.0\.0\.1:8787|localhost:8787/i.test(message)) return false;
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (typeof kind === "string" && ["service", "busy", "unreadable", "size", "auth"].includes(kind)) return false;
  return /failed to fetch|network ?error|network request failed|fetch failed|load failed|timeout|timed out|aborted|offline|err_internet|err_name_not_resolved|dns/i.test(message);
}

export function reportConnectivityError(error: unknown): void {
  if (!isConnectivityError(error)) return;
  const online = typeof navigator !== "undefined" && navigator.onLine;
  window.dispatchEvent(new CustomEvent(NETWORK_STATUS_EVENT, { detail: { state: online ? "service" : "offline" } }));
}

export function reportConnectivityRestored(): void {
  window.dispatchEvent(new Event(NETWORK_RESTORED_EVENT));
}

export function friendlyNetworkMessage(error: unknown, lang: "ja" | "en"): string {
  if (isConnectivityError(error)) {
    reportConnectivityError(error);
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    if (lang === "ja") return offline
      ? "オフラインです。接続して再試行してください。"
      : "サービスに接続できません。接続を確認して再試行してください。";
    return offline
      ? "You are offline. Reconnect and try again."
      : "Kiyometa could not reach a service. Check your connection or try again shortly.";
  }
  return userError(error, lang);
}

