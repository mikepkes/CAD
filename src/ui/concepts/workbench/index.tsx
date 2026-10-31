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
//
// The face selection follows its context: one store subscription drops it (selectFace(null))
// when the timeline length, the rollback marker, the active component or the mode changes
// (`shouldDropSelection`), so the verbs card never outlives the face it was opened on.

import "./workbench.css";
import { useEffect } from "react";
import { useStore } from "../../../model/store";
import { Pins } from "./Pins";
import { FeatureCard } from "./FeatureCard";
import { FaceVerbs } from "./FaceVerbs";
import { selectionContext, shouldDropSelection } from "./workbench";

export { HistoryStrip } from "./HistoryStrip";
export { Pins, FeatureCard, FaceVerbs };
export * from "./workbench";
export { useFeatureRows as useRows, useActiveComponent } from "../../kit/useFeatureRows";

/** Clears the face selection whenever its context changes (see `shouldDropSelection`). */
export function useDropSelectionOnContextChange() {
  useEffect(() => {
    let last = selectionContext(useStore.getState());
    return useStore.subscribe((st) => {
      const next = selectionContext(st);
      if (shouldDropSelection(last, next) && st.faceSelection) st.selectFace(null);
      last = next;
    });
  }, []);
}

export function WorkbenchOverlay() {
  useDropSelectionOnContextChange();
  return (
    <>
      <Pins />
      <FeatureCard />
      <FaceVerbs />
    </>
  );
}
