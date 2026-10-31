// The Workbench: history that lives on the part.
//
//   <WorkbenchOverlay/>  — mount inside the viewport overlay (<Viewport overlays={<WorkbenchOverlay/>}/>).
//                          Renders the ComponentCrumb (top-left), the numbered Pins, the open FeatureCard
//                          and the FaceVerbs card.
//                          No props: it reads the document from useStore (session, rev, solids,
//                          activeComponentId, faceSelection, mode) and the open/hot feature from useUi.
//                          Renders nothing in sketch mode or before the scene exists (pins need a projection).
//   <HistoryStrip/>      — mount as the bottom dock under the viewport. No props; reads the same stores.
//                          Scoped to the active component: its features, the assembly steps at the root,
//                          and one "N more in other components" chip for what the scope hides.
//
// Every mutation goes through the store: editOperation, moveRollback, suppressOperation,
// deleteOperation, selectFace, activateComponent, and the chisel:lookAt window event.

import "./workbench.css";
import { Pins } from "./Pins";
import { FeatureCard } from "./FeatureCard";
import { FaceVerbs } from "./FaceVerbs";
import { ComponentCrumb } from "./ComponentCrumb";

export { HistoryStrip } from "./HistoryStrip";
export { Pins, FeatureCard, FaceVerbs, ComponentCrumb };
export * from "./workbench";
export { useFeatureRows as useRows, useActiveComponent } from "../../kit/useFeatureRows";

export function WorkbenchOverlay() {
  return (
    <>
      <ComponentCrumb />
      <Pins />
      <FeatureCard />
      <FaceVerbs />
    </>
  );
}
