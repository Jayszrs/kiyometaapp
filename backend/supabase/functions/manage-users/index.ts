import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-process-id, x-parent-process-id, x-request-id, x-process-operation, x-device-id, x-app-release, x-session-id",
};

type Role = "administrator" | "operator";

function tracedFetch(input: RequestInfo | URL, init: RequestInit | undefined, trace: {
  processId: string; parentProcessId: string; deviceId: string; releaseId: string; sessionId: string; token: string;
}, source = "supabase") {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const requestId = crypto.randomUUID();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-process-id", trace.processId);
  headers.set("x-parent-process-id", trace.parentProcessId || trace.processId);
  headers.set("x-request-id", requestId);
  headers.set("x-device-id", trace.deviceId);
  headers.set("x-app-release", trace.releaseId);
  if (trace.sessionId) headers.set("x-session-id", trace.sessionId);
  const safePath = url.pathname
    .replace(/\/range\/[0-9a-f]{5}/gi, "/range/:prefix")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
  const operation = `${method} ${safePath}`;
  const started = performance.now();
  const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil(task: Promise<unknown>): void } }).EdgeRuntime;
  const emit = (stage: string, rc: string, status = 0, duration = 0) => {
    const event = { event_id: crypto.randomUUID(), process_id: trace.processId,
      parent_process_id: trace.parentProcessId || trace.processId, request_id: requestId,
      operation, stage, rc, http_status: status, duration_ms: Math.round(duration),
      service_host: url.hostname, device_id: trace.deviceId, release_id: trace.releaseId };
    const endpoint = Deno.env.get("KIYOMETA_DIAGNOSTICS_URL");
    const delivery = endpoint && trace.token
      ? fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${trace.token}` }, body: JSON.stringify({ events: [{ ...event, source: "supabase" }] }), signal: AbortSignal.timeout(2500) }).catch(() => undefined)
      : Promise.resolve();
    if (runtime) runtime.waitUntil(delivery);
    // Supabase Edge Function logs remain a diagnostic fallback when the file collector is unreachable.
    console.log(JSON.stringify({ ...event, source, message: rc === "00" ? `Langkah ${stage} selesai` : `Langkah ${stage} gagal dengan kode ${rc}` }));
  };
  emit("request.start", "00");
  return fetch(input, { ...init, headers }).then(response => {
    const status = response.status;
    const rc = response.ok ? "00" : status === 401 ? "AUTH-001" : status === 403 ? "AUTH-002" : status === 404 ? "DATA-001" : status === 429 ? "SVC-002" : status === 400 || status === 422 ? "VAL-002" : status >= 500 ? "SVC-001" : "SYS-001";
    emit("request.end", rc, status, performance.now() - started);
    return response;
  }, error => {
    emit("request.end", "NET-002", 0, performance.now() - started);
    throw error;
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function publicError(status: number, code: string) {
  return json({ error: code }, status);
}

// Leaked-password guard, same purpose as the paid Supabase Auth toggle but
// calling HIBP's keyless k-anonymity API directly: only the first 5 hex chars
// of the password's SHA-1 leave this server. -1 (unreachable) fails open so a
// HIBP outage never blocks account creation.
const kRangeUrl = "https://api.pwnedpasswords.com/range/";
async function breachedPasswordCount(password: string, trace: Parameters<typeof tracedFetch>[2]): Promise<number> {
  try {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    const response = await tracedFetch(`${kRangeUrl}${hex.slice(0, 5)}`, { signal: AbortSignal.timeout(6000) }, trace, "web");
    if (!response.ok) return -1;
    const suffix = hex.slice(5);
    const body = await response.text();
    for (const line of body.split("\n")) {
      const [candidate, count] = line.split(":");
      if (candidate === suffix) return Number(count || 0);
    }
    return 0;
  } catch {
    return -1;
  }
}

async function rejectBreachedPassword(password: string, trace: Parameters<typeof tracedFetch>[2]): Promise<Response | null> {
  const breached = await breachedPasswordCount(password, trace);
  if (breached <= 0) return null;
  return json({
    error: `This password appears in ${breached} known data breaches. Choose a different password.`,
  }, 400);
}

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = request.headers.get("Authorization") ?? "";
    const traceHeaders = Object.fromEntries(["x-process-id", "x-parent-process-id", "x-request-id", "x-device-id", "x-app-release"]
      .map(name => [name, request.headers.get(name) ?? ""])
      .filter(([, value]) => value));
    const processId = request.headers.get("x-process-id") ?? crypto.randomUUID();
    const trace = {
      processId,
      parentProcessId: request.headers.get("x-parent-process-id") ?? processId,
      deviceId: request.headers.get("x-device-id") ?? "unknown",
      releaseId: request.headers.get("x-app-release") ?? "unknown",
      sessionId: request.headers.get("x-session-id") ?? "",
      token: authorization.replace(/^Bearer\s+/i, ""),
    };

    if (!authorization.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization }, fetch: (input, init) => tracedFetch(input, init, trace) },
      auth: { persistSession: false },
    });
    const adminClient = createClient(supabaseUrl, serviceKey, {
      global: { headers: traceHeaders, fetch: (input, init) => tracedFetch(input, init, trace) },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return publicError(401, "AUTH-001");

    const { data: caller, error: callerError } = await adminClient
      .from("profiles")
      .select("id, username, role, active")
      .eq("id", userData.user.id)
      .single();
    if (callerError || !caller?.active) return publicError(403, "AUTH-002");

    const payload = await request.json();
    const action = String(payload.action ?? "");

    if (action === "list") {
      if (caller.role !== "administrator") return publicError(403, "AUTH-002");
      const { data, error } = await adminClient
        .from("profiles")
        .select("id, username, display_name, role, active, created_at, updated_at")
        .order("username");
      if (error) throw error;
      return json({ users: data });
    }

    if (action === "create") {
      if (caller.role !== "administrator") return publicError(403, "AUTH-002");

      const username = String(payload.username ?? "").trim().toLowerCase();
      const displayName = String(payload.displayName ?? username).trim();
      const password = String(payload.password ?? "");
      const role: Role = payload.role === "administrator" ? "administrator" : "operator";

      if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
        return publicError(400, "VAL-002");
      }
      if (password.length < 8) return publicError(400, "VAL-002");
      const breached = await rejectBreachedPassword(password, trace);
      if (breached) return breached;

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
      if (createError) return publicError(400, createError.code === "email_exists" ? "DATA-002" : "VAL-002");

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
      if (caller.role !== "administrator") return publicError(403, "AUTH-002");
      const targetId = String(payload.userId ?? "");
      const password = String(payload.password ?? "");
      if (password.length < 8) return publicError(400, "VAL-002");
      const breached = await rejectBreachedPassword(password, trace);
      if (breached) return breached;

      const { data: target, error: targetError } = await adminClient
        .from("profiles")
        .select("id, username, role")
        .eq("id", targetId)
        .single();
      if (targetError || !target) return publicError(404, "DATA-001");
      const { error } = await adminClient.auth.admin.updateUserById(targetId, { password });
      if (error) return publicError(400, "VAL-002");

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
      if (caller.role !== "administrator") return publicError(403, "AUTH-002");

      const targetId = String(payload.userId ?? "");
      const updates: { display_name?: string; role?: Role; active?: boolean; updated_at: string } = {
        updated_at: new Date().toISOString(),
      };
      if (typeof payload.displayName === "string") updates.display_name = payload.displayName.trim();
      if (payload.role === "administrator" || payload.role === "operator") updates.role = payload.role;
      if (typeof payload.active === "boolean") updates.active = payload.active;
      if (targetId === caller.id && (updates.role === "operator" || updates.active === false)) {
        return publicError(400, "BIZ-001");
      }

      const { data, error } = await adminClient
        .from("profiles")
        .update(updates)
        .eq("id", targetId)
        .select("id, username, display_name, role, active")
        .single();
      if (error) return publicError(400, "VAL-002");

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

    return publicError(400, "VAL-002");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505" ? "DATA-002" : "SVC-001";
    return publicError(500, code);
  }
});
