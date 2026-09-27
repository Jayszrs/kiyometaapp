import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Role = "administrator" | "operator";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = request.headers.get("Authorization") ?? "";

    if (!authorization.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    });
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Invalid session" }, 401);

    const { data: caller, error: callerError } = await adminClient
      .from("profiles")
      .select("id, username, role, active")
      .eq("id", userData.user.id)
      .single();
    if (callerError || !caller?.active) return json({ error: "Inactive user" }, 403);

    const payload = await request.json();
    const action = String(payload.action ?? "");

    if (action === "list") {
      if (caller.role !== "administrator") return json({ error: "Administrator role required" }, 403);
      const { data, error } = await adminClient
        .from("profiles")
        .select("id, username, display_name, role, active, created_at, updated_at")
        .order("username");
      if (error) throw error;
      return json({ users: data });
    }

    if (action === "create") {
      if (caller.role !== "administrator") return json({ error: "Administrator role required" }, 403);

      const username = String(payload.username ?? "").trim().toLowerCase();
      const displayName = String(payload.displayName ?? username).trim();
      const password = String(payload.password ?? "");
      const role: Role = payload.role === "administrator" ? "administrator" : "operator";

      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return json({ error: "Username must be 3-32 lowercase letters, numbers, dot, dash, or underscore" }, 400);
      }
      if (password.length < 8) return json({ error: "Password must contain at least 8 characters" }, 400);

      const email = `${username}@users.kiyometa.local`;
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          username,
          display_name: displayName,
          role,
          created_by: caller.id,
        },
      });
      if (createError) return json({ error: createError.message }, 400);

      const { error: profileError } = await adminClient.from("profiles").upsert({
        id: created.user.id,
        username,
        login_email: email,
        display_name: displayName,
        role,
        active: true,
        created_by: caller.id,
        updated_at: new Date().toISOString(),
      });
      if (profileError) {
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw profileError;
      }

      await adminClient.from("audit_logs").insert({
        user_id: caller.id,
        username: caller.username,
        action: "create_user",
        entity: "profiles",
        entity_id: created.user.id,
        new_data: { username, display_name: displayName, role, active: true },
      });
      return json({ user: { id: created.user.id, username, display_name: displayName, role, active: true } }, 201);
    }

    if (action === "reset-password") {
      if (caller.role !== "administrator") return json({ error: "Administrator role required" }, 403);
      const targetId = String(payload.userId ?? "");
      const password = String(payload.password ?? "");
      if (password.length < 8) return json({ error: "Password must contain at least 8 characters" }, 400);

      const { data: target, error: targetError } = await adminClient
        .from("profiles")
        .select("id, username, role")
        .eq("id", targetId)
        .single();
      if (targetError || !target) return json({ error: "User not found" }, 404);
      const { error } = await adminClient.auth.admin.updateUserById(targetId, { password });
      if (error) return json({ error: error.message }, 400);

      await adminClient.from("audit_logs").insert({
        user_id: caller.id,
        username: caller.username,
        action: "reset_password",
        entity: "profiles",
        entity_id: targetId,
        metadata: { target_username: target.username },
      });
      return json({ ok: true });
    }

    if (action === "update") {
      if (caller.role !== "administrator") return json({ error: "Administrator role required" }, 403);

      const targetId = String(payload.userId ?? "");
      const updates: { display_name?: string; role?: Role; active?: boolean; updated_at: string } = {
        updated_at: new Date().toISOString(),
      };
      if (typeof payload.displayName === "string") updates.display_name = payload.displayName.trim();
      if (payload.role === "administrator" || payload.role === "operator") updates.role = payload.role;
      if (typeof payload.active === "boolean") updates.active = payload.active;
      if (targetId === caller.id && (updates.role === "operator" || updates.active === false)) {
        return json({ error: "Administrators cannot demote or disable their own account" }, 400);
      }

      const { data, error } = await adminClient
        .from("profiles")
        .update(updates)
        .eq("id", targetId)
        .select("id, username, display_name, role, active")
        .single();
      if (error) return json({ error: error.message }, 400);

      await adminClient.from("audit_logs").insert({
        user_id: caller.id,
        username: caller.username,
        action: "update_user",
        entity: "profiles",
        entity_id: targetId,
        new_data: data,
      });
      return json({ user: data });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
