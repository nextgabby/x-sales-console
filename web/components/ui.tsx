import type { ComponentProps, ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** Shared so anchors can look identical to buttons without duplicating classes. */
export function buttonClasses(variant: ButtonVariant = "primary", className?: string): string {
  const styles = {
    primary: "bg-accent text-white hover:bg-accent/90 disabled:bg-accent/40",
    secondary:
      "bg-surface-2 text-ink border border-border hover:border-border-strong hover:bg-surface",
    ghost: "text-muted hover:text-ink hover:bg-surface",
    danger: "text-negative border border-negative/40 hover:bg-negative/10",
  }[variant];

  return cx(
    "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    styles,
    className,
  );
}

export function Button({
  variant = "primary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return <button className={buttonClasses(variant, className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cx(
        "w-full rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-ink placeholder:text-muted/70 transition-colors focus:border-accent focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "warn" | "negative" | "accent";
}) {
  const tones = {
    neutral: "bg-surface-2 text-muted border-border",
    positive: "bg-positive/10 text-positive border-positive/30",
    warn: "bg-warn/10 text-warn border-warn/30",
    negative: "bg-negative/10 text-negative border-negative/30",
    accent: "bg-accent-soft text-accent border-accent/30",
  }[tone];

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tones,
      )}
    >
      {children}
    </span>
  );
}

export function Callout({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "negative" | "warn";
  children: ReactNode;
}) {
  const tones = {
    neutral: "border-border bg-surface text-muted",
    negative: "border-negative/40 bg-negative/10 text-negative",
    warn: "border-warn/40 bg-warn/10 text-warn",
  }[tone];

  return (
    <div className={cx("rounded-xl border px-4 py-3 text-sm", tones)}>{children}</div>
  );
}

/** Hand-rolled so Phase 1 ships without a charting dependency. */
export function Sparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const width = 96;
  const height = 28;

  if (values.length === 0 || values.every((value) => value === 0)) {
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.35"
        />
      </svg>
    );
  }

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const points = values.map((value, index) => {
    const x = index * step;
    // A perfectly flat series has no span to scale against. Centring it reads as steady,
    // whereas scaling from the baseline would pin it to the floor and look like zero.
    const fraction = span === 0 ? 0.5 : (value - min) / span;
    const y = height - 2 - fraction * (height - 4);
    return [x, y] as const;
  });

  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} ${width},${height} 0,${height}`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <polygon points={area} fill="currentColor" opacity="0.14" />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-lg bg-surface-2", className)} />;
}
