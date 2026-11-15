export const WIP_POLICY_FIELDS = [
  { key: "materialIssuePoint", en: "Material recognition", ja: "材料費の認識時点", options: [["issue", "Issue", "払出時"], ["process_start", "Production start", "製作開始時"], ["actual_consumption", "Actual consumption", "実際消費時"]] },
  { key: "outsourcingRecognition", en: "Outsourcing recognition", ja: "外注費の認識時点", options: [["sent", "Sent", "発送時"], ["received", "Received", "受入時"], ["invoiced", "Invoiced", "請求時"]] },
  { key: "stockValuationMethod", en: "Stock cost method", ja: "在庫評価方法", options: [["fifo", "FIFO", "先入先出法"], ["weighted_average", "Weighted average", "加重平均法"], ["standard_cost", "Standard cost", "標準原価"]] },
] as const;

export const CLIENT_DECISION_FIELDS = [
  { key: "fullMachiningMode", en: "Full machining meaning", ja: "全加工の定義", options: [["summary", "Summary of detailed operations", "詳細工程の集計"], ["operation", "Separate operation", "独立した工程"]] },
  { key: "newStageScope", en: "New stage application", ja: "新工程の適用範囲", options: [["production_orders_only", "Production orders only", "生産指図のみ"], ["new_orders", "New orders", "新規受注"], ["selected_orders", "Selected orders", "選択受注"], ["active_orders", "Active orders", "進行中受注"]] },
  { key: "partialUnitRule", en: "Partial units", ja: "部分完了の扱い", options: [["completed_only", "Completed units only", "完了数量のみ"], ["actual_work", "Recorded actual work", "実績作業"]] },
  { key: "preparationLayout", en: "Preparation print layout", ja: "準備印刷の形式", options: [["combined", "Combined list", "一覧"], ["per_order", "One page per order", "受注ごと"]] },
  { key: "preparationBom", en: "Preparation BOM", ja: "準備印刷のBOM", options: [["include", "Include expanded BOM", "展開したBOMを含む"], ["exclude", "Exclude", "含まない"]] },
  { key: "preparationOperatorLog", en: "Preparation operator log", ja: "準備印刷の作業記録", options: [["include", "Include blank operator fields", "記入欄を含む"], ["exclude", "Exclude", "含まない"]] },
  { key: "reportOutput", en: "Report output", ja: "帳票出力", options: [["browser", "Browser / PDF print", "ブラウザ・PDF印刷"], ["excel", "Excel", "Excel"], ["both", "Both", "両方"]] },
] as const;

export function isWipPolicyComplete(settings: object | null): boolean {
  if (!settings) return false;
  const values = settings as Record<string, unknown>;
  return WIP_POLICY_FIELDS.every(field => field.options.some(option => option[0] === String(values[field.key])))
    && values.valuationMethod === "standard_time"
    && values.actualTimeBasis === "per_unit"
    && (values.includeInProgressOperation == null || values.includeInProgressOperation === true)
    && (values.includeLaborCost == null || values.includeLaborCost === true)
    && (values.includeMachineCost == null || values.includeMachineCost === true)
    && (values.includeOverheadCost == null || values.includeOverheadCost === true);
}

export function actualBatchMinutes(minutes: number, basis: "per_unit" | "per_batch", quantity: number): number {
  if (![minutes, quantity].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Time and quantity must be finite, nonnegative numbers.");
  return minutes * (basis === "per_unit" ? quantity : 1);
}
