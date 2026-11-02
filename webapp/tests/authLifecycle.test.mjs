import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
let fixtureNumber = 0;

async function fixture() {
  const states = [], requests = [];
  let cleanup, authEvent;
  const bootstrap = deferred();
  const react = {
    createContext: value => ({ value }), useContext: context => context.value,
    useState: value => { const index = states.push(value) - 1; return [value, next => { states[index] = next; }]; },
    useEffect: effect => { cleanup = effect(); },
  };
  const supabase = {
    auth: {
      getSession: () => bootstrap.promise,
      getUser: async () => ({ data: {}, error: null }),
      onAuthStateChange: callback => { authEvent = callback; return { data: { sub: null, subscription: { unsubscribe() {} } } }; },
    },
    from: () => {
      const result = deferred();
      const request = { result, owner: '', signal: null };
      requests.push(request);
      const query = {
        select() { return query; },
        eq(_key, owner) { request.owner = owner; return query; },
        abortSignal(signal) { request.signal = signal; return query; },
        maybeSingle() { return result.promise; },
      };
      return query;
    },
  };
  globalThis.__authLifecycleFixture = { react, supabase };
  let source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8');
  source = source
    .replace(/import \{[^\n]+\} from "react";/, 'const { createContext, useContext, useEffect, useState } = globalThis.__authLifecycleFixture.react;')
    .replace('import { supabase } from "./supabaseClient";', 'const { supabase } = globalThis.__authLifecycleFixture;')
    .replace('import { readRecovery, writeRecovery } from "./recoveryStorage";', 'const readRecovery = () => undefined; const writeRecovery = () => {};')
    .replace(/import \{[\s\S]*?getOperationsBackendStatus,[\s\S]*?\} from "\.\/backendStatus";/, 'const getOperationsBackendStatus = () => "ready"; const isMissingOperationsSchema = () => false; const markOperationsMigrationRequired = () => {};');
  const { outputText } = ts.transpileModule(source + `\n// fixture ${fixtureNumber++}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  module.useSession();
  return { states, requests, bootstrap, event: (...args) => authEvent(...args), dispose: () => cleanup() };
}

const session = id => ({ user: { id, email: `${id}@example.invalid`, user_metadata: {} } });
const row = id => ({ data: { id, username: id, display_name: id, role: 'operator', active: true }, error: null });

test('bootstrap validates the session and reads its profile once despite INITIAL_SESSION', async () => {
  const f = await fixture();
  f.event('INITIAL_SESSION', session('a'));
  f.bootstrap.resolve({ data: { session: session('a') } });
  await tick();
  assert.equal(f.requests.length, 1);
  f.requests[0].result.resolve(row('a'));
  await tick();
  assert.equal(f.states[1].id, 'a');
  assert.equal(f.states[2], false);
  f.dispose();
});

test('a late bootstrap cannot overwrite a newer sign-in event', async () => {
  const f = await fixture();
  f.event('SIGNED_IN', session('b'));
  f.bootstrap.resolve({ data: { session: session('a') } });
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].owner, 'b');
  f.requests[0].result.resolve(row('b'));
  await tick();
  assert.equal(f.states[0].user.id, 'b');
  assert.equal(f.states[1].id, 'b');
  f.dispose();
});

test('superseded profile requests are aborted and cannot restore the previous account', async () => {
  const f = await fixture();
  f.event('SIGNED_IN', session('a'));
  f.event('SIGNED_IN', session('b'));
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[1].result.resolve(row('b'));
  await tick();
  f.requests[0].result.resolve(row('a'));
  await tick();
  assert.equal(f.states[1].id, 'b');
  f.dispose();
});

test('sign-out and unmount prevent late profile state updates', async () => {
  const f = await fixture();
  f.event('SIGNED_IN', session('a'));
  f.event('SIGNED_OUT', null);
  f.requests[0].result.resolve(row('a'));
  await tick();
  assert.equal(f.states[0], null);
  assert.equal(f.states[1].id, '');
  f.event('SIGNED_IN', session('b'));
  f.dispose();
  assert.equal(f.requests[1].signal.aborted, true);
  f.requests[1].result.resolve(row('b'));
  await tick();
  assert.equal(f.states[1].id, '');
});
