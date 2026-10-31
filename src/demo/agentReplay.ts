// The video's mock agent: replays a cached Claude conversation through the real
// agent loop (agent.ts → runAgent), so the panel streams the cached text and the
// cached tool calls run as real commands, building the model on camera. A take
// is then deterministic. The cache is a likely result for the prompt; record a
// real run (recordingClient, with an API key) to refresh it.

import Anthropic from "@anthropic-ai/sdk";
import type { MessagesClient } from "../model/agent";
import { assistReplyMessage, isAssistRequest } from "../model/assist";

export interface AgentTurn {
  /** How long "thinking" takes before this turn arrives, ms. */
  delayMs?: number;
  stop_reason: "tool_use" | "end_turn";
  content: Anthropic.ContentBlock[];
}

export interface AgentCache {
  prompt: string;
  model: string;
  /** Where this cache came from (written by hand as a likely result, or recorded). */
  source: string;
  turns: AgentTurn[];
  /** Organizational assist's names by default name ("Sketch 1": "Base plate profile"); a list is used in order, for
   *  default names that repeat (two features both called "Extrude"). Others get the heuristic name. */
  names?: Record<string, string | string[]>;
}

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
});

/** A client that answers each request with the cache's next turn. */
export function replayClient(cache: AgentCache): MessagesClient {
  let i = 0;
  const used: Record<string, number> = {};
  const nameFor = (cur: string): string | undefined => {
    const n = cache.names?.[cur];
    if (!Array.isArray(n)) return n;
    const k = used[cur] ?? 0;
    used[cur] = k + 1;
    return n[k];
  };
  return {
    messages: {
      async create(body, opts) {
        // A naming request (organizational assist) is answered on the side, without using up a turn.
        if (isAssistRequest(body)) { await wait(400, opts?.signal); return assistReplyMessage(body, nameFor); }
        const turn = cache.turns[i++] ?? { stop_reason: "end_turn", content: [{ type: "text", text: "", citations: null }] as Anthropic.ContentBlock[] };
        await wait(turn.delayMs ?? 1200, opts?.signal);
        return {
          id: `msg_replay_${i}`, type: "message", role: "assistant", model: cache.model, container: null,
          content: turn.content, stop_reason: turn.stop_reason, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

/** A client that calls the real API and keeps every turn, to save as a cache (window.__agentRecording). */
export function recordingClient(apiKey: string, prompt: string): MessagesClient {
  const real = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const rec: AgentCache = { prompt, model: "", source: `recorded ${new Date().toISOString()}`, turns: [] };
  (window as unknown as { __agentRecording?: AgentCache }).__agentRecording = rec;
  return {
    messages: {
      async create(body, opts) {
        if (isAssistRequest(body)) return real.messages.create(body, opts); // naming requests aren't part of the recording
        const t0 = performance.now();
        const msg = await real.messages.create(body, opts);
        rec.model = msg.model;
        rec.turns.push({ delayMs: Math.round(performance.now() - t0), stop_reason: msg.stop_reason === "tool_use" ? "tool_use" : "end_turn", content: msg.content });
        return msg;
      },
    },
  };
}
