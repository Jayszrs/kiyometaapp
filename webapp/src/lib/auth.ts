import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
import {
  getOperationsBackendStatus,
  isMissingOperationsSchema,
  markOperationsBackendReady,
  markOperationsMigrationRequired,
} from "./backendStatus";

export type UserRole = "administrator" | "operator";

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
}

interface AuthValue {
  email: string;
  profile: UserProfile;
  signOut: () => void;
}

const emptyProfile: UserProfile = {
  id: "",
  username: "",
  displayName: "",
  role: "operator",
  active: true,
};

export const AuthContext = createContext<AuthValue>({
  email: "",
  profile: emptyProfile,
  signOut: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile>(emptyProfile);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const loadProfile = async (nextSession: Session | null) => {
      if (!nextSession) {
        if (!cancelled) {
          setProfile(emptyProfile);
          setLoading(false);
        }
        return;
      }

      const fallbackUsername =
        String(nextSession.user.user_metadata?.username ?? "").trim() ||
        (nextSession.user.email?.split("@")[0] ?? "operator");
      const fallbackRole: UserRole =
        nextSession.user.email === "operator@kiyometa.app" ||
        nextSession.user.user_metadata?.role === "administrator"
          ? "administrator"
          : "operator";

      let data: { id: string; username: string; display_name: string; role: string; active: boolean } | null = null;
      const result = await supabase
        .from("profiles")
        .select("id, username, display_name, role, active")
        .eq("id", nextSession.user.id)
        .maybeSingle();
      data = result.data;
      if (result.error && isMissingOperationsSchema(result.error)) {
        markOperationsMigrationRequired();
      } else if (!result.error) {
        markOperationsBackendReady();
      }

      if (!cancelled) {
        setProfile(data ? {
          id: data.id,
          username: data.username,
          displayName: data.display_name || data.username,
          role: data.role as UserRole,
          active: data.active,
        } : {
          id: nextSession.user.id,
          username: fallbackUsername,
          displayName: fallbackUsername,
          role: fallbackRole,
          active: true,
        });
        setLoading(false);
      }
    };

    supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return;
      let nextSession = data.session;
      if (nextSession) {
        const { error } = await supabase.auth.getUser();
        const invalidSession = error && (
          error.status === 401 || /invalid|expired|jwt|refresh token/i.test(error.message)
        );
        if (invalidSession) {
          await supabase.auth.signOut({ scope: "local" });
          nextSession = null;
        }
      }
      if (cancelled) return;
      setSession(nextSession);
      void loadProfile(nextSession);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      void loadProfile(s);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, profile, loading };
}

export async function signIn(identity: string, password: string) {
  const normalized = identity.trim().toLowerCase();
  let email = normalized;

  if (!normalized.includes("@")) {
    const { data } = await supabase.rpc("resolve_login_email", { p_username: normalized });
    email = typeof data === "string" && data ? data : `${normalized}@kiyometa.app`;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  if (getOperationsBackendStatus() === "ready") {
    try {
      await supabase.rpc("record_audit_event", {
        p_action: "login",
        p_entity: "session",
        p_metadata: { source: "webapp" },
      });
    } catch {
      // Login must not fail if audit logging is temporarily unavailable.
    }
  }
}

export async function signOut() {
  if (getOperationsBackendStatus() === "ready") {
    try {
      await supabase.rpc("record_audit_event", {
        p_action: "logout",
        p_entity: "session",
        p_metadata: { source: "webapp" },
      });
    } catch {
      // Sign-out must not be blocked by audit availability.
    }
  }
  await supabase.auth.signOut();
}
