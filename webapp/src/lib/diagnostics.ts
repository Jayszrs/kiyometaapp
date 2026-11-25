import { resultCode } from "./resultCodes";

// Diagnostics contain transport metadata only, never request/response bodies.
const key = "kiyometa-diagnostics";
const startedProcesses = new Set<string>();
let flushing = false;
let flushRetryAt = 0;
let flushRetryDelay = 15_000;
const deviceKey = "kiyometa-diagnostic-device";
const currentProcessByOperation = new Map<string, string>();
const parentProcessById = new Map<string, string>();
const idempotencyKeyByProcess = new Map<string, string>();
export function newProcessId(): string { return crypto.randomUUID(); }
export function getCurrentProcessId(operation: string): string | null { return currentProcessByOperation.get(operation) ?? null; }
export function startProcess(operation: string, options: { parentProcessId?: string; idempotencyKey?: string } = {}): string {
  const processId = newProcessId();
  currentProcessByOperation.set(operation, processId);
  if (options.parentProcessId) parentProcessById.set(processId, options.parentProcessId);
  if (options.idempotencyKey) idempotencyKeyByProcess.set(processId, options.idempotencyKey);
  startedProcesses.add(processId);
  record("web", operation, "process.start", "00", { process_id: processId,
    parent_process_id: options.parentProcessId, idempotency_key: options.idempotencyKey,
    request_id: crypto.randomUUID(), device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev" });
  void (async () => {
    await refreshProcessContext(processId);
    await flushDiagnostics();
  })();
  return processId;
}
export async function refreshProcessContext(processId: string): Promise<void> {
  const { actorId, sessionId } = await getAuthContext();
  updateQueuedProcessContext(processId, { actor_id: actorId, session_id: sessionId });
}
export function startTrace(operation: string, parentProcessId?: string): string {
  const processId = startProcess(operation, { parentProcessId });
  return processId;
}
async function getAuthContext(): Promise<{ actorId?: string; sessionId?: string }> {
  try {
    const { supabase } = await import("./supabaseClient");
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const claims = token ? JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) : {};
    return { actorId: data.session?.user.id, sessionId: claims.session_id };
  } catch { return {}; }
}
export function traceQuery<T>(query: T, processId: string, operation: string): T {
  const traced = query as T & { setHeader?: (name: string, value: string) => unknown };
  if (typeof traced.setHeader === "function") {
    for (const [name, value] of Object.entries(processHeaders(processId, operation))) traced.setHeader(name, value);
  }
  return query;
}
export function processHeaders(processId: string, operation: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-process-id": processId,
    "x-process-operation": operation,
    "x-request-id": crypto.randomUUID(),
    "x-device-id": deviceId(),
    "x-app-release": import.meta.env.VITE_APP_RELEASE ?? "dev",
  };
  const parentProcessId = parentProcessById.get(processId);
  if (parentProcessId) headers["x-parent-process-id"] = parentProcessId;
  const idempotencyKey = idempotencyKeyByProcess.get(processId);
  if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
  return headers;
}
export function subscribeRealtime<T extends { subscribe: (callback?: (status: string, error?: Error) => void) => T }>(channel: T, operation: string): T {
  const name = `realtime.${operation}`;
  const processId = startProcess(name);
  const requestId = crypto.randomUUID();
  const context = { process_id: processId, request_id: requestId,
    service_host: new URL(import.meta.env.VITE_SUPABASE_URL).hostname,
    device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev" };
  record("supabase", name, "request.start", "00", context);
  return channel.subscribe((status, error) => {
    const rc = status === "SUBSCRIBED" ? "00" : status === "TIMED_OUT" ? "NET-003"
      : status === "CHANNEL_ERROR" ? "SVC-001" : status === "CLOSED" ? "CANCEL-001" : "00";
    void (async () => {
      const auth = await getAuthContext();
      record("supabase", name, "realtime.status", rc, { ...context,
        request_id: crypto.randomUUID(), realtime_status: status,
        actor_id: auth.actorId, session_id: auth.sessionId,
        error_class: error?.name, error_fingerprint: error ? await errorFingerprint(error) : undefined });
      await flushDiagnostics("supabase");
    })();
  });
}
async function errorFingerprint(error: unknown): Promise<string> {
  const value = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function traceFetch(input: RequestInfo | URL, init: RequestInit | undefined, processId: string, operation: string, source: "web" | "supabase" = "supabase"): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-device-id", deviceId());
  headers.set("x-app-release", import.meta.env.VITE_APP_RELEASE ?? "dev");
  if (!headers.has("authorization")) {
    try {
      const { supabase } = await import("./supabaseClient");
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) headers.set("authorization", `Bearer ${data.session.access_token}`);
    } catch { /* Preserve the SDK's regular authorization behavior. */ }
  }
  headers.set("x-process-id", processId);
  const parentProcessId = parentProcessById.get(processId);
  if (parentProcessId) headers.set("x-parent-process-id", parentProcessId);
  headers.set("x-process-operation", operation);
  const request = new Request(input, { ...init, headers });
  if (source === "supabase") return diagnosticFetch(request);
  return diagnosticExternalFetch(request, source);
}

