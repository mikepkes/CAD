import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { CustomizeApp } from "./ui/CustomizeApp";
import { useStore } from "./model/store";
import "./styles.css";
import "./ui/kit/kit.css";

// DEV-only: expose the store for debugging/automation (like __scene in Viewport).
if (import.meta.env?.DEV) (window as unknown as { __chisel?: unknown }).__chisel = useStore;

// Slider-only customize mode is selected by the URL (?mode=customize or
// ?customize), so a model link can open straight into end-user tuning.
const q = new URLSearchParams(location.search);
const customize = q.get("mode") === "customize" || q.has("customize");

createRoot(document.getElementById("root")!).render(customize ? <CustomizeApp /> : <App />);
