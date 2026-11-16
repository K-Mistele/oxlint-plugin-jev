import path from 'node:path';
import type { Backend, ResolvedOptions } from './types.ts';

const DEFAULT_TYPESAFE_URL = 'https://api.typesafe.ai/v1';

const env = (name: string): string => (process.env[name] ?? '').trim();

// `TYPESAFE_BASE_URL` comes from `@typesafe-ai/sdk` and names the host; the AI SDK provider's
// `TYPESAFE_AI_BASE_URL` already includes the `/v1` API prefix.
export function typeSafeBaseURL(): string {
  const host = env('TYPESAFE_BASE_URL').replace(/\/+$/, '');
  if (host !== '') return `${host}/v1`;
  return env('TYPESAFE_AI_BASE_URL').replace(/\/+$/, '') || DEFAULT_TYPESAFE_URL;
}

const hasGatewayCredentials = (): boolean =>
  env('AI_GATEWAY_API_KEY') !== '' || env('VERCEL_OIDC_TOKEN') !== '';

/** Named in the warning when no Jev credential of any kind is set. */
export const NO_JEV_CREDENTIALS =
  'no Jev credentials: TYPESAFE_API_KEY, TYPESAFE_AI_API_KEY, and AI_GATEWAY_API_KEY are all unset';

/** The AI Gateway id for a TypeSafe model id; `jev-latest` is published there as `typesafe-ai/jev`. */
export const gatewayModelFor = (model: string): string =>
  model === 'jev-latest' ? 'typesafe-ai/jev' : `typesafe-ai/${model}`;

export type BackendResult =
  | { ok: true; backend: Backend; id: string }
  | { ok: false; reason: string };

/** Picks the backend for a rule list, or says which credential is missing. */
export function backendFor(options: ResolvedOptions): BackendResult {
  const { judge } = options;
  if (judge !== undefined) {
    if (judge.provider === undefined && !hasGatewayCredentials()) {
      return { ok: false, reason: 'AI_GATEWAY_API_KEY is not set' };
    }
    const provider =
      judge.provider === undefined ? undefined : path.resolve(process.cwd(), judge.provider);
    return {
      ok: true,
      backend: { kind: 'judge', model: judge.model, provider },
      id: `judge ${provider ?? 'gateway'} ${judge.model}`,
    };
  }
  // A provider-prefixed id such as `typesafe-ai/jev` is an AI Gateway model.
  if (options.model.includes('/')) {
    if (!hasGatewayCredentials()) return { ok: false, reason: 'AI_GATEWAY_API_KEY is not set' };
    return {
      ok: true,
      backend: { kind: 'gateway', model: options.model, longContext: options.longContext },
      id: `gateway ${options.model}`,
    };
  }
  const apiKey = env('TYPESAFE_API_KEY') || env('TYPESAFE_AI_API_KEY');
  if (apiKey === '') {
    if (!hasGatewayCredentials()) return { ok: false, reason: NO_JEV_CREDENTIALS };
    const model = gatewayModelFor(options.model);
    return {
      ok: true,
      backend: { kind: 'gateway', model, longContext: options.longContext },
      id: `gateway ${model}`,
    };
  }
  const baseURL = typeSafeBaseURL();
  return {
    ok: true,
    backend: {
      kind: 'typesafe',
      model: options.model,
      apiKey,
      baseURL,
      longContext: options.longContext,
    },
    id: `typesafe ${baseURL} ${options.model}`,
  };
}
