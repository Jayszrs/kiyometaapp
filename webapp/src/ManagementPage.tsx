import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth, type UserRole } from "./lib/auth";
import { MIGRATION_REQUIRED_MESSAGE, probeOperationsBackend } from "./lib/backendStatus";
import {
  createManagedUser,
  fetchAuditLogs,
  listManagedUsers,
  resetManagedUserPassword,
  undoAuditLog,
  updateManagedUser,
  type AuditLog,
  type ManagedUser,
} from "./lib/operations";

interface Props {
  onBack: () => void;
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

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export default function ManagementPage({ onBack }: Props) {
  const { profile, signOut } = useAuth();
  const [tab, setTab] = useState<"users" | "audit">("users");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("operator");
  const [resetTarget, setResetTarget] = useState<ManagedUser | null>(null);
  const [resetPassword, setResetPassword] = useState("operator1234");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      if (!await probeOperationsBackend(true)) {
        setError(MIGRATION_REQUIRED_MESSAGE);
        return;
      }
      const nextUsers = await listManagedUsers();
      setUsers(nextUsers);
      if (profile.role === "administrator") setLogs(await fetchAuditLogs());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }, [profile.role]);

  useEffect(() => { void load(); }, [load]);

  const filteredLogs = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return logs;
    return logs.filter(log =>
      `${log.username} ${log.action} ${log.entity} ${log.entityId ?? ""}`.toLowerCase().includes(keyword),
    );
  }, [logs, search]);

  const run = async (task: () => Promise<void>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      setNotice(success);
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const createUser = () => run(async () => {
    await createManagedUser({ username, displayName, password, role });
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("operator");
  }, "Employee account created.");

  const submitReset = () => {
    if (!resetTarget) return;
    void run(async () => {
      await resetManagedUserPassword(resetTarget.id, resetPassword);
      setResetTarget(null);
      setResetPassword("operator1234");
    }, `Password for ${resetTarget.username} was updated.`);
  };

  return (
    <div className="flex h-full flex-col bg-[#f5f6f8] text-slate-800">
      <header className="flex items-center gap-3 bg-[#1a3458] px-4 py-3 text-white">
        <button onClick={onBack} className="rounded px-2 py-1.5 text-sm hover:bg-white/10">← Home</button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-700">Role Management & Audit</h1>
          <p className="truncate text-xs text-blue-200">Signed in as {profile.username} · {profile.role}</p>
        </div>
        <button onClick={signOut} className="text-sm text-blue-200 hover:text-white">Sign out</button>
      </header>

      <div className="border-b border-slate-200 bg-white px-4 sm:px-8">
        <div className="mx-auto flex max-w-7xl gap-1 py-2">
          <button onClick={() => setTab("users")} className={`rounded px-4 py-2 text-sm font-600 ${tab === "users" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>Employees</button>
          <button onClick={() => setTab("audit")} className={`rounded px-4 py-2 text-sm font-600 ${tab === "audit" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>Activity audit</button>
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-7xl space-y-4">
          {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{error}</span><button type="button" disabled={busy} onClick={() => void load()} className="rounded border border-red-300 bg-white px-3 py-1.5 font-700 text-red-700 hover:bg-red-100 disabled:opacity-50">{busy ? "Checking..." : "Check again"}</button></div>}
          {notice && <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

          {tab === "users" && (
            <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
              <section className="rounded-lg bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <div className="mb-5">
                  <p className="text-xs font-700 uppercase tracking-wider text-[#0d7377]">Administrator</p>
                  <h2 className="mt-1 text-xl font-700 text-[#1a3458]">Add employee account</h2>
                  <p className="mt-1 text-sm text-slate-500">Employees sign in with a username. No personal email is required.</p>
                </div>

                {profile.role !== "administrator" ? (
                  <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">Only administrators can create accounts or change roles.</p>
                ) : (
                  <div className="space-y-4">
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">Username</span><input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ""))} placeholder="operator02" className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">Employee name</span><input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Operator Produksi 02" className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">Initial password</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Minimum 8 characters" className="w-full rounded border border-slate-300 px-3 py-2.5 outline-none focus:border-[#1a3458]" /></label>
                    <label className="block"><span className="mb-1 block text-sm font-600 text-slate-600">Role</span><select value={role} onChange={e => setRole(e.target.value as UserRole)} className="w-full rounded border border-slate-300 px-3 py-2.5"><option value="operator">Operator</option><option value="administrator">Administrator</option></select></label>
                    <button disabled={busy || username.length < 3 || password.length < 8} onClick={createUser} className="w-full rounded bg-[#1a3458] px-4 py-3 font-700 text-white disabled:cursor-not-allowed disabled:opacity-40">Create account</button>
                  </div>
                )}
              </section>

              <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
                <div className="border-b border-slate-200 px-5 py-4">
                  <h2 className="text-lg font-700 text-[#1a3458]">Employee access</h2>
                  <p className="text-sm text-slate-500">{users.filter(user => user.active).length} active accounts</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Employee</th><th className="px-4 py-3">Role</th><th className="px-4 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {users.map(user => (
                        <tr key={user.id} className="hover:bg-slate-50">
                          <td className="px-5 py-4"><p className="font-700 text-slate-800">{user.displayName}</p><p className="font-mono text-xs text-slate-500">@{user.username}</p></td>
                          <td className="px-4 py-4">
                            {profile.role === "administrator" && user.id !== profile.id ? (
                              <select value={user.role} onChange={e => void run(() => updateManagedUser({ userId: user.id, role: e.target.value as UserRole }), "Role updated.")} className="rounded border border-slate-300 px-2 py-1.5"><option value="operator">Operator</option><option value="administrator">Administrator</option></select>
                            ) : <span className="capitalize">{user.role}</span>}
                          </td>
                          <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-700 ${user.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{user.active ? "Active" : "Inactive"}</span></td>
                          <td className="px-5 py-4"><div className="flex justify-end gap-2"><button disabled={profile.role !== "administrator" && user.role !== "operator"} onClick={() => setResetTarget(user)} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-slate-50 disabled:opacity-30">Reset password</button>{profile.role === "administrator" && user.id !== profile.id && <button onClick={() => void run(() => updateManagedUser({ userId: user.id, active: !user.active }), user.active ? "Account disabled." : "Account activated.")} className="rounded border border-slate-300 px-3 py-1.5 font-600 hover:bg-slate-50">{user.active ? "Disable" : "Activate"}</button>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          {tab === "audit" && (
            profile.role !== "administrator" ? (
              <div className="rounded-lg bg-white p-8 text-center shadow-sm ring-1 ring-slate-200"><h2 className="text-lg font-700 text-[#1a3458]">Administrator access required</h2><p className="mt-2 text-sm text-slate-500">Only administrators can inspect employee activity and undo data changes.</p></div>
            ) : (
              <section className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-700 text-[#1a3458]">Operator activity</h2><p className="text-sm text-slate-500">Database changes are recorded automatically.</p></div><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search employee or action..." className="w-full rounded border border-slate-300 px-3 py-2 text-sm sm:w-72" /></div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[850px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Time</th><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Activity</th><th className="px-4 py-3">Record</th><th className="px-5 py-3 text-right">Recovery</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredLogs.map(log => {
                        const source = String(log.metadata.source ?? "");
                        const stockReference = String((log.newData ?? log.oldData)?.reference_type ?? "");
                        const isAutomaticStock = log.entity === "stock_movements" && ["purchase", "order"].includes(stockReference);
                        const undoable = !source.startsWith("undo:") && !isAutomaticStock && ["insert", "update", "delete"].includes(log.action) && ["clients", "products", "orders", "inventory_items", "purchases", "stock_movements"].includes(log.entity);
                        return <tr key={log.id} className="align-top hover:bg-slate-50"><td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">{new Date(log.createdAt).toLocaleString()}</td><td className="px-4 py-4 font-700">@{log.username}</td><td className="px-4 py-4"><span className="font-600">{ACTION_LABELS[log.action] ?? log.action}</span><p className="text-xs text-slate-500">{log.entity}</p></td><td className="max-w-xs px-4 py-4 font-mono text-xs text-slate-500">{log.entityId ?? String(log.metadata.target_username ?? "-")}</td><td className="px-5 py-4 text-right">{log.undoneAt ? <span className="text-xs font-700 text-emerald-700">Undone</span> : undoable ? <button disabled={busy} onClick={() => { if (confirm("Undo this data change?")) void run(() => undoAuditLog(log.id), "Activity was undone."); }} className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 font-700 text-amber-800 hover:bg-amber-100">Undo</button> : <span className="text-xs text-slate-400">View only</span>}</td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          )}
        </div>
      </main>

      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-2xl">
            <h2 className="text-xl font-700 text-[#1a3458]">Reset operator password</h2>
            <p className="mt-1 text-sm text-slate-500">Set a new password for @{resetTarget.username}.</p>
            <input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)} className="mt-5 w-full rounded border border-slate-300 px-3 py-2.5" />
            <div className="mt-5 flex justify-end gap-2"><button onClick={() => setResetTarget(null)} className="rounded border border-slate-300 px-4 py-2">Cancel</button><button disabled={busy || resetPassword.length < 8} onClick={submitReset} className="rounded bg-[#1a3458] px-4 py-2 font-700 text-white disabled:opacity-40">Update password</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
