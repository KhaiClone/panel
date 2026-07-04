import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { useData } from "../context/DataContext";
import { nodeKey } from "../components/NodeFilter";

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};
const clamp = (v) => (Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 100) : 0);
const fmtUptime = (s) => {
    if (s == null) return "—";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

function Ring({ percent, color, label, sub }) {
    const pct = clamp(percent);
    const r = 52, size = 130;
    const circ = 2 * Math.PI * r;
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <div style={{ position: "relative", width: size, height: size }}>
                <svg width={size} height={size} style={{ transform: "rotate(-90deg)", filter: `drop-shadow(0 0 10px ${color}40)` }}>
                    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-input)" strokeWidth="10" />
                    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
                        style={{ strokeDasharray: circ, strokeDashoffset: circ - (pct / 100) * circ, transition: "stroke-dashoffset 0.8s ease" }} />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 26, fontWeight: 800, color: "var(--text)" }}>{pct}<span style={{ fontSize: 13 }}>%</span></span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{label}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{sub}</p>
            </div>
        </div>
    );
}

function InfoRow({ label, value, mono = true }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "9px 0", borderBottom: "1px solid var(--border-light)" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
            <span className={mono ? "mono" : ""} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value ?? "—"}</span>
        </div>
    );
}

const PROC_STATUS_COLOR = { online: "var(--success)", stopped: "var(--danger)", errored: "#F97316", launching: "var(--warning)" };

