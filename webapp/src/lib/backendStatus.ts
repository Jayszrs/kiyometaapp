type BackendAvailability = "unknown" | "ready" | "migration-required";

let operationsBackend: BackendAvailability = "unknown";

export function getOperationsBackendStatus(): BackendAvailability {
  return operationsBackend;
}

export function markOperationsBackendReady(): void {
  operationsBackend = "ready";
}

export function markOperationsMigrationRequired(): void {
  operationsBackend = "migration-required";
}

export function isMissingOperationsSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  const text = `${candidate.message ?? ""} ${candidate.details ?? ""}`.toLowerCase();
  return candidate.code === "42P01" || candidate.code === "PGRST205" ||
    text.includes("could not find the table") || text.includes("schema cache");
}

export const OPERATIONS_SETUP_MESSAGE =
  "Backend feature belum diaktifkan. Jalankan migration 002 di Supabase lalu deploy Edge Function manage-users.";
