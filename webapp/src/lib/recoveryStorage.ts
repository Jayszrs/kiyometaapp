// Account-scoped storage. Writes happen before a request or React render, so
// abrupt WebView termination cannot leave a submitted action only in memory.
export const recoveryKey = (owner: string, slot: string) => `kiyometa.recovery.v1:${owner}:${slot}`;
export function readRecovery<T>(owner: string, slot: string): T | undefined {
  if (!owner) return undefined;
  try {
    const raw = localStorage.getItem(recoveryKey(owner, slot));
    return raw ? JSON.parse(raw) as T : undefined;
  } catch { return undefined; }
}
export function writeRecovery(owner: string, slot: string, value: unknown): void {
  if (!owner) throw new Error("Sign in before saving work on this device.");
  try {
    localStorage.setItem(recoveryKey(owner, slot), JSON.stringify(value));
    if (slot === "ocr-job") window.dispatchEvent(new Event("kiyometa-ocr-recovery"));
  } catch {
    window.dispatchEvent(new Event("kiyometa-storage-error"));
    throw new Error("Device storage is full or unavailable. Work could not be saved on this device.");
  }
}
export function removeRecovery(owner: string, slot: string): void {
  localStorage.removeItem(recoveryKey(owner, slot));
  if (slot === "ocr-job") window.dispatchEvent(new Event("kiyometa-ocr-recovery"));
}
