import { expect, test } from 'vite-plus/test';
import type { JevRule } from '../src/types.ts';
import { pluginPath, scratchProject, snippetsOf } from './project.ts';

const rule: JevRule = {
  id: 'name-matches-behavior',
  target: 'function',
  question: "Does this function's name imply it only reads data, while it also sends something?",
  cutoff: 0.6,
};

const source = (body: string) => `function getUser(id) {
  console.log("loaded");
  return id;
}

function readCount() {
  ${body}
}
`;

test('editing one function only re-asks about that function', async () => {
  const project = await scratchProject('per-match');
  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: { 'jev/ask': ['error', { rules: [rule] }] },
    }),
    'a.js': source('return 1;'),
  });
  const first = project.lint(['a.js']);
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect(Object.keys(project.requests()[0].questions).length).toBe(2);

  project.write({ 'a.js': source('return 2;') });
  const second = project.lint(['a.js']);
  const requests = project.requests();
  expect(requests.length).toBe(2);
  expect(snippetsOf([requests[1]]), 'only the edited function is sent').toEqual([
    'function readCount() {\n  return 2;\n}',
  ]);
  expect(second.jev, 'the cached function is still reported').toEqual(first.jev);

  project.write({
    '.oxlintrc.json': JSON.stringify({
      jsPlugins: [pluginPath],
      rules: {
        'jev/suggest': [
          'warn',
          { rules: [{ ...rule, id: 'renamed', cutoff: 0.7, message: 'Rename it.' }] },
        ],
      },
    }),
  });
  const third = project.lint(['a.js']);
  expect(
    project.requests().length,
    'a new id, cutoff, message, and severity reuse every answer',
  ).toBe(2);
  expect(third.jev).toEqual([
    'a.js:1:1: [renamed] Rename it. (jev-mock answered yes, 0.95 >= 0.70) [Warning/jev(suggest)]',
  ]);
});
