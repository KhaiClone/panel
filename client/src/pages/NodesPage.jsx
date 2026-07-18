import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { useData } from "../context/DataContext";
import { useNode } from "../context/NodeContext";
import { nodeKey } from "../components/NodeFilter";

// ── Formatters ───────────────────────────────────────────────────────────────
const fmtGB = (bytes) => (bytes == null ? "—" : `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`);
const fmtNet = (bps) => {
    if (bps == null) return "—";
    if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
    if (bps >= 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
    return `${Math.round(bps)} B/s`;
};
const fmtUptime = (sec) => {
    if (sec == null) return "—";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

const STATUS_STYLES = {
    online:   { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    offline:  { color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)",  label: "Offline" },
    disabled: { color: "var(--text-dim)", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", label: "Disabled" },
    unknown:  { color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)", label: "Checking…" },
};

const TYPE_ICON = { discord: "🤖", website: "🌐", service: "⚙️" };

// ── Fleet summary tiles ──────────────────────────────────────────────────────
function SummaryTile({ label, value, sub, color = "var(--accent)", icon }) {
    return (
        <div className="card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -14, right: -8, width: 60, height: 60, background: color, opacity: 0.07, filter: "blur(16px)", borderRadius: "50%" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
                {icon && <span style={{ fontSize: 15 }}>{icon}</span>}
            </div>
            <span style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>{value}</span>
            {sub && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{sub}</span>}
        </div>
    );
}

// ── Small spec row (label · value) ───────────────────────────────────────────
function Spec({ label, value, mono }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span style={{ fontSize: 9.5, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
            <span className={mono ? "mono" : ""} style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
        </div>
    );
}

function NodeBotList({ nodeBots, navigate }) {
    const MAX_ROWS = 6;
    return (
        <div style={{ borderTop: "1px solid var(--border-light)" }}>
            {nodeBots.slice(0, MAX_ROWS).map((bot) => {
                const isOnline = bot.live?.status === "online";
                const ramMB = bot.live?.memory ? Math.round(bot.live.memory / 1_048_576) : 0;
                return (
                    <div
                        key={bot._id}
                        onClick={() => navigate(`/${bot.projectType === "website" ? "sites" : "bots"}/${bot._id}`)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 18px", borderBottom: "1px solid var(--border-light)", cursor: "pointer", transition: "background 0.15s" }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                        <span style={{ fontSize: 14, flexShrink: 0 }}>{TYPE_ICON[bot.projectType] || "📦"}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bot.name}</p>
                            <p className="mono" style={{ margin: 0, fontSize: 10, color: "var(--text-dim)" }}>{bot.buyerID}</p>
                        </div>
                        {isOnline && ramMB > 0 && (
                            <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>{ramMB} MB</span>
                        )}
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: isOnline ? "var(--success)" : "var(--danger)", flexShrink: 0 }} />
                    </div>
                );
            })}
            {nodeBots.length > MAX_ROWS && (
                <div style={{ padding: "8px 18px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
                    +{nodeBots.length - MAX_ROWS} more…
                </div>
            )}
        </div>
    );
}

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
            <div className="card slide-up modal-card-mobile" style={{ width: "100%", maxWidth: 480, padding: 0 }}>
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
    const navigate = useNavigate();
    const { bots } = useData();
    const { nodeId: viewNode, setNode } = useNode();
    const [nodes, setNodes] = useState([]);
    const [infos, setInfos] = useState({}); // nodeId → agent /self/info
    const [loading, setLoading] = useState(true);
    const [modal, setModal] = useState(null); // null | { node } | { node: null } for create
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [testResult, setTestResult] = useState({}); // nodeId → message
    const [expanded, setExpanded] = useState({}); // nodeId → bool (bot list open)

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

    // Enrich remote online nodes with the agent's self-description (version, OS,
    // uptime…) — slower cadence than stats since /self/info runs git + pm2.
    const remoteOnlineIds = nodes.filter((n) => !n.local && n.status === "online").map((n) => n._id).join(",");
    useEffect(() => {
        if (!remoteOnlineIds) return;
        const ids = remoteOnlineIds.split(",");
        const load = () => ids.forEach((id) =>
            api.get(`/nodes/${id}/info`).then((r) => setInfos((p) => ({ ...p, [id]: r.data }))).catch(() => {}),
        );
        load();
        const int = setInterval(load, 30_000);
        return () => clearInterval(int);
    }, [remoteOnlineIds]);

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

    // ── Fleet aggregates ──────────────────────────────────────────────────────
    const online = nodes.filter((n) => n.status === "online").length;
    const withStats = nodes.filter((n) => n.stats);
    const totalBots = nodes.reduce((a, n) => a + (n.botCount || 0), 0);
    const totalProc = withStats.reduce((a, n) => a + (n.stats.processCount || 0), 0);
    const ramUsed = withStats.reduce((a, n) => a + (n.stats.memory?.usedBytes || 0), 0);
    const ramTotal = withStats.reduce((a, n) => a + (n.stats.memory?.totalBytes || 0), 0);
    const avgCpu = withStats.length
        ? Math.round(withStats.reduce((a, n) => a + (n.stats.cpu?.usagePercent || 0), 0) / withStats.length)
        : null;

    return (
        <div className="page fade-in" style={{ maxWidth: 1280, display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: "-0.02em" }}>Fleet</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Worker VPS across your infrastructure — live health, specs, and the projects running on each.
                    </p>
                </div>
                <button className="btn-primary" onClick={() => setModal({ node: null })}>+ Add Node</button>
            </div>

            {/* ── Fleet summary ── */}
            {!loading && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
                    <SummaryTile label="Nodes"     value={nodes.length} sub={`${online} online`} color="var(--accent)" icon="🖥️" />
                    <SummaryTile label="Projects"  value={totalBots}    sub="across fleet"       color="#5865F2" icon="📦" />
                    <SummaryTile label="Processes" value={totalProc}    sub="PM2 managed"        color="#a78bfa" icon="⚙️" />
                    <SummaryTile label="Fleet RAM" value={fmtGB(ramUsed)} sub={`of ${fmtGB(ramTotal)} used`} color="#60A5FA" icon="🧠" />
                    <SummaryTile label="Avg CPU"   value={avgCpu != null ? `${avgCpu}%` : "—"} sub="mean load" color={avgCpu > 70 ? "var(--danger)" : "var(--success)"} icon="📈" />
                </div>
            )}

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 16 }}>
                    {nodes.map((node) => {
                        const s = STATUS_STYLES[node.status] || STATUS_STYLES.unknown;
                        const st = node.stats;
                        const info = infos[node._id];
                        const nodeBots = bots.filter((b) => nodeKey(b) === node._id);
                        const isOpen = !!expanded[node._id];
                        const isViewing = viewNode === node._id;
                        return (
                            <div key={node._id} className="card" style={{ padding: 0, overflow: "hidden", border: isViewing ? "1px solid var(--accent)" : undefined }}>
                                <div style={{ height: 3, background: `linear-gradient(90deg, ${s.color}, transparent)` }} />
                                <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
                                    {/* Header */}
                                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                                <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{node.name}</h3>
                                                {node.local && (
                                                    <span className="badge" style={{ fontSize: 9, background: "var(--accent-dim)", color: "var(--accent-hover)", padding: "2px 6px" }}>PANEL</span>
                                                )}
                                                {isViewing && (
                                                    <span className="badge" style={{ fontSize: 9, background: "var(--success-bg)", color: "var(--success)", padding: "2px 6px", border: "1px solid var(--success-border)" }}>VIEWING</span>
                                                )}
                                                {!node.enabled && !node.local && (
                                                    <span className="badge" style={{ fontSize: 9, background: "rgba(255,255,255,0.06)", color: "var(--text-dim)", padding: "2px 6px" }}>DISABLED</span>
                                                )}
                                            </div>
                                            <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: "3px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                {node.local ? "this VPS" : `${node.host}:${node.port}`}
                                                {info?.hostname ? ` · ${info.hostname}` : ""}
                                            </p>
                                        </div>
                                        <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 11, padding: "3px 8px", flexShrink: 0 }}>
                                            <span className="status-dot" style={{ background: s.color, width: 6, height: 6 }} />
                                            {s.label}
                                        </span>
                                    </div>

                                    {/* Resource bars */}
                                    {st ? (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                            <UsageBar label="CPU" pct={st.cpu?.usagePercent} detail={st.cpu?.cores ? `${st.cpu.cores} cores` : null} />
                                            <UsageBar label="RAM" pct={st.memory?.usedPercent} detail={`${fmtGB(st.memory?.usedBytes)}/${fmtGB(st.memory?.totalBytes)}`} />
                                            <UsageBar label="Disk" pct={st.disk?.usedPercent} detail={`${fmtGB(st.disk?.freeBytes)} free`} />
                                        </div>
                                    ) : (
                                        <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", padding: "10px 0" }}>
                                            — No stats available —
                                        </div>
                                    )}

                                    {/* Specs grid */}
                                    {st && (
                                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px", paddingTop: 4, borderTop: "1px solid var(--border-light)" }}>
                                            {st.cpu?.model && <div style={{ gridColumn: "1 / -1" }}><Spec label="Processor" value={st.cpu.model} /></div>}
                                            <Spec label="Network" value={st.network ? `↓ ${fmtNet(st.network.rxBytesPerSec)}  ↑ ${fmtNet(st.network.txBytesPerSec)}` : "—"} mono />
                                            <Spec label="Disk mount" value={st.disk ? `${st.disk.mount || "/"} (${st.disk.fs || "—"})` : "—"} mono />
                                            <Spec label="Uptime" value={fmtUptime(st.uptime ?? info?.systemUptime)} />
                                            <Spec label="Agent" value={info ? `v${info.agentVersion}` : (node.local ? "panel" : "—")} mono />
                                            {info?.platform && <Spec label="OS" value={info.platform} />}
                                            {info?.nodeVersion && <Spec label="Node.js" value={info.nodeVersion} mono />}
                                        </div>
                                    )}

                                    {/* Counts row */}
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "var(--text-muted)" }}>
                                        <button
                                            onClick={() => setExpanded((e) => ({ ...e, [node._id]: !isOpen }))}
                                            disabled={nodeBots.length === 0}
                                            style={{ background: "none", border: "none", padding: 0, cursor: nodeBots.length ? "pointer" : "default", color: nodeBots.length ? "var(--accent-hover)" : "var(--text-muted)", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}
                                        >
                                            {nodeBots.length > 0 && (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 10, height: 10, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
                                                    <polyline points="9 18 15 12 9 6" />
                                                </svg>
                                            )}
                                            {node.botCount} project{node.botCount === 1 ? "" : "s"}
                                        </button>
                                        {st?.processCount != null && <span>{st.processCount} PM2 processes</span>}
                                    </div>

                                    {testResult[node._id] && (
                                        <div style={{ fontSize: 12, color: "var(--text-muted)", background: "var(--bg-input)", padding: "6px 10px", borderRadius: 6 }}>
                                            {testResult[node._id]}
                                        </div>
                                    )}
                                </div>

                                {isOpen && nodeBots.length > 0 && (
                                    <>
                                        <NodeBotList nodeBots={nodeBots} navigate={navigate} />
                                        <div style={{ display: "flex", gap: 8, padding: "8px 18px", justifyContent: "center" }}>
                                            <button className="btn-ghost" style={{ padding: "4px 12px", fontSize: 11 }} onClick={() => navigate(`/bots?node=${node._id}`)}>
                                                View in Bots →
                                            </button>
                                            {nodeBots.some((b) => b.projectType === "website") && (
                                                <button className="btn-ghost" style={{ padding: "4px 12px", fontSize: 11 }} onClick={() => navigate(`/sites?node=${node._id}`)}>
                                                    View in Sites →
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}

                                {/* Action bar */}
                                <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border-light)", display: "flex", gap: 6, background: "rgba(0,0,0,0.15)", flexWrap: "wrap" }}>
                                    {node.status === "online" && (
                                        <button
                                            className="btn-ghost"
                                            style={{ padding: "5px 12px", fontSize: 12, color: isViewing ? "var(--success)" : "var(--accent-hover)" }}
                                            onClick={() => setNode(isViewing ? "local" : node._id)}
                                            title="Point the whole panel at this node's data"
                                        >
                                            {isViewing ? "✓ Viewing" : "Remote view"}
                                        </button>
                                    )}
                                    {!node.local && (
                                        <>
                                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => navigate(`/nodes/${node._id}`)}>Details</button>
                                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => handleTest(node)}>Test</button>
                                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => setModal({ node })}>Edit</button>
                                            <div style={{ flex: 1 }} />
                                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12, color: "var(--danger)" }} onClick={() => setConfirmDelete(node)}>Delete</button>
                                        </>
                                    )}
                                </div>
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