export default function NodeDetailPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { bots } = useData();

    const [node, setNode] = useState(null);       // from /api/nodes list
    const [info, setInfo] = useState(null);        // /self/info
    const [stats, setStats] = useState(null);      // live stats
    const [processes, setProcesses] = useState([]);
    const [logs, setLogs] = useState("");
    const [logLines, setLogLines] = useState(100);
    const [busy, setBusy] = useState(null);        // "restart" | "update" | null
    const [actionMsg, setActionMsg] = useState("");
    const [confirmAction, setConfirmAction] = useState(null);
    const [error, setError] = useState("");

    const nodeBots = bots.filter((b) => nodeKey(b) === id);

    const fetchAll = useCallback(async () => {
        try {
            const { data: nodes } = await api.get("/nodes");
            const found = nodes.find((n) => n._id === id);
            setNode(found || null);
            if (found) setStats(found.stats);
            if (!found) return;
        } catch { return; }

        api.get(`/nodes/${id}/info`).then((r) => { setInfo(r.data); setError(""); })
            .catch((e) => setError(e.response?.data?.error || "Agent unreachable"));
        api.get(`/nodes/${id}/processes`).then((r) => setProcesses(r.data.processes || [])).catch(() => {});
    }, [id]);

    const fetchLogs = useCallback(() => {
        api.get(`/nodes/${id}/logs`, { params: { lines: logLines } })
            .then((r) => setLogs(r.data.logs || ""))
            .catch((e) => setLogs(`(cannot fetch agent logs: ${e.response?.data?.error || e.message})`));
    }, [id, logLines]);

    useEffect(() => {
        fetchAll();
        fetchLogs();
        const int = setInterval(fetchAll, 10_000);
        return () => clearInterval(int);
    }, [fetchAll, fetchLogs]);

    const doRestart = async () => {
        setConfirmAction(null);
        setBusy("restart");
        setActionMsg("");
        try {
            await api.post(`/nodes/${id}/restart-agent`);
            setActionMsg("✅ Agent is restarting — it should be back within a few seconds.");
            setTimeout(fetchAll, 5000);
        } catch (e) {
            setActionMsg(`❌ ${e.response?.data?.error || e.message}`);
        } finally {
            setBusy(null);
        }
    };

    const doUpdate = async () => {
        setConfirmAction(null);
        setBusy("update");
        setActionMsg("");
        try {
            const { data } = await api.post(`/nodes/${id}/update-agent`, {}, { timeout: 420_000 });
            setActionMsg(`✅ ${data.message}\n${data.pullOutput || ""}`);
            setTimeout(fetchAll, 6000);
        } catch (e) {
            setActionMsg(`❌ ${e.response?.data?.error || e.message}`);
        } finally {
            setBusy(null);
        }
    };

    if (node === null) {
        return (
            <div className="page fade-in" style={{ maxWidth: 1100 }}>
                <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading node…</p>
            </div>
        );
    }

    const cpu = stats?.cpu?.usagePercent;
    const ram = stats?.memory?.usedPercent;
    const disk = stats?.disk?.usedPercent;
    const cpuColor = cpu > 80 ? "#ef4444" : cpu > 50 ? "#f59e0b" : "#10b981";
    const ramColor = ram > 80 ? "#ef4444" : ram > 50 ? "#f59e0b" : "#6366f1";
    const diskColor = disk > 85 ? "#ef4444" : disk > 65 ? "#f59e0b" : "#0ea5e9";
    const online = node.status === "online";

    return (
        <div className="page fade-in" style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Header */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <button onClick={() => navigate("/nodes")} className="btn-ghost" style={{ padding: 10, borderRadius: 12, background: "var(--bg-input)" }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 18, height: 18 }}><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>⬡ {node.name}</h1>
                        <span className="status-pill" style={{
                            background: online ? "var(--success-bg)" : "var(--danger-bg)",
                            border: `1px solid ${online ? "var(--success-border)" : "var(--danger-border)"}`,
                            color: online ? "var(--success)" : "var(--danger)", fontSize: 11, padding: "3px 10px",
                        }}>
                            <span className="status-dot" style={{ background: online ? "var(--success)" : "var(--danger)", width: 6, height: 6 }} />
                            {online ? "Online" : "Offline"}
                        </span>
                    </div>
                    <p className="mono" style={{ fontSize: 12, color: "var(--text-dim)", margin: "4px 0 0" }}>{node.host}:{node.port}</p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-warning" disabled={!online || busy} onClick={() => setConfirmAction("restart")} style={{ padding: "8px 16px", fontSize: 13 }}>
                        {busy === "restart" ? "Restarting…" : "Restart Agent"}
                    </button>
                    <button className="btn-primary" disabled={!online || busy} onClick={() => setConfirmAction("update")} style={{ padding: "8px 16px", fontSize: 13 }}>
                        {busy === "update" ? "Updating…" : "Update Agent"}
                    </button>
                </div>
            </div>

            {error && (
                <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>
            )}
            {actionMsg && (
                <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 13, whiteSpace: "pre-wrap" }}>{actionMsg}</div>
            )}

            {/* Resource rings */}
            <div className="card" style={{ padding: "26px 28px" }}>
                <h2 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 22px" }}>Resources</h2>
                {stats ? (
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-around", gap: 24 }}>
                        <Ring percent={cpu} color={cpuColor} label="CPU" sub={stats.cpu?.cores ? `${stats.cpu.cores} cores` : stats.cpu?.model} />
                        <Ring percent={ram} color={ramColor} label="RAM" sub={`${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`} />
                        <Ring percent={disk} color={diskColor} label="Disk" sub={`${fmt(stats.disk?.freeBytes)} free of ${fmt(stats.disk?.totalBytes)}`} />
                    </div>
                ) : (
                    <p style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", margin: 0 }}>No stats — node unreachable</p>
                )}
            </div>

            {/* Agent info + hosted bots */}
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div className="card" style={{ padding: "20px 24px" }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px" }}>Agent</h3>
                    <InfoRow label="Version" value={info ? `v${info.agentVersion}` : null} />
                    <InfoRow label="Status (PM2)" value={info?.live?.status} />
                    <InfoRow label="Agent uptime" value={info ? fmtUptime(info.agentUptime) : null} />
                    <InfoRow label="System uptime" value={info ? fmtUptime(info.systemUptime) : null} />
                    <InfoRow label="Node.js" value={info?.nodeVersion} />
                    <InfoRow label="OS" value={info?.platform} mono={false} />
                    <InfoRow label="Hostname" value={info?.hostname} />
                    <InfoRow label="Git" value={info?.commit ? `${info.branch} @ ${info.commit}` : null} />
                    <InfoRow label="Bots dir" value={info?.config?.botsRootDir} />
                    <InfoRow label="Sites dir" value={info?.config?.sitesRootDir} />
                    <InfoRow label="Agent RAM" value={info?.live?.memory ? `${Math.round(info.live.memory / 1_048_576)} MB` : null} />
                </div>

                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>PM2 Processes ({processes.length})</h3>
                        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{nodeBots.length} managed by panel</span>
                    </div>
                    <div style={{ maxHeight: 420, overflowY: "auto" }}>
                        {processes.map((p) => {
                            const st = p.pm2_env?.status;
                            const managed = bots.find((b) => b.pm2Name === p.name && nodeKey(b) === id);
                            return (
                                <div key={p.pm_id}
                                    onClick={managed ? () => navigate(`/${managed.projectType === "website" ? "sites" : "bots"}/${managed._id}`) : undefined}
                                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 20px", borderBottom: "1px solid var(--border-light)", cursor: managed ? "pointer" : "default" }}
                                    onMouseEnter={(e) => managed && (e.currentTarget.style.background = "rgba(255,255,255,0.03)")}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                                >
                                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: PROC_STATUS_COLOR[st] || "var(--text-dim)", flexShrink: 0 }} />
                                    <span className="mono" style={{ flex: 1, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                                    {managed && <span className="badge" style={{ fontSize: 9, background: "var(--accent-dim)", color: "var(--accent-hover)", padding: "1px 6px" }}>PANEL</span>}
                                    <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{Math.round((p.monit?.memory || 0) / 1_048_576)} MB</span>
                                    <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", width: 42, textAlign: "right", flexShrink: 0 }}>{p.monit?.cpu ?? 0}%</span>
                                </div>
                            );
                        })}
                        {processes.length === 0 && (
                            <div style={{ padding: "28px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No PM2 processes</div>
                        )}
                    </div>
                </div>
            </div>

            {/* Agent logs */}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "center", gap: 12 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0, flex: 1 }}>Agent Logs</h3>
                    <select className="input" style={{ width: 110, padding: "5px 10px", fontSize: 12 }} value={logLines} onChange={(e) => setLogLines(parseInt(e.target.value))}>
                        {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} lines</option>)}
                    </select>
                    <button className="btn-ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={fetchLogs}>Refresh</button>
                </div>
                <pre className="mono" style={{ margin: 0, padding: "14px 20px", fontSize: 11.5, lineHeight: 1.6, color: "var(--text-muted)", background: "rgba(0,0,0,0.25)", maxHeight: 380, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {logs || "(empty)"}
                </pre>
            </div>

            {confirmAction === "restart" && (
                <ConfirmModal
                    title={`Restart agent on "${node.name}"?`}
                    message="Bots on this node keep running — only the agent process restarts. The node will show offline for a few seconds."
                    confirmText="Restart agent"
                    onConfirm={doRestart}
                    onCancel={() => setConfirmAction(null)}
                />
            )}
            {confirmAction === "update" && (
                <ConfirmModal
                    title={`Update agent on "${node.name}"?`}
                    message="Runs git pull + npm install in the agent folder, then restarts the agent. Bots on the node are not touched."
                    confirmText="Update agent"
                    onConfirm={doUpdate}
                    onCancel={() => setConfirmAction(null)}
                />
            )}
        </div>
    );
}
