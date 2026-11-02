import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadRecoveryModule.mjs';

const { createReadRefresh } = await import(moduleUrl('readRefresh.ts'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test('overlapping refreshes serialize reads and finish with a fresh read', async () => {
  const gates = [deferred(), deferred()];
  let calls = 0, active = 0, peak = 0;
  const results = [];
  const queue = createReadRefresh(async () => {
    const index = calls++;
    peak = Math.max(peak, ++active);
    results.push(await gates[index].promise);
    active--;
  });
  const first = queue.refresh();
  const mutationRefresh = queue.refresh();
  queue.refresh();
  assert.equal(calls, 1);
  assert.equal(first, mutationRefresh);
  gates[0].resolve('before mutation');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  gates[1].resolve('after mutation');
  await mutationRefresh;
  assert.equal(peak, 1);
  assert.deepEqual(results, ['before mutation', 'after mutation']);
});

test('leaving a module aborts its active read and cancels its queued refresh', async () => {
  const gate = deferred();
  let signal, calls = 0;
  const queue = createReadRefresh(async nextSignal => {
    signal = nextSignal;
    calls++;
    await gate.promise;
  });
  const pending = queue.refresh();
  queue.refresh();
  queue.dispose();
  assert.equal(signal.aborted, true);
  gate.resolve();
  await pending;
  await queue.refresh();
  assert.equal(calls, 1);
});

test('a rejected read remains an error and a later explicit refresh can recover', async () => {
  let attempts = 0;
  const queue = createReadRefresh(async () => {
    if (++attempts === 1) throw new Error('network unavailable');
  });
  await assert.rejects(queue.refresh(), /network unavailable/);
  await queue.refresh();
  assert.equal(attempts, 2);
});
