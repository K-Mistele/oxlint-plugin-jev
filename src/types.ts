import type { Location, Range } from '@oxlint/plugins';
import type { Mode } from './changed.ts';

export type Target = 'function' | 'call' | 'jsx' | 'file';

export type CiBehavior = 'skip' | 'fail';

export interface JevRule {
  /** Unique within the rule list. Shown in the lint message. */
  id: string;
  target: Target;
  /** One English yes/no question. "Yes" means "report an error". */
  question: string;
  /** Report when the yes-probability is >= this. Between 0 and 1. */
  cutoff: number;
  /** File rules may select a source line, keeping a file-level finding below this probability. */
  location?: { question: string; cutoff: number };
  /** Shown instead of the question when the rule fires. Not sent to the model. */
  message?: string;
}

export interface JudgeOptions {
  /** An AI SDK language model id: an AI Gateway id such as `openai/gpt-5-mini`, or an id the `provider` module knows. */
  model: string;
  /** Path, relative to the working directory, of an ES module whose default export is an AI SDK provider or registry. */
  provider?: string;
}

export interface SharedOptions {
  ci?: CiBehavior;
  timeoutMs?: number;
  maxMatchesPerFile?: number;
  maxSnippetChars?: number;
  /** A TypeSafe model id such as `jev-latest`, or an AI Gateway decision model id such as `typesafe-ai/jev`. */
  model?: string;
  /** Send TypeSafe's long-context header, raising its token limits. */
  longContext?: boolean;
  /** Answer the questions with an LLM judge instead of Jev. */
  judge?: JudgeOptions;
}

/** Per-rule options: `jev/ask` and `jev/suggest` take them next to `rules`, `createJevPlugin` rules as their only option. */
export interface ModeOptions {
  /** `"changed"` asks only about matches on lines changed since the merge base with the default branch. Default `"all"`. */
  mode?: Mode;
  /** The ref whose merge base with `HEAD` `"changed"` diffs against. Default: `JEV_CHANGED_BASE`, then the default branch. */
  base?: string;
}

export interface JevOptions extends SharedOptions, ModeOptions {
  rules: JevRule[];
}

export interface JevPluginOptions extends SharedOptions {
  /** The oxlint plugin name. Each rule is configured as `<name>/<id>`. */
  name: string;
  rules: JevRule[];
}

/** Options as a rule sees them, with the defaults already merged underneath. */
export type ResolvedOptions = Required<Omit<JevOptions, 'judge' | keyof ModeOptions>> & {
  judge?: JudgeOptions;
};

export interface RequestMatch {
  readonly rule: Pick<JevRule, 'question' | 'location'>;
  readonly snippet: string;
  readonly truncated?: boolean;
}

export interface Match extends RequestMatch {
  readonly rule: JevRule;
  readonly loc: Location;
  /** The oxlint rule that collected the match and reports it. */
  readonly owner: object;
}

export interface BooleanQuestion {
  type: 'boolean';
  instructions: string;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export type Question = BooleanQuestion | ChoiceQuestion;

export interface DecisionRequest {
  state: { snippets: Record<string, string> };
  questions: Record<string, Question>;
}

export type Backend =
  | { kind: 'typesafe'; model: string; apiKey: string; baseURL: string; longContext: boolean }
  | { kind: 'gateway'; model: string; longContext: boolean }
  | { kind: 'judge'; model: string; provider?: string };

export interface AskInput {
  backend: Backend;
  request: DecisionRequest;
  timeoutMs: number;
}

/** `answers` are AI SDK decision answers, such as `{ type: 'boolean', probability }`. */
export type AskResult =
  | { ok: true; model: string; answers: Record<string, unknown> }
  | { ok: false; reason: string };

export interface Answered {
  /** The model id that answered, such as `jev-1.13.0`, even when the request said `jev-latest`. */
  readonly model: string;
  readonly answer: unknown;
}

export interface SnippetNode {
  readonly type: string;
  readonly range: Range;
  readonly parent?: NamedParent | null | undefined;
}

export interface NamedParent extends SnippetNode {
  readonly init?: unknown;
  readonly value?: unknown;
}

export interface ReportNode {
  readonly loc: Location;
  readonly openingElement?: { readonly loc: Location } | undefined;
}

/** The public shape of the default export. Consumers load the plugin by name, so the rule
 * internals are deliberately not part of the published type. */
export interface JevPlugin {
  meta: { name: string };
  rules: { ask: object; suggest: object };
}

/** The public shape of a `createJevPlugin` plugin: one oxlint rule per question id. */
export interface JevRulesPlugin {
  meta: { name: string };
  rules: Record<string, object>;
}
