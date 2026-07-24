/**
 * Claude's sunburst mark, drawn as 12 tapered rays. Uses `currentColor` so the
 * caller controls the color (default styling applies the Claude terracotta).
 */
export function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      role="img"
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <path
          key={i}
          d="M12 1.5 L12.85 10.4 L12 12 L11.15 10.4 Z"
          transform={`rotate(${i * 30} 12 12)`}
        />
      ))}
    </svg>
  );
}
