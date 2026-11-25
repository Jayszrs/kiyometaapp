import { resultCode } from "./resultCodes";

// Diagnostics contain transport metadata only, never request/response bodies.
const key = "kiyometa-diagnostics";
const startedProcesses = new Set<string>();
let flushing = false;
const deviceKey = "kiyometa-diagnostic-device";
const currentProcessByOperation = new Map<string, string>();
export function newProcessId(): string { return crypto.randomUUID(); }
export function getCurrentProcessId(operation: string): string | null { return currentProcessByOperation.get(operation) ?? null; }
export function startProcess(operation: string, parentProcessId?: string): string {
  const processId = newProcessId();
  currentProcessByOperation.set(operation, processId);
  if (parentProcessId) currentProcessByOperation.set(`parent:${operation}`, parentProcessId);
  if (parentProcessId) currentProcessByOperation.set(`request-parent:${processId}`, parentProcessId);
  startedProcesses.add(processId);
  void (async () => {
    const { actorId, sessionId } = await getAuthContext();
    record("web", operation, "process.start", "00", { process_id: processId,
      parent_process_id: parentProcessId ?? undefined, request_id: crypto.randomUUID(), actor_id: actorId,
      session_id: sessionId, device_id: deviceId(), release_id: import.meta.env.VITE_APP_RELEASE ?? "dev" });
    await flushDiagnostics();
  })();
  return processId;
}
export function startTrace(operation: string, parentProcessId?: string): string {
  const processId = startProcess(operation, parentProcessId);
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
    traced.setHeader("x-process-id", processId);
    traced.setHeader("x-parent-process-id", currentProcessByOperation.get(`request-parent:${processId}`) ?? processId);
    traced.setHeader("x-process-operation", operation);
    traced.setHeader("x-request-id", crypto.randomUUID());
    traced.setHeader("x-device-id", deviceId());
    traced.setHeader("x-app-release", import.meta.env.VITE_APP_RELEASE ?? "dev");
  }
  return query;
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
  headers.set("x-parent-process-id", processId);
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
  const context = { process_id: processId, parent_process_id: request.headers.get("x-parent-process-id") ?? processId,
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
  } catch { /* Diagnostics must not block business operations. */ }
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
    if (response.ok) {
      const sent = new Set(batch.map(event => event.event_id));
      const current = JSON.parse(localStorage.getItem(key) ?? "[]") as { event_id: string }[];
      localStorage.setItem(key, JSON.stringify(current.filter(event => !sent.has(event.event_id))));
    }
  } catch { /* Retain bounded events until the next connection. */ }
  finally { flushing = false; }
}
export function flushOcrDiagnostics(): Promise<void> { return flushDiagnostics("web"); }
function queueSnapshot(): Array<{ event_id: string; actor_id?: string; timestamp?: string; source?: string; session_id?: string }> {
  try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; }
}
export async function diagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  const requestId = crypto.randomUUID();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
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
  const operation = headers.get("x-process-operation") ?? (url.pathname.startsWith("/rest/v1/") || url.pathname.startsWith("/storage/v1/") || url.pathname.includes("/functions/v1/") || url.pathname.startsWith("/auth/v1/")
    ? `supabase.${method.toLowerCase()}` : `${method} ${safePath(url.pathname)}`);
  const activeProcess = headers.get("x-process-id") ?? currentProcessByOperation.get(operation) ?? currentProcessByOperation.get(`parent:${operation}`) ?? crypto.randomUUID();
  headers.set("x-process-id", activeProcess);
  headers.set("x-parent-process-id", headers.get("x-parent-process-id") ?? currentProcessByOperation.get(`request-parent:${activeProcess}`) ?? currentProcessByOperation.get(`parent:${operation}`) ?? activeProcess);
  headers.set("x-request-id", requestId);
  headers.set("x-process-operation", operation);
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
  if (init?.signal?.aborted) return fetch(input, { ...init, headers });
  if (!startedProcesses.has(activeProcess)) {
    startedProcesses.add(activeProcess);
    record(source, operation, "process.start", "00", context);
  }
  record(source, operation, "request.start", "00", context);
  void flushDiagnostics(source);
  try {
    const response = await fetch(input, { ...init, headers });
    const responseRc = response.ok ? "00" : source === "web" && url.pathname.startsWith("/ocr/") && [400, 422].includes(response.status)
      ? "OCR-001" : resultCode(null, response.status);
    record(source, operation, "request.end", responseRc, { ...context, http_status: response.status, duration_ms: Math.round(performance.now() - started) });
    void flushDiagnostics(source);
    return response;
  } catch (error) {
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method) && (url.pathname.startsWith("/rest/v1/") || url.pathname.includes("/functions/v1/"));
    const rc = mutating ? "TXN-001" : resultCode(error);
    record(source, operation, "request.end", rc, { ...context, duration_ms: Math.round(performance.now() - started) });
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
