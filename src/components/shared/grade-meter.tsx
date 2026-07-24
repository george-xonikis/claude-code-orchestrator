import { DollarSign, Hammer, type LucideIcon } from 'lucide-react';

/**
 * The 1-5 impact/effort meter shared between proposal cards (read-only) and the
 * plan config (interactive), so both render identically: dollars for impact,
 * hammers for effort, filled up to the grade.
 */

export interface MeterStyle {
  icon: LucideIcon;
  label: string;
  filledClassName: string;
}

export const IMPACT_METER: MeterStyle = {
  icon: DollarSign,
  label: 'Impact',
  filledClassName: 'text-success',
};

export const EFFORT_METER: MeterStyle = {
  icon: Hammer,
  label: 'Effort',
  filledClassName: 'text-warning',
};

const CHIP_CLASS = 'inline-flex items-center gap-0.5 rounded-full bg-secondary px-2 py-1';

/** Read-only meter: five icons, `grade` of them filled. */
export function GradeMeter({ style, grade }: { style: MeterStyle; grade: number }) {
  const { icon: Icon, label, filledClassName } = style;
  return (
    <span
      title={`${label} ${grade}/5`}
      aria-label={`${label} ${grade} out of 5`}
      className={CHIP_CLASS}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Icon
          key={i}
          className={`h-3 w-3 ${i < grade ? filledClassName : 'text-muted-foreground/25'}`}
        />
      ))}
    </span>
  );
}

/** Interactive meter: click an icon to set the 1-5 value. */
export function GradeMeterInput({
  style,
  value,
  onChange,
}: {
  style: MeterStyle;
  value: number;
  onChange: (value: number) => void;
}) {
  const { icon: Icon, label, filledClassName } = style;
  return (
    <span role="group" aria-label={label} className={CHIP_CLASS}>
      {Array.from({ length: 5 }).map((_, i) => {
        const n = i + 1;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-label={`Set ${label.toLowerCase()} to ${n}`}
            aria-pressed={value === n}
            className="inline-flex transition-opacity hover:opacity-70"
          >
            <Icon
              className={`h-4 w-4 ${i < value ? filledClassName : 'text-muted-foreground/25'}`}
            />
          </button>
        );
      })}
    </span>
  );
}
