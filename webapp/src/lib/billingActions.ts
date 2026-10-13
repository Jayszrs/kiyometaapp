import { useRef, useState } from "react";
import { beginLoading, endLoading } from "./loading";
import { capturePrintableHtml, hasNativeBridge, printNative } from "./nativeBridge";

export function isAndroidWebView(): boolean {
  return /Android/i.test(navigator.userAgent) && /; wv\)|\bwv\b/i.test(navigator.userAgent);
}

export function useBillingAction(onError?: (error: unknown) => void) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => void | Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); beginLoading();
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await work();
    } catch (error) { console.error("Billing action failed", error); onError?.(error); } finally { lock.current = false; setBusy(false); endLoading(); }
  };
  return { busy, run, isBusy: () => lock.current };
}

export async function printBillingDocument(lang: "ja" | "en", alert: (message: string) => unknown) {
  // Inside the Android app the Flutter host prints through the Android print
  // service; hand it a snapshot of the current (print-styled) page instead of
  // relying on window.print(), which the WebView ignores.
  if (hasNativeBridge()) {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 8000))]);
    printNative(capturePrintableHtml(), document.title || "Kiyometa");
    return;
  }
  if (isAndroidWebView()) {
    void alert(lang === "ja" ? "このAndroidアプリはまだ印刷に対応していません。同じ画面をChromeで開いて印刷してください。" : "Printing is not connected in this Android app yet. Open the same page in Chrome to print.");
    return;
  }
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 8000))]);
  window.print();
}
