import { useEffect, useState } from "react";
import { useGlobalLoading, useLoadingScope } from "../lib/loading";

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
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex justify-end px-3" role="presentation">
      <div role="status" aria-live="polite" className="popup-panel flex min-w-56 items-center gap-3 rounded border border-slate-200 bg-white/95 px-4 py-2.5 text-sm font-600 text-slate-700 shadow-md backdrop-blur-sm">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-[#0d7377]" />
        <span>{label ?? (lang === "ja" ? "処理中です。しばらくお待ちください…" : "Please wait, this is taking a moment…")}</span>
      </div>
    </div>
  );
}

export function GlobalLoadingDialog() {
  const active = useGlobalLoading();
  const lang = localStorage.getItem("kiyometa-language") === "en" ? "en" : "ja";
  return <LoadingDialog active={active} lang={lang} />;
}

// Drop-in replacement for the old ad-hoc full-page loaders ("Loading module…",
// the blank auth boot screen). It paints the neutral app background and
// registers itself as a loading scope, so the delayed, non-blocking progress
// notice also appears during module (lazy route) loads and the session check.
export function PageLoading({ page = "home", lang: requestedLang }: { page?: string; lang?: "ja" | "en" } = {}) {
  useLoadingScope(true);
  const lang = requestedLang ?? (localStorage.getItem("kiyometa-language") === "en" ? "en" : "ja");
  const labels: Record<string, [string, string]> = {
    home: ["ホーム", "Home"], "order-entry": ["受注登録", "Order entry"],
    "search-billing": ["受注検索・請求", "Search & billing"], invoice: ["請求書", "Invoice"],
    "client-master": ["取引先マスター", "Client master"], "product-master": ["製品マスター", "Product master"],
    "delivery-slip": ["納品書", "Delivery slip"], schedule: ["カレンダー", "Calendar"],
    "production-progress": ["製作工程進捗", "Production progress"], checklist: ["工程チェックリスト", "Process checklist"],
    inventory: ["在庫・購買", "Inventory & purchasing"], management: ["権限管理・操作履歴", "Role management & audit"], profile: ["プロフィール", "Profile"],
  };
  const title = labels[page]?.[lang === "ja" ? 0 : 1] ?? labels.home[lang === "ja" ? 0 : 1];
  const isCalendar = page === "schedule";
  const isDashboard = page === "home";
  const isDocument = page === "invoice" || page === "delivery-slip";
  return <main role="status" aria-live="polite" className="flex h-full min-h-48 w-full flex-col bg-[#f5f6f8]">
    <header className="flex h-14 shrink-0 items-center gap-3 bg-[#1a3458] px-4 text-white">
      <span className="h-8 w-8 rounded bg-white/15" />
      <span className="text-sm font-600">Kiyometa Order Management</span>
      <span className="ml-auto h-8 w-20 rounded bg-white/10" />
    </header>
    <section className="flex-1 overflow-hidden p-4 sm:p-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-4 flex min-h-12 items-center justify-between gap-4">
          <div><h1 className="font-700 text-[#1a3458]">{title}</h1><div className="skeleton-block mt-2 h-3 w-52" /></div>
          <span className="skeleton-block hidden h-10 w-28 sm:block" />
        </div>
        {isCalendar ? <div className="overflow-hidden rounded border border-slate-200 bg-white p-4"><div className="mb-4 flex items-center justify-between"><div className="skeleton-block h-8 w-40" /><div className="flex gap-2"><div className="skeleton-block h-9 w-20" /><div className="skeleton-block h-9 w-20" /></div></div><div className="grid grid-cols-7 gap-px overflow-hidden rounded bg-slate-200">{Array.from({ length: 35 }, (_, cell) => <div key={cell} className="min-h-16 bg-white p-2 sm:min-h-24"><div className="skeleton-block h-3 w-6" />{cell % 3 === 0 && <div className="skeleton-block mt-3 h-5 w-full" />}</div>)}</div></div>
          : isDashboard ? <><div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{[0, 1, 2, 3].map(card => <div key={card} className="rounded border border-slate-200 bg-white p-4"><div className="skeleton-block h-3 w-3/5" /><div className="skeleton-block mt-3 h-7 w-1/3" /></div>)}</div><div className="grid gap-4 lg:grid-cols-2">{[0, 1].map(card => <div key={card} className="min-h-48 rounded border border-slate-200 bg-white p-5"><div className="skeleton-block h-4 w-2/5" /><div className="mt-5 space-y-4">{[0, 1, 2].map(row => <div key={row} className="flex gap-3"><div className="skeleton-block h-4 flex-1" /><div className="skeleton-block h-4 w-16" /></div>)}</div></div>)}</div></>
          : isDocument ? <div className="mx-auto min-h-[30rem] max-w-4xl rounded border border-slate-200 bg-white p-6 shadow-sm sm:p-10"><div className="skeleton-block mx-auto h-6 w-40" /><div className="mt-8 grid gap-4 sm:grid-cols-2"><div className="space-y-3"><div className="skeleton-block h-4 w-3/4" /><div className="skeleton-block h-3 w-full" /><div className="skeleton-block h-3 w-4/5" /></div><div className="skeleton-block h-24 rounded" /></div><div className="mt-8 space-y-2">{Array.from({ length: 8 }, (_, row) => <div key={row} className="flex gap-3 border-b border-slate-100 py-3"><div className="skeleton-block h-4 flex-1" /><div className="skeleton-block h-4 w-20" /><div className="skeleton-block h-4 w-16" /></div>)}</div></div>
          : <div className="grid gap-4 lg:grid-cols-[minmax(15rem,22rem)_1fr]">
            <div className="skeleton-card min-h-56 rounded border border-slate-200 bg-white p-5">
              <div className="skeleton-block h-4 w-2/5" /><div className="skeleton-block mt-4 h-10 w-full" />
              <div className="skeleton-block mt-3 h-10 w-full" /><div className="skeleton-block mt-3 h-10 w-4/5" />
              <div className="skeleton-block mt-6 h-9 w-28" />
            </div>
            <div className="skeleton-card min-h-56 overflow-hidden rounded border border-slate-200 bg-white">
              <div className="border-b border-slate-200 p-5"><div className="skeleton-block h-4 w-1/3" /><div className="skeleton-block mt-2 h-3 w-1/4" /></div>
              <div className="space-y-4 p-5">{[0, 1, 2, 3].map(row => <div key={row} className="flex items-center gap-4"><div className="skeleton-block h-3 flex-1" /><div className="skeleton-block h-3 w-20" /><div className="skeleton-block h-8 w-20" /></div>)}</div>
            </div>
          </div>}
        <p className="mt-4 text-center text-xs text-slate-500">{lang === "ja" ? "データを読み込んでいます…" : "Loading data…"}</p>
      </div>
    </section>
  </main>;
}
