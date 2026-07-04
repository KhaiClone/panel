import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const fmtGB = (bytes) => (bytes == null ? "—" : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`);

const STATUS_STYLES = {
    online:   { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    offline:  { color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)",  label: "Offline" },
    disabled: { color: "var(--text-dim)", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", label: "Disabled" },
    unknown:  { color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)", label: "Checking…" },
};

function UsageBar({ label, pct, detail }) {
    const color = pct == null ? "var(--text-dim)" : pct > 85 ? "var(--danger)" : pct > 60 ? "var(--warning)" : "var(--success)";
    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {pct != null ? `${Math.round(pct)}%` : "—"}{detail ? ` · ${detail}` : ""}
                </span>
            </div>
            <div style={{ height: 4, background: "var(--bg-input)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(pct ?? 0, 100)}%`, background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
            </div>
        </div>
    );
}

function NodeModal({ node, onClose, onSaved }) {
    const isEdit = !!node;
    const [form, setForm] = useState({
        name: node?.name || "",
        host: node?.host || "",
        port: node?.port || 4200,
        apiKey: "",
        enabled: node ? node.enabled : true,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const set = (field) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [field]: val }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            if (isEdit) {
                await api.put(`/nodes/${node._id}`, form);
            } else {
                await api.post("/nodes", form);
            }
            onSaved();
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save node");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div className="card slide-up" style={{ width: "100%", maxWidth: 480, padding: 0 }}>
                <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center" }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>{isEdit ? `Edit "${node.name}"` : "Add Worker Node"}</h2>
                    <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}>✕</button>
                </div>
                <form onSubmit={handleSubmit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                        <label className="label">Name *</label>
                        <input className="input" placeholder="VPS 2" value={form.name} onChange={set("name")} required />
                    </div>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
                        <div>
                            <label className="label">Host / IP *</label>
                            <input className="input mono" placeholder="14.225.211.157" value={form.host} onChange={set("host")} required />
                        </div>
                        <div>
                            <label className="label">Agent Port *</label>
                            <input className="input mono" type="number" min="1" max="65535" value={form.port} onChange={set("port")} required />
                        </div>
                    </div>
                    <div>
                        <label className="label">Agent API Key {isEdit ? "(leave blank to keep current)" : "*"}</label>
                        <input className="input mono" placeholder="printed by setup-agent.sh" value={form.apiKey} onChange={set("apiKey")} required={!isEdit} />
                    </div>
                    {isEdit && (
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                            <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
                            Enabled (scheduler may place new bots here)
                        </label>
                    )}
                    {error && <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>}
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, paddingTop: 8 }}>
                        <button type="button" className="btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={loading}>
                            {loading ? "Testing connection…" : isEdit ? "Save" : "Add Node"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

export default function NodesPage() {
    const [nodes, setNodes] = useState([]);
    const [loading, setLoading] = useState(true);
    const [modal, setModal] = useState(null); // null | { node } | { node: null } for create
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [testResult, setTestResult] = useState({}); // nodeId → message

    const fetchNodes = useCallback(async () => {
        try {
            const { data } = await api.get("/nodes");
            setNodes(data);
        } catch { /* keep last data */ }
        setLoading(false);
    }, []);

    useEffect(() => {
        fetchNodes();
        const int = setInterval(fetchNodes, 10_000);
        return () => clearInterval(int);
    }, [fetchNodes]);

    const handleTest = async (node) => {
        setTestResult((r) => ({ ...r, [node._id]: "Testing…" }));
        try {
            const { data } = await api.post(`/nodes/${node._id}/test`);
            setTestResult((r) => ({ ...r, [node._id]: data.ok ? "✅ Connection OK" : `❌ ${data.message}` }));
        } catch (err) {
            setTestResult((r) => ({ ...r, [node._id]: `❌ ${err.response?.data?.error || err.message}` }));
        }
    };

    const handleDelete = async () => {
        const node = confirmDelete;
        setConfirmDelete(null);
        try {
            await api.delete(`/nodes/${node._id}`);
            fetchNodes();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to delete node");
        }
    };

    return (
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Nodes</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Worker VPS list — new Discord bots are auto-placed on the best node, or pick one manually when creating.
                    </p>
                </div>
                <button className="btn-primary" onClick={() => setModal({ node: null })}>+ Add Node</button>
            </div>

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
                    {nodes.map((node) => {
                        const s = STATUS_STYLES[node.status] || STATUS_STYLES.unknown;
                        const st = node.stats;
                        return (
                            <div key={node._id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                                <div style={{ height: 3, background: `linear-gradient(90deg, ${s.color}, transparent)` }} />
                                <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                                <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>{node.name}</h3>
                                                {node.local && (
                                                    <span className="badge" style={{ fontSize: 9, background: "var(--accent-dim)", color: "var(--accent-hover)", padding: "2px 6px" }}>PANEL</span>
                                                )}
                                            </div>
                                            <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: "3px 0 0" }}>
                                                {node.local ? "this VPS" : `${node.host}:${node.port}`}
                                            </p>
                                        </div>
                                        <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 11, padding: "3px 8px" }}>
                                            <span className="status-dot" style={{ background: s.color, width: 6, height: 6 }} />
                                            {s.label}
                                        </span>
                                    </div>

                                    {st ? (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            <UsageBar label="CPU" pct={st.cpu?.usagePercent} detail={st.cpu?.cores ? `${st.cpu.cores} cores` : null} />
                                            <UsageBar label="RAM" pct={st.memory?.usedPercent} detail={`${fmtGB(st.memory?.freeBytes)} free`} />
                                            <UsageBar label="Disk" pct={st.disk?.usedPercent} detail={`${fmtGB(st.disk?.freeBytes)} free`} />
                                        </div>
                                    ) : (
                                        <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>
                                            — No stats available —
                                        </div>
                                    )}

                                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)" }}>
                                        <span>{node.botCount} bot{node.botCount === 1 ? "" : "s"} on this node</span>
                                        {st?.processCount != null && <span>{st.processCount} PM2 processes</span>}
                                    </div>

                                    {testResult[node._id] && (
                                        <div style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--bg-input)", padding: "6px 10px", borderRadius: 6 }}>
                                            {testResult[node._id]}
                                        </div>
                                    )}
                                </div>

                                {!node.local && (
                                    <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border-light)", display: "flex", gap: 6, background: "rgba(0,0,0,0.15)" }}>
                                        <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => handleTest(node)}>Test</button>
                                        <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setModal({ node })}>Edit</button>
                                        <div style={{ flex: 1 }} />
                                        <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12, color: "var(--danger)" }} onClick={() => setConfirmDelete(node)}>Delete</button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {modal && (
                <NodeModal node={modal.node} onClose={() => setModal(null)} onSaved={fetchNodes} />
            )}

            {confirmDelete && (
                <ConfirmModal
                    title={`Delete node "${confirmDelete.name}"?`}
                    message="The node is only removed from the panel — the agent keeps running on the VPS. Nodes with bots on them cannot be deleted."
                    confirmText="Delete node"
                    onConfirm={handleDelete}
                    onCancel={() => setConfirmDelete(null)}
                />
            )}
        </div>
    );
}
