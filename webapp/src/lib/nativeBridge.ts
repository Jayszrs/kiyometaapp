// Bridge to the native capabilities of the Kiyometa Android app. The Flutter
// host injects a `KiyometaAndroid` JavaScript channel. When it is present we
// hand exports and print jobs to the operating system, because the embedded
// WebView cannot perform blob: downloads nor window.print() on its own.

interface KiyometaAndroidChannel {
  postMessage(message: string): void;
}

declare global {
  interface Window {
    KiyometaAndroid?: KiyometaAndroidChannel;
  }
}

export function hasNativeBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.KiyometaAndroid?.postMessage === "function"
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function saveFileNative(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): boolean {
  if (!hasNativeBridge()) return false;
  window.KiyometaAndroid!.postMessage(
    JSON.stringify({
      action: "download",
      fileName,
      mimeType,
      base64: toBase64(bytes),
    }),
  );
  return true;
}

export function printNative(html: string, jobName: string): boolean {
  if (!hasNativeBridge()) return false;
  window.KiyometaAndroid!.postMessage(
    JSON.stringify({
      action: "print",
      html,
      jobName,
      baseUrl: window.location.origin + "/",
    }),
  );
  return true;
}

// Snapshot of the current page for printing. Script tags are stripped so the
// offscreen print WebView does not boot the app a second time.
export function capturePrintableHtml(): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script").forEach(node => node.remove());
  return "<!doctype html>" + clone.outerHTML;
}
