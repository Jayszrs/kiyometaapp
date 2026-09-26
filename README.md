# Kiyometa Order Management

The frontend UI lives in `webapp/` and is built with React, TypeScript, and
Vite. The backend definition lives separately in `backend/supabase/`. Flutter
provides a thin WebView wrapper so the same frontend can run on the shared
Android tablet emulator, Windows, Chrome, and Edge.

## Project structure

- `webapp/` - React/Vite frontend and its local environment configuration.
- `backend/supabase/` - database migrations and protected Edge Functions.
- `lib/`, `android/`, `windows/`, and `web/` - supported Flutter wrapper targets.
- `tool/`, `.tools/`, and `.vscode/` - shared tablet runner and VS Code setup.

Generated dependencies and build output are intentionally not stored in Git:
`node_modules/`, `dist/`, `.dart_tool/`, and `build/`. Local environment values
in `webapp/.env.local` are also ignored.

## First setup

Create `webapp/.env.local` from `webapp/.env.local.example`, then run:

```powershell
cd webapp
npm ci
cd ..
flutter pub get
```

Run these migrations in order from the Supabase SQL Editor when preparing a
new Supabase project:

1. `backend/supabase/migrations/001_order_management.sql`
2. `backend/supabase/migrations/002_roles_inventory_audit.sql`

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

- Administrators can create/deactivate accounts, assign roles, inspect the
  activity trail, and undo supported data changes.
- Operators can use operational screens and reset other operator passwords,
  but cannot create accounts, change roles, or open the audit trail.
- Inventory master data, purchases, printable purchase receipts, and stock
  mutations are stored in Supabase.
- Product material requirements (BOM) drive automatic stock deductions when
  an order reaches `Complete` or `Shipped`. Reopening/deleting the order safely
  reconciles the deducted stock.
- The supplied Excel workbooks were used as the field and workflow reference;
  they are not runtime dependencies and are not copied into the repository.

## Backend troubleshooting

- `404` for `profiles`, `purchases`, or `inventory_balances` means migration
  `002_roles_inventory_audit.sql` has not been run on that Supabase project.
- A CORS/preflight failure for `manage-users` normally means the Edge Function
  has not been deployed. The function already handles browser `OPTIONS`
  requests after it exists on Supabase.
- `401` for `orders` means the cached login session is invalid or expired. Use
  the **Sign out** button, sign in again, and verify that the frontend points to
  the same Supabase project where migrations were installed.
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

## Run only the web application

```powershell
cd webapp
npm run dev
```

For a production bundle, run `npm run build`. The generated `webapp/dist/`
directory can always be rebuilt and should not be committed.
