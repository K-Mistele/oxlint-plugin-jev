import { appendFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';

// The body `@ai-sdk/typesafe-ai` posts to `${baseURL}/systemone`: boolean questions arrive as
// TypeSafe `noul` questions, and choice questions keep their criteria.
interface MockRequestBody {
  model: string;
  questions: Record<
    string,
    { type: string; instructions: string; criteria?: Record<string, unknown> }
  >;
  state: { snippets: Record<string, string> };
}

const logPath = process.argv[2] ?? '';
const MARKER_BY_QUESTION: Record<string, string> = {
  'personal data': 'user.email, user.phone',
  'only reads data': 'loaded',
  'language model': '${message}',
};

function scoreFor(question: string, snippet: string): number {
  const topic = Object.keys(MARKER_BY_QUESTION).find((key) => question.includes(key));
  return topic !== undefined && snippet.includes(MARKER_BY_QUESTION[topic]) ? 0.95 : 0.05;
}

// Questions name their snippet in their instructions, since one snippet can serve many questions.
const snippetRefOf = (instructions: string): string =>
  /snippets?\.?\s*"?(s\d+)"?/.exec(instructions)?.[1] ?? '';

// The AI SDK checks that a choice answer carries a full distribution that sums to 1.
function distribution(keys: string[], choice: string, probability: number) {
  const rest = keys.length > 1 ? (1 - probability) / (keys.length - 1) : 0;
  return Object.fromEntries(keys.map((key) => [key, key === choice ? probability : rest]));
}

function answer(body: MockRequestBody, token: string) {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(body.questions)) {
    const snippet = body.state.snippets[snippetRefOf(question.instructions)] ?? '';
    if (question.type === 'choice') {
      const refinement = Object.values(body.questions).every((q) => q.type === 'choice');
      if (
        (token === 'location-missing-once' && hitsByToken[token] === 1) ||
        (token === 'refinement-missing-once' && refinement && hitsByToken[token] === 2)
      )
        continue;
      const line = snippet.split('\n').find((text) => text.includes('user.email, user.phone'));
      const lineNumber = Number(line?.match(/^L(\d+)\|/)?.[1]);
      const keys = Object.keys(question.criteria ?? {});
      const selected =
        keys.find((key) => {
          const range = key.match(/^L(\d+)(?:-L(\d+))?$/);
          return (
            range && Number(range[1]) <= lineNumber && lineNumber <= Number(range[2] ?? range[1])
          );
        }) ?? 'unknown';
      const choice = token === 'location-unknown' ? 'unknown' : selected;
      const probability = token === 'location-uncertain' ? 0.6 : 0.99;
      answers[id] = {
        type: 'choice',
        choice,
        probabilities: distribution(keys, choice, probability),
      };
      continue;
    }
    answers[id] = {
      type: 'noul',
      noul:
        token === 'location-always-positive'
          ? 0.99
          : token === 'location-no-violation'
            ? 0.05
            : scoreFor(question.instructions, snippet),
    };
  }
  return { model: 'jev-mock', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

// The LLM-judge test provider posts the prompt it was given and returns this text as the
// model's structured output.
function judgement(prompt: string) {
  const { snippets, questions } = JSON.parse(prompt) as {
    snippets: Record<string, string>;
    questions: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(questions).map(([id, instructions]) => {
      const score = scoreFor(instructions, snippets[snippetRefOf(instructions)] ?? '');
      return [id, { violation: score > 0.5, confidence: 0.9 }];
    }),
  );
}

const hitsByToken: Record<string, number> = {};

// The bearer token picks a failure mode, so one server covers the worker's error mapping too.
function reply(token: string, body: MockRequestBody, response: ServerResponse): void {
  hitsByToken[token] = (hitsByToken[token] ?? 0) + 1;
  const refinement = Object.values(body.questions).every((question) => question.type === 'choice');
  if (refinement && token === 'refinement-slow') return;
  if (refinement && token === 'refinement-fails') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  if (token === 'slow') return;
  if (token === 'unauthorized') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  if (token === 'flaky' && hitsByToken[token] === 1) {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '10' });
    response.end('{}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer(body, token)));
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (request.method === 'POST' && request.url === '/judge') {
      const { prompt } = JSON.parse(raw) as { prompt: string };
      appendFileSync(logPath, `${JSON.stringify({ judge: true, prompt })}\n`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ text: JSON.stringify(judgement(prompt)) }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/systemone') {
      response.writeHead(404).end('{}');
      return;
    }
    const body = JSON.parse(raw) as MockRequestBody;
    appendFileSync(
      logPath,
      `${JSON.stringify({ authorization: request.headers.authorization, headers: request.headers, body })}\n`,
    );
    reply((request.headers.authorization ?? '').replace('Bearer ', ''), body, response);
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the mock server did not bind a port');
  }
  process.stdout.write(`PORT=${address.port}\n`);
});
