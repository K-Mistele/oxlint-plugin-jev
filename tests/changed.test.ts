import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vite-plus/test';
import { defaultBase, parseDiff } from '../src/changed.ts';
import type { JevRule } from '../src/types.ts';
import { pluginPath, scratchProject, snippetsOf } from './project.ts';

const callRule: JevRule = {
  id: 'no-pii-in-logs',
  target: 'call',
  question: 'Does this call write personal data to a log?',
  cutoff: 0.8,
};
const fileRule: JevRule = {
  id: 'file-pii',
  target: 'file',
  question: 'Does this file write personal data to a log?',
  cutoff: 0.8,
};

// The scratch repo ignores the developer's git config; the identity is passed to its commits only.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
const commit = (cwd: string, message: string, ...args: string[]) =>
  git(
    cwd,
    '-c',
    'user.name=Jev Test',
    '-c',
    'user.email=jev-test@example.com',
    'commit',
    '-qm',
    message,
    ...args,
  );

const twoCalls = (first: string, second: string) =>
  `console.log("${first}", user.email, user.phone);\n\nconsole.log("${second}", user.email, user.phone);\n`;

/** `jev/ask` with the given mode options next to its rules; none means the default. */
const config = (mode: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsPlugins: [pluginPath],
    rules: { 'jev/ask': ['error', { ...mode, rules: [callRule, fileRule] }] },
  });

const CHANGED = { mode: 'changed' };

/**
 * `main` holds the base commit. The `feature` branch commits an edit to `committed.js`, then
 * leaves an unstaged edit, a staged edit, and an untracked file in the working tree.
 */
async function repo(mode?: Record<string, unknown>) {
  const project = await scratchProject('changed');
  project.write({
    '.oxlintrc.json': config(mode),
    '.gitignore': 'node_modules\n',
    'committed.js': twoCalls('zero', 'nine'),
    'edited.js': twoCalls('one', 'two'),
    'staged.js': twoCalls('three', 'four'),
    'clean.js': twoCalls('five', 'six'),
  });
  git(project.cwd, 'init', '-q', '-b', 'main');
  git(project.cwd, 'add', '.');
  commit(project.cwd, 'base');
  git(project.cwd, 'checkout', '-q', '-b', 'feature');
  project.write({ 'committed.js': twoCalls('zero committed', 'nine') });
  git(project.cwd, 'add', 'committed.js');
  commit(project.cwd, 'on the branch');
  project.write({
    'edited.js': twoCalls('one', 'two edited'),
    'staged.js': twoCalls('three staged', 'four'),
    'untracked.js': twoCalls('seven', 'eight'),
  });
  git(project.cwd, 'add', 'staged.js');
  return project;
}

const files = ['committed.js', 'edited.js', 'staged.js', 'clean.js', 'untracked.js'];
// A call snippet is one line; a file rule sends the whole file.
const isFile = (snippet: string) => snippet.includes('\n');
const callSnippets = (snippets: string[]) => snippets.filter((snippet) => !isFile(snippet)).sort();

test('without a mode every match is asked about, on changed and unchanged lines alike', async () => {
  const project = await repo();
  const result = project.lint(files);
  expect(result.stderr).not.toContain('could not diff');
  expect(callSnippets(snippetsOf(project.requests())).length).toBe(10);
  expect(project.requests().length, 'every file sends a request, the unchanged one included').toBe(
    5,
  );
});

test('"changed" asks only about lines changed since the merge base with main', async () => {
  const project = await repo(CHANGED);
  const result = project.lint(files);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const snippets = snippetsOf(project.requests());
  expect(callSnippets(snippets)).toEqual([
    'console.log("eight", user.email, user.phone)',
    'console.log("seven", user.email, user.phone)',
    'console.log("three staged", user.email, user.phone)',
    'console.log("two edited", user.email, user.phone)',
    'console.log("zero committed", user.email, user.phone)',
  ]);
  expect(
    project.requests().length,
    'the unchanged file sends nothing at all, its file rule included',
  ).toBe(4);
  expect(snippets.filter(isFile).length, 'a file rule matches every changed file').toBe(4);
  expect(result.jev.some((line) => line.startsWith('clean.js'))).toBe(false);
  expect(result.stderr).not.toContain('checking every line');
});

