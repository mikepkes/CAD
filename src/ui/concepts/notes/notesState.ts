// What the Notes concept has open: the note read in the panel, and the one
// being edited ("new" for a draft not yet added). Shared by the panel and the
// pins over the view (a pin opens its note), nothing else.

import { create } from "zustand";
import { useUi } from "../../../model/concepts/uiState";

export interface NotesUi {
  open: string | null;
  editing: string | "new" | null;
  setOpen: (id: string | null) => void;
  edit: (id: string | "new" | null) => void;
  /** Show a note in the Notes tab (turning it on and bringing it forward): what clicking its pin does. */
  reveal: (id: string) => void;
}

export const useNotesUi = create<NotesUi>((set) => ({
  open: null,
  editing: null,
  setOpen: (id) => set({ open: id }),
  edit: (id) => set({ editing: id, ...(id && id !== "new" ? { open: id } : {}) }),
  reveal: (id) => {
    const ui = useUi.getState();
    if (!ui.panels.notes) ui.togglePanel("notes", true);
    ui.setRightTab("notes");
    if (!ui.sideOpen.right) ui.setSideOpen("right", true);
    set((s) => (s.editing ? {} : { open: id })); // an edit in progress keeps the panel; its draft is not thrown away
  },
}));
