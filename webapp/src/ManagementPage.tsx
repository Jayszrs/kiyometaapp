import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadRefresh } from "./lib/useReadRefresh";
import { useAuth, type UserRole } from "./lib/auth";
import { AppShell, PageContainer, type DeliverySlipMode, type Lang, type Page } from "./App";
import { MIGRATION_REQUIRED_MESSAGE, probeOperationsBackend } from "./lib/backendStatus";
import { passwordBreachCount } from "./lib/pwnedPassword";
import { useIsTabletOrWider } from "./lib/useMediaQuery";
import { useDialog } from "./components/AppDialog";
import { friendlyNetworkMessage, isConnectivityError, reportConnectivityError } from "./lib/networkStatus";
import {
  createManagedUser,
  fetchAuditLogPage,
  isUndoableAuditLog,
  listManagedUsers,
  resetManagedUserPassword,
  undoAuditLog,
  updateManagedUser,
  type AuditLog,
  type ManagedUser,
} from "./lib/operations";

interface Props {
  onNavigate: (p: Page, mode?: DeliverySlipMode, orderId?: string) => void;
  initialTab?: "users" | "audit";
  lang: Lang;
  setLang: (l: Lang) => void;
}

const ACTION_LABELS: Record<string, string> = {
  insert: "Created",
  update: "Updated",
  delete: "Deleted",
  undo: "Undid",
  login: "Signed in",
  logout: "Signed out",
  create_user: "Created user",
  update_user: "Updated user",
  reset_password: "Reset password",
};
const ACTION_LABELS_JA: Record<string, string> = {
  insert: "作成", update: "更新", delete: "削除", undo: "取り消し",
  login: "ログイン", logout: "ログアウト", create_user: "ユーザー作成",
  update_user: "ユーザー更新", reset_password: "パスワード再設定",
};
const ENTITY_LABELS_JA: Record<string, string> = {
  clients: "取引先", products: "製品", orders: "受注",
  inventory_items: "在庫品目", purchases: "仕入", stock_movements: "在庫移動",
  product_materials: "製品材料", profiles: "プロフィール", session: "ログインセッション",
  production_tasks: "製造工程", manufacturing_operations: "工程マスター", production_costs: "製造原価",
};

type AuditTimePreset = "1h" | "24h" | "7d" | "30d" | "12w" | "all" | "custom";
type AuditSortKey = "time" | "employee" | "activity" | "record";
type SortDirection = "asc" | "desc";


