import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// orderStatus.ts is pure. The rules here are mirrored by the database trigger,
// and both sides matter: the browser copy stops an illegal move being offered,
// and these assertions document the case that reached production, where
// moving an order back from In production posted a material reversal and handed
// back stock for goods that had already been issued.
const source = readFileSync(new URL('../src/lib/orderStatus.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const status = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const { allowedTransitions, canTransition, consumesMaterials, transitionRejection } = status;

const FORWARD = [
  ['Order request', 'Receipt'],
  ['Receipt', 'In preparation'],
  ['In preparation', 'Preparation complete'],
  ['Preparation complete', 'In production'],
  ['In production', 'Complete'],
  ['Complete', 'Shipped'],
];

test('the production line moves forward one state at a time', () => {
  for (const [from, to] of FORWARD) {
    assert.equal(canTransition(from, to, false), true, `${from} -> ${to} should be allowed`);
  }
});

test('a shipped or cancelled order is terminal', () => {
  for (const to of ['Order request', 'In production', 'Complete', 'Shipped', 'Cancelled']) {
    if (to === 'Shipped' || to === 'Cancelled') continue; // the identity move is a plain re-save
    assert.equal(canTransition('Shipped', to, false), false, `Shipped -> ${to} must be blocked`);
    assert.equal(canTransition('Cancelled', to, false), false, `Cancelled -> ${to} must be blocked`);
  }
});

test('re-saving without touching the status is always allowed', () => {
  // The database trigger short-circuits on an unchanged progress value, so the
  // browser has to as well: otherwise saving an unrelated field on a shipped
  // order would be rejected by the select.
  assert.equal(canTransition('Shipped', 'Shipped', true), true);
  assert.equal(canTransition('Cancelled', 'Cancelled', true), true);
  assert.equal(canTransition('In production', 'In production', true), true);
});

test('any state before shipping can be cancelled, and cancelling twice is a no-op', () => {
  for (const from of ['Order request', 'Receipt', 'In preparation', 'Preparation complete', 'In production', 'Complete']) {
    assert.equal(canTransition(from, 'Cancelled', false), true, `${from} should be cancellable`);
  }
  assert.equal(canTransition('Cancelled', 'Cancelled', false), true);
  assert.equal(canTransition('Shipped', 'Cancelled', false), false);
});

test('moving backwards is refused once materials have been issued', () => {
  // The core bug: this used to reverse a stock movement, returning material
  // that had already been consumed for work in progress.
  assert.equal(canTransition('In production', 'Preparation complete', true), false);
  assert.equal(canTransition('In production', 'In preparation', true), false);
  assert.equal(canTransition('Complete', 'In production', true), false);
  assert.match(transitionRejection('In production', 'Preparation complete', true), /materials/i);
});

test('a completed order can only ship or be cancelled', () => {
  assert.equal(canTransition('Complete', 'Shipped', false), true);
  assert.equal(canTransition('Complete', 'In production', false), false);
  assert.match(transitionRejection('Complete', 'In production', false), /completed order/i);
});

test('an order that never consumed material may still be reopened', () => {
  // No materials have been issued, so a backward move posts nothing to the
  // stock ledger and the correction is safe. This matches the trigger, which
  // only refuses a backward move once inventory_stock_applied is set.
  assert.equal(canTransition('In preparation', 'Order request', false), true);
  assert.equal(canTransition('In production', 'Preparation complete', false), true);
  assert.equal(consumesMaterials('In production'), true);
  assert.equal(consumesMaterials('Complete'), true);
  assert.equal(consumesMaterials('In preparation'), false);
  assert.equal(consumesMaterials('Cancelled'), false);
});

test('the offered list is deduplicated and always contains the current state', () => {
  const options = allowedTransitions('In preparation', false);
  assert.equal(new Set(options).size, options.length, 'no duplicate entries');
  assert.ok(options.includes('In preparation'), 'the current state stays selectable');
  assert.ok(options.includes('Cancelled'), 'cancellation is always offered before shipping');
  // Backward and forward moves are both available while nothing is issued.
  assert.ok(options.includes('Order request'));
  assert.ok(options.includes('In production'));
  // Shipped is reachable, because forward jumps are legal.
  assert.ok(options.includes('Shipped'));
});

test('an order with issued materials is only offered forward or cancelled', () => {
  const options = allowedTransitions('In production', true);
  assert.ok(options.includes('In production'));
  assert.ok(options.includes('Complete'));
  assert.ok(options.includes('Cancelled'));
  assert.ok(!options.includes('Preparation complete'), 'no backward move once material is issued');
  assert.ok(!options.includes('In preparation'));
  assert.ok(!options.includes('Order request'));
});

test('nothing is offered out of a terminal state', () => {
  for (const terminal of ['Shipped', 'Cancelled']) {
    assert.deepEqual(allowedTransitions(terminal, false), [terminal]);
  }
});
