import { execFileSync } from 'node:child_process';
import { expect, test } from 'vite-plus/test';
import { parseDiff } from '../src/changed.ts';
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
const commit = (cwd: string, message: string) =>
  git(
    cwd,
    '-c',
    'user.name=Jev Test',
    '-c',
    'user.email=jev-test@example.com',
    'commit',
    '-qm',
    message,
  );

const twoCalls = (first: string, second: string) =>
  `console.log("${first}", user.email, user.phone);\n\nconsole.log("${second}", user.email, user.phone);\n`;

async function repo(options: Record<string, unknown>) {
  const project = await scratchProject('changed');
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { rules: [callRule, fileRule], ...options }] },
    }),
    '.gitignore': 'node_modules\n',
    'edited.js': twoCalls('one', 'two'),
    'staged.js': twoCalls('three', 'four'),
    'clean.js': twoCalls('five', 'six'),
  });
  git(project.cwd, 'init', '-q');
  git(project.cwd, 'add', '.');
  commit(project.cwd, 'base');
  project.write({
    'edited.js': twoCalls('one', 'two edited'),
    'staged.js': twoCalls('three staged', 'four'),
    'untracked.js': twoCalls('seven', 'eight'),
  });
  git(project.cwd, 'add', 'staged.js');
  return project;
}

const files = ['edited.js', 'staged.js', 'clean.js', 'untracked.js'];
// A call snippet is one line; a file rule sends the whole file.
const isFile = (snippet: string) => snippet.includes('\n');
const callSnippets = (snippets: string[]) => snippets.filter((snippet) => !isFile(snippet)).sort();

test('changedOnly asks only about matches on lines changed against HEAD', async () => {
  const project = await repo({ changedOnly: true });
  const result = project.lint(files);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const snippets = snippetsOf(project.requests());
  expect(callSnippets(snippets)).toEqual([
    'console.log("eight", user.email, user.phone)',
    'console.log("seven", user.email, user.phone)',
    'console.log("three staged", user.email, user.phone)',
    'console.log("two edited", user.email, user.phone)',
  ]);
  expect(
    project.requests().length,
    'the unchanged file sends nothing at all, its file rule included',
  ).toBe(3);
  expect(snippets.filter(isFile).length, 'a file rule matches every changed file').toBe(3);
  expect(result.jev.some((line) => line.startsWith('clean.js'))).toBe(false);
});

test('changedOnly is off by default and JEV_CHANGED_ONLY turns it on', async () => {
  const project = await repo({});
  project.lint(files);
  expect(callSnippets(snippetsOf(project.requests())).length, 'every call is asked about').toBe(8);

  const scoped = await repo({});
  scoped.lint(files, { JEV_CHANGED_ONLY: '1' });
  expect(callSnippets(snippetsOf(scoped.requests())).length).toBe(4);
});

test('changedBase and JEV_CHANGED_BASE pick the ref to diff against', async () => {
  const project = await repo({ changedOnly: true, changedBase: 'HEAD' });
  git(project.cwd, 'add', '.');
  commit(project.cwd, 'second');
  project.lint(files);
  expect(project.requests(), 'nothing changed against the new HEAD').toEqual([]);
  project.lint(files, { JEV_CHANGED_BASE: 'HEAD~1' });
  expect(callSnippets(snippetsOf(project.requests())).length).toBe(4);
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
