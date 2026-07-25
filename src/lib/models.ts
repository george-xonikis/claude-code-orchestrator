/**
 * Models offered for implementation (execution) sessions — the single source of
 * truth shared by the server (execution config validation) and the UI (the
 * repo-level default picker in Settings → Execution, and the per-ticket override
 * in the ticket settings modal).
 */
export const MODEL_OPTIONS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable' },
] as const;

/** Repo-level default when nothing is configured. A config naming a model that
 *  is no longer offered (e.g. a retired id) falls back to this. */
export const DEFAULT_EXECUTION_MODEL: string = 'claude-opus-5';

/** True if `value` is one of the offered model ids. */
export function isKnownModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_OPTIONS.some((m) => m.id === value);
}
