# Interrupted work and offline recovery

Draft fields are stored per account, synchronously before the next render.
Typing alone never submits. Reopening returns to the last page and draft.
Orders, search/billing edits, schedule edits, reviewed OCR fields, client/product
masters, inventory/purchase fields, BOM fields and profile text use this store.
Storage failures show a persistent warning; submitting an order fails before
sending if its pending action cannot be stored.

Order Submit creates a durable outbox entry before authentication/network work.
The pending banner explicitly distinguishes an unconfirmed submission from a
confirmed save. It retries on reconnect, app resume, startup and at 30-second
intervals while the app runs. `submit_order_once` atomically commits the order
and a receipt under the originating authenticated account. Repeating the same
request returns that receipt without repeating audit/stock effects. Permission,
validation and version conflicts require review; they never overwrite another
operator automatically. Review displays the latest editor and server versus
requested values. Edits made after Submit remain unsent.

OCR saves the corrected source in IndexedDB before upload and persists its job
ID/result. Closing the modal/app detaches polling; it does not cancel server
work. Reopen retrieves the result. A lost upload response or missing job after a
service restart can resume from the saved source. Server inference still has
its 300-second budget and bounded queue/result retention.

Production HTTPS/localhost builds precache the app shell and page chunks for
offline reopening after a successful first visit. Vite development/LAN HTTP
does not provide this production offline cache. The app must already have a
cached authenticated session and data to reopen its editing pages offline.

An Android force-stop does not execute JavaScript. Already accepted server work
can continue; unsent order submissions resume on next open. There is no native
WorkManager sending requests while the app is force-stopped. Client/product,
purchase and profile submissions retain drafts for manual retry; they are not
silently queued. Manual stock retries retain their exact date/payload/request
ID across reopening so stock is not posted twice. Large non-OCR attachments
can exceed local draft storage; the storage warning must be resolved before
closing. Clearing app/site data removes local drafts and pending actions.

Validation: web recovery/SQL tests cover offline submission, lost acknowledgements,
duplicate clicks, account separation, conflicts and exhausted storage. An isolated
browser harness exercised the real App/ScanModal through close/reopen and full
reload, including unsent fields, offline sync and background OCR retrieval.
Live Supabase checks used authenticated transactions with rollback, verifying
one audit event per successful operation and rejecting stale/different-account
replay. Flutter analysis and OCR job tests also pass.