export default function ManagementPage({ onNavigate, initialTab = "users", lang, setLang }: Props) {
  const { profile } = useAuth();
  const dialog = useDialog();
  const [tab, setTab] = useState<"users" | "audit">(initialTab);
  const isWide = useIsTabletOrWider();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("operator");
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [resetPassword, setResetPassword] = useState("operator1234");
  const [search, setSearch] = useState("");
  const [auditSearchQuery, setAuditSearchQuery] = useState("");
  const [auditTimePreset, setAuditTimePreset] = useState<AuditTimePreset>("7d");
  const [auditFromDate, setAuditFromDate] = useState("");
  const [auditToDate, setAuditToDate] = useState("");
  const [auditSortKey, setAuditSortKey] = useState<AuditSortKey>("time");
  const [auditSortDirection, setAuditSortDirection] = useState<SortDirection>("desc");
  const auditPageSize = 50;
  const text = (english: string, japanese: string) => lang === "ja" ? japanese : english;
  const langRef = useRef(lang);
  langRef.current = lang;

  const auditBounds = useMemo(() => {
    if (auditTimePreset === "all") return { from: undefined, to: undefined };
    if (auditTimePreset === "custom") {
      if (!auditFromDate && !auditToDate) return { from: undefined, to: undefined };
      const first = auditFromDate || auditToDate;
      const last = auditToDate || auditFromDate;
      const firstDate = new Date(`${first}T00:00:00`);
      const lastDate = new Date(`${last}T23:59:59.999`);
      const from = firstDate <= lastDate ? firstDate : new Date(`${last}T00:00:00`);
      const to = firstDate <= lastDate ? lastDate : new Date(`${first}T23:59:59.999`);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    const duration: Record<Exclude<AuditTimePreset, "all" | "custom">, number> = {
      "1h": 60 * 60 * 1000,
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
      "12w": 12 * 7 * 24 * 60 * 60 * 1000,
    };
    const now = new Date();
    return { from: new Date(now.getTime() - duration[auditTimePreset]).toISOString(), to: now.toISOString() };
  }, [auditFromDate, auditTimePreset, auditToDate]);
  const auditSortColumn = ({
    time: "created_at",
    employee: "username",
    activity: "action",
    record: "entity_id",
  } as const)[auditSortKey];

  const forceProbeRef = useRef(false);
  const refresh = useReadRefresh(async signal => {
      const force = forceProbeRef.current;
      forceProbeRef.current = false;
      const available = await probeOperationsBackend(force);
      if (!available || signal.aborted) return null;
      return Promise.all([listManagedUsers(signal), fetchAuditLogPage({
        limit: auditPageSize,
        offset: auditPage * auditPageSize,
        search: auditSearchQuery,
        sortBy: auditSortColumn,
        ascending: auditSortDirection === "asc",
        ...auditBounds,
      }, signal)]);
    }, data => {
      if (!data) {
        setError(langRef.current === "ja" ? "必要なデータベース更新が適用されていません。管理者にお問い合わせください。" : MIGRATION_REQUIRED_MESSAGE);
        return;
      }
      const [nextUsers, auditResult] = data;
      setUsers(nextUsers);
      setLogs(auditResult.logs);
      setAuditTotal(auditResult.total);
    }, err => {
      if (isConnectivityError(err)) { reportConnectivityError(err); return; }
      setError(langRef.current === "ja" ? "データを読み込めませんでした。通信状態を確認してください。" : friendlyNetworkMessage(err, langRef.current));
    }, active => { setBusy(active); if (active) setError(""); });
  const load = useCallback((forceProbe = false) => {
    forceProbeRef.current ||= forceProbe;
    return refresh();
  }, [refresh]);

  const auditFilterReady = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAuditPage(0);
      setAuditSearchQuery(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!auditFilterReady.current) {
      auditFilterReady.current = true;
      return;
    }
    void load();
  }, [auditBounds.from, auditBounds.to, auditPage, auditSearchQuery, auditSortColumn, auditSortDirection, load]);

  const filteredLogs = logs;
  const auditPageCount = Math.max(1, Math.ceil(auditTotal / auditPageSize));

  const setAuditSort = (key: AuditSortKey, direction?: SortDirection) => {
    if (direction) {
      setAuditPage(0);
      setAuditSortKey(key);
      setAuditSortDirection(direction);
      return;
    }
    setAuditPage(0);
    if (auditSortKey === key) setAuditSortDirection(current => current === "asc" ? "desc" : "asc");
    else {
      setAuditSortKey(key);
      setAuditSortDirection(key === "time" ? "desc" : "asc");
    }
  };

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      setNotice(success);
      await load();
    } catch (err) {
      if (isConnectivityError(err)) { reportConnectivityError(err); return; }
      setError(lang === "ja" ? "処理に失敗しました。入力内容と通信状態を確認してください。" : friendlyNetworkMessage(err, langRef.current));
    } finally {
      setBusy(false);
    }
  };

  const createUser = () => run(async () => {
    const breaches = await passwordBreachCount(password);
    if (breaches > 0) {
      throw new Error(lang === "ja"
        ? `このパスワードは既知のデータ漏洩に ${breaches} 回出現しています。別のパスワードを選んでください。`
        : `This password appears in ${breaches} known data breaches. Choose a different password.`);
    }
    await createManagedUser({ username, displayName, password, role });
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("operator");
  }, text("Employee account created.", "従業員アカウントを作成しました。"));

  const submitReset = () => {
    if (!resetTarget) return;
    void run(async () => {
      const breaches = await passwordBreachCount(resetPassword);
      if (breaches > 0) {
        throw new Error(lang === "ja"
          ? `このパスワードは既知のデータ漏洩に ${breaches} 回出現しています。別のパスワードを選んでください。`
          : `This password appears in ${breaches} known data breaches. Choose a different password.`);
      }
      await resetManagedUserPassword(resetTarget.id, resetPassword);
      setResetTarget(null);
      setResetPassword("operator1234");
    }, text(`Password for ${resetTarget.username} was updated.`, `ユーザー「${resetTarget.username}」のパスワードを更新しました。`));
  };

  return (
    <AppShell onNavigate={onNavigate} title={text("Role Management & Audit", "権限管理・操作履歴")} activePage="management" showBack backTarget="home" backLabel={text("Home", "ホーム")} lang={lang} setLang={setLang}>
      <div className="border-b border-slate-200 bg-white px-4 sm:px-8">
        <PageContainer className="flex gap-1 py-2">
          <button onClick={() => setTab("users")} className={`rounded px-4 py-2 text-sm font-600 ${tab === "users" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{text("Employees", "従業員")}</button>
          <button onClick={() => setTab("audit")} className={`rounded px-4 py-2 text-sm font-600 ${tab === "audit" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{text("Activity audit", "操作履歴")}</button>
        </PageContainer>
      </div>

      <main className="page-enter flex-1 overflow-y-auto p-3 sm:p-6">
        <PageContainer className="space-y-4">
          {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{error}</span><button type="button" disabled={busy} onClick={() => void load(true)} className="rounded border border-red-300 bg-white px-3 py-1.5 font-700 text-red-700 hover:bg-red-100 disabled:opacity-50">{busy ? text("Checking...", "確認中…") : text("Check again", "再確認")}</button></div>}
          {notice && <div className="motion-notice rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          {tab === "users" && (
            <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
              <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <div className="mb-5">
                  <p className="text-xs font-700 text-[#0d7377]">{text("Administrator", "管理者")}</p>
                  <h2 className="mt-1 text-xl font-700 text-[#1a3458]">{text("Add employee account", "従業員アカウントを追加")}</h2>
                  <p className="mt-1 text-sm text-slate-500">{text("Employees sign in with a username. No personal email is required.", "従業員はユーザー名でログインします。個人用メールアドレスは不要です。")}</p>
                </div>

                {profile.role !== "administrator" ? (
                  <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">{text("Only administrators can create accounts or change roles.", "アカウントの作成や権限の変更は管理者のみ行えます。")}</p>
                ) : (
                  <div className="space-y-4">
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">{text("Username", "ユーザー名")}</span><input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))} placeholder="operator02" className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">{text("Employee name", "従業員名")}</span><input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder={text("Operator 02", "従業員 02")} className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">{text("Initial password", "初期パスワード")}</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={text("Minimum 8 characters", "8文字以上")} className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">{text("Role", "権限")}</span><select value={role} onChange={e => setRole(e.target.value as UserRole)} className="w-full rounded border border-slate-300 px-3 py-2.5"><option value="operator">{text("Operator", "オペレーター")}</option><option value="administrator">{text("Administrator", "管理者")}</option></select></label>
                    <button disabled={busy || username.length < 3 || password.length < 8} onClick={createUser} className="w-full rounded bg-[#1a3458] px-4 py-3 font-700 text-white disabled:cursor-not-allowed disabled:opacity-40">{text("Create account", "アカウントを作成")}</button>
                  </div>
                )}
              </section>

              <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
                <div className="border-b border-slate-200 px-5 py-4">
                  <h2 className="text-lg font-700 text-[#1a3458]">{text("Employee access", "従業員アカウント")}</h2>
                  <p className="text-sm text-slate-500">{busy && users.length === 0 ? <span className="skeleton-block inline-block h-3 w-7 align-middle" /> : users.filter(user => user.active).length}{text(" active accounts", "件が有効")}</p>
                </div>
                {!isWide && <div className="divide-y divide-slate-100">
                  {busy && users.length === 0 && [0, 1, 2].map(row => <article key={`loading-user-${row}`} aria-hidden="true" className="space-y-4 p-4"><div className="flex items-center justify-between gap-3"><div className="min-w-0 flex-1"><div className="skeleton-block h-4 w-2/5" /><div className="skeleton-block mt-2 h-3 w-1/3" /></div><div className="skeleton-block h-6 w-16 rounded-full" /></div><div className="skeleton-block h-12 w-full" /><div className="flex gap-2"><div className="skeleton-block h-9 flex-1" /><div className="skeleton-block h-9 flex-1" /></div></article>)}
                  {users.map(user => (
                    <article key={user.id} className="space-y-4 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words font-700 text-slate-800">{user.displayName}</p>
                          <p className="truncate font-mono text-xs text-slate-500">@{user.username}</p>
                        </div>
                        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-700 ${user.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{user.active ? text("Active", "有効") : text("Inactive", "無効")}</span>
                      </div>
                      <label className="block text-xs font-600 text-slate-400">
                        {text("Role", "権限")}
                        {profile.role === "administrator" && user.id !== profile.id ? (
                          <select value={user.role} onChange={e => void run(() => updateManagedUser({ userId: user.id, role: e.target.value as UserRole }), text("Role updated.", "権限を更新しました。"))} className="mt-1.5 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-500 normal-case text-slate-700"><option value="operator">{text("Operator", "オペレーター")}</option><option value="administrator">{text("Administrator", "管理者")}</option></select>
                        ) : <span className="mt-1 block text-sm font-500 normal-case text-slate-700 capitalize">{text(user.role, user.role === "administrator" ? "管理者" : "オペレーター")}</span>}
                      </label>
                      <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                        <button disabled={profile.role !== "administrator" && user.role !== "operator"} onClick={() => setResetTarget(user)} className="rounded border border-slate-300 px-3 py-2 text-sm font-600 hover:bg-slate-50 disabled:opacity-30">{text("Reset password", "パスワードを再設定")}</button>
                        {profile.role === "administrator" && user.id !== profile.id && <button onClick={() => void run(() => updateManagedUser({ userId: user.id, active: !user.active }), user.active ? text("Account disabled.", "アカウントを無効にしました。") : text("Account activated.", "アカウントを有効にしました。"))} className="rounded border border-slate-300 px-3 py-2 text-sm font-600 hover:bg-slate-50">{user.active ? text("Disable", "無効化") : text("Activate", "有効化")}</button>}
                      </div>
                    </article>
                  ))}
                </div>}
                {isWide && <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-600 text-slate-500"><tr><th className="px-5 py-3">{text("Employee", "従業員")}</th><th className="px-4 py-3">{text("Role", "権限")}</th><th className="px-4 py-3">{text("Status", "状態")}</th><th className="px-5 py-3 text-right">{text("Actions", "操作")}</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {busy && users.length === 0 && [0, 1, 2].map(row => <tr key={`loading-user-row-${row}`} aria-hidden="true"><td className="px-5 py-4"><div className="skeleton-block h-4 w-32" /><div className="skeleton-block mt-2 h-3 w-24" /></td><td className="px-4 py-4"><div className="skeleton-block h-7 w-24" /></td><td className="px-4 py-4"><div className="skeleton-block h-6 w-16 rounded-full" /></td><td className="px-5 py-4"><div className="ml-auto flex max-w-56 gap-2"><div className="skeleton-block h-8 flex-1" /><div className="skeleton-block h-8 flex-1" /></div></td></tr>)}
                      {users.map(user => (
                        <tr key={user.id} className="hover:bg-slate-50">
                          <td className="px-5 py-4"><p className="font-700 text-slate-800">{user.displayName}</p><p className="font-mono text-xs text-slate-500">@{user.username}</p></td>
                          <td className="px-4 py-4">
                            {profile.role === "administrator" && user.id !== profile.id ? (
                              <select value={user.role} onChange={e => void run(() => updateManagedUser({ userId: user.id, role: e.target.value as UserRole }), text("Role updated.", "権限を更新しました。"))} className="rounded border border-slate-300 px-2 py-1.5"><option value="operator">{text("Operator", "オペレーター")}</option><option value="administrator">{text("Administrator", "管理者")}</option></select>
                            ) : <span className="capitalize">{text(user.role, user.role === "administrator" ? "管理者" : "オペレーター")}</span>}
                          </td>
                          <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-700 ${user.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{user.active ? text("Active", "有効") : text("Inactive", "無効")}</span></td>
                          <td className="px-5 py-4"><div className="flex justify-end gap-2"><button disabled={profile.role !== "administrator" && user.role !== "operator"} onClick={() => setResetTarget(user)} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-slate-50 disabled:opacity-30">{text("Reset password", "パスワードを再設定")}</button>{profile.role === "administrator" && user.id !== profile.id && <button onClick={() => void run(() => updateManagedUser({ userId: user.id, active: !user.active }), user.active ? text("Account disabled.", "アカウントを無効にしました。") : text("Account activated.", "アカウントを有効にしました。"))} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-slate-50">{user.active ? text("Disable", "無効化") : text("Activate", "有効化")}</button>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>}
              </section>
            </div>
          )}

          {tab === "audit" && (
              <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
                <div className="border-b border-slate-200 px-5 py-4"><h2 className="text-lg font-700 text-[#1a3458]">{text("Activity & undo", "操作履歴と取り消し")}</h2><p className="text-sm text-slate-500">{profile.role === "administrator" ? text("Administrators can recover activity from every employee.", "管理者は全従業員の操作を復元できます。") : text("Operators can review and recover their own activity.", "オペレーターは自身の操作を確認・復元できます。")}</p></div>
                <div className="border-b border-slate-200 bg-slate-50 p-4">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_11rem_10rem_10rem_12rem]">
                    <label className="text-xs font-700 text-slate-600">{text("Search", "検索")}<input value={search} onChange={event => setSearch(event.target.value)} placeholder={text("Employee, activity, record...", "従業員・操作・対象データ…")} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal" /></label>
                    <label className="text-xs font-700 text-slate-600">{text("Time range", "期間")}<select value={auditTimePreset} onChange={event => { setAuditPage(0); setAuditTimePreset(event.target.value as AuditTimePreset); }} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal"><option value="1h">{text("Last 1 hour", "過去1時間")}</option><option value="24h">{text("Last 24 hours", "過去24時間")}</option><option value="7d">{text("Last 7 days", "過去7日間")}</option><option value="30d">{text("Last 30 days", "過去30日間")}</option><option value="12w">{text("Last 12 weeks", "過去12週間")}</option><option value="all">{text("All time", "全期間")}</option><option value="custom">{text("Custom dates", "日付を指定")}</option></select></label>
                    <label className="text-xs font-700 text-slate-600">{text("From", "開始日")}<input type="date" value={auditFromDate} onChange={event => { setAuditPage(0); setAuditFromDate(event.target.value); setAuditTimePreset("custom"); }} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-normal" /></label>
                    <label className="text-xs font-700 text-slate-600">{text("To", "終了日")}<input type="date" value={auditToDate} onChange={event => { setAuditPage(0); setAuditToDate(event.target.value); setAuditTimePreset("custom"); }} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm font-normal" /></label>
                    <label className="text-xs font-700 text-slate-600">{text("Sort", "並び順")}<select value={`${auditSortKey}:${auditSortDirection}`} onChange={event => { const [key, direction] = event.target.value.split(":") as [AuditSortKey, SortDirection]; setAuditSort(key, direction); }} className="mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-sm font-normal"><option value="time:desc">{text("Newest first", "新しい順")}</option><option value="time:asc">{text("Oldest first", "古い順")}</option><option value="employee:asc">{text("Employee A–Z", "従業員 A–Z")}</option><option value="activity:asc">{text("Activity A–Z", "操作 A–Z")}</option><option value="record:asc">{text("Record A–Z", "対象データ A–Z")}</option></select></label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>{busy ? text("Loading activity…", "操作履歴を読み込み中…") : text(`${auditTotal} matching activities`, `該当する操作 ${auditTotal}件`)}</span>{auditTimePreset === "custom" && <span>{text("If To is blank, the selected From date is used as one full day.", "終了日が空の場合、開始日の1日分を表示します。")}</span>}</div>
                </div>
                {!isWide && <div className="divide-y divide-slate-100">
                  {busy && logs.length === 0 && [0, 1, 2].map(row => <article key={`loading-audit-${row}`} aria-hidden="true" className="space-y-3 p-4"><div className="flex items-center justify-between"><div><div className="skeleton-block h-4 w-24" /><div className="skeleton-block mt-2 h-3 w-32" /></div><div className="skeleton-block h-6 w-20" /></div><div className="skeleton-block h-12 w-full" /><div className="ml-auto skeleton-block h-8 w-20" /></article>)}
                  {filteredLogs.map(log => {
                    const undoable = isUndoableAuditLog(log);
                    return <article key={log.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-700 text-slate-800">@{log.username}</p><p className="text-xs text-slate-500">{new Date(log.createdAt).toLocaleString(lang === "ja" ? "ja-JP" : undefined)}</p></div><span className="rounded bg-slate-100 px-2 py-1 text-xs font-700 text-slate-600">{(lang === "ja" ? ACTION_LABELS_JA[log.action] : ACTION_LABELS[log.action]) ?? log.action}</span></div><div className="rounded bg-slate-50 p-3"><p className="text-xs font-600 text-slate-400">{lang === "ja" ? ENTITY_LABELS_JA[log.entity] ?? "データ" : log.entity}</p><p className="mt-1 break-all font-mono text-xs text-slate-600">{log.entityId ?? String(log.metadata.target_username ?? "-")}</p></div><div className="flex justify-end">{log.undoneAt ? <span className="text-xs font-700 text-emerald-700">{text("Undone", "取り消し済み")}</span> : undoable ? <button disabled={busy} onClick={() => { void dialog.confirm(text("Undo this data change?", "このデータ変更を取り消しますか？"), { tone: "danger" }).then(ok => { if (ok) void run(() => undoAuditLog(log.id), text("Activity was undone.", "操作を取り消しました。")); }); }} className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-700 text-amber-800 hover:bg-amber-100">{text("Undo", "元に戻す")}</button> : <span className="text-xs text-slate-400">{text("View only", "表示のみ")}</span>}</div></article>;
                  })}
                </div>}
                {isWide && <div className="overflow-x-auto">
                  <table className="w-full min-w-[850px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-600 text-slate-500"><tr>
                      {([
                        ["time", text("Time", "日時")],
                        ["employee", text("Employee", "従業員")],
                        ["activity", text("Activity", "操作")],
                        ["record", text("Record", "対象データ")],
                      ] as Array<[AuditSortKey, string]>).map(([key, label], index) => <th key={key} aria-sort={auditSortKey === key ? (auditSortDirection === "asc" ? "ascending" : "descending") : "none"} className={index === 0 ? "px-5 py-3" : "px-4 py-3"}><button type="button" onClick={() => setAuditSort(key)} className="flex items-center gap-1.5 font-700 hover:text-[#1a3458]">{label}<span aria-hidden="true" className={auditSortKey === key ? "text-[#1a3458]" : "text-slate-300"}>{auditSortKey === key ? (auditSortDirection === "asc" ? "↑" : "↓") : "↕"}</span></button></th>)}
                      <th className="px-5 py-3 text-right">{text("Recovery", "復元")}</th>
                    </tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {busy && logs.length === 0 && [0, 1, 2].map(row => <tr key={`loading-audit-row-${row}`} aria-hidden="true"><td className="px-5 py-4"><div className="skeleton-block h-3 w-28" /></td><td className="px-4 py-4"><div className="skeleton-block h-4 w-20" /></td><td className="px-4 py-4"><div className="skeleton-block h-4 w-24" /><div className="skeleton-block mt-2 h-3 w-16" /></td><td className="px-4 py-4"><div className="skeleton-block h-3 w-28" /></td><td className="px-5 py-4"><div className="ml-auto skeleton-block h-8 w-16" /></td></tr>)}
                      {filteredLogs.map(log => {
                        const undoable = isUndoableAuditLog(log);
                        return <tr key={log.id} className="align-top hover:bg-slate-50"><td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{new Date(log.createdAt).toLocaleString(lang === "ja" ? "ja-JP" : undefined)}</td><td className="px-4 py-4 font-700">@{log.username}</td><td className="px-4 py-4"><span className="font-600">{(lang === "ja" ? ACTION_LABELS_JA[log.action] : ACTION_LABELS[log.action]) ?? log.action}</span><p className="text-xs text-slate-500">{lang === "ja" ? ENTITY_LABELS_JA[log.entity] ?? "データ" : log.entity}</p></td><td className="max-w-xs px-4 py-4 font-mono text-xs text-slate-500">{log.entityId ?? String(log.metadata.target_username ?? "-")}</td><td className="px-5 py-4 text-right">{log.undoneAt ? <span className="text-xs font-700 text-emerald-700">{text("Undone", "取り消し済み")}</span> : undoable ? <button disabled={busy} onClick={() => { void dialog.confirm(text("Undo this data change?", "このデータ変更を取り消しますか？"), { tone: "danger" }).then(ok => { if (ok) void run(() => undoAuditLog(log.id), text("Activity was undone.", "操作を取り消しました。")); }); }} className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 font-700 text-amber-800 hover:bg-amber-100">{text("Undo", "元に戻す")}</button> : <span className="text-xs text-slate-400">{text("View only", "表示のみ")}</span>}</td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>}
                {auditTotal > auditPageSize && <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm"><span className="text-slate-500">{text(`Page ${auditPage + 1} of ${auditPageCount}`, `${auditPageCount}ページ中 ${auditPage + 1}ページ`)}</span><div className="flex gap-2"><button type="button" disabled={busy || auditPage === 0} onClick={() => setAuditPage(page => Math.max(0, page - 1))} className="rounded border border-slate-300 bg-white px-3 py-1.5 font-700 text-slate-700 disabled:opacity-40">{text("Previous", "前へ")}</button><button type="button" disabled={busy || auditPage + 1 >= auditPageCount} onClick={() => setAuditPage(page => Math.min(auditPageCount - 1, page + 1))} className="rounded border border-slate-300 bg-white px-3 py-1.5 font-700 text-slate-700 disabled:opacity-40">{text("Next", "次へ")}</button></div></div>}
              </section>
          )}
        </PageContainer>
      </main>

      {resetTarget && (
        <div className="popup-backdrop fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-2 pt-4 sm:items-center sm:p-4">
          <div className="popup-panel w-full max-w-md rounded-lg bg-white p-4 shadow-2xl sm:p-6">
            <h2 className="text-xl font-700 text-[#1a3458]">{text("Reset operator password", "オペレーターのパスワードを再設定")}</h2>
            <p className="mt-1 text-sm text-slate-500">{text(`Set a new password for @${resetTarget.username}.`, `@${resetTarget.username} の新しいパスワードを設定します。`)}</p>
            <input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} className="mt-5 w-full rounded border border-slate-300 px-3 py-2.5" />
            <div className="mt-5 flex justify-end gap-2"><button onClick={() => setResetTarget(null)} className="rounded border border-slate-300 px-4 py-2">{text("Cancel", "キャンセル")}</button><button disabled={busy || resetPassword.length < 8} onClick={submitReset} className="rounded bg-[#1a3458] px-4 py-2 font-700 text-white disabled:opacity-40">{text("Update password", "パスワードを更新")}</button></div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
