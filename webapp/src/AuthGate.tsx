import { useEffect, useRef, useState } from "react";
import App from "./App";
import LoginPage from "./LoginPage";
import { AuthContext, useSession, signOut } from "./lib/auth";
import type { Lang } from "./App";
import LoadingDialog from "./components/LoadingDialog";
import { DialogProvider } from "./components/AppDialog";

export default function AuthGate() {
  const { session, profile, loading, updateProfile } = useSession();
  const [lang, setLang] = useState<Lang>(() => localStorage.getItem("kiyometa-language") === "en" ? "en" : "ja");
  const previousLang = useRef(lang);
  const [languageChanging, setLanguageChanging] = useState(false);

  useEffect(() => {
    localStorage.setItem("kiyometa-language", lang);
  }, [lang]);

  useEffect(() => {
    if (previousLang.current === lang) return;
    previousLang.current = lang;
    setLanguageChanging(true);
    const timer = window.setTimeout(() => setLanguageChanging(false), 130);
    return () => window.clearTimeout(timer);
  }, [lang]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#f5f6f8]" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        <LoadingDialog active lang={lang} label={lang === "ja" ? "認証情報を確認しています…" : "Checking your session…"} />
      </div>
    );
  }

  if (!session) return <div className={`h-full ${languageChanging ? "language-change" : ""}`}><LoginPage lang={lang} setLang={setLang} /></div>;

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
      <div className={`h-full ${languageChanging ? "language-change" : ""}`}>
        <DialogProvider lang={lang}>
          <App lang={lang} setLang={setLang} />
        </DialogProvider>
      </div>
    </AuthContext.Provider>
  );
}
