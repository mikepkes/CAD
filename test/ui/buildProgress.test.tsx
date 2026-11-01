// The rebuild progress bar: hidden for quick rebuilds, shown with its percentage once one runs past a second.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { BuildProgress, SHOW_AFTER_MS, buildStepText } from "../../src/ui/BuildProgress";
import { LoadingOverlay } from "../../src/ui/CustomizeControls";

describe("what the build is doing (V4, V20)", () => {
  beforeEach(() => { vi.useFakeTimers(); useStore.setState({ build: null, kernelLoading: false }); });
  afterEach(() => vi.useRealTimers());

  it("names the step, so the last phase doesn't look finished", () => {
    expect(buildStepText({ phase: "features", done: 11, total: 44 })).toBe("Building 12 of 44 features");
    expect(buildStepText({ phase: "meshing", done: 24, total: 29 })).toBe("Meshing 25 of 29 parts");
    expect(buildStepText({ phase: "meshing", done: 0, total: 1 })).toBe("Meshing 1 of 1 part");
    expect(buildStepText(undefined)).toBe("Rebuilding");
    render(<BuildProgress />);
    act(() => useStore.setState({ build: { started: performance.now() - 2000, fraction: 0.97, step: { phase: "meshing", done: 24, total: 29 } } }));
    const bar = screen.getByRole("progressbar", { name: "Rebuilding the model" });
    expect(bar.textContent).toBe("Meshing 25 of 29 parts · 97%");
    expect(bar.getAttribute("aria-valuetext")).toBe("Meshing 25 of 29 parts, 97%");
  });

  it("the viewer's loading screen says what it waits for, then how far the build has got", () => {
    act(() => useStore.setState({ kernelLoading: true }));
    const { rerender } = render(<LoadingOverlay phase="loading" name="clockwork" />);
    expect(screen.getByRole("status").textContent).toBe("Loading the 3D engine…");
    act(() => useStore.setState({ kernelLoading: false }));
    expect(screen.getByRole("status").textContent).toMatch(/^Loading .clockwork.…$/);
    rerender(<LoadingOverlay phase="building" name="clockwork" />);
    act(() => useStore.setState({ build: { started: performance.now(), fraction: 0.245, step: { phase: "features", done: 11, total: 44 } } }));
    expect(screen.getByRole("status").textContent).toMatch(/^Building .clockwork.…$/);
    expect(screen.getByText("Building 12 of 44 features · 25%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Building the model" }).getAttribute("aria-valuenow")).toBe("25");
  });
});

describe("<BuildProgress/>", () => {
  beforeEach(() => { vi.useFakeTimers(); useStore.setState({ build: null }); });
  afterEach(() => vi.useRealTimers());

  it("stays hidden for the first second, then shows how far the rebuild has got, and goes when it's done", () => {
    render(<BuildProgress />);
    act(() => useStore.setState({ build: { started: performance.now(), fraction: 0.1 } }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    act(() => { vi.advanceTimersByTime(SHOW_AFTER_MS + 10); });
    act(() => useStore.setState({ build: { started: useStore.getState().build!.started, fraction: 0.42 } }));
    const bar = screen.getByRole("progressbar", { name: "Rebuilding the model" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.textContent).toContain("42%");
    act(() => useStore.setState({ build: null }));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("a quick rebuild never shows it", () => {
    render(<BuildProgress />);
    act(() => useStore.setState({ build: { started: performance.now(), fraction: 0 } }));
    act(() => { vi.advanceTimersByTime(400); });
    act(() => useStore.setState({ build: null }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
