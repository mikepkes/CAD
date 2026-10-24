import { activeSketch, useStore } from "../model/store";

export function StatusBar() {
  const message = useStore((s) => s.lastMessage);
  const mode = useStore((s) => s.mode);
  const tool = useStore((s) => s.tool);
  const store = useStore();
  const sk = activeSketch(store);
  const mcp = useStore((s) => s.desktopMcp);

  return (
    <div className="statusbar">
      <span className="status-mode">{mode === "sketch" ? `Sketch · ${tool}` : "Model"}</span>
      <span className="status-msg">{message}</span>
      <div className="spacer" />
      {mcp.running && mcp.port && (
        <span className="status-dof ok" title={`MCP server live at ${mcp.url}`}>● MCP :{mcp.port}</span>
      )}
      {sk && (
        <span className={`status-dof ${sk.status.fullyConstrained ? "ok" : sk.status.conflicting ? "bad" : "warn"}`}>
          {sk.status.fullyConstrained
            ? "● Fully constrained"
            : sk.status.conflicting
              ? "● Conflicting"
              : `● ${sk.status.dof} DOF`}
        </span>
      )}
    </div>
  );
}
