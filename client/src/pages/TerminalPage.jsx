import { useEffect, useState } from "react";
import api from "../api/client";
import ShellTerminal from "../components/ShellTerminal";

// Interactive shell for one node, chosen right here rather than from a global
// switcher — the choice only means anything on this page. A project's own
// Terminal tab opens the same kind of shell, already in the project's folder.

export default function TerminalPage() {
    const [nodes, setNodes] = useState([]);
    const [nodeId, setNodeId] = useState(null);
    const selectedNode = nodes.find((n) => n._id === nodeId) || null;

    // Node list for the picker. Defaults to the panel's own node, which is the
    // one an admin almost always wants a shell on.
    useEffect(() => {
        api.get("/nodes")
            .then((r) => {
                setNodes(r.data);
                setNodeId((cur) => cur || (r.data.find((n) => n.isPanelNode) || r.data[0])?._id || null);
            })
            .catch(() => {});
    }, []);

    return (
        <div className="page fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", maxWidth: 1400 }}>
            <ShellTerminal
                params={nodeId ? { node: nodeId } : null}
                targetLabel={selectedNode?.name || nodeId}
                title={
                    <div>
                        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--text)", margin: "0 0 4px" }}>Terminal</h1>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                            {selectedNode
                                ? <>Shell on <strong style={{ color: "var(--text)" }}>{selectedNode.name}</strong>{selectedNode.host ? ` — ${selectedNode.host}` : ""}</>
                                : "Pick a node to open a shell on."}
                        </p>
                    </div>
                }
                actions={
                    <select
                        className="input mono"
                        style={{ fontSize: 12, padding: "6px 10px", width: "auto", minWidth: 170 }}
                        value={nodeId || ""}
                        onChange={(e) => setNodeId(e.target.value || null)}
                        aria-label="Node to open a shell on"
                    >
                        {!nodeId && <option value="">Select a node…</option>}
                        {nodes.map((n) => (
                            <option key={n._id} value={n._id}>
                                {n.name}{n.isPanelNode ? " — panel" : ""}{n.status === "offline" ? " (offline)" : ""}
                            </option>
                        ))}
                    </select>
                }
            />

            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "10px 2px 0" }}>
                Pick a different node above to open a shell on another machine; a project's own Terminal tab
                opens one already in its folder. Tap <strong>Ctrl</strong> then a letter for combos (e.g. Ctrl→R for reverse-search). Sessions idle-timeout after 30 minutes.
            </p>
        </div>
    );
}
