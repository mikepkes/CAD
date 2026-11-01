// Dev-only icon gallery (not linked from the app): `npx vite`, then open
// /icon-gallery.html. Every icon at 16, 24 and 48 px on a light and a dark
// ground, then which icon every command type and hotkey action resolves to.

import { createRoot } from "react-dom/client";
import { Icon } from "./Icon";
import { ICONS, ICON_NAMES, FALLBACK_ICON } from "./icons";
import { iconForAction, iconForCommand, JOINT_ICONS, PRIMITIVE_ICONS, CONSTRAINT_ICONS } from "./lookup";
import { createDefaultRegistry } from "../../core/command/builtins";
import { hotkeys } from "../../model/hotkeys";
import { installHotkeys } from "../../model/hotkeyActions";
import { installContextActions } from "../concepts/contextActions";
import { OPEN_ACTION_ID } from "../concepts/intent/IntentLine";

const CSS = `
  :root { --light-bg: #f6f7f9; --light-ink: #1d2128; --dark-bg: #1b1d23; --dark-ink: #e6e8ec; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #e9ebef; color: #1d2128; }
  main { padding: 16px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
  .note { color: #5a6270; margin: 0 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 8px; }
  .card { border-radius: 8px; overflow: hidden; border: 1px solid #cfd3da; background: #fff; }
  .card .name { padding: 4px 8px; font: 11px ui-monospace, monospace; display: flex; justify-content: space-between; gap: 6px; }
  .card .name span { color: #6b7280; font-family: system-ui; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .swatch { display: flex; align-items: center; gap: 12px; padding: 8px 10px; }
  .light { background: var(--light-bg); color: var(--light-ink); }
  .dark { background: var(--dark-bg); color: var(--dark-ink); }
  .strip { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  td, th { padding: 3px 8px; border-bottom: 1px solid #eceef1; text-align: left; vertical-align: middle; }
  td code { font-size: 12px; }
  .fallback { color: #b42318; font-weight: 600; }
  .cols { columns: 2 520px; column-gap: 16px; }
  .cols table { break-inside: avoid; margin-bottom: 0; }
`;

function Card({ name }: { name: string }) {
  const def = ICONS[name as keyof typeof ICONS];
  return (
    <div className="card" data-name={name}>
      <div className="swatch light"><Icon name={name} size={16} /><Icon name={name} size={24} /><Icon name={name} size={48} /></div>
      <div className="swatch dark"><Icon name={name} size={16} /><Icon name={name} size={24} /><Icon name={name} size={48} /></div>
      <div className="name"><b>{name}</b><span>{def.label}</span></div>
    </div>
  );
}

function Row({ id, icon }: { id: string; icon: string }) {
  return (
    <tr>
      <td><code>{id}</code></td>
      <td className="light"><Icon name={icon} size={16} /> <Icon name={icon} size={24} /></td>
      <td className={icon === FALLBACK_ICON ? "fallback" : undefined}>{icon}</td>
    </tr>
  );
}

function Gallery() {
  const commands = createDefaultRegistry().list().map((d) => d.type);
  const actions = hotkeys.describe().contexts.flatMap((c) => c.actions.map((a) => a.id));
  if (!actions.includes(OPEN_ACTION_ID)) actions.push(OPEN_ACTION_ID);
  const kinds: [string, string][] = [
    ...Object.keys(JOINT_ICONS).map((k): [string, string] => [`joint.create { kind: ${k} }`, iconForCommand("joint.create", { kind: k })]),
    ...Object.keys(PRIMITIVE_ICONS).map((s): [string, string] => [`feature.primitive { shape: ${s} }`, iconForCommand("feature.primitive", { shape: s })]),
    ["feature.pattern { mode: circular }", iconForCommand("feature.pattern", { mode: "circular" })],
    ...Object.keys(CONSTRAINT_ICONS).map((t): [string, string] => [`sketch.addConstraint { type: ${t} }`, iconForCommand("sketch.addConstraint", { type: t })]),
  ];
  return (
    <main>
      <style>{CSS}</style>
      <h1>VibeCAD icons</h1>
      <p className="note">{ICON_NAMES.length} icons · 24×24 grid, 1.75 strokes, round caps and joins, currentColor · {commands.length} commands · {actions.length} hotkey actions</p>
      <h2>At 16 px</h2>
      <div className="strip light" id="strip-light">{ICON_NAMES.map((n) => <Icon key={n} name={n} size={16} title={n} />)}</div>
      <div className="strip dark" id="strip-dark" style={{ marginTop: 8 }}>{ICON_NAMES.map((n) => <Icon key={n} name={n} size={16} title={n} />)}</div>
      <h2>Every icon</h2>
      <div className="grid" id="grid">{ICON_NAMES.map((n) => <Card key={n} name={n} />)}</div>
      <h2>Commands → icon</h2>
      <div className="cols" id="commands"><table><tbody>{commands.map((t) => <Row key={t} id={t} icon={iconForCommand(t)} />)}{kinds.map(([id, icon]) => <Row key={id} id={id} icon={icon} />)}</tbody></table></div>
      <h2>Hotkey actions → icon</h2>
      <div className="cols" id="actions"><table><tbody>{actions.map((a) => <Row key={a} id={a} icon={iconForAction(a)} />)}</tbody></table></div>
    </main>
  );
}

installHotkeys();
installContextActions();
createRoot(document.getElementById("root")!).render(<Gallery />);
