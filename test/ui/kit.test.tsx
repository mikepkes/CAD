import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveNumber } from "../../src/ui/kit/LiveNumber";
import { Button, Pills, Card, Readout, Chip } from "../../src/ui/kit/primitives";

describe("LiveNumber", () => {
  const spec = { min: 0, max: 100, step: 0.5 };

  it("shows the value with its unit and an accessible name", () => {
    render(<LiveNumber value={3} spec={spec} unit="mm" name="wall thickness" onChange={() => {}} />);
    const b = screen.getByRole("button", { name: /wall thickness, 3\.0 mm/ });
    expect(b.textContent).toBe("3.0 mm");
  });

  it("steps with the arrow keys and commits each step", async () => {
    const onChange = vi.fn(), onCommit = vi.fn();
    render(<LiveNumber value={3} spec={spec} name="n" onChange={onChange} onCommit={onCommit} />);
    const b = screen.getByRole("button");
    b.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(0); // 3 - 5 clamps at the min
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("scrubs sideways: one step per 5 px, and commits on release", () => {
    const onChange = vi.fn(), onCommit = vi.fn();
    render(<LiveNumber value={10} spec={spec} name="n" onChange={onChange} onCommit={onCommit} />);
    const b = screen.getByRole("button");
    fireEvent.pointerDown(b, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(b, { clientX: 125 });
    expect(onChange).toHaveBeenLastCalledWith(12.5);
    fireEvent.pointerUp(b);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("types a value on Enter and ignores nonsense", async () => {
    const onChange = vi.fn();
    render(<LiveNumber value={10} spec={spec} name="n" onChange={onChange} />);
    screen.getByRole("button").focus();
    await userEvent.keyboard("{Enter}");
    const input = screen.getByRole("textbox", { name: "n" });
    await userEvent.clear(input);
    await userEvent.type(input, "42.3{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(42.5);
    expect(screen.getByRole("button").textContent).toBe("10.0");
  });

  it("reports hover so the part can light up", () => {
    const onHover = vi.fn();
    render(<LiveNumber value={1} spec={spec} name="n" onChange={() => {}} onHover={onHover} />);
    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.mouseLeave(screen.getByRole("button"));
    expect(onHover.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });
});

describe("primitives", () => {
  it("Button exposes pressed state and the accessible label", () => {
    render(<Button on ariaLabel="Zoom in" onClick={() => {}}>+</Button>);
    expect(screen.getByRole("button", { name: "Zoom in" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("Pills are a group with one pressed option that changes on click", async () => {
    const onChange = vi.fn();
    render(<Pills value="b" ariaLabel="Mode" options={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Mode" });
    expect(group.querySelectorAll("[aria-pressed='true']").length).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "A" }));
    expect(onChange).toHaveBeenCalledWith("a");
  });
  it("Card is a dialog placed where asked, with a close button", async () => {
    const onClose = vi.fn();
    render(<Card at={{ x: 20, y: 30 }} num={2} title="Upright wall" onClose={onClose}>body</Card>);
    const d = screen.getByRole("dialog", { name: "Upright wall" });
    expect(d.style.left).toBe("20px");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
  it("Readout and Chip render their text", () => {
    render(<><Readout label="Mass" value="99.6 g" state="bad" /><Chip num={3} label="Holes" state="ghost" /></>);
    expect(screen.getByText("99.6 g")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3Holes" }).className).toContain("ghost");
  });
});
