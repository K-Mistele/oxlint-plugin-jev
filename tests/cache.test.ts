import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vite-plus/test';
import { defaultCacheDir, readCache, writeCache } from '../src/cache.ts';

const scratch = () => mkdtempSync(path.join(tmpdir(), 'jev-cache-'));
const key = 'a'.repeat(64);
const entry = (probability: unknown) => ({
  model: 'jev-mock',
  answer: { type: 'boolean', probability },
});
const store = (dir: string, text: string) => writeFileSync(path.join(dir, `${key}.json`), text);

test('lives under node_modules/.cache in the working directory', () => {
  expect(defaultCacheDir()).toBe(
    path.join(process.cwd(), 'node_modules', '.cache', 'oxlint-plugin-jev'),
  );
});

test('reads an answer back with the model that gave it', () => {
  const dir = scratch();
  writeCache(dir, key, entry(0.93));
  expect(readCache(dir, key)).toEqual(entry(0.93));
});

test('creates the cache directory on first write', () => {
  const dir = path.join(scratch(), 'nested', 'deeper');
  writeCache(dir, key, entry(1));
  expect(readCache(dir, key)).toEqual(entry(1));
});

test('leaves no temporary file behind', () => {
  const dir = scratch();
  writeCache(dir, key, entry(1));
  expect(readdirSync(dir)).toEqual([`${key}.json`]);
});

test('overwrites an earlier entry for the same key', () => {
  const dir = scratch();
  writeCache(dir, key, entry(0.1));
  writeCache(dir, key, entry(0.9));
  expect(readCache(dir, key)).toEqual(entry(0.9));
});

test('misses when the entry does not exist', () => {
  expect(readCache(scratch(), key)).toBe(null);
});

test('misses when the directory does not exist', () => {
  expect(readCache(path.join(scratch(), 'absent'), key)).toBe(null);
});

test('misses when the entry is not valid json', () => {
  const dir = scratch();
  store(dir, '{ half-written');
  expect(readCache(dir, key)).toBe(null);
  expect(
    existsSync(path.join(dir, `${key}.json`)),
    'the bad entry is left for the next write to replace',
  ).toBe(true);
});

const malformedEntries = [
  ['an empty object', '{}'],
  ['a bare answer without a model', JSON.stringify(entry(0.9).answer)],
  ['an entry with an empty model id', JSON.stringify({ ...entry(0.9), model: '' })],
  ['an entry without an answer', JSON.stringify({ model: 'jev-mock' })],
] as const;

for (const [name, text] of malformedEntries) {
  test(`misses when the entry is ${name}`, () => {
    const dir = scratch();
    store(dir, text);
    expect(readCache(dir, key)).toBe(null);
  });
}
