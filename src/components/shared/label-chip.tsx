/**
 * GitHub label chips. Colors mirror the repo's label palette on GitHub
 * (intentionally hardcoded — they are GitHub label colors, not theme tokens).
 */

export const LABEL_COLORS: Record<string, { bg: string; text: string }> = {
  AI: { bg: '#F7D6EF', text: '#5B2D55' },
  BE: { bg: '#2F8A68', text: '#FFFFFF' },
  Bug: { bg: '#CC4B4B', text: '#FFFFFF' },
  Docs: { bg: '#2D6FC2', text: '#FFFFFF' },
  FE: { bg: '#E5E060', text: '#3F3D1A' },
  Infra: { bg: '#6A5AE8', text: '#FFFFFF' },
};

export function LabelChip({ label }: { label: string }) {
  const color = LABEL_COLORS[label];
  if (color) {
    return (
      <span
        className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={{ backgroundColor: color.bg, color: color.text }}
      >
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
      {label}
    </span>
  );
}
