import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/resultCodes.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { resultCode, userError, AppError } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

test('return codes classify common transport, auth, data and validation errors', () => {
  assert.equal(resultCode({ code: '23502' }), 'VAL-001');
  assert.equal(resultCode({ code: '23505' }), 'DATA-002');
  assert.equal(resultCode({ code: '42501' }), 'AUTH-002');
  assert.equal(resultCode(null, 429), 'SVC-002');
  assert.equal(resultCode(new AppError('TXN-001')), 'TXN-001');
});

test('user messages are localized and never include raw service details', () => {
  const raw = new Error('PostgREST PGRST204 internal relation audit_logs_secret');
  assert.equal(userError(raw, 'ja'), '処理を完了できませんでした。再試行しても続く場合は管理者にお問い合わせください。');
  assert.equal(userError(raw, 'en'), 'The action could not be completed. Retry, or contact your administrator if it continues.');
});

test('unknown write outcome tells the user to check before resubmitting', () => {
  assert.match(userError(new AppError('TXN-001'), 'en'), /save result is unknown/i);
});
