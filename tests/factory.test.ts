import { expect, test } from 'vite-plus/test';
import { createJevPlugin } from '../src/index.ts';
import type { JevRule } from '../src/types.ts';
import { pluginPath, scratchProject } from './project.ts';

const rules: JevRule[] = [
  {
    id: 'no-pii-in-logs',
    target: 'call',
    question: 'Does this call write personal data to a log?',
    cutoff: 0.8,
  },
  {
    id: 'pii-smell',
    target: 'call',
    question: 'Does this call hint at personal data in a log or console?',
    cutoff: 0.8,
    message: 'Possibly logs personal data.',
  },
  {
    id: 'name-matches-behavior',
    target: 'function',
    question: "Does this function's name imply it only reads data, while it also sends something?",
    cutoff: 0.6,
  },
  {
    id: 'never-enabled',
    target: 'function',
    question: 'Is this a never-enabled check?',
    cutoff: 0.5,
  },
];

const rulesModule = `import { createJevPlugin } from ${JSON.stringify(pluginPath)};
export default createJevPlugin(${JSON.stringify({ name: 'acme', rules })});
`;

const source = `function getUser(id) {
  console.log("loaded", user.email, user.phone);
  return id;
}
function quiet() {
  return 1;
}
`;

const configWith = (severities: Record<string, string>) =>
  JSON.stringify({
    jsPlugins: ['./jev-rules.mjs'],
    rules: Object.fromEntries(
      Object.entries(severities).map(([id, level]) => [`acme/${id}`, level]),
    ),
  });

test('each question is its own oxlint rule with its own severity, and one file is one request', async () => {
  const project = await scratchProject('factory');
  project.write({
    'jev-rules.mjs': rulesModule,
    'a.js': source,
    'b.js': 'console.log("hi");\n',
    '.oxlintrc.json': configWith({
      'no-pii-in-logs': 'error',
      'pii-smell': 'warn',
      'name-matches-behavior': 'error',
      'never-enabled': 'off',
    }),
  });
  const result = project.lint(['a.js', 'b.js']);
  expect(result.jev, result.stdout + result.stderr).toEqual([
    "a.js:1:1: [name-matches-behavior] jev-mock answered yes (0.95 >= 0.60): Does this function's name imply it only reads data, while it also sends something? [Error/acme(name-matches-behavior)]",
    'a.js:2:3: [no-pii-in-logs] jev-mock answered yes (0.95 >= 0.80): Does this call write personal data to a log? [Error/acme(no-pii-in-logs)]',
    'a.js:2:3: [pii-smell] Possibly logs personal data. (jev-mock answered yes, 0.95 >= 0.80) [Warning/acme(pii-smell)]',
  ]);
  expect(result.status).toBe(1);

  const requests = project.requests();
  expect(requests.length, 'three enabled rules share one request per file').toBe(2);
  const questions = requests.flatMap((request) =>
    Object.values(request.questions).map((question) => question.instructions),
  );
  expect(questions.filter((text) => text.includes('write personal data')).length).toBe(2);
  expect(questions.filter((text) => text.includes('hint at personal data')).length).toBe(2);
  expect(questions.filter((text) => text.includes('only reads data')).length).toBe(2);
  expect(
    questions.some((text) => text.includes('never-enabled')),
    'a rule turned off in the config sends nothing',
  ).toBe(false);

  project.write({
    '.oxlintrc.json': configWith({
      'no-pii-in-logs': 'warn',
      'pii-smell': 'error',
      'name-matches-behavior': 'error',
    }),
  });
  const reseverity = project.lint(['a.js', 'b.js']);
  expect(project.requests().length, 'changing a severity keeps every cached answer').toBe(2);
  expect(
    reseverity.jev.filter((line) => line.includes('[Warning/acme(no-pii-in-logs)]')),
  ).toHaveLength(1);
});

test('a factory plugin with every rule off sends nothing', async () => {
  const project = await scratchProject('factory-off');
  project.write({
    'jev-rules.mjs': rulesModule,
    'a.js': source,
    '.oxlintrc.json': configWith({ 'no-pii-in-logs': 'off', 'pii-smell': 'off' }),
  });
  const result = project.lint(['a.js']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(project.requests()).toEqual([]);
});

test('the shared request is capped across all of the plugin rules', async () => {
  const project = await scratchProject('factory-cap');
  const capped = `import { createJevPlugin } from ${JSON.stringify(pluginPath)};
export default createJevPlugin(${JSON.stringify({ name: 'acme', maxMatchesPerFile: 3, rules })});
`;
  project.write({
    'jev-rules.mjs': capped,
    'a.js': ['a', 'b', 'c']
      .map((row) => `console.log("${row}", user.email, user.phone);\n`)
      .join(''),
    '.oxlintrc.json': configWith({ 'no-pii-in-logs': 'error', 'pii-smell': 'warn' }),
  });
  const result = project.lint(['a.js']);
  expect(project.requests().length).toBe(1);
  expect(Object.keys(project.requests()[0].questions).length).toBe(3);
  expect(result.stderr).toContain('6 matches exceeded maxMatchesPerFile=3, 3 not checked by acme');
});

test('createJevPlugin names one rule per id', () => {
  const plugin = createJevPlugin({ name: 'acme', rules });
  expect(plugin.meta).toEqual({ name: 'acme' });
  expect(Object.keys(plugin.rules)).toEqual(rules.map((rule) => rule.id));
});

const badPlugins: [string, unknown, string][] = [
  ['the name is missing', { rules }, 'plugin name'],
  ['the name has a slash', { name: 'a/b', rules }, 'plugin name'],
  ['there are no rules', { name: 'acme', rules: [] }, 'options.rules must list at least 1'],
  [
    'an id has a slash',
    { name: 'acme', rules: [{ ...rules[0], id: 'a/b' }] },
    'cannot contain "/"',
  ],
  ['two ids repeat', { name: 'acme', rules: [rules[0], rules[0]] }, 'used more than once'],
  [
    'a cutoff is out of range',
    { name: 'acme', rules: [{ ...rules[0], cutoff: 2 }] },
    'cutoff is out of range',
  ],
  [
    'a target is unknown',
    { name: 'acme', rules: [{ ...rules[0], target: 'class' }] },
    'target must be one of',
  ],
  ['an option is unknown', { name: 'acme', rules, foo: 1 }, 'options.foo is not a known option'],
  ['a judge has no model', { name: 'acme', rules, judge: {} }, 'options.judge.model is required'],
];

test.each(badPlugins)('createJevPlugin refuses options where %s', (_name, options, message) => {
  expect(() => createJevPlugin(options as Parameters<typeof createJevPlugin>[0])).toThrow(message);
});
