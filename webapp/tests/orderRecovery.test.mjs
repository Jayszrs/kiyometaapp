import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { moduleUrl, storageUrl, memoryStorage } from './loadRecoveryModule.mjs';
globalThis.localStorage = memoryStorage();
globalThis.window = new EventTarget();
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
class StaleOrderError extends Error {}
let owner, calls, writes, behavior, receipts;
globalThis.recoverySupabase = { auth: { getSession: async () => ({ data: { session: { user: { id: owner } } } }) } };
globalThis.recoveryDb = { StaleOrderError, submitOrderOnce: async (id, order) => {
  calls++;
  if (behavior) return behavior(id, order);
  if (!receipts.has(id)) { writes++; receipts.set(id, { ...order, version: (order.version ?? 0) + 1 }); }
  return receipts.get(id);
} };
const url = moduleUrl('orderOutbox.ts', {
  'import { supabase } from "./supabaseClient";': 'const supabase = globalThis.recoverySupabase;',
  'import { submitOrderOnce, StaleOrderError } from "./db";': 'const {submitOrderOnce, StaleOrderError} = globalThis.recoveryDb;',
  '"./uuid"': JSON.stringify(moduleUrl('uuid.ts')),
  '"./recoveryStorage"': JSON.stringify(storageUrl),
});
const outbox = await import(url);
const { readRecovery, writeRecovery } = await import(storageUrl);
const order = { id: '6db92ec6-e05c-4102-bdf6-1d61dd291b9a', orderNumber: 'test', quantity: 3, progress: 'Order request', version: 1 };
beforeEach(() => { localStorage.clear(); owner = 'factory-operator'; navigator.onLine = true; calls = writes = 0; behavior = undefined; receipts = new Map(); });

test('offline submit is durable before sending, survives module restart, and syncs on reopen', async () => {
  navigator.onLine = false;
  await assert.rejects(outbox.saveOrderDurably(order, owner), outbox.QueuedOrderError);
  assert.equal(calls, 0);
  assert.equal(outbox.pendingOrders(owner)[0].order.quantity, 3);
  const reopened = await import(`${url}#reopened`);
  navigator.onLine = true;
  await reopened.syncOrders(owner);
  assert.equal(writes, 1);
  assert.equal(reopened.pendingOrders(owner).length, 0);
});
test('response lost after database commit retries the same receipt without a second write', async () => {
  let lost = true;
  behavior = async (id, value) => {
    if (!receipts.has(id)) { writes++; receipts.set(id, { ...value, version: 2 }); }
    if (lost) { lost = false; throw new TypeError('Failed to fetch'); }
    return receipts.get(id);
  };
  await assert.rejects(outbox.saveOrderDurably(order, owner), outbox.QueuedOrderError);
  const requestId = outbox.pendingOrders(owner)[0].requestId;
  await outbox.syncOrders(owner);
  assert.equal(writes, 1);
  assert.equal(calls, 2);
  assert.ok(receipts.has(requestId));
  assert.equal(outbox.pendingOrders(owner).length, 0);
});
test('double click shares one in-flight submission', async () => {
  let release;
  behavior = async (_id, value) => new Promise(resolve => { release = () => resolve({ ...value, version: 2 }); });
  const first = outbox.saveOrderDurably(order, owner);
  const second = outbox.saveOrderDurably(order, owner);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
test('queued snapshot cannot be changed by further form edits', async () => {
  navigator.onLine = false;
  const mutable = { ...order };
  await assert.rejects(outbox.saveOrderDurably(mutable, owner), outbox.QueuedOrderError);
  mutable.quantity = 77;
  assert.equal(outbox.pendingOrders(owner)[0].order.quantity, 3);
  await assert.rejects(outbox.saveOrderDurably(mutable, owner), /earlier submission/);
});
test('permission errors and real conflicts stop automatic retry and preserve fields for review', async () => {
  behavior = async () => { throw { code: '42501', message: 'permission denied' }; };
  await assert.rejects(outbox.saveOrderDurably(order, owner));
  assert.equal(outbox.pendingOrders(owner)[0].state, 'blocked');
  await outbox.syncOrders(owner);
  assert.equal(calls, 1);
  localStorage.clear();
  behavior = async () => { throw new StaleOrderError('Last changed by operator-two'); };
  await assert.rejects(outbox.saveOrderDurably(order, owner));
  assert.match(outbox.pendingOrders(owner)[0].message, /operator-two/);
  assert.equal(outbox.pendingOrders(owner)[0].order.quantity, 3);
});
test('another account cannot replay or view this account\'s queued work', async () => {
  navigator.onLine = false;
  await assert.rejects(outbox.saveOrderDurably(order, owner), outbox.QueuedOrderError);
  owner = 'another-account'; navigator.onLine = true;
  assert.equal(outbox.pendingOrders(owner).length, 0);
  await outbox.syncOrders('factory-operator');
  assert.equal(calls, 0);
});
test('storage failure prevents sending an action that would be lost on termination', async () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota exceeded'); };
  try { await assert.rejects(outbox.saveOrderDurably(order, owner), /storage is full/); assert.equal(calls, 0); }
  finally { localStorage.setItem = original; }
});
test('background acknowledgement advances a stored draft version without erasing newer unsent edits', async () => {
  writeRecovery(owner, 'entry-form', { ...order, quantity: 9 });
  await outbox.saveOrderDurably(order, owner);
  assert.equal(readRecovery(owner, 'entry-form').quantity, 9);
  assert.equal(readRecovery(owner, 'entry-form').version, 2);
});
test('unsubmitted fields remain unsent, including after a sync pass', async () => {
  writeRecovery(owner, 'entry-form', { ...order, quantity: 12 });
  await outbox.syncOrders(owner);
  assert.equal(calls, 0);
  assert.equal(readRecovery(owner, 'entry-form').quantity, 12);
});

test('action is stored before an authentication refresh can block the request', async () => {
  const original = recoverySupabase.auth.getSession;
  let release;
  recoverySupabase.auth.getSession = () => new Promise(resolve => { release = () => resolve({data:{session:{user:{id:owner}}}}); });
  try {
    const saving = outbox.saveOrderDurably(order, owner);
    assert.equal(outbox.pendingOrders(owner).length, 1);
    assert.equal(calls, 0);
    release();
    await saving;
  } finally { recoverySupabase.auth.getSession = original; }
});
test('failed storage during conflict review retains the original pending action', async () => {
  behavior = async () => { throw new StaleOrderError('Last changed by factory-user'); };
  await assert.rejects(outbox.saveOrderDurably(order, owner));
  const originalItem = outbox.pendingOrders(owner)[0];
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota exceeded'); };
  try { await assert.rejects(outbox.retryReviewedSubmission(owner, originalItem.requestId, {...order,version:2}), /storage is full/); }
  finally { localStorage.setItem = original; }
  assert.deepEqual(outbox.pendingOrders(owner)[0], originalItem);
});
