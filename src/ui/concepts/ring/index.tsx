// The action ring.
//
// <RingOverlay/>  Mount once (ConceptShell does; it portals into document.body
//                 and renders only while useRing.open). No props. Opens from
//                 the "ring.open" hotkey action (Space by default: hold, point,
//                 release to run; tap to leave it open and click) and from a
//                 right-click on the viewport in model mode (Interactions).
//
// Which action sits in which slot, and the ring state, are src/model/ring.ts;
// the labels and key handling are the pure ./ringView. Slots only ever run
// hotkey actions (hotkeys.runAction).

export { RingOverlay } from "./RingOverlay";
export { shortLabel, slotViews, ringKeys, releasesRingKey, digitSlot, arrowDir, moveHighlight, RING_R, RING_PAD, DEAD_ZONE } from "./ringView";
export type { SlotView, HotkeySource, ArrowDir } from "./ringView";
