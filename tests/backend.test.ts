import { afterEach, beforeEach, expect, test } from 'vite-plus/test';
import { backendFor, NO_JEV_CREDENTIALS } from '../src/backend.ts';
import { checkOptions, DEFAULTS } from '../src/options.ts';

const CREDENTIALS = [
  'TYPESAFE_API_KEY',
  'TYPESAFE_AI_API_KEY',
  'TYPESAFE_BASE_URL',
  'TYPESAFE_AI_BASE_URL',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(CREDENTIALS.map((name) => [name, process.env[name]]));
  for (const name of CREDENTIALS) delete process.env[name];
});

afterEach(() => {
  for (const name of CREDENTIALS) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const options = (extra: Record<string, unknown> = {}) =>
  checkOptions({
    ...DEFAULTS,
    rules: [{ id: 'r', target: 'function', question: 'Is this bad?', cutoff: 0.8 }],
    ...extra,
  });

test('with no credentials at all, the reason names every credential that could be set', () => {
  const result = backendFor(options());
  expect(result).toEqual({ ok: false, reason: NO_JEV_CREDENTIALS });
  for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_AI_API_KEY', 'AI_GATEWAY_API_KEY']) {
    expect(NO_JEV_CREDENTIALS).toContain(name);
  }
});

test('a TypeSafe key wins over gateway credentials', () => {
  process.env.TYPESAFE_API_KEY = 'k';
  process.env.AI_GATEWAY_API_KEY = 'g';
  const result = backendFor(options());
  expect(result.ok && result.backend.kind).toBe('typesafe');
});

test('without a TypeSafe key, gateway credentials send jev-latest to typesafe-ai/jev', () => {
  process.env.AI_GATEWAY_API_KEY = 'g';
  const result = backendFor(options());
  expect(result.ok && result.backend).toMatchObject({ kind: 'gateway', model: 'typesafe-ai/jev' });
});

test('a pinned model falls back to its typesafe-ai gateway id', () => {
  process.env.VERCEL_OIDC_TOKEN = 'oidc';
  const result = backendFor(options({ model: 'jev-1.13.0' }));
  expect(result.ok && result.backend).toMatchObject({
    kind: 'gateway',
    model: 'typesafe-ai/jev-1.13.0',
  });
});
