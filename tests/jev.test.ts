import { expect, test } from 'vite-plus/test';
import {
  buildRequest,
  isValidAnswer,
  locationAsk,
  locationCandidates,
  probabilityOf,
  selectedLocation,
  truncateSnippet,
  verdictAsk,
} from '../src/jev.ts';
import type { ChoiceQuestion, JevRule, RequestMatch } from '../src/types.ts';

const secretRule: JevRule = {
  id: 'no-secret-logging',
  target: 'call',
  question: 'Does this call print, log, or send a password, token, secret, or API key?',
  cutoff: 0.8,
};
const swallowRule: JevRule = {
  id: 'no-swallowed-errors',
  target: 'function',
  question: 'Does this function swallow an error silently?',
  cutoff: 0.75,
};
const matches: RequestMatch[] = [
  { rule: secretRule, snippet: 'console.log("token", process.env.API_TOKEN)' },
  { rule: swallowRule, snippet: 'function f() { try { g() } catch {} }' },
];
const backend = 'typesafe https://api.typesafe.ai/v1 jev-latest';
const verdicts = (list: readonly RequestMatch[]) => list.map((match) => verdictAsk(backend, match));

test('builds the request body the AI SDK decision API takes', () => {
  expect(buildRequest(verdicts(matches))).toEqual({
    request: {
      state: {
        snippets: {
          s0: 'console.log("token", process.env.API_TOKEN)',
          s1: 'function f() { try { g() } catch {} }',
        },
      },
      questions: {
        q0: {
          type: 'boolean',
          instructions:
            'Consider only snippet "s0" in state.snippets. Does this call print, log, or send a password, token, secret, or API key?',
        },
        q1: {
          type: 'boolean',
          instructions:
            'Consider only snippet "s1" in state.snippets. Does this function swallow an error silently?',
        },
      },
    },
    ids: ['q0', 'q1'],
  });
});

test('sends a snippet shared by two questions once', () => {
  const shared = { rule: swallowRule, snippet: matches[0].snippet };
  const { request } = buildRequest(verdicts([matches[0], shared]));
  expect(Object.keys(request.state.snippets)).toEqual(['s0']);
  expect(Object.keys(request.questions)).toEqual(['q0', 'q1']);
  expect(request.questions.q1.instructions).toContain('snippet "s0"');
});

test('asks an identical question about an identical snippet once', () => {
  const { request, ids } = buildRequest(verdicts([matches[0], { ...matches[0] }]));
  expect(Object.keys(request.questions)).toEqual(['q0']);
  expect(ids).toEqual(['q0', 'q0']);
});

test('leaves a snippet at the limit untouched', () => {
  expect(truncateSnippet('abcde', 5)).toBe('abcde');
});

test('marks a snippet past the limit as truncated', () => {
  expect(truncateSnippet('abcdef', 5)).toBe('abcde/* ...truncated */');
});

test.each([0, 0.4, 1])('reads a boolean probability of %s', (probability) => {
  expect(probabilityOf({ type: 'boolean', probability })).toBe(probability);
});

test.each([
  undefined,
  null,
  0.4,
  { type: 'noul', noul: 0.4 },
  { type: 'boolean' },
  { type: 'boolean', probability: '0.4' },
  { type: 'boolean', probability: Number.NaN },
  { type: 'boolean', probability: -0.01 },
  { type: 'boolean', probability: 1.01 },
])('refuses a verdict that is not a probability in [0, 1] (%j)', (answer) => {
  expect(probabilityOf(answer)).toBe(null);
  expect(isValidAnswer(verdictAsk(backend, matches[0]), answer)).toBe(false);
});

const keyOf = (match: RequestMatch, on = backend) => verdictAsk(on, match).key;

test('hashes to a stable sha256 hex digest', () => {
  expect(keyOf(matches[0])).toMatch(/^[0-9a-f]{64}$/);
  expect(keyOf(matches[0])).toBe(keyOf({ ...matches[0] }));
});

const keyEdits: [string, string][] = [
  ['the model changes', keyOf(matches[0], 'typesafe https://api.typesafe.ai/v1 jev-1.13.0')],
  ['the backend changes', keyOf(matches[0], 'gateway typesafe-ai/jev')],
  ['the snippet changes', keyOf({ ...matches[0], snippet: 'console.log(2)' })],
  [
    'the question changes',
    keyOf({ ...matches[0], rule: { ...secretRule, question: 'Something else?' } }),
  ],
];

for (const [name, key] of keyEdits) {
  test(`invalidates a cached answer when ${name}`, () => {
    expect(key).not.toBe(keyOf(matches[0]));
  });
}