test('mode "all" and JEV_MODE=all ask about every match', async () => {
  const explicit = await repo({ mode: 'all' });
  explicit.lint(files);
  expect(callSnippets(snippetsOf(explicit.requests())).length).toBe(10);

  const forced = await repo(CHANGED);
  forced.lint(files, { JEV_MODE: 'all' });
  expect(callSnippets(snippetsOf(forced.requests())).length).toBe(10);
});

test('the base option and JEV_CHANGED_BASE pick the ref to diff against', async () => {
  const project = await repo({ ...CHANGED, base: 'HEAD' });
  project.lint(files);
  expect(
    callSnippets(snippetsOf(project.requests())),
    'against HEAD, the commit on the branch no longer counts',
  ).toHaveLength(4);

  const fromEnv = await repo(CHANGED);
  fromEnv.lint(files, { JEV_CHANGED_BASE: 'HEAD' });
  expect(callSnippets(snippetsOf(fromEnv.requests()))).toHaveLength(4);
});

test('outside a git repository every line is checked, with a warning', async () => {
  const project = await scratchProject('changed-nogit');
  project.write({ '.oxlintrc.json': config(CHANGED), 'a.js': twoCalls('one', 'two') });
  const result = project.lint(['a.js']);
  expect(callSnippets(snippetsOf(project.requests()))).toHaveLength(2);
  expect(result.stderr).toMatch(/could not diff .*checking every line/);
});

test('without a default branch every line is checked, with a warning', async () => {
  const project = await scratchProject('changed-trunk');
  project.write({ '.oxlintrc.json': config(CHANGED), 'a.js': twoCalls('one', 'two') });
  git(project.cwd, 'init', '-q', '-b', 'trunk');
  git(project.cwd, 'add', '.');
  commit(project.cwd, 'base');
  const result = project.lint(['a.js']);
  expect(callSnippets(snippetsOf(project.requests()))).toHaveLength(2);
  expect(result.stderr).toMatch(/no default branch found/);
});

function bareRepo(branch: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jev-base-'));
  git(cwd, 'init', '-q', '-b', branch);
  commit(cwd, 'base', '--allow-empty');
  return cwd;
}

test('the default branch is origin/HEAD, then origin/main, origin/master, main, master', () => {
  const master = bareRepo('master');
  expect(defaultBase(master)).toBe('master');

  git(master, 'branch', 'main');
  expect(defaultBase(master), 'main is tried before master').toBe('main');

  git(master, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  expect(defaultBase(master), 'remote branches come before local ones').toBe('origin/master');

  git(master, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(master, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
  expect(defaultBase(master), 'origin/HEAD names the remote default branch').toBe('origin/master');

  const none = bareRepo('trunk');
  expect(defaultBase(none)).toBeNull();
});

test('a createJevPlugin rule takes mode as its own option, and rejects other options', async () => {
  const project = await repo();
  project.write({
    'jev-rules.mjs': `import { createJevPlugin } from ${JSON.stringify(pluginPath)};
export default createJevPlugin(${JSON.stringify({ name: 'acme', rules: [callRule, fileRule] })});
`,
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['./jev-rules.mjs'],
      rules: { 'acme/no-pii-in-logs': ['error', CHANGED], 'acme/file-pii': 'error' },
    }),
  });
  const result = project.lint(files);
  expect(result.stderr).not.toContain('Options validation failed');
  const snippets = snippetsOf(project.requests());
  expect(callSnippets(snippets), 'the call rule asks only about changed lines').toHaveLength(5);
  expect(
    snippets.filter(isFile).length,
    'the file rule has no mode, so it asks about every file',
  ).toBe(5);

  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: ['./jev-rules.mjs'],
      rules: { 'acme/no-pii-in-logs': ['error', { mode: 'changed', cutoff: 0.5 }] },
    }),
  });
  const rejected = project.lint(files);
  expect(rejected.stdout + rejected.stderr).toMatch(/Unexpected property "cutoff"/);
});

test('parses zero-context hunks into new-side line numbers', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -3 +3 @@',
    '@@ -10,0 +11,2 @@',
    '@@ -20,2 +21,0 @@',
    'diff --git a/gone.js b/gone.js',
    '--- a/gone.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
  ].join('\n');
  expect(parseDiff(diff)).toEqual(new Map([['a.js', new Set([3, 11, 12, 21, 22])]]));
});
