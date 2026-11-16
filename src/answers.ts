import { readCache, writeCache } from './cache.ts';
import { buildRequest, isValidAnswer, messageOf, type Ask } from './jev.ts';
import { askModel } from './sync-jev.ts';
import type { Answered, Backend } from './types.ts';

export type AnswersResult =
  | { ok: true; answers: Map<string, Answered> }
  | { ok: false; reason: string };

export interface AnswerInput {
  readonly asks: readonly Ask[];
  readonly backend: Backend;
  readonly timeoutMs: number;
  readonly cacheDir: string;
  readonly onCacheError?: (message: string) => void;
}

/**
 * Answers every ask, from the cache where it can and with one request for the rest. A missing
 * or invalid verdict fails the batch; an invalid location is returned but never cached, so it is
 * asked again on the next run.
 */
export function answerAll({
  asks,
  backend,
  timeoutMs,
  cacheDir,
  onCacheError,
}: AnswerInput): AnswersResult {
  const answers = new Map<string, Answered>();
  const misses = new Map<string, Ask>();
  for (const ask of asks) {
    if (answers.has(ask.key) || misses.has(ask.key)) continue;
    const cached = readCache(cacheDir, ask.key);
    if (cached !== null && isValidAnswer(ask, cached.answer)) answers.set(ask.key, cached);
    else misses.set(ask.key, ask);
  }
  if (misses.size === 0) return { ok: true, answers };

  const pending = [...misses.values()];
  const { request, ids } = buildRequest(pending);
  const result = askModel({ backend, request, timeoutMs });
  if (!result.ok) return result;
  let missingVerdict: string | null = null;
  for (const [index, ask] of pending.entries()) {
    const answer = result.answers[ids[index]];
    const entry = { model: result.model, answer };
    if (!isValidAnswer(ask, answer)) {
      if (ask.kind === 'verdict') missingVerdict ??= ids[index];
      else answers.set(ask.key, entry);
      continue;
    }
    answers.set(ask.key, entry);
    try {
      writeCache(cacheDir, ask.key, entry);
    } catch (error) {
      onCacheError?.(`could not write cache in ${cacheDir}: ${messageOf(error)}`);
    }
  }
  if (missingVerdict !== null) {
    return { ok: false, reason: `response has no probability in [0, 1] for "${missingVerdict}"` };
  }
  return { ok: true, answers };
}
