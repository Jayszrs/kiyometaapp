# Kiyometa result codes

Return codes (RCs) describe an application step result. HTTP status and PostgreSQL error codes are separate diagnostic fields. An RC on `request.start` is not a success receipt for the later database transaction.

## Codes used by the application

| RC | Meaning | User action |
|---|---|---|
| `00` | The recorded step succeeded or started as logged | Continue to the next step |
| `VAL-001` | Required value is missing | Complete the marked field |
| `VAL-002` | Input or database constraint rejected the change | Correct the fields and retry |
| `DATA-001` | Requested record was not found | Refresh the list and check the record |
| `DATA-002` | Duplicate record or unique value | Check existing records and the entered value |
| `BIZ-001` | Business rule rejected the action | Review related records and the rule |
| `BIZ-002` | Required BOM or production setup is incomplete | Complete the required setup |
| `CON-001` | Record changed elsewhere or conflicts with current data | Reload and review the latest values |
| `AUTH-001` | Session is missing or expired | Sign in again |
| `AUTH-002` | Account cannot perform this action | Ask an administrator to review access |
| `NET-001` | Device reports offline | Reconnect; queued diagnostics send later |
| `NET-002` | Network request could not reach the service | Check the connection and retry when available |
| `NET-003` | Request timed out or was aborted | Check the saved state before retrying a write |
| `TXN-001` | A write was sent but its final result is unknown | Refresh/check the record or receipt before retrying |
| `SVC-001` | Service returned an internal error or is unavailable | Retry later; give support the process ID if it continues |
| `SVC-002` | Service is busy or rate-limited | Wait briefly and retry |
| `FILE-001` | File type is unsupported | Choose a supported file |
| `FILE-002` | File exceeds the supported size | Choose a smaller file |
| `FILE-003` | File contents could not be read | Re-save or choose another file |
| `OCR-001` | OCR could not find readable text or rejected the upload | Use a clearer supported document |
| `OCR-002` | OCR completed with values that need user review | Check uncertain values and correct them manually |
| `LOCAL-001` | Device storage could not save local work | Free device space and retry |
| `CANCEL-001` | User cancelled the action | No action needed |
| `UNDO-001` | Undo was rejected or is no longer safe | Refresh and review the latest audit entry |
| `SYS-001` | Failure has no specific mapping yet | Retry once; if repeated, report the process ID |

## What is implemented

The shared frontend mapper returns these codes where it can classify the error. The user-facing message catalog is Japanese and English. OCR request status, frontend Supabase HTTP status, transport failures, and the `manage-users` Edge Function response are mapped. The Edge Function returns RC identifiers instead of internal exception text.

Not every field-level validation or business rule currently emits its dedicated RC. Some database constraints still map to `VAL-002` or `BIZ-001`; some unclassified failures map to `SYS-001`. Do not infer a specific root cause from the RC alone. Use process/request IDs and the database audit record. Form-specific field highlighting is only present where that form implements field validation.

## Retry rules

- A read can usually be retried after connectivity returns.
- Do not automatically retry a write with `NET-002`, `NET-003`, or `TXN-001` unless that operation has a stable idempotency key/receipt.
- Order submission and production task submission use durable request IDs. Check their receipt before creating a new submission.
- `00` means only that its logged step succeeded. Check the final step and audit/receipt before reporting that a whole workflow succeeded.

## English reference

RC is an application-level classification, independent of HTTP and PostgreSQL codes. The user message is actionable; the code and process ID are for support. For uncertain writes, inspect the request chain and transaction evidence before retrying.