const verdictNeutralEdits: [string, JevRule][] = [
  ['a cutoff changes', { ...secretRule, cutoff: 0.81 }],
  ['a rule id changes', { ...secretRule, id: 'renamed' }],
  ['a message changes', { ...secretRule, message: 'Do not log secrets.' }],
];

for (const [name, rule] of verdictNeutralEdits) {
  test(`keeps the answer when ${name}, since verdicts do not depend on it`, () => {
    expect(keyOf({ ...matches[0], rule })).toBe(keyOf(matches[0]));
  });
}

test('keys each match on its own, so a neighbour or its position does not matter', () => {
  const alone = buildRequest(verdicts([matches[1]]));
  const after = buildRequest(verdicts([matches[0], matches[1]]));
  expect(verdictAsk(backend, matches[1]).key).toBe(verdicts([matches[0], matches[1]])[1].key);
  expect(alone.request.questions.q0.instructions).not.toBe(after.request.questions.q1.instructions);
});

const locationMatch = {
  rule: {
    question: 'Does this file log a secret?',
    location: { question: 'Select the logging call.', cutoff: 0.75 },
  },
  snippet: '// Context\n\nconsole.log(secret);\n',
};
const located = locationAsk(backend, locationMatch);
const criteria = (located.question('s0') as ChoiceQuestion).criteria;

test('numbers the source a location question reads', () => {
  const { request } = buildRequest([verdictAsk(backend, locationMatch), located]);
  expect(request.state.snippets).toEqual({
    s0: 'L1| // Context\nL2| \nL3| console.log(secret);\nL4| ',
  });
  expect(Object.keys(request.questions)).toEqual(['q0', 'q1']);
  expect(request.questions.q1.type).toBe('choice');
});

test('offers only nonblank source lines and an unknown location', () => {
  expect(Object.keys(criteria)).toEqual(['L1', 'L3', 'unknown']);
});

test('an empty file offers only an unknown location', () => {
  const empty = locationAsk(backend, { ...locationMatch, snippet: ' \n\t' });
  expect(Object.keys((empty.question('s0') as ChoiceQuestion).criteria)).toEqual(['unknown']);
});

test('a refinement is cached apart from the first location question', () => {
  expect(locationAsk(backend, locationMatch, { start: 1, end: 3 }).key).not.toBe(located.key);
});

test.each([254, 255, 70000])(
  'bounds location choices for %i nonblank lines and refines to a line',
  (count) => {
    const snippet = 'code();\n'.repeat(count);
    let candidates = locationCandidates(snippet);
    for (let depth = 0; depth < 10; depth++) {
      expect(Object.keys(candidates).length).toBeLessThanOrEqual(254);
      const last = Object.values(candidates).at(-1)!;
      expect(last.end).toBe(count);
      if (last.start === last.end) return;
      candidates = locationCandidates(snippet, last);
    }
    throw new Error('Location refinement did not reach a line');
  },
);

const malformedChoices: unknown[] = [
  undefined,
  null,
  'L3',
  { type: 'boolean', probability: 0.99 },
  { type: 'choice', choice: 'L3' },
  { type: 'choice', choice: 3, probabilities: { 3: 0.99 } },
  { type: 'choice', choice: 'L2', probabilities: { L2: 0.99 } },
  ...[NaN, Infinity, -0.01, 1.01, '0.99', null].map((probability) => ({
    type: 'choice',
    choice: 'L3',
    probabilities: { L3: probability },
  })),
];

test.each(malformedChoices)('rejects a malformed location (%j)', (answer) => {
  expect(isValidAnswer(located, answer)).toBe(false);
  expect(selectedLocation(answer, locationCandidates(locationMatch.snippet), 0.75)).toBe(null);
});

test.each([0, 0.6, 0.75, 1])(
  'accepts a valid probability and locates only above cutoff (%s)',
  (probability) => {
    const answer = { type: 'choice', choice: 'L3', probabilities: { L3: probability } };
    expect(isValidAnswer(located, answer)).toBe(true);
    expect(selectedLocation(answer, locationCandidates(locationMatch.snippet), 0.75)).toEqual(
      probability >= 0.75 ? { start: 3, end: 3 } : null,
    );
  },
);

test('changing only a location cutoff reuses the same answer', () => {
  const changed = {
    ...locationMatch,
    rule: {
      ...locationMatch.rule,
      location: { question: 'Select the logging call.', cutoff: 0.9 },
    },
  };
  expect(locationAsk(backend, changed).key).toBe(located.key);
});
