import { useState } from "react";
import { userError } from "../lib/resultCodes";
import { fetchAuditLogs, isUndoableAuditLog, undoAuditLog } from "../lib/operations";
import { Icon } from "./Icon";
import { useDialog } from "./AppDialog";

export default function UndoButton({ className = "", lang = "ja" }: { className?: string; lang?: "ja" | "en" }) {
  const [busy, setBusy] = useState(false);
  const dialog = useDialog();

  const undoLatest = async () => {
    setBusy(true);
    try {
      const logs = await fetchAuditLogs(100);
      const latest = logs.find(log =>
        !log.undoneAt
        && !String(log.metadata.source ?? "").startsWith("undo:")
        && ["insert", "update", "delete"].includes(log.action),
      );
      if (!latest) {
        await dialog.alert(lang === "ja" ? "元に戻せる操作はありません。" : "There is no activity to undo.");
        return;
      }
      if (!isUndoableAuditLog(latest)) {
        await dialog.alert(lang === "ja" ? "直前の操作はこの画面から元に戻せません。誤った変更を取り消さないよう、他の記録は変更していません。" : "The latest activity cannot be undone from this screen. No other records were changed.");
        return;
      }

      const action = latest.action === "insert" ? (lang === "ja" ? "登録" : "created") : latest.action === "update" ? (lang === "ja" ? "更新" : "updated") : (lang === "ja" ? "削除" : "deleted");
      const question = lang === "ja" ? `直前に${action}した記録を元に戻しますか？` : `Undo the record you just ${action}?`;
      if (!(await dialog.confirm(question, { tone: "danger" }))) return;

      await undoAuditLog(latest.id);
      await dialog.alert(lang === "ja" ? "操作を元に戻しました。" : "The activity was undone.");
      window.location.reload();
    } catch (error) {
      await dialog.alert(userError(error, lang));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Same wrapper as every other header control, so undo and the language
    // toggle paint one shared surface instead of each carrying its own
    // border, which is what made the old row look assembled rather than
    // designed.
    <div className={`header-control shrink-0 ${className}`}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void undoLatest()}
        title={lang === "ja" ? "直前の操作を元に戻す" : "Undo latest activity"}
        aria-label={lang === "ja" ? "直前の操作を元に戻す" : "Undo latest activity"}
      >
        <Icon name="undo" size={15} />
      </button>
    </div>
  );
}
