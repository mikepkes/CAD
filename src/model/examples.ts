// The bundled example models (public/examples/<name>.json): what the editor's
// Examples menu, the first-run card and the viewer's "couldn't find" page list.
// test/examplesList.test.ts keeps this in step with the directory.

export interface ExampleInfo {
  /** The file's name, without .json; ?example=<name>. */
  name: string;
  title: string;
  /** One line on what it shows. */
  blurb: string;
}

export const EXAMPLES: ExampleInfo[] = [
  { name: "starbox", title: "Star box", blurb: "A snap-together box: two identical halves" },
  { name: "roubo", title: "Roubo workbench", blurb: "A full-size bench with a leg vise and a shop drawing" },
  { name: "clockwork", title: "Clockwork", blurb: "Every kind of gear, turned by one knob" },
  { name: "gyroscope", title: "Gyroscope", blurb: "Nested rings on pins, printed in one go" },
  { name: "bistable", title: "Bistable switch", blurb: "Curved beams that snap between two rests" },
  { name: "fourbar", title: "Compliant four-bar", blurb: "Four links joined by flexures, printed flat" },
  { name: "gripper", title: "Compliant gripper", blurb: "Push the plunger and the jaws open" },
  { name: "gimbal", title: "Flexure gimbal", blurb: "A mirror steered on two pairs of blades" },
  { name: "xystage", title: "XY flexure stage", blurb: "A platform that moves in X and Y on blades" },
  { name: "skadis", title: "SKÅDIS holder", blurb: "A pegboard holder that grips by its load's weight" },
  { name: "handlebar", title: "Bike handlebar", blurb: "A riser bar and winged grips from organic surfaces" },
  { name: "walker", title: "Wind walker", blurb: "Twelve Jansen legs walking off one crank" },
  { name: "motor", title: "Motor", blurb: "NEMA steppers and servos at catalogue size, to design a mount round" },
  { name: "origami", title: "Paper airplane", blurb: "A dart folded from a sheet, step by step" },
  { name: "masu", title: "Masu box", blurb: "The origami box, folded from one square, its corners tucking in" },
  { name: "crane", title: "Paper crane", blurb: "The traditional crane: a square base, petal folds, neck and tail" },
  { name: "popup-box", title: "Pop-up card: box fold", blurb: "A card with a box fold cut into it, stepping up as it opens" },
  { name: "scissor", title: "Scissor lift", blurb: "A scissor linkage driven by its stage count" },
  { name: "scissor-jointed", title: "Jointed scissor", blurb: "The scissor as a pattern of jointed stages" },
];

/** Where an example's file is served. */
export const exampleUrl = (name: string): string => `${import.meta.env?.BASE_URL ?? "/"}examples/${encodeURIComponent(name)}.json`;
/** A link that opens an example in the customize viewer. */
export const customizeLink = (name: string): string => `?customize&example=${encodeURIComponent(name)}`;
/** A link that opens an example in the editor. */
export const editorLink = (name: string): string => `?example=${encodeURIComponent(name)}`;
/** An example's title, else its name made readable ("scissor-jointed" → "Scissor jointed"). */
export function exampleTitle(name: string): string {
  const known = EXAMPLES.find((e) => e.name === name);
  if (known) return known.title;
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : name;
}
