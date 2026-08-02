import { useEffect, useState } from "react";
import api from "../api/client";

// Egress proxy: pin each bot's public IP to a chosen VPS (agent), independent of the
// node that runs the process. Replaces the old global socks/http proxy page.

export default function ProxyPage() {
    const [nodes, setNodes] = useState([]);
    const [bots, setBots] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [rowState, setRowState] = useState({}); // botId -> { busy, msg, ok }

    const nodeName = (id) => {
        if (!id || id === "local") return "Local (panel VPS)";
        return nodes.find((n) => n._id === id)?.name || id;
    };

    const load = async () => {
        setLoading(true);
        setErr(null);
        try {
            const { data } = await api.get("/proxy");
            setNodes(data.nodes || []);
            setBots(data.bots || []);
        } catch (e) {
            setErr(e.response?.data?.error || "Failed to load.");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const setEgress = async (bot, egressNodeId) => {
        setBots((prev) => prev.map((b) => (b._id === bot._id ? { ...b, egressNodeId } : b)));
        setRowState((s) => ({ ...s, [bot._id]: { busy: true } }));
        try {
            const { data } = await api.put(`/proxy/bots/${bot._id}`, { egressNodeId });
            setRowState((s) => ({
                ...s,
                [bot._id]: {
                    busy: false,
                    ok: true,
                    msg: data.applied ? "Applied (restarted)" : "Saved",
                },
            }));
        } catch (e) {
            setRowState((s) => ({
                ...s,
                [bot._id]: { busy: false, ok: false, msg: e.response?.data?.error || "Failed" },
            }));
        }
    };

    return (
        <div className="page fade-in" style={{ maxWidth: 1000 }}>
            <div style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
                    Egress Proxy
                </h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    Pin a project's public IP to any VPS, independent of the node that runs it. Traffic is
                    tunneled through that VPS's agent proxy — so you can move a bot to another node for
                    resources while keeping its IP.
                </p>
            </div>

            {err && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 16, borderLeft: "3px solid var(--danger)", color: "var(--danger)", fontSize: 13 }}>
                    {err}
                </div>
            )}

            {loading ? (
                <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)" }}>Loading…</div>
            ) : bots.length === 0 ? (
                <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)" }}>No projects yet.</div>
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div className="scroll-x">
                        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
                            <thead>
                                <tr style={{ textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-dim)" }}>
                                    <th style={{ padding: "12px 16px" }}>Project</th>
                                    <th style={{ padding: "12px 16px" }}>Runs on</th>
                                    <th style={{ padding: "12px 16px" }}>Egress IP (VPS)</th>
                                    <th style={{ padding: "12px 16px" }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {bots.map((b) => {
                                    const rs = rowState[b._id] || {};
                                    return (
                                        <tr key={b._id} style={{ borderTop: "1px solid var(--border-light)" }}>
                                            <td style={{ padding: "10px 16px" }}>
                                                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{b.name}</div>
                                                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{b.projectType}</div>
                                            </td>
                                            <td style={{ padding: "10px 16px", fontSize: 12.5, color: "var(--text-muted)" }}>
                                                {nodeName(b.nodeId)}
                                            </td>
                                            <td style={{ padding: "10px 16px" }}>
                                                <select
                                                    className="input"
                                                    style={{ maxWidth: 240 }}
                                                    value={b.egressNodeId || ""}
                                                    disabled={rs.busy}
                                                    onChange={(e) => setEgress(b, e.target.value)}
                                                >
                                                    <option value="">None (run-host IP)</option>
                                                    {nodes.map((n) => (
                                                        <option key={n._id} value={n._id}>
                                                            {n.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </td>
                                            <td style={{ padding: "10px 16px", fontSize: 12, whiteSpace: "nowrap" }}>
                                                {rs.busy ? (
                                                    <span style={{ color: "var(--text-dim)" }}>Saving…</span>
                                                ) : rs.msg ? (
                                                    <span style={{ color: rs.ok ? "var(--success)" : "var(--danger)" }}>{rs.msg}</span>
                                                ) : null}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            <p style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 12 }}>
                Changing the egress restarts the project if it is running. Choosing the same VPS it runs on
                uses the native IP (no tunnel).
            </p>
        </div>
    );
}
