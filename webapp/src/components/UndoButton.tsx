import { useState } from "react";
import type { ReactNode } from "react";
import { friendlyNetworkMessage } from "../lib/networkStatus";
import { fetchAuditLogs, isUndoableAuditLog, undoAuditLog, type AuditLog } from "../lib/operations";
import { Icon } from "./Icon";
import { useDialog } from "./AppDialog";

type Lang = "ja" | "en";

const ENTITY_NAMES: Record<string, [string, string]> = {
  clients: ["client", "取引先"], products: ["product", "製品"], orders: ["order", "受注"],
  inventory_items: ["inventory item", "在庫品目"], purchases: ["purchase", "仕入"],
  stock_movements: ["stock movement", "在庫移動"], product_materials: ["product material", "製品材料"],
  production_tasks: ["production task", "製造工程"], manufacturing_operations: ["manufacturing process", "製造工程"],
  production_costs: ["production cost", "製造原価"],
};
const ENTITY_NAME_FIELDS: Record<string, string[]> = {
  clients: ["client_name", "clientName", "name"],
  products: ["product_name", "productName", "product_number", "productNumber", "product_no", "productNo", "name"],
  orders: ["order_number", "orderNumber", "order_no", "orderNo", "product_name", "productName"],
  inventory_items: ["item_name", "itemName", "item_code", "itemCode", "name"],
  purchases: ["purchase_no", "purchaseNo", "supplier_name", "supplierName"],
  stock_movements: ["movement_no", "movementNo", "item_name", "itemName"],
  product_materials: ["product_name", "productName", "item_name", "itemName", "material_name"],
  production_tasks: ["order_number", "orderNumber", "product_name", "productName", "task_name"],
  manufacturing_operations: ["operation_name", "operationName", "name"],
  production_costs: ["order_number", "orderNumber", "product_name", "productName"],
};
const FIELD_NAMES: Record<string, [string, string]> = {
  product_name: ["Product name", "製品名"], product_no: ["Product number", "製品番号"],
  product_number: ["Product number", "製品番号"],
  client_name: ["Client", "取引先"], order_number: ["Order number", "受注番号"],
  quantity: ["Quantity", "数量"], total_price: ["Total price", "合計金額"],
  delivery_date: ["Delivery date", "納期"], status: ["Status", "状態"],
  unit_price: ["Unit price", "単価"], item_name: ["Item", "品目"], item_code: ["Item number", "品目番号"],
  category: ["Category", "分類"], supplier_name: ["Supplier", "仕入先"],
};

function plainValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function describeActivity(log: AuditLog, lang: Lang): { summary: string; entity: string; changes: Array<[string, string, string]> } {
  const ja = lang === "ja";
  const entity = ENTITY_NAMES[log.entity]?.[ja ? 1 : 0] ?? log.entity.replace(/_/g, " ");
  const data = log.action === "delete" ? log.oldData : log.newData ?? log.oldData;
  const fields = ENTITY_NAME_FIELDS[log.entity] ?? ["name"];
  const name = data && fields.map(field => plainValue(data[field])).find(Boolean);
  const target = name ? `${entity} “${name}”` : log.entityId ? `${entity} (ID: ${log.entityId})` : entity;
  const action = log.action === "insert" ? (ja ? "登録しました" : "Created")
    : log.action === "update" ? (ja ? "更新しました" : "Updated")
      : (ja ? "削除しました" : "Deleted");
  const summary = ja ? `${target}を${action}` : `${action} ${target}`;
  const watched = Object.keys(FIELD_NAMES);
  const changes = log.action === "update" && log.oldData && log.newData
    ? watched.filter(key => log.oldData?.[key] !== log.newData?.[key] && (plainValue(log.oldData?.[key]) !== null || plainValue(log.newData?.[key]) !== null))
      .slice(0, 4)
      .map(key => [FIELD_NAMES[key][ja ? 1 : 0], plainValue(log.oldData?.[key]) ?? "—", plainValue(log.newData?.[key]) ?? "—"] as [string, string, string])
    : [];
  return { summary, entity, changes };
}

export default function UndoButton({ className = "", lang = "ja", canViewAudit = false }: { className?: string; lang?: Lang; canViewAudit?: boolean }) {
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
        await dialog.alert(lang === "ja" ? "取り消せる操作はありません。" : "There is no activity to undo.", {
          title: lang === "ja" ? "取り消し" : "Undo",
        });
        return;
      }
      if (!isUndoableAuditLog(latest)) {
        await dialog.alert(lang === "ja"
          ? "直前の変更はこの画面から取り消せません。他の記録は変更していません。"
          : "The latest activity cannot be undone here. No other records were changed.", {
          title: lang === "ja" ? "この操作は取り消せません" : "This activity cannot be undone",
        });
        return;
      }

      const activity = describeActivity(latest, lang);
      const occurred = new Date(latest.createdAt).toLocaleString(lang === "ja" ? "ja-JP" : "en-US");
      const message: ReactNode = (
        <div>
          <div className="rounded border border-slate-200 bg-slate-50 p-3">
            <p className="break-words font-700 text-slate-800">{activity.summary}</p>
            <p className="mt-1 text-xs text-slate-500">{occurred}</p>
            {activity.changes.length > 0 && <dl className="mt-3 space-y-1 border-t border-slate-200 pt-2 text-xs">{activity.changes.map(([label, before, after]) => <div key={label} className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-2"><dt className="text-slate-500">{label}</dt><dd className="break-words text-slate-700">{before} → {after}</dd></div>)}</dl>}
          </div>
        </div>
      );
      const confirmed = await dialog.confirm(message, {
        title: lang === "ja" ? "直前の操作を取り消しますか？" : "Undo the latest activity?",
        confirmLabel: lang === "ja" ? "取り消す" : "Undo",
        cancelLabel: lang === "ja" ? "キャンセル" : "Cancel",
        tone: "danger",
        headerTone: "navy",
        actionsAlign: "start",
        secondaryActionPosition: "actions",
        ...(canViewAudit ? {
          secondaryActionLabel: lang === "ja" ? "操作履歴を開く" : "Go to Activity audit",
          onSecondaryAction: () => window.dispatchEvent(new Event("kiyometa-open-activity-audit")),
        } : {}),
      });
      if (!confirmed) return;

      await undoAuditLog(latest.id);
      window.dispatchEvent(new Event("kiyometa-retry-reads"));
      await dialog.alert(lang === "ja" ? "操作を取り消しました。" : "The activity was undone.", {
        title: lang === "ja" ? "取り消し完了" : "Undo complete",
      });
    } catch (error) {
      await dialog.alert(friendlyNetworkMessage(error, lang), {
        title: lang === "ja" ? "取り消しに失敗しました" : "Could not undo this activity",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
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
