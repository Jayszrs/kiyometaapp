import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadRecoveryModule.mjs';

const { actualBatchMinutes, isWipPolicyComplete, WIP_POLICY_FIELDS } = await import(moduleUrl('manufacturingPolicy.ts'));

test('the client example distinguishes batch time from unit time', () => {
  assert.equal(actualBatchMinutes(50, 'per_batch', 10), 50);
  assert.equal(actualBatchMinutes(50, 'per_unit', 10), 500);
  assert.equal(actualBatchMinutes(5, 'per_unit', 10), 50);
  assert.throws(() => actualBatchMinutes(NaN, 'per_batch', 10));
  assert.throws(() => actualBatchMinutes(5, 'per_unit', -1));
});

test('negative client decisions are complete, undecided or invalid values are not', () => {
  const settings = Object.fromEntries(WIP_POLICY_FIELDS.map(field => [field.key, field.options[0][0]]));
  settings.includeInProgressOperation = true;
  settings.includeLaborCost = true;
  settings.includeMachineCost = true;
  settings.includeOverheadCost = true;
  settings.valuationMethod = 'standard_time';
  settings.actualTimeBasis = 'per_unit';
  assert.equal(isWipPolicyComplete(settings), true);
  for (const field of WIP_POLICY_FIELDS) {
    assert.equal(isWipPolicyComplete({ ...settings, [field.key]: null }), false);
    assert.equal(isWipPolicyComplete({ ...settings, [field.key]: 'unknown' }), false);
  }
  assert.equal(isWipPolicyComplete(null), false);
});
