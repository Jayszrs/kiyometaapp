import { useState } from "react";
import { Icon, Btn, TextInput } from "./App";
import { signIn } from "./lib/auth";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-center h-full bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white border border-slate-200 rounded-sm shadow-sm p-8">
        <div className="flex items-center gap-2.5 mb-6">
          <span className="flex items-center justify-center w-9 h-9 rounded bg-[#0d7377] text-white text-base font-700 shrink-0">K</span>
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
          <span className="block text-sm font-600 text-slate-500 mb-1">Email</span>
          <TextInput type="email" value={email} onChange={setEmail} placeholder="operator@kiyometa.app" />
        </label>
        <label className="block mb-6">
          <span className="block text-sm font-600 text-slate-500 mb-1">Password</span>
          <TextInput type="password" value={password} onChange={setPassword} />
        </label>

        <Btn variant="primary" size="lg" className="w-full justify-center" disabled={busy || !email || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </Btn>
      </form>
    </div>
  );
}
