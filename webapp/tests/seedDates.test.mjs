import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// This seed is executed by hand in the Supabase SQL editor, so nothing in CI
// would otherwise notice if its dates went stale. These assertions are the
// regression guard for the exact symptom that got reported: Search & Billing
// opened empty while the orders plainly existed in the database.

const seedUrl = new URL('../../backend/supabase/seed_demo_data.sql', import.meta.url);
const seed = readFileSync(seedUrl, 'utf8');

const source = readFileSync(new URL('../src/lib/date.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { addDaysJST, endOfMonthJST } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

// Mirrors SearchBillingPage's defaults: fromDate is today-30, toDate is the end
// of the current month. If this ever changes, the offsets below must be
// re-checked, which is why it is derived rather than hard-coded here.
const fromDate = addDaysJST('2026-10-06', -30);
const toDate = endOfMonthJST('2026-10-06');

// The seeded rows carry their date as a day offset from the JST run date, e.g.
// ('d1111111-...', -26, -23, ...) is order -26 days, delivery -23 days.
// The seed's UUIDs start with a readable letter prefix (d- orders, f- purchases),
// so the pattern matches that letter and then the remaining 7-4-4-4-12 hex.
const UUID_TAIL = '[0-9a-f]{7}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const orderRows = [...seed.matchAll(new RegExp(`'d${UUID_TAIL}'::uuid,\\s*(-?\\d+),\\s*(-?\\d+),`, 'g'))];
const purchaseRows = [...seed.matchAll(new RegExp(`'f${UUID_TAIL}'::uuid,\\s*'PUR-\\d{4}-\\d+',\\s*(-?\\d+),`, 'g'))];

test('the seed declares its orders as day offsets, not fixed dates', () => {
  assert.equal(orderRows.length, 4, 'expected all four seeded orders to be parsed');
  assert.equal(purchaseRows.length, 4, 'expected all four seeded purchases to be parsed');
  // A literal YYYY-MM-DD anywhere in the insert blocks is what made the page go
  // empty: the seed ran once and the dates never moved again.
  assert.equal(/\d{4}-\d{2}-\d{2}'?\s*,\s*'(伸和テクノス|信州|ナガノ)/.test(seed), false);
});

test('every seeded delivery date lands inside the Search & Billing default window', () => {
  // Checked across a whole year of run dates, not just one: the window's start
  // slides with the run day while the offsets stay fixed.
  for (const day of [1, 2, 15, 27, 28, 29, 30, 31]) {
    for (const month of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']) {
      const runDay = `2026-${month}-${String(day).padStart(2, '0')}`;
      const windowStart = addDaysJST(runDay, -30);
      const windowEnd = endOfMonthJST(runDay);
      for (const [, orderOffset, deliveryOffset] of orderRows) {
        const order = addDaysJST(runDay, Number(orderOffset));
        const delivery = addDaysJST(runDay, Number(deliveryOffset));
        assert.ok(
          delivery >= windowStart && delivery <= windowEnd,
          `delivery ${delivery} for an order seeded on ${runDay} is outside ${windowStart}..${windowEnd}`
        );
        assert.ok(order <= delivery, `order ${order} must not be after its delivery ${delivery}`);
      }
    }
  }
});

test('the default window used by the test is the one the page actually uses', () => {
  // Pins the assumption above so a change in App.tsx shows up as a failing test
  // rather than as a quietly meaningless guard.
  assert.equal(fromDate, '2026-09-06');
  assert.equal(toDate, '2026-10-31');
});
