# Stitch export — FactoryTrack Tablet UI

**Project ID:** `12667476870196524172`

| # | Screen | Status | Notes |
| --- | --- | --- | --- |
| 1 | Home Dashboard | ⚠️ PARTIAL | Original payload truncated mid-activity-log |
| 2 | Scan Job | ✅ COMPLETE | Full HTML + inline JS |
| 3 | Production Progress / Active Job | ✅ TEMPLATED | Generated from design system (3-job monitoring view) |
| 4 | Scan Material Issue | ✅ TEMPLATED | Generated from design system (issue reporting + photo) |

**Assets:**

- `assets/factorytrack-logo.png` — 480×96 PNG (downloaded via curl)

**Design System (all screens):**

- Tailwind config with Material Symbols icons
- 12-column responsive grid (5/7 split on large)
- Consistent color tokens & spacing scale
- Touch targets ≥48px (glove-friendly)
- Fixed header + nav, footer
