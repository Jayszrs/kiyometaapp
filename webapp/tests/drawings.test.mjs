import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// planDrawingSlots is pure, but it lives in db.ts, which imports the Supabase
// client and throws at import time when the env vars are absent. The body is
// extracted and evaluated on its own so the storage path rules can be tested
// without a live project.
const source = readFileSync(new URL('../src/lib/db.ts', import.meta.url), 'utf8');
const start = source.indexOf('export type DrawingSlotPlan');
const end = source.indexOf('function drawingExtension');
assert.ok(start > 0 && end > start, 'planDrawingSlots block not found in db.ts');
const { outputText } = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { planDrawingSlots } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';
const SIGNED = 'https://project.supabase.co/storage/v1/object/sign/product-drawings/p1/1700000000000-0.png?token=abc';

test('a slot showing nothing still keeps its stored key', () => {
  // The regression this guards: a save that lands before signing finishes used
  // to blank the row, deleting the drawing reference outright.
  const plan = planDrawingSlots(['', ''], ['p1/1.png', 'p1/2.png']);
  assert.deepEqual(plan, [
    { kind: 'keep', path: 'p1/1.png' },
    { kind: 'keep', path: 'p1/2.png' },
  ]);
});

test('a signed display URL is never re-uploaded and never persisted', () => {
  // The bucket is private, so the display string is ephemeral. Storing it would
  // write an expired token into the row, and the drawing would be unrecoverable
  // once the token lapsed.
  const plan = planDrawingSlots([SIGNED], ['p1/1.png']);
  assert.deepEqual(plan, [{ kind: 'keep', path: 'p1/1.png' }]);
  assert.ok(!JSON.stringify(plan).includes('token=abc'));
});

test('a freshly picked file uploads and supersedes the key it replaces', () => {
  const plan = planDrawingSlots([PNG, ''], ['p1/old.png', 'p1/keep.png']);
  assert.deepEqual(plan, [
    { kind: 'upload', mime: 'image/png' },
    { kind: 'keep', path: 'p1/keep.png' },
  ]);
});

test('empty slots keep their index instead of collapsing the row', () => {
  // Gaps must survive a save and reload. Compressing them would slide every
  // later drawing down a slot and renumber the drawings the user sees.
  const plan = planDrawingSlots(['', PNG, '', PNG], ['', 'p1/2.png', '', 'p1/4.png']);
  assert.equal(plan.length, 4);
  assert.deepEqual(plan.map(s => s.kind), ['keep', 'upload', 'keep', 'upload']);
  assert.deepEqual(plan[0], { kind: 'keep', path: '' });
  assert.deepEqual(plan[2], { kind: 'keep', path: '' });
});

test('a slot with no key to fall back on stays empty rather than inventing one', () => {
  const plan = planDrawingSlots([SIGNED], []);
  assert.deepEqual(plan, [{ kind: 'keep', path: '' }]);
});

test('the mime type is carried through for the upload path', () => {
  assert.deepEqual(planDrawingSlots([JPEG], ['']), [{ kind: 'upload', mime: 'image/jpeg' }]);
  // A malformed data URI must not be mistaken for something already stored.
  assert.deepEqual(planDrawingSlots(['data:'], ['']), [{ kind: 'upload', mime: 'image/png' }]);
});
