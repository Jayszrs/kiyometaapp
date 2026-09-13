import App from "./App";
import LoginPage from "./LoginPage";
import { AuthContext, useSession, signOut } from "./lib/auth";

export default function AuthGate() {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[#f5f6f8] text-slate-400 text-sm" style={{ fontFamily: "'Work Sans', system-ui, sans-serif" }}>
        Loading...
      </div>
    );
  }

  if (!session) return <LoginPage />;

  return (
    <AuthContext.Provider value={{ email: session.user.email ?? "", signOut }}>
      <App />
    </AuthContext.Provider>
  );
}
