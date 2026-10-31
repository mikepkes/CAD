// The app panels whose open state lives in the store (the agent chat, the
// hotkeys sheet, settings), made switchable by set_panel alongside the concept
// panels in useUi. App mounts this once.

import { useStore } from "./store";
import { registerPanel } from "./uiControl";

export function registerAppPanels(): () => void {
  const off = [
    registerPanel("agent", { get: () => useStore.getState().agentOpen, set: (on) => useStore.setState({ agentOpen: on }) }),
    registerPanel("hotkeys", { get: () => useStore.getState().hotkeysOpen, set: (on) => useStore.getState().setHotkeysOpen(on) }),
    registerPanel("settings", { get: () => useStore.getState().settingsOpen, set: (on) => useStore.getState().setSettingsOpen(on) }),
  ];
  return () => { for (const f of off) f(); };
}
