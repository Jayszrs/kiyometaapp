import { supabase } from "./supabaseClient";

type BackendAvailability = "unknown" | "ready" | "migration-required";

let operationsBackend: BackendAvailability = "unknown";
let operationsProbe: Promise<boolean> | null = null;

export function getOperationsBackendStatus(): BackendAvailability {
  return operationsBackend;
}

export function markOperationsBackendReady(): void {
  operationsBackend = "ready";
}

export function markOperationsMigrationRequired(): void {
  operationsBackend = "migration-required";
}

export async function probeOperationsBackend(force = false): Promise<boolean> {
  if (!force && operationsBackend === "ready") return true;
  if (operationsProbe) return operationsProbe;

  operationsProbe = (async () => {
    const [{ error: profilesError }, { error: numbersError }] = await Promise.all([
      supabase.from("profiles").select("id").limit(1),
      supabase.from("stock_movements").select("movement_no").limit(1),
    ]);
    const error = profilesError ?? numbersError;
    if (!error) {
      markOperationsBackendReady();
      return true;
    }
    if (isMissingOperationsSchema(error)) {
      markOperationsMigrationRequired();
      return false;
    }
    throw error;
  })();

  try {
    return await operationsProbe;
  } finally {
    operationsProbe = null;
  }
}

export function isMissingOperationsSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string; details?: string };
  const text = `${candidate.message ?? ""} ${candidate.details ?? ""}`.toLowerCase();
  return candidate.code === "42P01" || candidate.code === "42703" ||
    candidate.code === "PGRST204" || candidate.code === "PGRST205" ||
    text.includes("could not find the table") || text.includes("could not find the") ||
    text.includes("schema cache");
}

export const MIGRATION_REQUIRED_MESSAGE =
  "Migration backend belum lengkap. Jalankan migration 001, 002, lalu 003 di project Supabase yang dipakai aplikasi, kemudian klik Check again.";

export const EDGE_FUNCTION_REQUIRED_MESSAGE =
  "Database sudah siap, tetapi Edge Function manage-users belum dapat diakses. Deploy function tersebut ke project Supabase yang sama, lalu klik Check again.";
