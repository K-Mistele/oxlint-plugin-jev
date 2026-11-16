import path from 'node:path';
import { expect, test } from 'vite-plus/test';
import type { JevRule } from '../src/types.ts';
import { pluginPath, root, scratchProject } from './project.ts';

const rules: JevRule[] = [
  {
    id: 'no-pii-in-logs',
    target: 'call',
    question: 'Does this call write personal data to a log?',
    cutoff: 0.8,
  },
  {
    id: 'file-pii',
    target: 'file',
    question: 'Does this file write personal data to a log?',
    cutoff: 0.8,
    location: { question: 'Select the logging call.', cutoff: 0.75 },
  },
];
const source = '// header\nconsole.log("row", user.email, user.phone);\nconsole.log("ok");\n';

test('an LLM judge answers the same questions through any AI SDK provider', async () => {
  const project = await scratchProject('judge');
  const judge = { model: 'mock-judge', provider: path.join(root, 'tests', 'judge-provider.mjs') };
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { judge, rules }] },
    }),
    'a.js': source,
  });
  const env = { JEV_JUDGE_URL: project.baseURL, TYPESAFE_API_KEY: '' };
  const result = project.lint(['a.js'], env);
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.jev).toEqual([
    'a.js:1:1: [file-pii] mock-judge-answered answered yes (0.90 >= 0.80): Does this file write personal data to a log? [Error/jev(ask)]',
    'a.js:2:1: [no-pii-in-logs] mock-judge-answered answered yes (0.90 >= 0.80): Does this call write personal data to a log? [Error/jev(ask)]',
  ]);
  const calls = project.logged();
  expect(project.requests(), 'Jev is not asked').toEqual([]);
  expect(calls.length, 'one judge call for the file').toBe(1);
  const prompt = JSON.parse(calls[0].prompt ?? '{}') as { questions: Record<string, string> };
  expect(Object.keys(prompt.questions), 'three yes/no questions, no location question').toEqual([
    'q0',
    'q1',
    'q2',
  ]);

  project.lint(['a.js'], env);
  expect(project.logged().length, 'judge answers are cached like Jev answers').toBe(1);
});

test('a judge without a provider module uses AI Gateway and needs its key', async () => {
  const project = await scratchProject('judge-gateway');
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { judge: { model: 'openai/gpt-5-mini' }, rules }] },
    }),
    'a.js': source,
  });
  const result = project.lint(['a.js']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('AI_GATEWAY_API_KEY is not set');
});

test('an AI Gateway decision model id needs the AI Gateway key', async () => {
  const project = await scratchProject('gateway');
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { model: 'typesafe-ai/jev', ci: 'fail', rules }] },
    }),
    'a.js': source,
  });
  const result = project.lint(['a.js'], { CI: '1' }, 'default');
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('AI_GATEWAY_API_KEY is not set');
});

test('the AI SDK variable names TYPESAFE_AI_API_KEY and TYPESAFE_AI_BASE_URL work too', async () => {
  const project = await scratchProject('ai-sdk-env');
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { rules: [rules[0]] }] },
    }),
    'a.js': source,
  });
  const result = project.lint(['a.js'], {
    TYPESAFE_API_KEY: '',
    TYPESAFE_BASE_URL: '',
    TYPESAFE_AI_API_KEY: 'sdk-key',
    TYPESAFE_AI_BASE_URL: `${project.baseURL}/v1`,
  });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(project.logged()[0].authorization).toBe('Bearer sdk-key');
});
