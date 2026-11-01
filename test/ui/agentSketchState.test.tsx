import { describe, it, expect, afterEach } from "vitest";
import { useStore } from "../../src/model/store";
import { setAgentClientFactory } from "../../src/model/agent";
import { replayClient } from "../../src/demo/agentReplay";
import { realSession } from "../helpers";

afterEach(() => setAgentClientFactory(null));

describe("the agent building a feature from a sketch", () => {
  it("leaves model mode with no sketch open, as finishing a sketch does", async () => {
    useStore.setState({ session: realSession(), rev: 1, mode: "model", activeSketchId: null, apiKey: "test", agentChat: [], solids: {} } as never);
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
    const client = replayClient({ prompt: "p", model: "m", source: "test", turns: [
      { delayMs: 0, stop_reason: "tool_use", content: [use("t1", "sketch__create", { plane: "XY" })] as never },
      { delayMs: 0, stop_reason: "tool_use", content: [use("t2", "sketch__addRectangle", { sketch: "sketch2", corner: { x: 0, y: 0 }, opposite: { x: 20, y: 10 } })] as never },
      { delayMs: 0, stop_reason: "tool_use", content: [use("t3", "feature__extrude", { sketch: "sketch2", distance: "5" })] as never },
      { delayMs: 0, stop_reason: "end_turn", content: [{ type: "text", text: "done", citations: null }] as never },
    ] });
    setAgentClientFactory(() => client);
    await useStore.getState().sendAgentMessage("a plate");
    const st = useStore.getState();
    expect(st.agentChat.filter((e) => e.role === "tool").every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(st.mode).toBe("model");
    expect(st.activeSketchId).toBeNull();
  });
});
