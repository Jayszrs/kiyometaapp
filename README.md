# Kiyometa Order Management

The application UI lives in `webapp/` and is built with React, TypeScript, and
Vite. Flutter provides a thin WebView wrapper so the same UI can run on the
shared Android tablet emulator, Windows, Chrome, and Edge.

## Project structure

- `webapp/src/` - application source and Supabase integration.
- `webapp/supabase/migrations/` - database schema required by the application.
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

Run `webapp/supabase/migrations/001_order_management.sql` once in the Supabase
SQL Editor when preparing a new Supabase project.

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
