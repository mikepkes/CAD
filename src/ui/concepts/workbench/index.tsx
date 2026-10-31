// The Workbench: history that lives on the part.
//
//   <WorkbenchOverlay/>  — mount inside the viewport overlay (<Viewport overlays={<WorkbenchOverlay/>}/>).
//                          Renders the numbered Pins, the open FeatureCard and the FaceVerbs card.
//                          No props: it reads the document from useStore (session, rev, solids,
//                          activeComponentId, faceSelection, mode) and the open/hot feature from useUi.
//                          Renders nothing in sketch mode or before the scene exists (pins need a projection).
//   <HistoryStrip/>      — mount as the bottom dock under the viewport. No props; reads the same stores.
//
// Every mutation goes through the store: editOperation, moveRollback, suppressOperation,
// deleteOperation, selectFace, activateComponent, and the chisel:lookAt window event.

import "./workbench.css";
import { Pins } from "./Pins";
import { FeatureCard } from "./FeatureCard";
import { FaceVerbs } from "./FaceVerbs";

export { HistoryStrip } from "./HistoryStrip";
export { Pins, FeatureCard, FaceVerbs };
export * from "./workbench";
export { useFeatureRows as useRows, useActiveComponent } from "../../kit/useFeatureRows";

export function WorkbenchOverlay() {
  return (
    <>
      <Pins />
      <FeatureCard />
      <FaceVerbs />
    </>
  );
}
