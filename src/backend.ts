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

export type BackendResult =
  | { ok: true; backend: Backend; id: string }
  | { ok: false; missing: string };

/** Picks the backend for a rule list, or names the credential that is missing. */
export function backendFor(options: ResolvedOptions): BackendResult {
  const { judge } = options;
  if (judge !== undefined) {
    if (judge.provider === undefined && !hasGatewayCredentials()) {
      return { ok: false, missing: 'AI_GATEWAY_API_KEY' };
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
    if (!hasGatewayCredentials()) return { ok: false, missing: 'AI_GATEWAY_API_KEY' };
    return {
      ok: true,
      backend: { kind: 'gateway', model: options.model, longContext: options.longContext },
      id: `gateway ${options.model}`,
    };
  }
  const apiKey = env('TYPESAFE_API_KEY') || env('TYPESAFE_AI_API_KEY');
  if (apiKey === '') return { ok: false, missing: 'TYPESAFE_API_KEY' };
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
