# Kiyometa logging guide

This guide describes the diagnostics code in this branch. It is not active in production until the branch is released, the Supabase migration is applied, and the Edge Function secret below is set. A small local demo can show the event format before rollout, but it does not exercise network delivery or production storage.

## Find one complete process

Every traced user action, including grouped data loads, writes a `process.start` event with a UUID `process_id`. Requests made by that action carry the same ID. Service requests and audit rows also carry a `request_id`; OCR upload and polling share the OCR scan process ID. A stable idempotency key is recorded as the parent process reference for order and production task retries.

First find the root event, optionally filter by operation, then copy the `process_id` and search all files:

```sh
grep -R '"stage":"process.start"' /srv/kiyometa/logs
grep -R '"stage":"process.start"' /srv/kiyometa/logs | grep '"operation":"order.submit"'
grep -R -F 'PASTE_PROCESS_ID_HERE' /srv/kiyometa/logs
```

JSONL is emitted compactly (no spaces around separators). The parent event and child service events may be in separate files. This is exactly the intended parent-first workflow. A process describes one user action/request-retry lifecycle, not the complete lifetime of a product or BOM. Use `lifecycle_id` in database audit metadata to follow changes to the same business record across separate actions.

To inspect a local sample without contacting Supabase, run `await import('/src/lib/diagnosticsDemo.ts')` in the browser console while the local Vite dev server is open. The module prints a demo `process_id` and four sample rows. It stores them under a separate demo key. The app collector never sends that key. Run `clearKiyometaDiagnosticDemo()` in the console to remove the sample.

## Live and retained logs

Logs are centralized in `/srv/kiyometa/logs` on the application host and mounted into the OCR container at `/logs`.

| File | What it contains | How it gets there |
|---|---|---|
| `web.log` | Frontend process starts and UI failures | Buffered on the device and posted to the authenticated collector after connectivity returns |
| `supabase.log` | Frontend Supabase HTTP requests that use the traced fetch path and internal `manage-users` Edge Function calls | Frontend collector plus Edge Function collector; Edge logs also appear in Supabase Edge Function logs |
| `ocr.log` | OCR service request timing and scan job stages/outcomes | Written by the OCR service directly |
| `deploy.log` | Auto-deploy fetch/build/start output | Written by the host deploy script |

Follow events in real time:

```sh
tail -F /srv/kiyometa/logs/web.log /srv/kiyometa/logs/supabase.log /srv/kiyometa/logs/ocr.log /srv/kiyometa/logs/deploy.log
```

The OCR writer rotates an active file at 10 MiB and keeps each source below 100 MiB, deleting archives after 90 days or sooner if a size cap is reached. The auto-deploy script rotates `deploy.log` at 10 MiB and retains at most ten rotated files, deleting files older than 90 days. These limits intentionally cap disk use; 90 days is the maximum age, not a guaranteed minimum retention under heavy volume.

## Event fields and trust

Events are JSON lines. Useful fields include `timestamp`, `received_at`, `source`, `stage`, `operation`, `rc`, `process_id`, `parent_process_id`, `request_id`, `lifecycle_id`, `related_lifecycle_ids`, `actor_id`, `session_id`, `device_id`, `release_id`, `service_host`, `hostname`, `http_status`, `duration_ms`, `error_class`, and `error_fingerprint`.

`actor_id` at the collector is derived from a verified Supabase access token. The browser `device_id` is a locally generated installation identifier; it is not the device's hardware ID or IP address. `hostname` identifies the OCR container. `client_ip` is the client address passed by the trusted Nginx proxy. Frontend events describe what the client attempted or observed; they do not prove that a database transaction committed. A database audit row written in the same transaction as the data change is the commit evidence. An HTTP timeout leaves a write outcome uncertain until its receipt or current database state is checked.

The collector allowlists metadata fields and excludes request/response bodies, credentials, passwords, document names, OCR text, and business payloads. The frontend keeps at most 500 queued events per browser storage and expires them after 30 days. Events are sent in batches of 50 when online. If the queue fills while a device is offline, oldest entries are discarded. Diagnostics never block business actions.

## Supabase audit correlation

`backend/supabase/migrations/20261125090000_audit_request_context.sql` adds process/request/session/device/release/operation and business-record lifecycle context to the existing `audit_logs.metadata` using a `BEFORE INSERT` trigger. The trigger runs inside the audit insert transaction, so it does not create a separate, partially committed audit record. Existing audit snapshots and undo behavior remain the source of historical changes.

The migration must be applied to the same Supabase project as the app. It does not create a Supabase log file. `supabase.log` is Kiyometa's copy of traced service-call metadata. Supabase's own platform logs remain separately available in the Supabase dashboard. Some SDK calls may bypass the traced fetch path; verify representative read/write/Storage calls in a deployed preview before claiming complete HTTP coverage.

## Enable Edge Function forwarding

Set this secret on the same Supabase project, using the production application URL:

```sh
supabase secrets set KIYOMETA_DIAGNOSTICS_URL=https://kiyometa.smartbsd.my.id/ocr/diagnostics --project-ref YOUR_PROJECT_REF
```

Deploy the updated function after releasing the branch:

```sh
supabase functions deploy manage-users --project-ref YOUR_PROJECT_REF
```

Without the secret, Edge events still appear in Supabase Edge Function logs as structured JSON but are not copied to `/srv/kiyometa/logs/supabase.log`. Collector delivery is best-effort and must not fail a user action.

## Return codes and investigation

See [result-codes.md](result-codes.md) for the implemented RC mapping and user-facing messages. RC identifies the observed step outcome; HTTP status remains a separate field. `00` on `request.start` means only that the request was sent. It is not a transaction-success receipt.

For a report such as “the product disappeared” or “the total is wrong”:

1. Ask for the approximate time, account, module, and action. Do not ask for passwords or document contents.
2. Search `process.start` by operation and time, then search all files by the resulting process ID.
3. Compare frontend request events with OCR/Edge events and database audit rows using `request_id`, `process_id`, and `lifecycle_id`.
4. If a Supabase request ended with a transport/5xx failure, check the audit row or current record before retrying. A timeout alone cannot prove rollback.
5. Compare `release_id` to the deployed commit to locate the code version. Use `error_fingerprint` to group the same frontend failure without retaining raw error details.

## Rollout and rollback

1. Back up the Supabase database and apply the migration to the intended project.
2. Set `KIYOMETA_DIAGNOSTICS_URL` and deploy `manage-users`.
3. Release the frontend/OCR branch to the intended server and confirm `/srv/kiyometa/logs` is mounted and writable.
4. Verify one read, one data update, one OCR scan, and one undo using a test account; inspect each process across the files and confirm the matching audit row.
5. Monitor disk use and configure rotation for `deploy.log`.

Rollback the app release first if needed. The migration rollback removes only the correlation trigger/function/indexes; it leaves existing audit records intact. Edge Function forwarding can be stopped by unsetting the secret. Keep the existing audit log and its policies enabled.

## English service naming

The log fields and operation names are technical identifiers and remain in English for grep consistency. Human-readable `message` values are Indonesian. User interface messages follow the selected Japanese/English language.
