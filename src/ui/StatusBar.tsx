import { activeSketch, useStore } from "../model/store";
import { AssistChip } from "./AssistInbox";
import { sketchStatus } from "./sketchStatus";

export function StatusBar() {
  const message = useStore((s) => s.lastMessage);
  const mode = useStore((s) => s.mode);
  const tool = useStore((s) => s.tool);
  const store = useStore();
  const sk = activeSketch(store);
  const mcp = useStore((s) => s.desktopMcp);

  return (
    <div className="statusbar" role="contentinfo" aria-label="Status">
      <span className="status-mode">{mode === "sketch" ? `Sketch · ${tool}` : "Model"}</span>
      {/* a live region: what just happened is read out as it changes */}
      <span className="status-msg" role="status" aria-live="polite">{message}</span>
      <div className="spacer" />
      <AssistChip />
      {mcp.running && mcp.port && (
        <span className="status-dof ok" title={`MCP server live at ${mcp.url}`}>● MCP :{mcp.port}</span>
      )}
      {sk && (() => { const st = sketchStatus(sk); return <span className={`status-dof ${st.cls}`}>● {st.text}</span>; })()}
    </div>
  );
}
