// First run (V11): a welcome card with the ways to start, an Examples menu
// beside Open, ? for the shortcuts. And the editor's landmarks (V12, V16): the
// side-panel toggles are named and say whether they're open; the page has a
// heading; the status bar is a live region.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useStore, __setGeometryBackend } from "../../src/model/store";
import { FirstRun, WELCOME_LS } from "../../src/ui/FirstRun";
import { ExamplesMenu } from "../../src/ui/ExamplesMenu";
import { EXAMPLES } from "../../src/model/examples";
import { realSession } from "../helpers";

vi.mock("../../src/ui/Viewport", () => ({ Viewport: () => null })); // no WebGL here

const fake = { init: async () => {}, ready: () => true, evaluate: async () => ({ solids: {}, facePlanes: {} }), analyze: async () => [], dispose: () => {} } as never;
beforeEach(() => {
  localStorage.clear();
  __setGeometryBackend(fake);
  act(() => useStore.setState({ session: realSession(), mode: "model", sketchPlacing: false, hotkeysOpen: false, toast: null }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the first-run card", () => {
  it("offers a sketch, a box, an example and the shortcuts over an empty document", async () => {
    render(<FirstRun />);
    expect(screen.getByRole("heading", { name: "Welcome to VibeCAD" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Shortcuts/ }));
    expect(useStore.getState().hotkeysOpen).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Open an example ▾" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(EXAMPLES.length);
    await userEvent.click(screen.getByRole("button", { name: "Start a sketch" }));
    expect(useStore.getState().sketchPlacing).toBe(true);
    expect(screen.queryByRole("heading", { name: "Welcome to VibeCAD" })).toBeNull(); // out of the way while a plane is picked
  });
  it("goes once the document has something in it, and for good when dismissed", async () => {
    const { unmount } = render(<FirstRun />);
    await act(async () => { await useStore.getState().session.dispatch("parameter.add", { name: "w", expression: "1" }); useStore.setState({ rev: useStore.getState().rev + 1 }); });
    expect(screen.queryByRole("heading", { name: "Welcome to VibeCAD" })).toBeNull();
    unmount();
    act(() => useStore.setState({ session: realSession() }));
    render(<FirstRun />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss the welcome" }));
    expect(localStorage.getItem(WELCOME_LS)).toBe("1");
    expect(screen.queryByRole("heading", { name: "Welcome to VibeCAD" })).toBeNull();
  });
});

describe("the Examples menu", () => {
  it("is a menu button listing every example; picking one opens it", async () => {
    const openExample = vi.fn(async () => {});
    const keep = useStore.getState().openExample;
    useStore.setState({ openExample });
    render(<ExamplesMenu />);
    const button = screen.getByRole("button", { name: "Examples ▾" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByRole("menuitem", { name: /Roubo workbench/ }));
    await waitFor(() => expect(openExample).toHaveBeenCalledWith("roubo"));
    expect(screen.queryByRole("menu")).toBeNull();
    useStore.setState({ openExample: keep });
  });
  it("opening an example that isn't there says so", async () => {
    vi.stubGlobal("fetch", async () => new Response("<!doctype html><html></html>", { status: 200 }));
    await useStore.getState().openExample("nope");
    expect(useStore.getState().toast).toEqual({ kind: "error", text: "Couldn't find the example “nope”." });
  });
});

describe("the editor's landmarks", () => {
  it("names the side-panel toggles and says whether they're open; the page has a heading; status is live", async () => {
    const { App } = await import("../../src/ui/App");
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "VibeCAD" })).toBeTruthy();
    const left = screen.getByRole("button", { name: "Hide the left panel" });
    expect(left.getAttribute("aria-expanded")).toBe("true");
    expect(left.getAttribute("aria-controls")).toBe("side-left");
    fireEvent.click(left);
    expect(screen.getByRole("button", { name: "Show the left panel" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Hide the right panel" }).getAttribute("aria-controls")).toBe("side-right");
    expect(document.querySelector(".status-msg")!.getAttribute("role")).toBe("status");
    expect(document.querySelector(".toast-region")!.getAttribute("aria-live")).toBe("polite");
  });
  it("the viewport's canvas is an image named for what it shows", () => {
    const path = "../../src/ui/Viewport.tsx"; // through a variable, so Vite leaves the URL alone
    const src = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    expect(src).toMatch(/setAttribute\("role", "img"\)/);
    expect(src).toMatch(/setAttribute\("aria-label"/);
  });
});
