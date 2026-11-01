// The customize viewer's controls (V7, V16, V21, V23, V17): labels a person can
// read, with units, a line about each and an exact-value field; slider names
// without their values and values read out with units; hidden parameters stay
// out; a missing model is said in a sentence, with the examples to pick from.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Control, LoadProblem, modelTitle, typedValue, viewerControls, withUnit } from "../../src/ui/CustomizeControls";
import { EXAMPLES } from "../../src/model/examples";
import { createDocument, type Parameter } from "../../src/core/document";

const length = { name: "L", expr: "1700", value: 1700, label: "Length", unit: "mm", description: "Overall length of the bench top", min: 1200, max: 2400, step: 10 };

describe("a viewer control", () => {
  it("shows the label, unit, range and description; the slider is named by the label alone", () => {
    render(<Control {...length} onEdit={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Length" }); // not "Length 1700"
    expect(slider.getAttribute("aria-valuetext")).toBe("1700 mm");
    expect(slider.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(slider.getAttribute("aria-describedby")!)!.textContent).toBe("Overall length of the bench top");
    expect(screen.getByText("1200 mm")).toBeTruthy();
    expect(screen.getByText("2400 mm")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Length, exact value in mm" }) as HTMLInputElement).value).toBe("1700");
  });

  it("falls back to the name, with no unit", () => {
    render(<Control name="r3i" expr="4" value={4} min={2} max={8} onEdit={() => {}} />);
    expect(screen.getByRole("slider", { name: "r3i" }).getAttribute("aria-valuetext")).toBe("4");
  });

  it("takes a typed value, kept in range and on the step; Escape or nonsense changes nothing", async () => {
    const onEdit = vi.fn();
    render(<Control {...length} onEdit={onEdit} />);
    const box = screen.getByRole("textbox", { name: /exact value/ }) as HTMLInputElement;
    await userEvent.clear(box);
    await userEvent.type(box, "1834{Enter}");
    expect(onEdit).toHaveBeenLastCalledWith("L", "1830", true); // snapped to the 10 mm step
    expect(box.value).toBe("1830");
    await userEvent.clear(box);
    await userEvent.type(box, "9999{Enter}");
    expect(onEdit).toHaveBeenLastCalledWith("L", "2400", true); // clamped to the top
    onEdit.mockClear();
    await userEvent.clear(box);
    await userEvent.type(box, "wide{Enter}");
    expect(onEdit).not.toHaveBeenCalled();
    expect(box.value).toBe("2400");
    await userEvent.clear(box);
    await userEvent.type(box, "1500{Escape}");
    expect(onEdit).not.toHaveBeenCalled();
    expect(box.value).toBe("2400");
  });

  it("typedValue clamps and snaps from min, and refuses what isn't a number", () => {
    expect(typedValue("1834", 1200, 2400, 10)).toBe(1830);
    expect(typedValue("3,5", 0, 10, 0.5)).toBe(3.5);
    expect(typedValue("7", 1, 8, 2)).toBe(7); // the slider's steps count from min: 1, 3, 5, 7
    expect(typedValue("-4", 0, 10)).toBe(0);
    expect(typedValue("", 0, 10)).toBeNull();
    expect(typedValue("abc", 0, 10)).toBeNull();
    expect(withUnit("30", "°")).toBe("30°");
    expect(withUnit("30", "mm")).toBe("30 mm");
  });

  it("a dropdown and a checkbox are labelled and described too", () => {
    const { unmount } = render(<Control name="material" label="Material" expr="1" value={1} values={[0, 1, 2]} options={["PLA", "PETG", "TPU 68D (TPU for flexures)"]} description="What it's printed in" onEdit={() => {}} />);
    const select = screen.getByRole("combobox", { name: "Material" });
    expect(select.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("option", { name: "TPU 68D (TPU for flexures)" })).toBeTruthy();
    unmount();
    const onEdit = vi.fn();
    render(<Control name="lid" label="Show the lid" expr="1" value={1} boolean onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Show the lid" }));
    expect(onEdit).toHaveBeenCalledWith("lid", "0", true);
  });
});

describe("what the viewer shows", () => {
  const p = (q: Partial<Parameter>): Parameter => ({ id: q.name!, name: q.name!, expr: "1", value: 1, ...q });
  it("offers bounded parameters only, and never hidden ones (V23)", () => {
    const params = [p({ name: "W", min: 1, max: 9 }), p({ name: "free" }), p({ name: "pick", values: [1, 2] }), p({ name: "joint", min: 0, max: 360, hidden: true })];
    expect(viewerControls(params).map((x) => x.name)).toEqual(["W", "pick"]);
  });
  it("titles the model: its own title, else the drawing's, the root component's, the example's", () => {
    const doc = createDocument();
    expect(modelTitle(doc, "scissor-jointed")).toBe("Jointed scissor");
    expect(modelTitle(doc, "my-thing")).toBe("My thing");
    expect(modelTitle(null)).toBe("Model");
    doc.drawing = { title: "Bench" };
    expect(modelTitle(doc, "roubo")).toBe("Bench");
    doc.about = { title: "Roubo workbench" };
    expect(modelTitle(doc, "roubo")).toBe("Roubo workbench");
  });
});

describe("a model that isn't there (V17)", () => {
  it("says so in a sentence and lists the examples, not a JSON parse error", () => {
    render(<LoadProblem failure={{ kind: "missing", example: "nope", url: "/examples/nope.json" }} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Couldn't find the model “nope”");
    expect(screen.queryByText(/JSON|Unexpected token/)).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links.find((a) => a.textContent === "Star box")!.getAttribute("href")).toBe("?customize&example=starbox");
    expect(links.length).toBe(EXAMPLES.length + 1); // and the editor
  });
});