async function diagnosticExternalFetch(request: Request, source: "web"): Promise<Response> {
  const processId = request.headers.get("x-process-id") ?? newProcessId();
  const operation = request.headers.get("x-process-operation") ?? "external.request";
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const started = performance.now();
  const context = { process_id: processId, parent_process_id: request.headers.get("x-parent-process-id") ?? undefined,
    request_id: requestId, service_host: url.hostname, device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev" };
  if (!startedProcesses.has(processId)) {
    startedProcesses.add(processId);
    record(source, operation, "process.start", "00", context);
  }
  record(source, operation, "request.start", "00", context);
  try {
    const response = await fetch(request);
    record(source, operation, "request.end", response.ok ? "00" : resultCode(null, response.status), { ...context, http_status: response.status, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics();
    return response;
  } catch (error) {
    record(source, operation, "request.end", resultCode(error), { ...context, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics();
    throw error;
  }
}
function deviceId(): string {
  try {
    let id = localStorage.getItem(deviceKey);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(deviceKey, id); }
    return id;
  } catch { return "unavailable"; }
}
function record(source: string, operation: string, stage: string, rc: string, extra: Record<string, unknown> = {}) {
  try {
    const queue = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
    const event = { event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), source, operation, stage, rc, origin: location.origin, device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev", message: logMessage(source, stage, rc), ...extra };
    queue.push(event);
    localStorage.setItem(key, JSON.stringify(queue.slice(-500)));
    window.dispatchEvent(new CustomEvent("kiyometa:diagnostic", { detail: event }));
    return event;
  } catch { /* Diagnostics must not block business operations. */ }
  return { event_id: "" };
}
function updateQueuedProcessContext(processId: string, values: Record<string, unknown>) {
  try {
    const queue = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
    let changed = false;
    for (const event of queue) {
      if (event.process_id !== processId) continue;
      for (const [name, value] of Object.entries(values)) {
        if (value !== undefined && event[name] === undefined) { event[name] = value; changed = true; }
      }
    }
    if (changed) localStorage.setItem(key, JSON.stringify(queue));
  } catch { /* Do not block the user action if local storage is unavailable. */ }
}
function logMessage(source: string, stage: string, rc: string): string {
  if (rc !== "00") return `Langkah ${stage} gagal dengan kode ${rc}`;
  if (stage === "process.start") return `Proses ${source} dimulai`;
  if (stage === "request.start") return `Permintaan ${source} dikirim`;
  if (stage === "request.end") return `Permintaan ${source} selesai`;
  if (stage === "frontend.failure") return `Tampilan aplikasi mengalami kegagalan`;
  return `Tahap ${source} selesai`;
}
export async function recordFrontendFailure(operation: string, error: unknown, componentStack = "") {
  let actorId: string | undefined;
  let sessionId: string | undefined;
  try {
    const { supabase } = await import("./supabaseClient");
    const { data } = await supabase.auth.getSession();
    actorId = data.session?.user.id;
    sessionId = data.session?.access_token ? JSON.parse(atob(data.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).session_id : undefined;
  } catch { /* Keep a safe local event even while authentication or network is unavailable. */ }
  const processId = currentProcessByOperation.get(operation) ?? crypto.randomUUID();
  let fingerprint = "unavailable";
  try {
    const value = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch { /* Do not store raw error text as a fallback. */ }
  record("web", operation, "frontend.failure", "SYS-001", {
    process_id: processId, request_id: crypto.randomUUID(), actor_id: actorId, session_id: sessionId,
    error_class: error instanceof Error ? error.name : typeof error,
    error_fingerprint: fingerprint, component_stack: componentStack.slice(0, 2000),
  });
  void flushDiagnostics();
}
export async function flushDiagnostics(sourceFilter?: "web" | "supabase") {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  if (Date.now() < flushRetryAt) return;
  if (flushing) return;
  flushing = true;
  try {
    const { supabase } = await import("./supabaseClient");
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    const queued = queueSnapshot();
    localStorage.setItem(key, JSON.stringify(queued));
    const queue = queued;
    if (!queue.length) return;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = queue.filter(event => !event.timestamp || Date.parse(event.timestamp) >= cutoff);
    if (recent.length !== queue.length) localStorage.setItem(key, JSON.stringify(recent));
    const batch = recent.filter(event => event.actor_id === data.session!.user.id && (!sourceFilter || event.source === sourceFilter)).slice(0, 50);
    if (!batch.length) return;
    const response = await fetch("/ocr/diagnostics", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` }, body: JSON.stringify({ events: batch }) });
    if (!response.ok) throw new Error("Diagnostics endpoint is unavailable.");
    const sent = new Set(batch.map(event => event.event_id));
    const current = JSON.parse(localStorage.getItem(key) ?? "[]") as { event_id: string }[];
    localStorage.setItem(key, JSON.stringify(current.filter(event => !sent.has(event.event_id))));
    flushRetryAt = 0;
    flushRetryDelay = 15_000;
  } catch {
    // Keep local events and back off when the OCR/log service is absent (common
    // when running only Vite locally) instead of hammering its proxy every event.
    flushRetryAt = Date.now() + flushRetryDelay;
    flushRetryDelay = Math.min(flushRetryDelay * 2, 5 * 60_000);
  }
  finally { flushing = false; }
}
export function flushOcrDiagnostics(): Promise<void> { return flushDiagnostics("web"); }
function queueSnapshot(): Array<{ event_id: string; actor_id?: string; timestamp?: string; source?: string; session_id?: string }> {
  try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
}
export async function diagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const requestId = headers.get("x-request-id") ?? crypto.randomUUID();
  headers.set("x-device-id", deviceId());
  headers.set("x-app-release", import.meta.env.VITE_APP_RELEASE ?? "dev");
  if (!headers.has("authorization") && url.pathname.startsWith("/storage/v1/")) {
    try {
      const { supabase } = await import("./supabaseClient");
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        headers.set("authorization", `Bearer ${data.session.access_token}`);
        headers.set("x-session-id", JSON.parse(atob(data.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).session_id ?? "");
      }
    } catch { /* Keep the SDK's normal auth behavior if local session lookup fails. */ }
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const signedBucket = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)/)?.[1];
  const operation = headers.get("x-process-operation") ?? (signedBucket
    ? `storage.${signedBucket}.sign`
    : url.pathname.startsWith("/rest/v1/") || url.pathname.startsWith("/storage/v1/") || url.pathname.includes("/functions/v1/") || url.pathname.startsWith("/auth/v1/")
      ? `supabase.${method.toLowerCase()}` : `${method} ${safePath(url.pathname)}`);
  const authProcess = url.pathname.endsWith("/token") && method === "POST" ? currentProcessByOperation.get("auth.login")
    : url.pathname.endsWith("/logout") ? currentProcessByOperation.get("auth.logout") : undefined;
  const activeProcess = headers.get("x-process-id") ?? currentProcessByOperation.get(operation) ?? authProcess ?? crypto.randomUUID();
  const processOperation = authProcess ? (url.pathname.endsWith("/token") ? "auth.login" : "auth.logout") : operation;
  headers.set("x-process-id", activeProcess);
  const parentProcessId = headers.get("x-parent-process-id") ?? parentProcessById.get(activeProcess);
  if (parentProcessId) headers.set("x-parent-process-id", parentProcessId);
  const idempotencyKey = headers.get("x-idempotency-key") ?? idempotencyKeyByProcess.get(activeProcess);
  if (idempotencyKey) headers.set("x-idempotency-key", idempotencyKey);
  headers.set("x-request-id", requestId);
  headers.set("x-process-operation", processOperation);
  const started = performance.now();
  const source = url.pathname.startsWith("/ocr") ? "web" : "supabase";
  let actorId: string | undefined;
  try {
    const token = headers.get("authorization")?.replace(/^Bearer /i, "");
    if (token) actorId = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
  } catch { /* Auth server remains the authority for identity. */ }
  let claims: Record<string, unknown> = {};
  try {
    const token = headers.get("authorization")?.replace(/^Bearer /i, "");
    if (token) claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch { /* Auth server remains the authority for identity. */ }
  if (!headers.has("authorization") && url.pathname.startsWith("/ocr/")) {
    try {
      const { supabase } = await import("./supabaseClient");
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        headers.set("authorization", `Bearer ${data.session.access_token}`);
        actorId = data.session.user.id;
        claims = JSON.parse(atob(data.session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        if (typeof claims.session_id === "string") headers.set("x-session-id", claims.session_id);
      }
    } catch { /* Continue with the request's original auth behavior. */ }
  }
  const context = { process_id: activeProcess, request_id: requestId, service_host: url.hostname, actor_id: actorId,
    session_id: typeof claims.session_id === "string" ? claims.session_id : undefined,
    device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev" };
  if (!startedProcesses.has(activeProcess)) {
    startedProcesses.add(activeProcess);
    record(source, processOperation, "process.start", "00", context);
  }
  record(source, processOperation, "request.start", "00", context);
  void flushDiagnostics(source);
  if (init?.signal?.aborted) {
    record(source, processOperation, "request.end", "CANCEL-001", { ...context, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics(source);
    return fetch(input, { ...init, headers });
  }
  try {
    const response = await fetch(input, { ...init, headers });
    const responseRc = response.ok ? "00" : source === "web" && url.pathname.startsWith("/ocr/") && [400, 422].includes(response.status)
      ? "OCR-001" : resultCode(null, response.status);
    record(source, processOperation, "request.end", responseRc, { ...context, http_status: response.status, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics(source);
    return response;
  } catch (error) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method) && (url.pathname.startsWith("/rest/v1/") || url.pathname.includes("/functions/v1/"));
    const rc = mutating ? "TXN-001" : resultCode(error);
    record(source, processOperation, "request.end", rc, { ...context, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics(source);
    throw error;
  }
}
function safePath(path: string): string {
  if (path.startsWith("/storage/v1/object/")) return "/storage/v1/object/:object";
  return path.replace(/\/ocr\/jobs\/[^/]+/g, "/ocr/jobs/:job_id")
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:id");
}
window.addEventListener("online", () => void flushDiagnostics());
window.setInterval(() => void flushDiagnostics(), 15000);
