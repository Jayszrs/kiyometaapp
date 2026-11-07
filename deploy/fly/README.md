# Fly.io deployment

This image serves the React app and authenticated OCR on one HTTPS origin.
Fly region nrt is Tokyo, Japan. The app uses the Japan Supabase project.

## Configuration

The root fly.toml selects one shared-cpu-2x Machine with 2 GB RAM in nrt.
The Nginx process serves the Vite build and proxies /ocr to the local OCR
worker. Supervisor keeps Nginx and one Uvicorn worker running in the same
Machine. The OCR worker validates Supabase access tokens through the Japan
project's public JWKS endpoint.

The Vite build reads the Japan project URL and publishable key from
webapp/.env.production. These are client-side values. This deployment does not
use a service-role key or the database password.

## Trial and cost

Fly.io does not offer a free tier. New accounts get $1 of trial credit for
seven days, and trial Machines stop after five minutes. The trial supports
shared-cpu-2x with up to 4 GB RAM, so it can start this 2 GB test Machine, but
it is not suitable for a continuous production service.

The current Fly pricing page lists a shared-cpu-2x Machine with 2 GB RAM at
about $13.39 per month in the base region. Tokyo pricing can differ. Network
egress in Asia Pacific is billed separately. The app is configured to stay on,
so approve an ongoing budget before creating the Fly app or Machine.

## Deploy after budget approval

1. Install flyctl and sign in to the Fly.io account.
2. Review the current price for the nrt region.
3. From the repository root, run fly launch --no-deploy --copy-config.
4. Keep the configured app name if available, or choose a unique name.
5. Deploy one Machine with fly deploy --ha=false.
6. Check the app URL and the /health route.

Do not add Supabase service-role keys or database passwords to Fly secrets.
The frontend uses the publishable key, and OCR uses the public JWKS endpoint.
