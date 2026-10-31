// Presentational primitives. Each is a thin template over kit.css: no state
// beyond what the props say, no store access, so concepts compose them and
// never restyle them.

import { ReactNode, CSSProperties, forwardRef } from "react";

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
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(p, ref) {
  return (
    <button
      ref={ref}
      type="button"
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

export interface CardProps {
  /** Viewport-local top-left (from placeCard). */
  at: { x: number; y: number };
  width?: number;
  num?: string | number;
  title?: string;
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
    <div ref={ref} className={cx("k-card", p.className)} role={p.role ?? "dialog"} aria-label={p.ariaLabel ?? p.title} style={{ left: p.at.x, top: p.at.y, width: p.width }}>
      {(p.title || p.num != null || p.onClose) && (
        <div className="k-card-head">
          {p.num != null && <span className="k-num">{p.num}</span>}
          {p.title && <span className="k-title">{p.title}</span>}
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
  onClick?: () => void;
  title?: string;
}

/** One stop on a history strip. */
export function Chip(p: ChipProps) {
  return (
    <button type="button" className={cx("k-chip", p.state === "at" && "at", p.state === "ghost" && "ghost", p.off && "off", p.err && "err")} onClick={p.onClick} title={p.title}>
      {p.num != null && <span className="k-num">{p.num}</span>}
      {p.label}
    </button>
  );
}

/** The line between two chips; dashed where the history is rolled back. */
export function Track(p: { ghost?: boolean }) {
  return <div className={cx("k-track", p.ghost && "ghost")} />;
}
