// Presentational primitives. Each is a thin template over kit.css: no state
// beyond what the props say, no store access, so concepts compose them and
// never restyle them.

import { ReactNode, CSSProperties, ChangeEvent, forwardRef } from "react";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  /** Visual variant; "on" marks a pressed toggle. */
  on?: boolean;
  accent?: boolean;
  ghost?: boolean;
  icon?: boolean;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  className?: string;
  style?: CSSProperties;
  /** "submit" inside a form, so Enter in its fields presses it (default "button"). */
  type?: "button" | "submit";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(p, ref) {
  return (
    <button
      ref={ref}
      type={p.type ?? "button"}
      className={cx("k-btn", p.on && "on", p.accent && "accent", p.ghost && "ghost", p.icon && "icon", p.size === "lg" && "lg", p.size === "sm" && "sm", p.className)}
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.title}
      aria-label={p.ariaLabel}
      aria-pressed={p.on != null ? p.on : undefined}
      style={p.style}
    >
      {p.children}
    </button>
  );
});

/** A row of mutually exclusive choices (lens mode, view, material…). */
export function Pills<K extends string>(p: { value: K; options: { key: K; label: string; title?: string }[]; onChange: (k: K) => void; ariaLabel: string }) {
  return (
    <div className="k-pills" role="group" aria-label={p.ariaLabel}>
      {p.options.map((o) => (
        <Button key={o.key} on={o.key === p.value} onClick={() => p.onChange(o.key)} title={o.title}>{o.label}</Button>
      ))}
    </div>
  );
}

export type CardVariant = "float" | "inline" | "agent";

export interface CardProps {
  /** Viewport-local top-left (from placeCard); a "float" card needs it, an inline one ignores it. */
  at?: { x: number; y: number };
  width?: number;
  /** "float" (default) hangs over the viewport; "inline" sits in a panel's flow; "agent" is a dashed proposal from the agent. */
  variant?: CardVariant;
  num?: string | number;
  title?: string;
  /** Extra controls in the head, after the title (a remove button, a pill). */
  headActions?: ReactNode;
  onClose?: () => void;
  children?: ReactNode;
  foot?: ReactNode;
  role?: string;
  ariaLabel?: string;
  className?: string;
}

/** A floating card anchored over the viewport. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(p, ref) {
  return (
    <div ref={ref} className={cx("k-card", p.variant && p.variant !== "float" && p.variant, p.className)} role={p.role ?? "dialog"} aria-label={p.ariaLabel ?? p.title} style={{ left: p.at?.x, top: p.at?.y, width: p.width }}>
      {(p.title || p.num != null || p.onClose || p.headActions) && (
        <div className="k-card-head">
          {p.num != null && <span className="k-num">{p.num}</span>}
          {p.title && <span className="k-title">{p.title}</span>}
          {p.headActions}
          {p.onClose && <Button icon ghost size="sm" ariaLabel="Close" onClick={p.onClose}>×</Button>}
        </div>
      )}
      {p.children}
      {p.foot && <div className="k-card-foot">{p.foot}</div>}
    </div>
  );
});

/** A labelled value tile (mass, deflection, …). */
export function Readout(p: { label: string; value: string; state?: "ok" | "bad"; title?: string }) {
  return (
    <div className={cx("k-readout", p.state)} title={p.title}>
      <span className="k-label">{p.label}</span>
      <span className="k-value">{p.value}</span>
    </div>
  );
}

/** A colour legend: swatch rows, or a ramp with end labels. */
export function Legend(p: { title?: string; rows?: { color: string; label: string }[]; ramp?: { css: string; min: string; mid?: string; max: string } }) {
  return (
    <div className="k-legend">
      {p.title && <span>{p.title}</span>}
      {p.rows?.map((r) => (
        <div key={r.label} className="k-legend-row"><span className="k-swatch" style={{ background: r.color }} />{r.label}</div>
      ))}
      {p.ramp && (
        <>
          <div className="k-ramp" style={{ background: p.ramp.css }} />
          <div className="k-legend-row k-num k-dim" style={{ justifyContent: "space-between" }}><span>{p.ramp.min}</span>{p.ramp.mid && <span>{p.ramp.mid}</span>}<span>{p.ramp.max}</span></div>
        </>
      )}
    </div>
  );
}

export interface ChipProps {
  num?: string | number;
  label: string;
  state?: "at" | "ghost" | "on";
  off?: boolean;
  err?: boolean;
  /** The feature is hot (hovered somewhere else): the kit's one hover-sync look. */
  hot?: boolean;
  onClick?: () => void;
  /** Hover in/out, so the strip can light the feature elsewhere. */
  onHover?: (on: boolean) => void;
  title?: string;
  className?: string;
}

/** One stop on a history strip. */
export function Chip(p: ChipProps) {
  return (
    <button type="button" className={cx("k-chip", p.state === "at" && "at", p.state === "ghost" && "ghost", p.off && "off", p.err && "err", p.hot && "k-hot", p.className)} onClick={p.onClick} title={p.title}
      onMouseEnter={p.onHover ? () => p.onHover!(true) : undefined} onMouseLeave={p.onHover ? () => p.onHover!(false) : undefined}>
      {p.num != null && <span className="k-num">{p.num}</span>}
      {p.label}
    </button>
  );
}

export interface PinProps {
  /** Viewport-local centre. */
  at: { x: number; y: number };
  children: ReactNode;
  /** open: its card is shown; ghost: rolled back; off: suppressed; err: failed; "" plain. */
  state?: "open" | "ghost" | "off" | "err" | "";
  /** A wide badge (a cluster or a collapsed component) rather than a round pin. */
  cluster?: boolean;
  hot?: boolean;
  onClick?: () => void;
  onHover?: (on: boolean) => void;
  ariaLabel: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  title?: string;
  className?: string;
}

/** A numbered pin (or badge) on the geometry. */
export function Pin(p: PinProps) {
  return (
    <button
      type="button"
      className={cx("k-pin", p.state, p.cluster && "cluster", p.hot && "k-hot", p.className)}
      style={{ left: p.at.x, top: p.at.y }}
      aria-label={p.ariaLabel}
      aria-pressed={p.ariaPressed}
      aria-expanded={p.ariaExpanded}
      title={p.title}
      onClick={p.onClick}
      onMouseEnter={p.onHover ? () => p.onHover!(true) : undefined}
      onMouseLeave={p.onHover ? () => p.onHover!(false) : undefined}
    >
      {p.children}
    </button>
  );
}

export interface InputProps {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  invalid?: boolean;
  mono?: boolean;
  className?: string;
}

/** A text field in the kit's one control style. */
export function Input(p: InputProps) {
  return (
    <input className={cx("k-input", p.mono && "k-mono", p.className)} aria-label={p.ariaLabel} placeholder={p.placeholder} value={p.value}
      aria-invalid={p.invalid || undefined} onChange={(e: ChangeEvent<HTMLInputElement>) => p.onChange(e.target.value)} />
  );
}

export interface SelectProps<K extends string> {
  value: K;
  options: { key: K; label: string }[];
  onChange: (k: K) => void;
  ariaLabel: string;
  title?: string;
  className?: string;
}

/** A drop-down in the kit's one control style. */
export function Select<K extends string>(p: SelectProps<K>) {
  return (
    <select className={cx("k-select", p.className)} aria-label={p.ariaLabel} title={p.title} value={p.value} onChange={(e) => p.onChange(e.target.value as K)}>
      {p.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  );
}

/** The line between two chips; dashed where the history is rolled back. */
export function Track(p: { ghost?: boolean }) {
  return <div className={cx("k-track", p.ghost && "ghost")} />;
}
