# Kiyometa Direction

Extracted from the existing codebase, not invented. Every value below was read
out of `webapp/src/index.css` or counted from actual usage, so this file records
what the product already is rather than proposing a new identity.

## Identity

An internal order-management tool for a small manufacturing shop. The people
using it are operators on the floor, often on a tablet, often standing, often
in a hurry. The interface is a work instrument, not a product page. Everything
that does not help someone read a number or finish a task is decoration and gets
cut.

This is why the app is dense, high-contrast, and quiet. A shop floor does not
benefit from a soft, spacious, marketing-style layout: it wastes screen space,
lowers the contrast that matters for small text, and makes the next tap harder
to place.

## Personality

Precise, plain, unembellished. Says the label, shows the number. No persuasion,
no celebration, no encouragement copy. The tone of a well-kept machine
worksheet.

## Palette

Two core colors plus neutrals. Teal is the only accent, used sparingly to mark
the secondary action or a live value, never as decoration.

| Role | Value | Count in source | Purpose |
|---|---|---|---|
| Navy | `#1a3458` | 148 | Primary. Headers, labels, the primary button. Carries all structure. |
| Navy dark | `#112240` | 5 | Pressed state for navy surfaces. |
| Teal | `#0d7377` | 15 | The single accent. Secondary action, active tab, links in prose. |
| Teal light | `#14a085` | defined | Hover/active for teal. |
| App background | `#f5f6f8` | 18 | The page. Cool grey, not white, so white cards read as raised. |
| Panel background | `#f0f4f8` | defined | Sidebars and grouped panels. |
| Sky | `#dbeafe` | defined | Rare tinted highlight. |

Neutrals come from Tailwind's slate ramp. Status colors (red, amber, emerald)
are allowed only to carry a real state, and only with a text label beside them,
never color alone.

**Gradient policy: none.** A gradient with no hierarchy to express is the
fastest way to make an industrial tool look like a template. The profile header
gradient was removed for exactly this reason.

## Typography

Two families, each with a stated job.

- **Work Sans** (400/500/600/700) for all UI text. Chosen because it is a
  grotesk with open apertures and tall x-height, which keeps small labels legible
  at the 12 to 14px sizes this app runs at, and because it has real 600 and 700
  weights available so hierarchy comes from weight rather than from size alone.
- **DM Mono** (400/500) for anything numeric or a code: quantities, prices,
  dates, order numbers, part numbers, times. Tabular alignment in a column of
  numbers is only possible with a monospace, and a misread digit in a quantity is
  a real cost.

Base size 16px, dropping to 15px below 360px wide. Inputs are locked to 16px so
iOS does not zoom the viewport on focus.

**Caps policy: no `uppercase`, no wide `tracking-*` on labels.** Hierarchy comes
from font weight and color. A table header set in tracked-out capitals reads as
a template at a glance and costs horizontal room in the dense tables this app
depends on. This is not a stylistic preference, it is the single most common
marker of generated interface work, and the shop floor does not benefit from it.

## Mood

Quiet, exact, quick. A user should be able to open the app mid-task, find the
thing they need, change it, and go back to the floor without the interface
having drawn attention to itself.

## Dials

**ENERGY 1 / RHYTHM 1 / MOTION 1.**

Energy 1 because the app's job is to disappear behind the task. Energy 3 would be
actively harmful here: it would compete with the numbers the operator is reading.

Rhythm 1 because every screen is the same shape on purpose: a list on the left,
the working record on the right, a persistent header. Shop-floor muscle memory
depends on that being predictable. Divergence between screens is a cost, not a
feature.

Motion 1, meaning hover and focus transitions only. No entrances, no scroll
reveal, no choreography. A tablet that is passed between people and used in
harsh light should not animate.

## Spacing, radius, density

Small radius throughout (`rounded-sm`), never pill-shaped. Pills read as
consumer. Inputs, buttons, and panels share one radius so the grid stays
aligned.

Density over whitespace. 16px base, compact panel padding, thin custom
scrollbars. Vertical space is the scarce resource on a tablet held at
production height.

Breakpoints are 767px and 359px. Below 767px the two-column workspace becomes a
single stacked column, because a two-panel layout on a phone leaves both panels
too narrow to read.

## Identity motif

The navy header bar with its teal accent, carried at a constant height across
every screen. It is the one element a user can rely on being in the same place
whenever they look up, which is the whole job of a persistent header on a
glanceable shop-floor tool.

## Tap targets

Interactive controls are at least 44px on touch. `touch-action: manipulation` is
set globally to remove the 300ms tap delay, and safe-area insets are respected at
the top on notched devices.
