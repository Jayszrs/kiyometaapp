import { useState } from "react";

export default function HelpDialog({ title, description, lang, buttonClassName = "ml-2 inline-grid h-5 w-5 place-items-center rounded-full border border-slate-400 text-xs font-700 text-slate-600" }: {
  title: string;
  description: string;
  lang: "en" | "ja";
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const text = (en: string, ja: string) => lang === "ja" ? ja : en;
  return <>
    <button type="button" aria-label={text(`Help: ${title}`, `${title}のヘルプ`)} onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(true); }} className={buttonClassName}>?</button>
    {open && <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section className="w-full max-w-md overflow-hidden rounded-sm bg-white shadow-xl">
        <header className="bg-[#1a3458] px-5 py-4 text-white"><div className="flex items-start justify-between gap-3"><h2 className="font-700">{title}</h2><button type="button" onClick={() => setOpen(false)} aria-label={text("Close", "閉じる")} className="rounded px-2 text-xl leading-none text-white/80 hover:bg-white/10">×</button></div></header>
        <div className="p-5"><p className="text-sm leading-6 text-slate-700">{description}</p><button type="button" onClick={() => setOpen(false)} className="mt-5 min-h-11 rounded-sm bg-[#1a3458] px-4 py-2 text-sm font-700 text-white">OK</button></div>
      </section>
    </div>}
  </>;
}
