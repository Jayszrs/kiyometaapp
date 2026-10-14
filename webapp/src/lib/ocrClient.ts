import { supabase } from "./supabaseClient";
import { readRecovery, writeRecovery, removeRecovery } from "./recoveryStorage";

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

export function isHeicPhoto(file: File): boolean {
  return /\.(heic|heif|hif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
}

// Decode only: creating a crop preview must never start an OCR job.
export async function preparePhoto(file: File, signal: AbortSignal): Promise<Blob> {
  if (!isHeicPhoto(file)) return file;
  const body = new FormData();
  body.append("file", file);
  const response = await fetch(`${OCR_URL}/prepare-image`, {
    method: "POST", headers: await authHeaders(), body, signal,
  });
  if (!response.ok) throw responseError(response.status);
  return response.blob();
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new OcrError("timeout")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 1200);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

interface OcrRecovery { id?: string; name: string; lines?: OcrLine[] }
export const getOcrRecovery = (owner: string) => readRecovery<OcrRecovery>(owner, "ocr-job");

async function sourceFile(owner: string, file?: File, remove = false): Promise<File | undefined> {
  // IndexedDB stores the uploaded bytes, including a corrected camera image.
  // Closing during upload can then retry the same source, deduped by the server.
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kiyometa-ocr-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sources");
    request.onerror = () => reject(new Error("Could not preserve the OCR source on this device."));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("sources", file || remove ? "readwrite" : "readonly");
      const store = tx.objectStore("sources");
      const action = remove ? store.delete(owner) : file ? store.put(file, owner) : store.get(owner);
      let result: File | undefined;
      action.onsuccess = () => { result = action.result as File | undefined; };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Could not preserve the OCR source on this device.")); };
    };
  });
}
export function clearOcrRecovery(owner: string): void {
  removeRecovery(owner, "ocr-job");
  removeRecovery(owner, "scan-lines");
  removeRecovery(owner, "scan-fields");
  void sourceFile(owner, undefined, true).catch(() => {});
}

export type OcrProgress = "uploading" | "queued" | "preparing" | "recognizing" | "cleaning" | "master";

export async function runOcr(file?: File, signal?: AbortSignal, onProgress?: (stage: OcrProgress) => void): Promise<OcrLine[]> {
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
  try {
    const { data } = await supabase.auth.getSession();
    const owner = data.session?.user.id;
    if (!owner) throw new OcrError("auth");
    let recovery = file ? undefined : getOcrRecovery(owner);
    if (recovery?.lines) return recovery.lines;
    if (file) {
      await sourceFile(owner, file);
      recovery = { name: file.name };
      writeRecovery(owner, "ocr-job", recovery);
    }
    if (!recovery) throw new OcrError("service");
    headers = await authHeaders().catch(() => { throw new OcrError("auth"); });
    const upload = async () => {
      onProgress?.("uploading");
      const source = file ?? await sourceFile(owner);
      if (!source) throw new OcrError("service");
      const body = new FormData();
      body.append("file", source, recovery!.name);
      const res = await fetch(`${OCR_URL}/jobs`, { method: "POST", body, headers, signal: controller.signal });
      if (!res.ok) throw responseError(res.status);
      const accepted = await res.json();
      if (typeof accepted?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(accepted.id)) throw new OcrError("service");
      recovery = { name: recovery!.name, id: accepted.id };
      writeRecovery(owner, "ocr-job", recovery);
      jobUrl = `${OCR_URL}/jobs/${accepted.id}`;
      onProgress?.("queued");
    };
    if (recovery.id) jobUrl = `${OCR_URL}/jobs/${recovery.id}`;
    else await upload();
    let failures = 0;
    let recoveredMissingJob = false;
    while (!controller.signal.aborted) {
      let poll: Response;
      try {
        poll = await fetch(jobUrl, { headers, signal: controller.signal, cache: "no-store" });
      } catch (error) {
        if (controller.signal.aborted || ++failures >= 3) throw error;
        await pollDelay(controller.signal);
        continue;
      }
      if (poll.status === 404 && !recoveredMissingJob) {
        recoveredMissingJob = true;
        await upload(); // Service restart/retention: recover from saved bytes.
        continue;
      }
      if (!poll.ok) throw responseError(poll.status);
      failures = 0;
      const job = await poll.json();
      if (job.status === "done") {
        if (!Array.isArray(job.result?.lines)) throw new OcrError("service");
        writeRecovery(owner, "ocr-job", { ...recovery, lines: job.result.lines });
        return job.result.lines as OcrLine[];
      }
      if (job.status === "error" || job.status === "cancelled") {
        // Retry starts a new job rather than polling a terminal error forever.
        writeRecovery(owner, "ocr-job", { name: recovery!.name });
        throw new OcrError(job.error === "timeout" ? "timeout" : job.error === "unreadable" ? "unreadable"
          : job.error === "size" ? "size" : "service");
      }
      if (!["queued", "running", "cancelling"].includes(job.status)) throw new OcrError("service");
      onProgress?.(job.status === "queued" ? "queued"
        : job.stage === "preparing" ? "preparing"
        : job.stage === "queued" ? "queued" : "recognizing");
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
    // Closing the modal/app or losing connectivity detaches this poller only.
    // The server keeps processing; the durable job handle resumes on reopen.
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
