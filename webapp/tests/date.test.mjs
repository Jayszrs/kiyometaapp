import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// date.ts is pure and imports nothing, but it is TypeScript, so it is
// transpiled the same way the drawing tests transpile their block out of db.ts.
const source = readFileSync(new URL('../src/lib/date.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const date = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const { addDaysJST, endOfMonthJST, isValidISODate, parseISODate, parseNumberStrict, todayJST } = date;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

test('todayJST returns a well-formed calendar day', () => {
  assert.match(todayJST(), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(isValidISODate(todayJST()));
});

test('a rejected date is reported as a real problem instead of a near-miss', () => {
  // The regression this guards: Date rolls 2025-02-30 over to March 2, so an
  // impossible Excel cell used to arrive as a valid day in the wrong month and
  // then sorted into the wrong billing period.
  assert.equal(isValidISODate('2025-02-30'), false);
  assert.equal(isValidISODate('2025-13-01'), false);
  assert.equal(isValidISODate('2025-00-10'), false);
  assert.equal(isValidISODate('2025-04-31'), false);
  assert.equal(parseISODate('2025-02-30'), null);
  assert.ok(isValidISODate('2024-02-29'));
  assert.equal(isValidISODate('2025-02-29'), false);
});

test('only a full ISO calendar date is accepted', () => {
  assert.equal(isValidISODate('2025-1-1'), false);
  assert.equal(isValidISODate('2025/11/01'), false);
  assert.equal(isValidISODate('11/01/2025'), false);
  assert.equal(isValidISODate(''), false);
  assert.equal(isValidISODate(null), false);
  assert.equal(isValidISODate(undefined), false);
  assert.deepEqual(parseISODate('2025-11-01'), { year: 2025, month: 11, day: 1, hour: 0, minute: 0, second: 0 });
});

test('day arithmetic crosses month and year boundaries', () => {
  assert.equal(addDaysJST('2025-11-01', 30), '2025-12-01');
  assert.equal(addDaysJST('2025-12-31', 1), '2026-01-01');
  assert.equal(addDaysJST('2024-02-28', 1), '2024-02-29');
  assert.equal(addDaysJST('2025-01-01', -1), '2024-12-31');
  // An unparseable input is returned unchanged rather than becoming NaN-NaN.
  assert.equal(addDaysJST('not-a-date', 5), 'not-a-date');
});

test('end of month knows the real length, including February', () => {
  assert.equal(endOfMonthJST('2025-11-01'), '2025-11-30');
  assert.equal(endOfMonthJST('2025-02-10'), '2025-02-28');
  assert.equal(endOfMonthJST('2024-02-10'), '2024-02-29');
  assert.equal(endOfMonthJST('2025-04-15'), '2025-04-30');
});

test('a blank or mistyped number is not silently a zero', () => {
  // The regression this guards: Number("") is 0 and Number("abc") is NaN, so an
  // empty numeric cell used to save a real zero quantity, and a typo saved as
  // a price of nothing.
  assert.equal(parseNumberStrict(''), null);
  assert.equal(parseNumberStrict('   '), null);
  assert.equal(parseNumberStrict(null), null);
  assert.equal(parseNumberStrict(undefined), null);
  assert.equal(parseNumberStrict('abc'), null);
  assert.equal(parseNumberStrict('NaN'), null);
  assert.equal(parseNumberStrict(Infinity), null);
  assert.equal(parseNumberStrict('0'), 0);
  assert.equal(parseNumberStrict('1,250'), 1250);
  assert.equal(parseNumberStrict(-3.5), -3.5);
  assert.equal(parseNumberStrict(7), 7);
});
