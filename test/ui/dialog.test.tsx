import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../../src/ui/kit/Dialog";
import { ask, askText, useDialog } from "../../src/ui/kit/askDialog";

afterEach(() => act(() => useDialog.getState().cancel()));

describe("in-app dialog (no browser confirm / prompt)", () => {
  it("asks yes/no and resolves on the buttons", async () => {
    render(<Dialog />);
    let p!: Promise<boolean>;
    act(() => { p = ask({ title: "New document", text: "Start over?", confirmLabel: "New document", danger: true }); });
    expect(screen.getByRole("dialog", { name: "New document" })).toBeTruthy();
    expect(screen.getByText("Start over?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "New document" }));
    await expect(p).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => { p = ask({ title: "Again" }); });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(p).resolves.toBe(false);
  });

  it("cancels on Escape without letting the app's Escape run", async () => {
    render(<Dialog />);
    let seen = 0;
    const late = () => { seen++; };
    window.addEventListener("keydown", late);
    let p!: Promise<boolean>;
    act(() => { p = ask({ title: "Q" }); });
    fireEvent.keyDown(window, { key: "Escape" });
    await expect(p).resolves.toBe(false);
    expect(seen).toBe(0);
    window.removeEventListener("keydown", late);
  });

  it("asks for text: Enter submits the trimmed value, empty can't submit, cancel is null", async () => {
    render(<Dialog />);
    let p!: Promise<string | null>;
    act(() => { p = askText({ title: "New configuration", label: "Name", initial: "Config 2", confirmLabel: "Create" }); });
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(input.value).toBe("Config 2");
    await userEvent.clear(input);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(input, "  Large {Enter}");
    await expect(p).resolves.toBe("Large");
    act(() => { p = askText({ title: "Again" }); });
    act(() => { void ask({ title: "Newer" }); }); // a new request cancels the open one
    await expect(p).resolves.toBeNull();
  });
});
