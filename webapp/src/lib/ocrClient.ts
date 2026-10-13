import { supabase } from "./supabaseClient";

export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  page?: number;
}

// VITE_OCR_URL override, otherwise same-origin /ocr (hosted behind a reverse proxy).
const OCR_BASE: string =
  (import.meta.env.VITE_OCR_URL as string | undefined) ?? window.location.origin;
const OCR_URL: string = `${OCR_BASE}/ocr`;

// The service verifies this token, so a request without one is rejected with
// 401. There is no cache here: the OCR call is a rare, user-initiated action and
// a stale or missing header would surface as a confusing failure.
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in to use OCR.");
  return { Authorization: `Bearer ${token}` };
}

export class OcrError extends Error {
  constructor(public kind: "timeout" | "unreadable" | "auth" | "busy" | "size" | "service") {
    super(kind);
  }
}

function responseError(status: number): OcrError {
  console.error("OCR response", status);
  return new OcrError([408, 504, 524].includes(status) ? "timeout"
    : status === 422 || status === 400 ? "unreadable"
    : status === 401 || status === 403 ? "auth"
    : status === 429 ? "busy" : status === 413 ? "size" : "service");
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new OcrError("timeout")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1200);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function runOcr(file: File, signal?: AbortSignal): Promise<OcrLine[]> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  // Backend jobs have a 300s budget. Leave time for the terminal poll rather
  // than cutting off a still-valid result at 90s.
  const timer = window.setTimeout(cancel, 330000);
  const started = performance.now();
  let jobUrl = "";
  let headers: Record<string, string> = {};
  let completed = false;
  try {
    const body = new FormData();
    body.append("file", file);
    headers = await authHeaders().catch(() => { throw new OcrError("auth"); });
    const res = await fetch(`${OCR_URL}/jobs`, { method: "POST", body, headers, signal: controller.signal });
    if (!res.ok) throw responseError(res.status);
    const accepted = await res.json();
    if (typeof accepted?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(accepted.id)) throw new OcrError("service");
    jobUrl = `${OCR_URL}/jobs/${accepted.id}`;
    let failures = 0;
    while (!controller.signal.aborted) {
      let poll: Response;
      try {
        poll = await fetch(jobUrl, { headers, signal: controller.signal, cache: "no-store" });
      } catch (error) {
        if (controller.signal.aborted || ++failures >= 3) throw error;
        await pollDelay(controller.signal);
        continue;
      }
      if (!poll.ok) throw responseError(poll.status);
      failures = 0;
      const job = await poll.json();
      if (job.status === "done") {
        if (!Array.isArray(job.result?.lines)) throw new OcrError("service");
        completed = true;
        return job.result.lines as OcrLine[];
      }
      if (job.status === "error" || job.status === "cancelled") {
        completed = true;
        throw new OcrError(job.error === "timeout" ? "timeout" : job.error === "unreadable" ? "unreadable"
          : job.error === "size" ? "size" : "service");
      }
      if (!["queued", "running", "cancelling"].includes(job.status)) throw new OcrError("service");
      await pollDelay(controller.signal);
    }
    throw new OcrError("timeout");
  } catch (error) {
    console.error("OCR diagnostic", error);
    if (error instanceof OcrError) throw error;
    throw new OcrError(controller.signal.aborted ? "timeout" : "service");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (jobUrl && !completed) {
      // Separate signal: the poll controller is already aborted on close.
      void fetch(jobUrl, { method: "DELETE", headers, keepalive: true }).catch(() => {});
    }
    console.info("OCR request duration", Math.round(performance.now() - started), "ms");
  }
}

export async function sendOcrLog(message: string): Promise<void> {
  try {
    await fetch(`${OCR_BASE}/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ message }),
    });
  } catch {}
}