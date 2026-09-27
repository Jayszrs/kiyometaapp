import { useState } from "react";
import { Icon, Btn, TextInput } from "./App";
import { signIn } from "./lib/auth";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    // Read from the form DOM so OS autofill / WebView keyboards that skip
    // React onChange still work (button must not be gated on reactive state).
    const fd = new FormData(e.currentTarget);
    const submittedIdentity = String(fd.get("identity") ?? "").trim();
    const submittedPassword = String(fd.get("password") ?? "");
    if (!submittedIdentity || !submittedPassword) {
      setError("Username and password are required.");
      return;
    }
    setBusy(true);
    try {
      await signIn(submittedIdentity, submittedPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[#f5f6f8] p-3 sm:p-6" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <img src="/app-logo.png" alt="Kiyometa" className="h-10 w-10 shrink-0 rounded object-cover shadow-sm" />
          <div>
            <p className="text-lg font-700 text-[#1a3458] leading-tight">Kiyometa</p>
            <p className="text-sm text-slate-500 leading-tight">Order Management</p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2.5 mb-4 bg-red-50 border border-red-200 rounded-sm">
            <Icon name="alert-triangle" size={15} className="text-red-600 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <label className="block mb-4">
          <span className="block text-sm font-600 text-slate-500 mb-1">Username</span>
          <TextInput name="identity" value={username} onChange={setUsername} placeholder="operator" />
        </label>
        <label className="block mb-6">
          <span className="block text-sm font-600 text-slate-500 mb-1">Password</span>
          <TextInput name="password" type="password" value={password} onChange={setPassword} />
        </label>

        <Btn variant="primary" size="lg" className="w-full justify-center" disabled={busy}>
          {busy ? "Signing in..." : "Sign in"}
        </Btn>
      </form>
    </div>
  );
}
