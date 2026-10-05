import { useEffect, useState } from "react";

export default function LoadingDialog({ active, lang, label }: {
  active: boolean;
  lang: "ja" | "en";
  label?: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 350);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!visible) return null;
  return (
    <div className="popup-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/35 p-4" role="presentation">
      <div role="status" aria-live="polite" className="popup-panel flex min-w-56 items-center gap-3 rounded-lg bg-white px-5 py-4 text-sm font-600 text-slate-700 shadow-xl">
        <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-[#0d7377]" />
        <span>{label ?? (lang === "ja" ? "処理中です。しばらくお待ちください…" : "Please wait, this is taking a moment…")}</span>
      </div>
    </div>
  );
}
