import App from "./App";
import LoginPage from "./LoginPage";
import { AuthContext, useSession, signOut } from "./lib/auth";

export default function AuthGate() {
  const { session, profile, loading } = useSession();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#f5f6f8] text-slate-400 text-sm" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        Loading...
      </div>
    );
  }

  if (!session) return <LoginPage />;

  if (!profile.active) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-5">
        <section className="w-full max-w-md rounded-lg bg-white p-8 text-center shadow-lg ring-1 ring-slate-200">
          <h1 className="text-xl font-700 text-[#1a3458]">Account disabled</h1>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            This account is no longer active. Contact an administrator if access should be restored.
          </p>
          <button onClick={() => void signOut()} className="mt-6 rounded bg-[#1a3458] px-5 py-2.5 font-700 text-white">
            Sign out
          </button>
        </section>
      </main>
    );
  }

  return (
    <AuthContext.Provider value={{ email: session.user.email ?? "", profile, signOut }}>
      <App />
    </AuthContext.Provider>
  );
}
