// The command icon set: data (icons.ts), the <Icon/> component, and the lookups
// from command types and hotkey action ids to icon names.

export { Icon, type IconProps } from "./Icon";
export { ICONS, ICON_NAMES, FALLBACK_ICON, isIconName, resolveIcon, type IconName, type IconDef } from "./icons";
export { iconForCommand, iconForAction, iconForView, iconForPanel, JOINT_ICONS, PRIMITIVE_ICONS, CONSTRAINT_ICONS } from "./lookup";
