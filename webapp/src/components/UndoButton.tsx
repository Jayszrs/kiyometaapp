import { useState } from "react";
import { fetchAuditLogs, isUndoableAuditLog, undoAuditLog } from "../lib/operations";
import { Icon } from "./Icon";

export default function UndoButton({ className = "" }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  const undoLatest = async () => {
    setBusy(true);
    try {
      const logs = await fetchAuditLogs(100);
      const latest = logs.find(isUndoableAuditLog);
      if (!latest) {
        alert("No activity is currently available to undo.");
        return;
      }

      const activity = `${latest.action} ${latest.entity.replace(/_/g, " ")}`;
      if (!confirm(`Undo your latest activity: ${activity}?`)) return;

      await undoAuditLog(latest.id);
      alert("The activity was undone successfully.");
      window.location.reload();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Undo failed.");
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
        title="Undo latest activity"
        aria-label="Undo latest activity"
      >
        <Icon name="undo" size={15} />
      </button>
    </div>
  );
}
