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

export async function runOcr(file: File): Promise<OcrLine[]> {
  const body = new FormData();
  body.append("file", file);

  let res: Response;
  try {
    res = await fetch(OCR_URL, { method: "POST", body, headers: await authHeaders() });
  } catch (err) {
    if (err instanceof Error && err.message === "Sign in to use OCR.") throw err;
    throw new Error(
      `Could not reach the OCR service at ${OCR_URL}. Is it running?`,
    );
  }

  if (!res.ok) {
    let msg = `OCR failed (HTTP ${res.status})`;
    try {
      const j = await res.json();
      if (j && typeof j.detail === "string") msg = j.detail;
    } catch {}
    throw new Error(msg);
  }

  const j = await res.json();
  if (!Array.isArray(j?.lines)) {
    throw new Error("OCR service returned an unexpected response.");
  }
  return j.lines as OcrLine[];
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