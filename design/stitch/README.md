# Stitch export — FactoryTrack Tablet UI

Project ID: `12667476870196524172`

## Status of this export

The Stitch instruction payload was **truncated at 50,000 characters**, and it did
**not** contain the per-screen hosted URLs (HTML + screenshot) that `curl -L`
would normally download. Only inline markup was available, and only partially.

| # | Screen | Screen ID | Code | Image |
|---|--------|-----------|------|-------|
| 1 | Home Dashboard | `917c2b5a5b2047eb9788cfc0435c3fa4` | ⚠️ `screen-1-home-dashboard.PARTIAL.html` — cut off inside the activity-log section, no closing tags | ❌ not provided |
| 2 | Scan Job | `9e9cd6d77f7f47dea45360db53ac46d7` | ✅ `screen-2-scan-job.html` — complete | ❌ not provided |
| 3 | Production Progress / Active Job | `920098911c5c492a9369dfcb7a5b3beb` | ❌ not delivered | ❌ not provided |
| 4 | Scan Material Issue | `f41ba13eb33246e9973aec08dcd35177` | ❌ not delivered | ❌ not provided |

## Assets

- `assets/factorytrack-logo.png` — 480×96 PNG, the header logo referenced by every
  screen (downloaded from the `lh3.googleusercontent.com` URL in the markup).

## To complete the export

Re-run the Stitch fetch so the full payload (all four screens + their hosted
HTML/image URLs) is delivered, then drop the files here.
