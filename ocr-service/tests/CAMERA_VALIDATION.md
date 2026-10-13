# Camera OCR validation — 13 October 2026

Historical measurements from the initial change. The timeout/queue regression and current workflow are superseded by POLLING_VALIDATION.md.

Camera files were the supplied tablet screenshots of camera previews, not original camera JPEGs. Timings are single local CPU observations with engines already loaded; model startup, upload/network time and production gateway behavior are excluded. They demonstrate individual changes, not a universal speed guarantee.

| Input | Before (s) | Final (s) | Result |
| --- | ---: | ---: | --- |
| Reference quotation -1.pdf | 32.141 | 21.985 | Same dates, issuer, order 210266, drawing NHD-F1772-11, tank, qty 3, price 5000, net 15000, process and phone; seeded client/product match. Postal code is not printed. |
| Reference quotation -2.pdf | 24.141 | 24.985 | Same dates, issuer, order MS294541, drawing NSQ-F0124-05, tank TOP, qty 1, price/net 6000, process, postcode/address. Client matches; product intentionally absent from seed. Phone remains missing. |
| Camera image #4 | 32.266 | 10.485 | Dates, order, drawing, product, qty, price, net amount, process and phone recovered. Seeded client/product match. Address contains OCR errors requiring review. |
| Camera image #7, sideways/moire | 20.078 | 16.281 | Issuer, dates, order, qty/net recovered. Drawing/product reading remains insufficient for a product match. |
| Camera image #8, heavy moire | 31.969 | 13.672* | Correct order/net and drawing after page correction; issuer and some numeric fields remain unreliable. No forced master match. |

*13.672s was measured before the final orientation early-exit refinement. See camera-validation-results.json for field values, review flags and missing fields. Matching used the same names/codes as the seed, without editing seed data or querying live production state.

Camera/PDF differences: camera submitted an uncropped image including screen chrome/blank surroundings; PDF rasterization uses 300 dpi. Small text and screen moire damaged OCR labels. The parser allowed amounts to borrow a value from a neighboring column with an unrecognized header, and misread currency grouping dots as decimal points. Four orientation passes concurrently mutated shared RapidOCR settings and competed for CPU.

Changes: App.tsx and PhotoEditor.tsx provide touch/keyboard cropping, 90-degree and 1-degree rotation, actual cropped preview/export, cancel/retake and return-to-edit. Images retain source resolution up to a 4000px long edge after cropping. ocrClient.ts has a 90s abort and localized typed recovery states. recognition.py adds conservative bright-page quadrilateral correction, rule-based deskew and sequential orientation selection with confident early exit. main.py bounds inference queue waits and logs decode/recognition/total time and inference exceptions. parseQuotation.ts preserves unknown column boundaries and flags ambiguous yen grouping for review. No dependencies, API shape, seed values or master matching rules changed. Experimental upscaling worsened names and was not shipped.

Validation: 44 web tests, 19 Python tests, TypeScript and production build passed. Tests cover actual camera OCR fields, missing/damaged headers, numeric corrections, portrait rotation, blank input, perspective/deskew, malformed/oversized files, busy service, timeout, typed service failures and retry. The existing Python tests were updated to pass the request parameter required by the HTTP handler.

Limitations: original device JPEGs, physical tablet camera/edit gestures, HEIC devices, real network/production gateway timeout and live master data were not exercised. Browser UI verification was unavailable because the browser tool blocked the local test URL. Severe blur and screen moire cannot be reconstructed reliably; partial results still require review/retaking. Perspective correction deliberately leaves uncertain/clipped document edges alone. Deployment/restart of the web app and OCR service is still needed for the tablet to use the changes.
