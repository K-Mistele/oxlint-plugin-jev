import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';
import { buildRequest, verdictAsk } from '../src/jev.ts';
import type { AskInput, AskResult } from '../src/types.ts';
import { startMockJev, type MockJev } from './mock-jev.ts';

// `src/sync-jev.ts` resolves its worker as `./worker.mjs` next to itself, which only exists in
// `dist`, so this drives the built copy. The specifier is a variable so a typecheck before the
// first build still resolves, and the signature comes from the source it was built from.
const dist: unknown = await import(new URL('../dist/sync-jev.mjs', import.meta.url).href);
const { askModel } = dist as { askModel: (input: AskInput) => AskResult };

const { request } = buildRequest([
  verdictAsk('test', { rule: { question: 'Is it bad?' }, snippet: 'f()' }),
]);

let mock: MockJev;
beforeAll(async () => {
  mock = await startMockJev();
});
afterAll(() => mock.child.kill());

const ask = (apiKey: string, extra: Partial<AskInput> = {}): AskResult =>
  askModel({
    backend: {
      kind: 'typesafe',
      model: 'jev-latest',
      apiKey,
      baseURL: `${mock.baseURL}/v1`,
      longContext: false,
    },
    request,
    timeoutMs: 5000,
    ...extra,
  });
const logged = (token: string) =>
  readFileSync(mock.logPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes(`"Bearer ${token}"`))
    .map((line) => JSON.parse(line) as { headers: Record<string, string>; body: unknown });
const hits = (token: string) => logged(token).length;

test('returns the AI SDK answers and the model that answered on 2xx', () => {
  const result = ask('test-key');
  expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  expect(result).toEqual({
    ok: true,
    model: 'jev-mock',
    answers: { q0: { type: 'boolean', probability: 0.05 } },
  });
});

test('posts the TypeSafe systemone body, with boolean questions sent as noul', () => {
  ask('wire-check');
  expect(logged('wire-check')[0].body).toEqual({
    model: 'jev-latest',
    state: { snippets: { s0: 'f()' } },
    questions: {
      q0: {
        type: 'noul',
        instructions: 'Consider only snippet "s0" in state.snippets. Is it bad?',
      },
    },
  });
  expect(logged('wire-check')[0].headers['typesafe-danger-zone-long-context']).toBeUndefined();
});

test('sends the long-context header only when longContext is on', () => {
  askModel({
    backend: {
      kind: 'typesafe',
      model: 'jev-latest',
      apiKey: 'long-context',
      baseURL: `${mock.baseURL}/v1`,
      longContext: true,
    },
    request,
    timeoutMs: 5000,
  });
  expect(logged('long-context')[0].headers['typesafe-danger-zone-long-context']).toBe('true');
});

test('maps a non-2xx status to an http reason', () => {
  const result = ask('unauthorized');
  expect(result).toEqual({ ok: false, reason: 'http 401: bad key' });
  expect(hits('unauthorized'), 'a 401 is not retried').toBe(1);
});

test('retries a 429 through the AI SDK and returns the eventual answer', () => {
  expect(ask('flaky').ok).toBe(true);
  expect(hits('flaky'), 'the first attempt got the 429 and the second the answer').toBe(2);
});

test('maps a stalled response to timeout within the per-file budget', () => {
  const started = Date.now();
  expect(ask('slow', { timeoutMs: 300 })).toEqual({ ok: false, reason: 'timeout' });
  expect(Date.now() - started, 'retries do not extend the wait past our signal').toBeLessThan(2000);
});

test('maps a refused connection to a network reason, even when the deadline ends the retries', () => {
  const result = askModel({
    backend: {
      kind: 'typesafe',
      model: 'jev-latest',
      apiKey: 'test-key',
      baseURL: 'http://127.0.0.1:9/v1',
      longContext: false,
    },
    request,
    timeoutMs: 500,
  });
  expect(result.ok).toBe(false);
  expect(result.ok ? '' : result.reason).toMatch(/^network: /);
});
