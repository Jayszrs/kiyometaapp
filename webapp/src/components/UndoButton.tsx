import { useState } from "react";
import { fetchAuditLogs, isUndoableAuditLog, undoAuditLog } from "../lib/operations";

interface Props {
  className?: string;
  label?: string;
}

export default function UndoButton({ className = "", label = "Undo" }: Props) {
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
    <button
      type="button"
      disabled={busy}
      onClick={() => void undoLatest()}
      title="Undo latest activity"
      className={`flex shrink-0 items-center justify-center gap-1.5 rounded border border-white/25 bg-white/10 px-2.5 py-1.5 text-xs font-700 text-white transition-colors hover:bg-white/20 disabled:cursor-wait disabled:opacity-50 ${className}`}
    >
      <span aria-hidden="true" className="text-base leading-none">↶</span>
      <span className="hidden sm:inline">{busy ? "Undoing..." : label}</span>
    </button>
  );
}
