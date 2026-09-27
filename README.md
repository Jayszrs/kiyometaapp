# Kiyometa Order Management

The frontend UI lives in `webapp/` and is built with React, TypeScript, and
Vite. The backend definition lives separately in `backend/supabase/`. Flutter
provides a thin WebView wrapper so the same frontend can run on the shared
Android tablet emulator, Windows, Chrome, and Edge.

## Project structure

- `webapp/src/` - React/TypeScript application source.
- `webapp/public/` - static browser assets; `webapp/dist/` is generated output.
- `backend/supabase/migrations/` - ordered PostgreSQL schema migrations.
- `backend/supabase/functions/` - protected Supabase Edge Functions.
- `lib/` - thin Flutter WebView wrapper source.
- `android/`, `windows/`, and `web/` - Flutter platform projects. These paths are
  required by Flutter and should not be moved into custom folders.
- `assets/branding/` - canonical app branding used by the Flutter wrapper.
- `tool/`, `.tools/`, and `.vscode/` - tablet runner and shared editor setup.

Generated dependencies and build output are intentionally not stored in Git:
`node_modules/`, `dist/`, `.dart_tool/`, and `build/`. Local environment values
in `webapp/.env.local` are also ignored.

## First setup

Create `webapp/.env.local` from the committed safe template, then run:

```powershell
Copy-Item webapp/.env.local.example webapp/.env.local
cd webapp
npm ci
cd ..
flutter pub get
```

Run these migrations in order from the Supabase SQL Editor when preparing a
new Supabase project:

1. `backend/supabase/migrations/001_order_management.sql`
2. `backend/supabase/migrations/002_roles_inventory_audit.sql`
3. `backend/supabase/migrations/003_business_numbers_excel.sql`
4. `backend/supabase/migrations/004_business_number_permissions.sql`
5. `backend/supabase/migrations/005_all_roles_safe_undo.sql`
6. `backend/supabase/migrations/006_employee_profiles.sql`
7. `backend/supabase/migrations/007_product_inventory_integration.sql`

Then link the Supabase CLI to the project and deploy the protected user
management function:

```powershell
cd backend
npx supabase login
npx supabase functions deploy manage-users --project-ref YOUR_PROJECT_REF
cd ..
```

The second migration promotes the existing `operator@kiyometa.app` account to
the initial administrator. Sign in with username `operator`; email addresses
are no longer entered in the application. In **Role management**, reset that
account to `operator1234` and create additional username-only employee
accounts. If the current password is unknown, reset it once from Supabase
Dashboard -> Authentication -> Users before using the in-app controls.

## Roles, audit, and inventory

- Administrators can create/deactivate accounts, assign roles, reset employee
  passwords, and inspect the complete activity trail.
- Role Management is hidden from operators and its server endpoint also
  rejects operator requests.
- Every active role can undo its own latest supported data change, including
  accidental deletions. Administrators can additionally undo other users'
  supported changes from the audit screen.
- Every employee can edit their own display name, private profile photo, and
  employee biodata without being able to change their username or role.
- Inventory master data, purchases, printable purchase receipts, and stock
  mutations are stored in Supabase.
- Product material requirements (BOM) can be managed from Product Master or
  Inventory. Stock is deducted when an order enters `In production`, remains
  idempotent through `Complete`/`Shipped`, and is restored when the order moves
  back before production or is deleted.
- Database-level balance guards reject any order, purchase correction, import,
  manual movement, or undo operation that would make inventory negative.
- The supplied Excel workbooks were used as the field and workflow reference;
  they are not runtime dependencies and are not copied into the repository.

## Backend troubleshooting

- `404` for `profiles`, `purchases`, or `inventory_balances` means migration
  `002_roles_inventory_audit.sql` has not been run on that Supabase project.
- A CORS/preflight failure for `manage-users` normally means the Edge Function
  has not been deployed. The function already handles browser `OPTIONS`
  requests after it exists on Supabase.
- `401` or `403` from `/auth/v1/user` means the cached login session is invalid
  or expired. The frontend clears it automatically; sign in again and verify
  that it points to the same Supabase project where migrations were installed.
- `ERR_BLOCKED_BY_CLIENT` and `feature_collector.js` normally come from a
  browser extension or content blocker, not from the application bundle.
- The React DevTools console line is an informational development message, not
  an application error.

## Run on the project tablet

From the repository root:

```powershell
flutter run
```

Choose option `4` for **Kiyometa Tablet**. The runner creates or starts the
Android tablet, waits until Android has finished booting, starts Vite, connects
port 5173 to the emulator, and launches the Flutter wrapper.

To launch the tablet directly, use:

```powershell
.\run-tablet.cmd
```

`run-tablet.cmd` starts the emulator, Vite, port forwarding, and the Flutter
app. `start-tablet.cmd` only prepares the emulator and is useful when the app
will be launched separately from VS Code.

## Run only the web application

```powershell
cd webapp
npm run dev
```

For a production bundle, run `npm run build`. The generated `webapp/dist/`
directory can always be rebuilt and should not be committed.

## Generated folders

The following folders are local build products, not application source:
`build/`, `.dart_tool/`, `android/.gradle/`, `webapp/node_modules/`,
`webapp/dist/`, and `backend/supabase/.temp/`. Git ignores them. Use
`flutter clean` when Flutter output becomes large; use `npm ci` to recreate
frontend dependencies.
