import { supabase } from "./supabaseClient";
import { AppError, resultCode } from "./resultCodes";
import { processHeaders } from "./diagnostics";

type SecureOperation =
  | "record-stock-movement"
  | "save-production-task"
  | "undo-audit-entry"
  | "update-own-profile";

export async function invokeSecureOperation<T>(
  action: SecureOperation,
  input: Record<string, unknown>,
  processId: string,
  operation: string,
): Promise<T> {
  const headers = processHeaders(processId, operation);
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (token) {
    try {
      const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as { session_id?: string };
      if (claims.session_id) headers["x-session-id"] = claims.session_id;
    } catch {
      // The Edge Function validates the token. Session logging can fall back
      // to the Edge request id if the local token claims cannot be decoded.
    }
  }
  const invoke = () => supabase.functions.invoke("secure-operations", { body: { action, input }, headers });
  let { data, error } = await invoke();
  let response = (error as (Error & { context?: Response }) | null)?.context;
  if (response instanceof Response && response.status === 401) {
    const refreshed = await supabase.auth.refreshSession();
    if (!refreshed.error && refreshed.data.session) {
      ({ data, error } = await invoke());
      response = (error as (Error & { context?: Response }) | null)?.context;
    }
  }

  if (error) {
    const status = response instanceof Response ? response.status : 0;
    let remoteCode: unknown;
    if (response instanceof Response) {
      try {
        remoteCode = (await response.clone().json())?.error;
      } catch {
        remoteCode = undefined;
      }
    }
    const rc = typeof remoteCode === "string"
      ? remoteCode
      : error.name === "FunctionsFetchError" ? "NET-002" : resultCode(error, status);
    throw new AppError(rc);
  }

  return data as T;
}
