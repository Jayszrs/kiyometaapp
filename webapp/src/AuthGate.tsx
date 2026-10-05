import { useEffect, useState } from "react";
import App from "./App";
import LoginPage from "./LoginPage";
import { AuthContext, useSession, signOut } from "./lib/auth";
import type { Lang } from "./App";
import LoadingDialog from "./components/LoadingDialog";

export default function AuthGate() {
  const { session, profile, loading, updateProfile } = useSession();
  const [lang, setLang] = useState<Lang>(() => localStorage.getItem("kiyometa-language") === "en" ? "en" : "ja");

  useEffect(() => {
    localStorage.setItem("kiyometa-language", lang);
  }, [lang]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        <LoadingDialog active lang={lang} label={lang === "ja" ? "認証情報を確認しています…" : "Checking your session…"} />
      </div>
    );
  }

  if (!session) return <LoginPage lang={lang} setLang={setLang} />;

  if (!profile.active) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-3 sm:p-5">
        <section className="w-full max-w-md rounded-lg bg-white p-5 text-center shadow-lg ring-1 ring-slate-200 sm:p-8">
          <h1 className="text-xl font-700 text-[#1a3458]">{lang === "ja" ? "アカウントは無効です" : "Account disabled"}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            {lang === "ja" ? "このアカウントは現在利用できません。利用を再開する場合は管理者にお問い合わせください。" : "This account is no longer active. Contact an administrator if access should be restored."}
          </p>
          <button onClick={() => void signOut()} className="mt-6 rounded bg-[#1a3458] px-5 py-2.5 font-700 text-white">
            {lang === "ja" ? "ログアウト" : "Sign out"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={{ email: session.user.email ?? "", profile, signOut, updateProfile }}>
      <App lang={lang} setLang={setLang} />
    </AuthContext.Provider>
  );
}
