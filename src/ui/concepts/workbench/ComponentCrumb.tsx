// Where you are in the assembly: the path from the root component to the active
// one, each crumb a button that activates that component. Sits at the top-left of
// the viewport overlay; hidden on a single-component document and in sketch mode.

import { Fragment } from "react";
import { useStore } from "../../../model/store";
import { Button } from "../../kit/primitives";
import { useActiveComponent } from "../../kit/useFeatureRows";
import { crumbPath, showCrumb } from "./workbench";

export function ComponentCrumb() {
  const session = useStore((s) => s.session);
  const rev = useStore((s) => s.rev);
  const mode = useStore((s) => s.mode);
  const active = useActiveComponent();
  const activateComponent = useStore((s) => s.activateComponent);
  void rev;
  const doc = session.doc;
  if (mode !== "model" || !showCrumb(doc)) return null;
  const path = crumbPath(doc, active);
  return (
    <nav className="wb-crumb" aria-label="Component path">
      {path.map((c, i) => (
        <Fragment key={c.id}>
          {i > 0 && <span className="k-dim wb-crumb-sep" aria-hidden="true">›</span>}
          <Button size="sm" ghost on={c.id === active} title={c.id === active ? `${c.name} — the active component` : `Activate ${c.name}`}
            ariaLabel={`Activate ${c.name}`} onClick={() => activateComponent(c.id)}>
            {c.name}
          </Button>
        </Fragment>
      ))}
    </nav>
  );
}
