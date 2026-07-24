/** 'claude-fable-5' -> 'fable-5' for compact display on cards and meta rows. */
export function formatModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/** Models offered for implementation sessions (first = default). */
export const MODEL_OPTIONS = [
  { id: 'claude-opus-4-8', label: 'Opus' },
  { id: 'claude-sonnet-5', label: 'Sonnet' },
  { id: 'claude-fable-5', label: 'Fable' },
] as const;
