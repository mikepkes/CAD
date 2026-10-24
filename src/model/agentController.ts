// The embedded agent's controller, extracted from the store so store.ts stays
// smaller and the agent flow is a self-contained unit. The conversation history
// and the in-flight request's aborter live here as closure state (not
// React-reactive); the store wires this in and spreads the returned actions.

import type AnthropicNS from "@anthropic-ai/sdk";
import { ChatEntry, AgentContext, runAgent } from "./agent";
import { CommandRegistry } from "../core/command/registry";

export const AGENT_KEY_LS = "chisel.anthropic.key";
export const AGENT_MODEL_LS = "chisel.anthropic.model";

/** Store fields the agent reads/writes. Kept structural so this module doesn't
 *  depend on the full AppState (which would be a cycle). */
export interface AgentStateSlice {
  apiKey: string;
  agentModel: string;
  agentRunning: boolean;
  agentOpen: boolean;
}

export interface AgentActions {
  toggleAgent: () => void;
  setApiKey: (key: string) => void;
  setAgentModel: (model: string) => void;
  sendAgentMessage: (text: string) => Promise<void>;
  stopAgent: () => void;
  clearAgentChat: () => void;
}

export interface AgentControllerDeps {
  getState: () => AgentStateSlice;
  patch: (p: Partial<AgentStateSlice & { agentChat: ChatEntry[]; settingsOpen: boolean }>) => void;
  appendChat: (entry: ChatEntry) => void;
  registry: CommandRegistry;
  commandHost: () => AgentContext;
}

export function createAgentController(deps: AgentControllerDeps): AgentActions {
  // Multi-turn history and the current request's aborter (not store state).
  let history: AnthropicNS.MessageParam[] = [];
  let abort: AbortController | null = null;

  return {
    toggleAgent: () => deps.patch({ agentOpen: !deps.getState().agentOpen }),
    setApiKey: (key) => { try { localStorage.setItem(AGENT_KEY_LS, key); } catch { /* ignore */ } deps.patch({ apiKey: key }); },
    setAgentModel: (model) => { try { localStorage.setItem(AGENT_MODEL_LS, model); } catch { /* ignore */ } deps.patch({ agentModel: model }); },
    stopAgent: () => { abort?.abort(); },
    clearAgentChat: () => { history = []; deps.patch({ agentChat: [] }); },
    sendAgentMessage: async (text) => {
      const s = deps.getState();
      if (!s.apiKey) { deps.patch({ settingsOpen: true }); return; }
      if (s.agentRunning || !text.trim()) return;
      deps.appendChat({ role: "user", text });
      history.push({ role: "user", content: text });
      abort = new AbortController();
      deps.patch({ agentRunning: true, agentOpen: true });
      try {
        history = await runAgent({
          apiKey: s.apiKey,
          model: s.agentModel,
          history,
          registry: deps.registry,
          signal: abort.signal,
          ctx: deps.commandHost(),
          onText: (t) => deps.appendChat({ role: "assistant", text: t }),
          onTool: (name, ok, detail) => deps.appendChat({ role: "tool", name: name.replace(/__/g, "."), ok, detail }),
        });
      } catch (e) {
        if (!abort.signal.aborted) deps.appendChat({ role: "error", text: (e as Error).message || String(e) });
      } finally {
        deps.patch({ agentRunning: false });
        abort = null;
      }
    },
  };
}
