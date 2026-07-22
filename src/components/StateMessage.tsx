interface StateMessageProps {
  tone: "idle" | "loading" | "empty" | "error";
  title: string;
  description?: string;
}

/** Shared presentational block for idle / loading / empty / error states. */
export function StateMessage({ tone, title, description }: StateMessageProps) {
  const isError = tone === "error";

  return (
    <div
      className={`border p-8 ${
        isError ? "border-fault/40 bg-fault-soft" : "border-dashed border-rule bg-card/50"
      }`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      {tone === "loading" ? (
        <div className="mb-4 h-0.5 w-full overflow-hidden bg-rule" aria-hidden="true">
          <div className="animate-scan h-full w-1/4 bg-ink" />
        </div>
      ) : null}
      <p
        className={`font-mono text-xs font-medium uppercase tracking-[0.15em] ${
          isError ? "text-fault" : "text-ink-soft"
        }`}
      >
        {isError ? "Error" : title}
      </p>
      {isError ? (
        <p className="mt-2 text-sm text-ink">{description ?? title}</p>
      ) : (
        description && <p className="mt-2 text-sm text-ink-soft">{description}</p>
      )}
    </div>
  );
}
