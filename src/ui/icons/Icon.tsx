// <Icon name=… />: draws one icon of the set (icons.ts) as an inline SVG in
// currentColor, so it follows the text colour of whatever it sits in (light and
// dark themes, disabled and accent states alike).

import { useId } from "react";
import { DASH, DOT_R, MOD_BADGE, MOD_MASK, STROKE, resolveIcon } from "./icons";
import "./icons.css";

export interface IconProps {
  /** An icon name (see ICONS); an unknown name draws the fallback. */
  name: string;
  /** Rendered size in px (default 16). */
  size?: number;
  className?: string;
  /** Accessible name. Without one the icon is decorative (aria-hidden): the control's text names it. */
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  const { glyph, mod } = resolveIcon(name);
  const maskId = `icon-mask${useId().replace(/:/g, "")}`;
  const body = (
    <>
      {glyph.d && <path d={glyph.d} />}
      {glyph.dash && <path d={glyph.dash} strokeDasharray={DASH} />}
      {glyph.dots?.map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r ?? DOT_R} fill="currentColor" stroke="none" />)}
    </>
  );
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-icon={name}
    >
      {mod ? (
        <>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="#fff" />
            <circle cx={MOD_MASK.cx} cy={MOD_MASK.cy} r={MOD_MASK.r} fill="#000" />
          </mask>
          <g mask={`url(#${maskId})`}>{body}</g>
          <path d={MOD_BADGE[mod]} />
        </>
      ) : body}
    </svg>
  );
}
