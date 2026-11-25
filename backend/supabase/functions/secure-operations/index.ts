import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-process-id, x-parent-process-id, x-request-id, x-process-operation, x-device-id, x-app-release, x-session-id, x-idempotency-key",
};

type Action = "record-stock-movement" | "save-production-task" | "undo-audit-entry" | "update-own-profile";
type Trace = {
  processId: string;
  parentProcessId?: string;
  requestId: string;
  operation: string;
  deviceId: string;
  releaseId: string;
  sessionId?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function safeErrorCode(error: { code?: string; status?: number }): string {
  if (error.code === "42501") return "AUTH-002";
  if (error.code === "23505") return "DATA-002";
  if (error.code === "P0002") return "DATA-001";
  if (error.code === "23503" || error.code === "23514") return "BIZ-001";
  if (error.code?.startsWith("22")) return "VAL-002";
  if (error.status === 401) return "AUTH-001";
  if (error.status === 403) return "AUTH-002";
  return "SVC-001";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "VAL-002" }, 405);

  const processId = request.headers.get("x-process-id") ?? crypto.randomUUID();
  const trace: Trace = {
    processId,
    parentProcessId: request.headers.get("x-parent-process-id") ?? undefined,
    requestId: request.headers.get("x-request-id") ?? crypto.randomUUID(),
    operation: request.headers.get("x-process-operation") ?? "secure-operation",
    deviceId: request.headers.get("x-device-id") ?? "unknown",
    releaseId: request.headers.get("x-app-release") ?? "unknown",
    sessionId: request.headers.get("x-session-id") ?? undefined,
  };
  const log = (stage: string, rc: string, durationMs = 0, actorId?: string) => {
    console.log(JSON.stringify({
      process_id: trace.processId,
      parent_process_id: trace.parentProcessId,
      request_id: trace.requestId,
      operation: trace.operation,
      stage,
      rc,
      duration_ms: Math.round(durationMs),
      actor_id: actorId,
      device_id: trace.deviceId,
      release_id: trace.releaseId,
    }));
  };

  const started = performance.now();
  log("request.start", "00");
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      log("request.end", "SVC-001", performance.now() - started);
      return json({ error: "SVC-001" }, 500);
    }

    const authorization = request.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      log("request.end", "AUTH-001", performance.now() - started);
      return json({ error: "AUTH-001" }, 401);
    }

    const traceHeaders = new Headers();
    for (const header of [
      "x-process-id", "x-parent-process-id", "x-request-id", "x-process-operation",
      "x-device-id", "x-app-release", "x-session-id", "x-idempotency-key",
    ]) {
      const value = request.headers.get(header);
      if (value) traceHeaders.set(header, value);
    }
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const serviceClient = createClient(supabaseUrl, serviceKey, {
      global: { headers: Object.fromEntries(traceHeaders) },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: authData, error: authError } = await callerClient.auth.getUser();
    if (authError || !authData.user) {
      log("request.end", "AUTH-001", performance.now() - started);
      return json({ error: "AUTH-001" }, 401);
    }

    const { data: profile, error: profileError } = await serviceClient
      .from("profiles")
      .select("id, active")
      .eq("id", authData.user.id)
      .maybeSingle();
    if (profileError || !profile?.active) {
      log("request.end", "AUTH-002", performance.now() - started, authData.user.id);
      return json({ error: "AUTH-002" }, 403);
    }

    const body: unknown = await request.json();
    if (!isObject(body) || typeof body.action !== "string" || !isObject(body.input)) {
      log("request.end", "VAL-002", performance.now() - started, authData.user.id);
      return json({ error: "VAL-002" }, 400);
    }
    const action = body.action as Action;
    if (!["record-stock-movement", "save-production-task", "undo-audit-entry", "update-own-profile"].includes(action)) {
      log("request.end", "VAL-002", performance.now() - started, authData.user.id);
      return json({ error: "VAL-002" }, 400);
    }

    const { data, error } = await serviceClient.rpc("execute_user_operation", {
      p_action: action,
      p_actor_id: authData.user.id,
      p_input: body.input,
    });
    if (error) {
      const rc = safeErrorCode(error);
      log("request.end", rc, performance.now() - started, authData.user.id);
      return json({ error: rc }, rc === "AUTH-002" ? 403 : rc === "DATA-001" ? 404 : rc === "CON-001" ? 409 : rc === "SVC-001" ? 500 : 400);
    }

    log("request.end", "00", performance.now() - started, authData.user.id);
    return json(data);
  } catch {
    log("request.end", "SVC-001", performance.now() - started);
    return json({ error: "SVC-001" }, 500);
  }
});
