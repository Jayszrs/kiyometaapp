import { useState } from "react";
import { Icon, Btn, TextInput } from "./App";
import { signIn } from "./lib/auth";
import type { Lang } from "./App";
import LoadingDialog from "./components/LoadingDialog";

export default function LoginPage({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
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
      setError(lang === "ja" ? "ユーザー名とパスワードを入力してください。" : "Username and password are required.");
      return;
    }
    setBusy(true);
    try {
      await signIn(submittedIdentity, submittedPassword);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(lang === "ja"
        ? /invalid login credentials/i.test(message) ? "ユーザー名またはパスワードが正しくありません。" : "ログインできませんでした。入力内容と通信状態を確認してください。"
        : message || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full items-center justify-center overflow-y-auto bg-[#f5f6f8] p-3 sm:p-6" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <img src="/app-logo.png" alt="Kiyometa" className="h-10 w-10 shrink-0 rounded object-cover shadow-sm" />
            <div>
              <p className="text-lg font-700 text-[#1a3458] leading-tight">Kiyometa</p>
              <p className="text-sm text-slate-500 leading-tight">{lang === "ja" ? "受注管理" : "Order Management"}</p>
            </div>
          </div>
          <div className="inline-flex shrink-0 rounded border border-slate-200 p-0.5" role="group" aria-label={lang === "ja" ? "表示言語" : "Display language"}>
            <button type="button" aria-pressed={lang === "ja"} onClick={() => setLang("ja")} className={`rounded px-2 py-1.5 text-xs font-600 ${lang === "ja" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{lang === "ja" ? "日本語" : "Japanese"}</button>
            <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} className={`rounded px-2 py-1.5 text-xs font-600 ${lang === "en" ? "bg-[#1a3458] text-white" : "text-slate-600 hover:bg-slate-100"}`}>{lang === "ja" ? "英語" : "English"}</button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2.5 mb-4 bg-red-50 border border-red-200 rounded-sm">
            <Icon name="alert-triangle" size={15} className="text-red-600 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <label className="block mb-4">
          <span className="block text-sm font-600 text-slate-500 mb-1">{lang === "ja" ? "ユーザー名" : "Username"}</span>
          <TextInput name="identity" value={username} onChange={setUsername} placeholder={lang === "ja" ? "ユーザー名を入力" : "Username"} />
        </label>
        <label className="block mb-6">
          <span className="block text-sm font-600 text-slate-500 mb-1">{lang === "ja" ? "パスワード" : "Password"}</span>
          <TextInput name="password" type="password" value={password} onChange={setPassword} />
        </label>

        <Btn variant="primary" size="lg" className="w-full justify-center" disabled={busy}>
          {busy ? (lang === "ja" ? "ログイン中…" : "Signing in…") : (lang === "ja" ? "ログイン" : "Sign in")}
        </Btn>
      </form>
      <LoadingDialog active={busy} lang={lang} label={lang === "ja" ? "ログインしています…" : "Signing in…"} />
    </div>
  );
}
