// The rebuild progress bar: hidden for quick rebuilds, shown with its percentage once one runs past a second.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useStore } from "../../src/model/store";
import { BuildProgress, SHOW_AFTER_MS } from "../../src/ui/BuildProgress";

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
