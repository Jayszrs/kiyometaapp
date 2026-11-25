const knownCodes = new Set(["VAL-001", "VAL-002", "DATA-001", "DATA-002", "BIZ-001", "BIZ-002", "CON-001", "AUTH-001", "AUTH-002", "NET-001", "NET-002", "NET-003", "TXN-001", "SVC-001", "SVC-002", "FILE-001", "FILE-002", "FILE-003", "OCR-001", "OCR-002", "LOCAL-001", "CANCEL-001", "UNDO-001", "SYS-001"]);

export class AppError extends Error {
  constructor(public readonly rc: string) { super(rc); this.name = "AppError"; }
}

export function resultCode(error: unknown, status = 0): string {
  const value = error as { code?: string; rc?: string; name?: string; message?: string } | null;
  if (value?.code && knownCodes.has(value.code)) return value.code;
  if (value?.rc && knownCodes.has(value.rc)) return value.rc;
  const message = String(value?.message ?? error ?? "");
  if (/^\s*[A-Z]+-\d{3}\s*$/.test(message)) return message.trim();
  if (typeof value?.name === "string" && /^(?:PostgrestError|FunctionsHttpError|FunctionsFetchError|StorageError|AuthApiError)$/.test(value.name)) return status >= 500 ? "SVC-001" : status === 401 ? "AUTH-001" : status === 403 ? "AUTH-002" : "SYS-001";
  const kind = message.toLowerCase();
  if (kind === "unreadable") return "OCR-001";
  if (kind === "size") return "FILE-002";
  if (kind === "busy") return "SVC-002";
  if (kind === "service") return "SVC-001";
  if (kind === "auth") return "AUTH-001";
  if (kind === "cancelled" || kind === "canceled") return "CANCEL-001";
  if (value?.code === "23505") return "DATA-002";
  if (value?.code === "23502") return "VAL-001";
  if (value?.code === "23503" || value?.code === "23514") return "BIZ-001";
  if (status === 404 || value?.code === "P0002") return "DATA-001";
  if (status === 401) return "AUTH-001";
  if (status === 403 || value?.code === "42501") return "AUTH-002";
  if (status === 409 || value?.code === "23505") return "CON-001";
  if (status === 429) return "SVC-002";
  if (status === 413) return "FILE-002";
  if (status === 415) return "FILE-001";
  if (/storage is full|could not preserve|device storage/i.test(message)) return "LOCAL-001";
  if (/unsupported file|choose an? \.xlsx|file type/i.test(message)) return "FILE-001";
  if (/could not be read|malformed|invalid workbook|no worksheet/i.test(message)) return "FILE-003";
  if (value?.name === "AbortError" || /timeout|timed out/i.test(message)) return "NET-003";
  if (status === 400 || status === 422 || /^(22|23)/.test(value?.code ?? "")) return "VAL-002";
  if (typeof navigator !== "undefined" && !navigator.onLine) return "NET-001";
  if (/fetch|network|offline|failed to send|relay/i.test(message)) return "NET-002";
  return status >= 500 ? "SVC-001" : "SYS-001";
}

export function userError(error: unknown, lang: "ja" | "en"): string {
  const rc = resultCode(error);
  const messages: Record<string, [string, string]> = {
    "NET-001": ["オフラインです。接続後に再試行してください。", "You are offline. Reconnect and try again."],
    "DATA-001": ["データが見つかりません。最新の一覧を確認してください。", "This record is unavailable. Refresh the list and check again."],
    "DATA-002": ["同じデータが登録されています。入力内容を確認してください。", "This record already exists. Check the entered values."],
    "VAL-001": ["必須項目を入力してください。", "Complete the required field and try again."],
    "VAL-002": ["入力内容を確認してください。保存できませんでした。", "Check the entered values and try saving again."],
    "BIZ-001": ["関連するデータを確認してから、もう一度お試しください。", "Review the related records and try again."],
    "AUTH-001": ["再度ログインしてからお試しください。", "Sign in again, then retry the action."],
    "AUTH-002": ["この操作を行う権限がありません。管理者にお問い合わせください。", "Your account cannot perform this action. Contact your administrator."],
    "CON-001": ["データが重複しているか更新されています。最新の内容を確認してください。", "This record already exists or has changed. Review the latest data."],
    "NET-002": ["接続できません。接続を確認して再試行してください。", "Cannot connect. Check your connection and try again."],
    "NET-003": ["応答に時間がかかっています。保存結果を確認してから再試行してください。", "The response took too long. Check whether the change was saved before retrying."],
    "TXN-001": ["保存結果を確認できません。再送信する前に一覧を更新して、変更が反映されたか確認してください。", "The save result is unknown. Refresh the list and check whether it changed before submitting again."],
    "FILE-001": ["対応しているファイル形式を選んでください。", "Choose a supported file type."],
    "FILE-002": ["ファイルが大きすぎます。小さいファイルを選んでください。", "This file is too large. Choose a smaller file."],
    "FILE-003": ["ファイルを読み取れません。別のファイルを選ぶか、保存し直してください。", "This file could not be read. Choose another file or save it again."],
    "OCR-001": ["読み取れる文字が見つかりません。鮮明な書類を選んでください。", "No readable text was found. Choose a clearer document."],
    "OCR-002": ["読み取り結果を確認して、不明な項目を手入力してください。", "Review the scan and enter any unclear fields manually."],
    "LOCAL-001": ["端末に作業を保存できません。空き容量を確保して、もう一度お試しください。", "This device could not save your work. Free some storage and try again."],
    "CANCEL-001": ["操作をキャンセルしました。", "The action was cancelled."],
    "UNDO-001": ["この変更を元に戻せません。最新の記録を確認してください。", "This change cannot be undone. Review the latest record."],
    "SVC-002": ["処理が混み合っています。少し待って再試行してください。", "The service is busy. Wait a moment and try again."],
    "SVC-001": ["サービスを利用できません。しばらくして再試行してください。", "The service is unavailable. Try again shortly."],
    "SYS-001": ["処理を完了できませんでした。再試行しても続く場合は管理者にお問い合わせください。", "The action could not be completed. Retry, or contact your administrator if it continues."],
  };
  return (messages[rc] ?? messages["SYS-001"])[lang === "ja" ? 0 : 1];
}
