import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vite-plus/test';
import { backendFor } from '../src/backend.ts';
import { checkOptions, DEFAULTS } from '../src/options.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cacheDir = path.join(root, 'node_modules', '.cache', 'oxlint-plugin-jev');
const RULE_IDS = ['name-matches-behavior', 'no-pii-in-logs', 'no-prompt-injection'];

// The example's own options go through the plugin's backend selection, so this test runs exactly
// when linting example/ would reach a real decision model.
const exampleConfig = JSON.parse(
  readFileSync(path.join(root, 'example', '.oxlintrc.json'), 'utf8'),
) as { rules: { 'jev/ask': [string, object] } };
const chosen = backendFor(checkOptions({ ...DEFAULTS, ...exampleConfig.rules['jev/ask'][1] }));

test.skipIf(!chosen.ok)(
  'the example produces exactly the documented diagnostics against the real API',
  () => {
    rmSync(cacheDir, { recursive: true, force: true });
    const env = { ...process.env };
    delete env.CI;
    const result = spawnSync(
      path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint'),
      ['-c', 'example/.oxlintrc.json', '--format', 'unix', 'example/'],
      { cwd: root, encoding: 'utf8', env },
    );
    const lines = result.stdout.split('\n').filter((line) => line.includes('jev(ask)'));
    const idsOn = (file: string) =>
      lines
        .filter((line) => line.includes(file))
        .map((line) => line.match(/\[([^\]]+)\]/)?.[1] ?? '')
        .sort();
    expect(
      idsOn('fail.js'),
      `fail.js trips each rule once\n${result.stdout}${result.stderr}`,
    ).toEqual(RULE_IDS);
    expect(idsOn('pass.js'), `pass.js is clean\n${result.stdout}${result.stderr}`).toEqual([]);
    expect(result.status, 'oxlint fails the run').toBe(1);
  },
);
