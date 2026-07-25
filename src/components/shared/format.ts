/** 'claude-fable-5' -> 'fable-5' for compact display on cards and meta rows. */
export function formatModel(model: string): string {
  return model.replace(/^claude-/, '');
}

/** Re-exported so existing importers keep resolving it from this module. */
export { MODEL_OPTIONS } from '@/lib/models';
