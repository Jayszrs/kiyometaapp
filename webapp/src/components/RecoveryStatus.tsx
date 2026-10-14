import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { useDialog } from "./AppDialog";
import { pendingOrders, syncOrders, discardSubmission, retryReviewedSubmission, type PendingOrder } from "../lib/orderOutbox";
import { fetchOrdersByIds } from "../lib/db";
import type { Lang, OrderRecord } from "../App";
import { getOcrRecovery } from "../lib/ocrClient";

export default function RecoveryStatus({ lang, onOpenScan }: { lang: Lang; onOpenScan: () => void }) {
  const { profile } = useAuth();
  const dialog = useDialog();
  const [online, setOnline] = useState(navigator.onLine);
  const [items, setItems] = useState(() => pendingOrders(profile.id));
  const [expanded, setExpanded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(() => getOcrRecovery(profile.id));
  const text = (en: string, ja: string) => lang === "ja" ? ja : en;
  useEffect(() => {
    let active = true;
    const update = () => setItems(pendingOrders(profile.id));
    const resume = () => { if (!active) return; setOnline(navigator.onLine); void syncOrders(profile.id); };
    const failedStorage = () => setStorageError(true);
    const updateScan = () => setScan(getOcrRecovery(profile.id));
    window.addEventListener("kiyometa-outbox", update);
    window.addEventListener("kiyometa-storage-error", failedStorage);
    window.addEventListener("kiyometa-ocr-recovery", updateScan);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("kiyometa-resume", resume);
    const timer = window.setInterval(resume, 30000);
    resume();
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("kiyometa-outbox", update);
      window.removeEventListener("kiyometa-storage-error", failedStorage);
      window.removeEventListener("kiyometa-ocr-recovery", updateScan);
      for (const name of ["online", "offline", "focus", "kiyometa-resume"]) window.removeEventListener(name, resume);
    };
  }, [profile.id]);

  const review = async (item: PendingOrder) => {
    setBusy(true);
    try {
      const [latest] = await fetchOrdersByIds([item.order.id]);
      if (!latest) { await dialog.alert(text("This order no longer exists. Its draft remains on this device. Remove this pending submission, then review the draft before creating a new order.", "受注が見つかりません。下書きは端末に残っています。保留を削除し、下書きを確認して新規登録してください。")); return; }
      const ignored = new Set(["id", "version", "materialsIssued", "preparationPrintStatus", "preparationPrintedAt"]);
      const changes = (Object.keys(item.order) as (keyof OrderRecord)[])
        .filter(key => !ignored.has(key) && JSON.stringify(item.order[key]) !== JSON.stringify(latest[key]))
        .map(key => `${key}: ${JSON.stringify(latest[key])} → ${JSON.stringify(item.order[key])}`).join("\n");
      const confirmed = await dialog.confirm(`${item.message ?? ""}\n\n${text("Server → your submitted values:", "サーバー → 送信する値:")}\n${changes || text("Fields match. Retry saving their status.", "値は一致しています。保存を再試行します。")}`, {
        confirmLabel: text("Apply reviewed values", "確認した値を送信"), cancelLabel: text("Keep pending", "保留を維持"),
      });
      if (!confirmed) return;
      await retryReviewedSubmission(profile.id, item.requestId, { ...item.order, version: latest.version });
    } catch (error) { await dialog.alert(error instanceof Error ? error.message : text("Could not retry. Your draft is retained.", "再試行できません。下書きは保持されています。")); }
    finally { setBusy(false); }
  };
  if (online && !items.length && !storageError && !scan) return null;
  return <aside className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 print:hidden" aria-label={text("Connection and pending submissions", "接続と保留中の送信")}>
    <div className="flex flex-wrap items-center justify-between gap-2" role="status">
      <span>{storageError ? text("Device storage unavailable. Keep the app open; drafts cannot survive closing.", "端末に保存できません。下書きを保持するためアプリを閉じないでください。")
        : !online ? text("Offline · drafts stay on this device. Submitted orders sync when connected.", "オフライン · 下書きは端末に保存されます。送信した受注は再接続後に同期します。")
        : items.length ? text(`${items.length} pending submission(s) · not confirmed saved yet`, `未確認の送信 ${items.length}件`)
        : scan?.lines ? text("OCR result ready", "OCR結果を取得しました")
        : scan?.id ? text("OCR continues on the server", "サーバーでOCR処理中") : text("OCR source saved · upload can resume", "OCR画像を保存しました · アップロードを再開できます")}</span>
      {!!scan && <button onClick={onOpenScan} className="rounded border border-amber-400 px-3 py-1 font-600">{text("Open scan", "スキャンを開く")}</button>}
      {!!items.length && <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="rounded border border-amber-400 px-3 py-1 font-600">{text("Pending submissions", "保留中の送信")}</button>}
    </div>
    {expanded && <ul className="mt-2 max-h-44 space-y-2 overflow-y-auto">
      {items.map(item => <li key={item.requestId} className="flex flex-wrap items-center gap-2 border-t border-amber-200 pt-2">
        <span className="min-w-0 flex-1 break-words">{item.order.orderNumber || item.order.productName} · {item.state === "blocked" ? item.message : text("Waiting to sync", "同期待ち")}</span>
        {item.state === "blocked" ? <>
          <button disabled={busy || !online} onClick={() => void review(item)} className="rounded border border-amber-400 px-3 py-1 font-600 disabled:opacity-50">{text("Review and retry", "確認して再送信")}</button>
          <button disabled={busy} onClick={async () => { if (await dialog.confirm(text("Remove this pending submission? Draft fields will remain on this device.", "保留中の送信を削除しますか？下書きは端末に残ります。"))) discardSubmission(profile.id, item.requestId); }} className="rounded border border-amber-400 px-3 py-1 disabled:opacity-50">{text("Remove pending", "保留を削除")}</button>
        </> : <button disabled={busy || !online} onClick={() => void syncOrders(profile.id)} className="rounded border border-amber-400 px-3 py-1 font-600 disabled:opacity-50">{text("Sync now", "今すぐ同期")}</button>}
      </li>)}
    </ul>}
  </aside>;
}
