// In-app confirm / text prompts. The browser's confirm() and prompt() don't show
// in the desktop app's webview (they return at once with "no"), so every question
// the app asks goes through here instead: `ask` and `askText` return promises and
// the <Dialog/> mounted once in App draws the one open request. A new request
// cancels one still open.

import { create } from "zustand";

export interface AskOptions {
  title: string;
  text?: string;
  /** The confirming button's label (default "OK"). */
  confirmLabel?: string;
  /** The confirming action destroys something: styled as a warning. */
  danger?: boolean;
}

export interface AskTextOptions extends AskOptions {
  /** The field's label (default: none). */
  label?: string;
  initial?: string;
}

export type DialogRequest =
  | (AskOptions & { kind: "confirm"; settle: (ok: boolean) => void })
  | (AskTextOptions & { kind: "text"; settle: (value: string | null) => void });

interface DialogState {
  current: DialogRequest | null;
  ask: (o: AskOptions) => Promise<boolean>;
  askText: (o: AskTextOptions) => Promise<string | null>;
  /** Close the open request with "cancel" (false / null). */
  cancel: () => void;
}

export const useDialog = create<DialogState>((set, get) => {
  const open = <T,>(req: (settle: (v: T) => void) => DialogRequest) =>
    new Promise<T>((resolve) => {
      get().cancel();
      set({ current: req((v) => { set({ current: null }); resolve(v); }) });
    });
  return {
    current: null,
    ask: (o) => open<boolean>((settle) => ({ ...o, kind: "confirm", settle })),
    askText: (o) => open<string | null>((settle) => ({ ...o, kind: "text", settle })),
    cancel: () => {
      const c = get().current;
      if (!c) return;
      if (c.kind === "confirm") c.settle(false); else c.settle(null);
    },
  };
});

/** Ask a yes/no question in the app. */
export const ask = (o: AskOptions) => useDialog.getState().ask(o);
/** Ask for a line of text in the app: null when cancelled. */
export const askText = (o: AskTextOptions) => useDialog.getState().askText(o);
