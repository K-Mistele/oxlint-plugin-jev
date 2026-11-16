import { pathToFileURL } from 'node:url';
import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import {
  APICallError,
  experimental_decide,
  gateway,
  generateText,
  InvalidResponseDataError,
  jsonSchema,
  Output,
  RetryError,
} from 'ai';
import { runAsWorker } from 'synckit';
import { messageOf } from './jev.ts';
import type { AskInput, AskResult, Backend, DecisionRequest } from './types.ts';

type DecisionModel = ReturnType<ReturnType<typeof createTypeSafeAi>['decisionModel']>;
type LanguageModel = Parameters<typeof generateText>[0]['model'];

let cached: { key: string; provider: ReturnType<typeof createTypeSafeAi> } | null = null;

function typeSafeWith(apiKey: string, baseURL: string): ReturnType<typeof createTypeSafeAi> {
  const key = JSON.stringify([apiKey, baseURL]);
  if (cached === null || cached.key !== key) {
    cached = { key, provider: createTypeSafeAi({ apiKey, baseURL }) };
  }
  return cached.provider;
}

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

// The AI SDK wraps exhausted retries in a RetryError; the last attempt names the real cause.
function reasonFor(error: unknown, lastAttemptError: unknown): string {
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (isAbort(cause)) {
    // A deadline that expires between retries is reported as the error being retried.
    return lastAttemptError === undefined || isAbort(lastAttemptError)
      ? 'timeout'
      : reasonFor(lastAttemptError, undefined);
  }
  if (APICallError.isInstance(cause)) {
    return cause.statusCode === undefined
      ? `network: ${cause.message}`
      : `http ${cause.statusCode}: ${cause.message}`;
  }
  return `${cause instanceof Error ? cause.name : 'error'}: ${messageOf(cause)}`;
}

interface Attempts {
  lastError?: unknown;
}

async function decide(
  backend: Extract<Backend, { kind: 'typesafe' | 'gateway' }>,
  request: DecisionRequest,
  abortSignal: AbortSignal,
  attempts: Attempts,
): Promise<AskResult> {
  const inner: DecisionModel =
    backend.kind === 'typesafe'
      ? typeSafeWith(backend.apiKey, backend.baseURL).decisionModel(backend.model)
      : gateway.decisionModel(backend.model);
  let last: Awaited<ReturnType<DecisionModel['doDecide']>> | undefined;
  // The AI SDK rejects a whole response when one answer is malformed. Keeping the raw result lets
  // the plugin use the valid verdicts and ask again only for the malformed location answers.
  const model: DecisionModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedQuestionTypes: inner.supportedQuestionTypes,
    doDecide: async (options) => {
      try {
        last = await inner.doDecide(options);
        attempts.lastError = undefined;
        return last;
      } catch (error) {
        attempts.lastError = error;
        throw error;
      }
    },
  };
  try {
    const result = await experimental_decide({
      model,
      state: request.state,
      questions: request.questions,
      abortSignal,
      providerOptions: backend.longContext ? { typesafe: { longContext: true } } : undefined,
    });
    return { ok: true, model: result.response.modelId, answers: result.answers };
  } catch (error) {
    if (!InvalidResponseDataError.isInstance(error) || last === undefined) throw error;
    return { ok: true, model: last.response?.modelId ?? inner.modelId, answers: last.answers };
  }
}

const JUDGE_INSTRUCTIONS =
  'You are a code reviewer answering yes/no questions about code snippets. Each question names the snippet in `snippets` it is about. For every question id, set `violation` to true when the answer is yes, and `confidence` to your probability, between 0 and 1, that your answer is correct. Answer every question id.';

async function languageModelFor(backend: Extract<Backend, { kind: 'judge' }>) {
  if (backend.provider === undefined) return backend.model;
  const module: unknown = await import(pathToFileURL(backend.provider).href);
  const provider: unknown =
    typeof module === 'object' && module !== null && 'default' in module ? module.default : null;
  if (
    (typeof provider === 'object' || typeof provider === 'function') &&
    provider !== null &&
    'languageModel' in provider &&
    typeof provider.languageModel === 'function'
  ) {
    return (provider.languageModel as (id: string) => LanguageModel)(backend.model);
  }
  throw new Error(`${backend.provider} must default-export an AI SDK provider or registry`);
}

interface Judgement {
  violation: boolean;
  confidence: number;
}

const isJudgement = (value: unknown): value is Judgement =>
  typeof value === 'object' &&
  value !== null &&
  'violation' in value &&
  typeof value.violation === 'boolean' &&
  'confidence' in value &&
  typeof value.confidence === 'number' &&
  value.confidence >= 0 &&
  value.confidence <= 1;

async function judge(
  backend: Extract<Backend, { kind: 'judge' }>,
  request: DecisionRequest,
  abortSignal: AbortSignal,
): Promise<AskResult> {
  const ids = Object.keys(request.questions).filter(
    (id) => request.questions[id].type === 'boolean',
  );
  const judgement = {
    type: 'object',
    additionalProperties: false,
    required: ['violation', 'confidence'],
    properties: {
      violation: { type: 'boolean' },
      confidence: { type: 'number', description: 'Probability between 0 and 1.' },
    },
  } as const;
  const schema = jsonSchema<Record<string, unknown>>({
    type: 'object',
    additionalProperties: false,
    required: ids,
    properties: Object.fromEntries(ids.map((id) => [id, judgement])),
  });
  const questions = Object.fromEntries(ids.map((id) => [id, request.questions[id].instructions]));
  const result = await generateText({
    model: await languageModelFor(backend),
    instructions: JUDGE_INSTRUCTIONS,
    prompt: JSON.stringify({ snippets: request.state.snippets, questions }),
    output: Output.object({ schema, name: 'verdicts' }),
    abortSignal,
  });
  const answers: Record<string, unknown> = {};
  for (const id of ids) {
    const verdict = result.output[id];
    if (!isJudgement(verdict)) continue;
    answers[id] = {
      type: 'boolean',
      probability: verdict.violation ? verdict.confidence : 1 - verdict.confidence,
    };
  }
  return { ok: true, model: result.response.modelId, answers };
}

runAsWorker(async ({ backend, request, timeoutMs }: AskInput): Promise<AskResult> => {
  const attempts: Attempts = {};
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    return backend.kind === 'judge'
      ? await judge(backend, request, signal)
      : await decide(backend, request, signal, attempts);
  } catch (error) {
    return { ok: false, reason: reasonFor(error, attempts.lastError) };
  }
});
