import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Lang } from "../App";

export interface DialogOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

interface DialogApi {
  confirm: (message: ReactNode, options?: DialogOptions) => Promise<boolean>;
  alert: (message: ReactNode, options?: DialogOptions) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogContext);
  if (!api) throw new Error("useDialog must be used within DialogProvider");
  return api;
}

type Pending =
  | { kind: "confirm"; message: ReactNode; options: DialogOptions; resolve: (value: boolean) => void }
  | { kind: "alert"; message: ReactNode; options: DialogOptions; resolve: (value: boolean) => void };

export function DialogProvider({ lang = "ja", children }: { lang?: Lang; children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback((message: ReactNode, options: DialogOptions = {}) =>
    new Promise<boolean>(resolve => setPending({ kind: "confirm", message, options, resolve })), []);
  const alert = useCallback((message: ReactNode, options: DialogOptions = {}) =>
    new Promise<void>(resolve => setPending({ kind: "alert", message, options, resolve: () => resolve() })), []);

  const settle = useCallback((value: boolean) => {
    setPending(current => { current?.resolve(value); return null; });
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (pending.kind === "confirm" && pending.options.tone === "danger") cancelRef.current?.focus();
    else confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); settle(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  const isJa = lang === "ja";
  const tone = pending?.options.tone ?? "default";
  const confirmLabel = pending?.options.confirmLabel ?? "OK";
  const cancelLabel = pending?.options.cancelLabel ?? (isJa ? "キャンセル" : "Cancel");

  return (
    <DialogContext.Provider value={{ confirm, alert }}>
      {children}
      {pending && (
        <div
          className="popup-backdrop fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={pending.options.title ? "app-dialog-title" : undefined}
          onMouseDown={event => { if (event.target === event.currentTarget) settle(false); }}
        >
          <div className="popup-panel w-full max-w-md rounded-sm border border-slate-200 bg-white p-5 shadow-2xl">
            {pending.options.title && (
              <h2 id="app-dialog-title" className="text-base font-700 text-[#1a3458]">{pending.options.title}</h2>
            )}
            <div className={`text-sm leading-6 text-slate-600 whitespace-pre-line ${pending.options.title ? "mt-2" : ""}`}>
              {pending.message}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              {pending.kind === "confirm" && (
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={() => settle(false)}
                  className="rounded-sm border border-slate-300 bg-white px-4 py-2 text-sm font-600 text-slate-700 hover:bg-slate-50"
                >
                  {cancelLabel}
                </button>
              )}
              <button
                ref={confirmRef}
                type="button"
                onClick={() => settle(true)}
                className={`rounded-sm px-4 py-2 text-sm font-700 text-white ${tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-[#1a3458] hover:bg-[#112240]"}`}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
