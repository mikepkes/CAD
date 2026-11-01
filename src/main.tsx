import "./model/legacyStorage"; // first: settings move to their VibeCAD keys before any store reads them
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { CustomizeApp } from "./ui/CustomizeApp";
import { useStore } from "./model/store";
import { installTheme } from "./model/theme";
import "./styles.css";
import "./ui/kit/kit.css";

// DEV-only: expose the store for debugging/automation (like __scene in Viewport).
if (import.meta.env?.DEV) (window as unknown as { __vibecad?: unknown }).__vibecad = useStore;

// Light or dark (Settings; follows the system by default), before the first render.
installTheme();

// Slider-only customize mode is selected by the URL (?mode=customize or
// ?customize), so a model link can open straight into end-user tuning.
const q = new URLSearchParams(location.search);
const customize = q.get("mode") === "customize" || q.has("customize");

createRoot(document.getElementById("root")!).render(customize ? <CustomizeApp /> : <App />);

// Demo mode for the tutorial video (?demo): a presenter layer and the director's API, loaded only when asked for.
if (q.has("demo")) void import("./demo/demo").then((m) => m.installDemo());
