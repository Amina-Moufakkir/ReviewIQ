import type { ReactNode } from "react";

interface SectionLabelProps {
  children: ReactNode;
}

/**
 * A monospace eyebrow trailed by a hairline rule — the recurring structural
 * device that segments the brief into sections.
 */
export function SectionLabel({ children }: SectionLabelProps) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-ink-soft">
        {children}
      </span>
      <span className="h-px flex-1 bg-rule" aria-hidden="true" />
    </div>
  );
}
