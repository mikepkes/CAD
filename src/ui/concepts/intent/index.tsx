// Concept 5 — the intent line.
//
// <IntentLine/>   Mount once in App (anywhere; it renders a fixed, centred
//                 palette only while open). No props. Opens on ⌘K / Ctrl+K or
//                 "/" (a global hotkey action, id OPEN_ACTION_ID, registered
//                 at mount and removed at unmount) and from <IntentButton/>.
// <IntentButton/> A small "⌘K" kit Button for the toolbar; optional `size`.
//
// Pure modules: `resolve(text, ctx)` in ./intent (grammar → suggestions with
// serialisable actions) and `execute(action, executor)` in ./execute (actions
// → injected store calls). Nothing here talks to the kernel or the session.

export { IntentLine, IntentButton, OPEN_ACTION_ID } from "./IntentLine";
export { resolve, tokenize, parseNumber, fuzzy, moveSelection, buildCtx, VIEWS, PANELS, MAX_SUGGESTIONS } from "./intent";
export type { IntentCtx, IntentAction, Suggestion, SuggestionKind, ParamInfo } from "./intent";
export { execute } from "./execute";
export type { Executor } from "./execute";
