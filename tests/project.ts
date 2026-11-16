import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vite-plus/test';
import type { DecisionRequest } from '../src/types.ts';
import { startMockJev } from './mock-jev.ts';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const pluginPath = path.join(root, 'dist', 'index.mjs');
// vite-plus ships its own LSP-only `oxlint` bin, which shadows the real one in node_modules/.bin.
const oxlintBin = path.join(root, 'node_modules', 'oxlint', 'bin', 'oxlint');

export interface Logged {
  authorization?: string;
  judge?: boolean;
  prompt?: string;
  body?: DecisionRequest & { model: string };
}

/** A scratch project linted by the real oxlint against a fresh mock server. */
export async function scratchProject(prefix: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), `jev-${prefix}-`));
  const mock = await startMockJev();
  onTestFinished(() => {
    mock.child.kill();
  });
  const write = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
      writeFileSync(path.join(cwd, name), text);
    }
  };
  const logged = (): Logged[] => {
    try {
      return readFileSync(mock.logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Logged);
    } catch {
      return [];
    }
  };
  return {
    cwd,
    baseURL: mock.baseURL,
    write,
    logged,
    /** Systemone requests only. */
    requests: () => logged().flatMap((entry) => (entry.body ? [entry.body] : [])),
    lint(files: string[], env: Record<string, string> = {}, format = 'unix') {
      const clean = { ...process.env };
      for (const name of Object.keys(clean)) {
        if (name === 'CI' || name.startsWith('TYPESAFE') || name.startsWith('JEV_')) {
          delete clean[name];
        }
        if (name === 'AI_GATEWAY_API_KEY' || name === 'VERCEL_OIDC_TOKEN') delete clean[name];
      }
      const result = spawnSync(oxlintBin, ['--format', format, '-c', '.oxlintrc.json', ...files], {
        cwd,
        encoding: 'utf8',
        env: {
          ...clean,
          TYPESAFE_API_KEY: 'test-key',
          TYPESAFE_BASE_URL: mock.baseURL,
          ...env,
        },
      });
      return {
        ...result,
        jev: result.stdout
          .split('\n')
          .filter((line) => /\[(Error|Warning)\/(?!eslint\()/.test(line))
          .sort(),
      };
    },
  };
}

/** Every snippet sent to the model, across requests. */
export const snippetsOf = (requests: DecisionRequest[]): string[] =>
  requests.flatMap((request) => Object.values(request.state.snippets));
