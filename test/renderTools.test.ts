import { describe, expect, it } from "vitest";
import { buildTools, type WebMcpHost } from "../src/model/webmcp";
import { fitDistance, orbitDirection } from "../src/viewport/orbitCamera";
import { sanitizeOutputName, timestampedStem } from "../src/model/saveOutput";
import type { RenderViewOpts } from "../src/viewport/SceneManager";
import type { TurntableOpts } from "../src/viewport/turntableRecorder";

// The render tools (render_view's free camera + saveAs, record_turntable) as the
// MCP surfaces see them. Pure — the host is faked, so no WebGL or Tauri here.

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

function fakeHost(withRecorder = true) {
  const calls = { render: [] as RenderViewOpts[], record: [] as TurntableOpts[], saved: [] as { name: string; bytes: Uint8Array; mime: string }[] };
  const host: WebMcpHost = {
    registry: { toMcpTools: () => [] } as unknown as WebMcpHost["registry"],
    runCommand: async () => ({ ok: true }),
    describe: () => ({}),
    render: async (opts) => { calls.render.push(opts); return { base64: PNG_B64, width: 640, height: 480, view: opts.azimuthDeg != null ? "az-90_el30" : "iso" }; },
    saveOutput: async (name, bytes, mime) => { calls.saved.push({ name, bytes, mime }); return `/Users/me/Downloads/Chisel CAD/${name}`; },
    ...(withRecorder ? {
      recordTurntable: async (opts: TurntableOpts) => {
        calls.record.push(opts);
        return { bytes: new Uint8Array(1234), codec: "avc1.640033", width: opts.width!, height: opts.height!, fps: opts.fps!, frames: Math.round(opts.fps! * opts.seconds!) };
      },
    } : {}),
  };
  return { host, calls };
}
const tool = (host: WebMcpHost, name: string) => buildTools(host).find((t) => t.name === name)!;
const text = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content.find((c) => c.type === "text")!.text!);

describe("orbit camera math", () => {
  it("maps azimuth/elevation onto the Z-up view sphere", () => {
    const front = orbitDirection(-90, 0);
    expect(front[0]).toBeCloseTo(0); expect(front[1]).toBeCloseTo(-1); expect(front[2]).toBeCloseTo(0);
    const up45 = orbitDirection(0, 45);
    expect(up45[0]).toBeCloseTo(Math.SQRT1_2); expect(up45[2]).toBeCloseTo(Math.SQRT1_2);
  });

  it("clamps elevation short of the poles", () => {
    const top = orbitDirection(0, 90);
    expect(top[2]).toBeLessThan(1);
    expect(Math.hypot(...top)).toBeCloseTo(1);
  });

  it("fits a bounding sphere to the narrower half-angle", () => {
    // 90° vertical, square: the sphere touches at 45°.
    expect(fitDistance(10, 90, 1, 1)).toBeCloseTo(10 / Math.sin(Math.PI / 4));
    // A tall frame is limited by its horizontal angle, so the camera backs off further.
    expect(fitDistance(10, 45, 0.5, 1)).toBeGreaterThan(fitDistance(10, 45, 1, 1));
    // Narrowing the field of view (a zoomed lens) moves the camera out.
    expect(fitDistance(10, 10)).toBeGreaterThan(fitDistance(10, 45));
  });
});

describe("output filenames", () => {
  it("keeps only a plain filename with the right extension", () => {
    expect(sanitizeOutputName("turntable.mp4", "mp4", "x")).toBe("turntable.mp4");
    expect(sanitizeOutputName("../../etc/passwd", "png", "x")).toBe("passwd.png");
    expect(sanitizeOutputName("C:\\temp\\shot.PNG", "png", "x")).toBe("shot.png");
    expect(sanitizeOutputName("weird*name?.mp4", "mp4", "x")).toBe("weird_name_.mp4");
    expect(sanitizeOutputName(".hidden", "png", "x")).toBe("hidden.png");
  });

  it("falls back when nothing usable is left", () => {
    expect(sanitizeOutputName(undefined, "mp4", "chisel-turntable")).toBe("chisel-turntable.mp4");
    expect(sanitizeOutputName("/", "png", "fallback")).toBe("fallback.png");
  });

  it("stamps default names", () => {
    expect(timestampedStem("chisel-turntable", new Date(2026, 9, 29, 14, 5, 9))).toBe("chisel-turntable-20261029-140509");
  });
});

describe("render_view", () => {
  it("passes the free camera through to the host", async () => {
    const { host, calls } = fakeHost();
    const r = await tool(host, "render_view").execute({ azimuthDeg: -90, elevationDeg: 30, fovDeg: 10, rollDeg: 15, clean: true, width: 640 });
    expect(r.isError).toBeFalsy();
    expect(calls.render[0]).toMatchObject({ azimuthDeg: -90, elevationDeg: 30, fovDeg: 10, rollDeg: 15, clean: true, width: 640 });
    expect(r.content).toEqual([{ type: "image", data: PNG_B64, mimeType: "image/png" }]);
    expect(calls.saved).toHaveLength(0);
  });

  it("saveAs also writes the decoded PNG and reports where", async () => {
    const { host, calls } = fakeHost();
    const r = await tool(host, "render_view").execute({ view: "iso", saveAs: "shots/part" });
    expect(calls.saved[0].name).toBe("part.png");
    expect(calls.saved[0].mime).toBe("image/png");
    expect(Array.from(calls.saved[0].bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    expect(r.content[0].type).toBe("image");
    expect(text(r)).toMatchObject({ ok: true, saved: "/Users/me/Downloads/Chisel CAD/part.png" });
  });
});

describe("record_turntable", () => {
  it("is only offered when the host can record and save", () => {
    expect(buildTools(fakeHost(false).host).some((t) => t.name === "record_turntable")).toBe(false);
    expect(buildTools(fakeHost().host).some((t) => t.name === "record_turntable")).toBe(true);
  });

  it("records with defaults and saves a timestamped mp4", async () => {
    const { host, calls } = fakeHost();
    const r = await tool(host, "record_turntable").execute({});
    expect(calls.record[0]).toMatchObject({ seconds: 4, fps: 60, width: 1280, height: 720, revolutions: 1, elevationDeg: 25, startAzDeg: -60, fovDeg: 30 });
    expect(calls.saved[0].name).toMatch(/^chisel-turntable-\d{8}-\d{6}\.mp4$/);
    expect(calls.saved[0].mime).toBe("video/mp4");
    expect(text(r)).toMatchObject({ ok: true, codec: "avc1.640033", frames: 240, bytes: 1234 });
  });

  it("clamps out-of-range requests and sanitizes the filename", async () => {
    const { host, calls } = fakeHost();
    await tool(host, "record_turntable").execute({ seconds: 600, fps: 240, width: 8000, height: 10, elevationDeg: 120, filename: "../out/spin" });
    expect(calls.record[0]).toMatchObject({ seconds: 30, fps: 60, width: 1920, height: 64, elevationDeg: 89 });
    expect(calls.saved[0].name).toBe("spin.mp4");
  });

  it("reports recorder failures as tool errors", async () => {
    const { host } = fakeHost();
    host.recordTurntable = async () => { throw new Error("nothing to record — build a solid first"); };
    const r = await tool(host, "record_turntable").execute({});
    expect(r.isError).toBe(true);
    expect(text(r).error).toMatch(/nothing to record/);
  });
});
