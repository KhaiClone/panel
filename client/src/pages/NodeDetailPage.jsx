import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import NodeMetrics from "../components/NodeMetrics";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import NodeModal from "../components/NodeModal";
import RemoveNodeModal from "../components/RemoveNodeModal";
import LogRotateSection from "../components/LogRotateSection";
import Section from "./panel/Section";
import { DataTable, Icon, Notice, PageHeader, StatusBadge } from "../components/ui";

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
                <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
                    <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="10" style={{ stroke: "var(--bg-input)" }} />
                    <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="10" strokeLinecap="round"
                        style={{ stroke: color, strokeDasharray: circ, strokeDashoffset: circ - (pct / 100) * circ, transition: "stroke-dashoffset 0.8s ease" }} />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 26, fontWeight: 600, color: "var(--text)" }}>{pct}<span style={{ fontSize: 13 }}>%</span></span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{label}</p>
                <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{sub}</p>
            </div>
        </div>
    );
}

function InfoRow({ label, value, mono = true }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "9px 0", borderBottom: "1px solid var(--border-light)" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
            <span className={mono ? "mono" : ""} style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value ?? "—"}</span>
        </div>
    );
}

// PM2 states, coloured as on the Bots page.
const PROC_STATUS_COLOR = { online: "var(--success)", stopped: "var(--text-dim)", errored: "var(--danger)", launching: "var(--warning)" };

export default function NodeDetailPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    // Bots are fetched for THIS node explicitly rather than read from
    // DataContext: that list is scoped by the header switcher, so viewing
    // node A while opening node B's page would show an empty B.
    const [bots, setBots] = useState([]);

    const [node, setNode] = useState(null);       // from /api/nodes list
    const [info, setInfo] = useState(null);        // /self/info
    const [stats, setStats] = useState(null);      // live stats
    const [processes, setProcesses] = useState([]);
    const [logs, setLogs] = useState("");
    const [logLines, setLogLines] = useState(100);
    const [busy, setBusy] = useState(null);        // "restart" | "update" | null
    const [actionMsg, setActionMsg] = useState(null); // { tone: "success" | "danger", text }
    const [confirmAction, setConfirmAction] = useState(null);
    const [error, setError] = useState("");
    const [tab, setTab] = useState("Metrics");
    const [editOpen, setEditOpen] = useState(false);
    // The node as it was when Remove was pressed: the modal outlives it — once
    // removed it is gone from /api/nodes while the modal follows the clean-up.
    const [removing, setRemoving] = useState(null);
    const [testMsg, setTestMsg] = useState("");

    const nodeBots = bots;

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

        // Pin the request to THIS node. The axios interceptor only fills in
        // X-Panel-Node when it is absent, so passing it explicitly overrides
        // whatever the header switcher is currently pointing at.
        api.get("/bots", { headers: { "X-Panel-Node": id } })
            .then((r) => setBots(r.data))
            .catch(() => setBots([]));
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

    const doTest = async () => {
        setTestMsg("Testing…");
        try {
            const { data } = await api.post(`/nodes/${id}/test`);
            setTestMsg(data.message || (data.ok ? "Agent reachable." : "Agent did not answer."));
        } catch (err) {
            setTestMsg(err.response?.data?.error || "Agent did not answer.");
        }
    };

    const doRestart = async () => {
        setConfirmAction(null);
        setBusy("restart");
        setActionMsg(null);
        try {
            await api.post(`/nodes/${id}/restart-agent`);
            setActionMsg({ tone: "success", text: "Agent is restarting — it should be back within a few seconds." });
            setTimeout(fetchAll, 5000);
        } catch (e) {
            setActionMsg({ tone: "danger", text: e.response?.data?.error || e.message });
        } finally {
            setBusy(null);
        }
    };

    const doUpdate = async () => {
        setConfirmAction(null);
        setBusy("update");
        setActionMsg(null);
        try {
            const { data } = await api.post(`/nodes/${id}/update-agent`, {}, { timeout: 420_000 });
            setActionMsg({ tone: "success", text: `${data.message}\n${data.pullOutput || ""}` });
            setTimeout(fetchAll, 6000);
        } catch (e) {
            setActionMsg({ tone: "danger", text: e.response?.data?.error || e.message });
        } finally {
            setBusy(null);
        }
    };

    const removeModal = removing && (
        <RemoveNodeModal
            node={removing}
            onClose={() => setRemoving(null)}
            onRemoved={() => navigate("/systems")}
            onOpenProject={navigate}
        />
    );

    if (node === null) {
        return (
            <div className="page fade-in" style={{ maxWidth: 1100 }}>
                <p style={{ color: "var(--text-muted)", fontSize: 14 }}>{removing ? "Node removed." : "Loading node…"}</p>
                {removeModal}
            </div>
        );
    }

    const cpu = stats?.cpu?.usagePercent;
    const ram = stats?.memory?.usedPercent;
    const disk = stats?.disk?.usedPercent;
    const cpuColor = cpu > 80 ? "var(--danger)" : cpu > 50 ? "var(--warning)" : "var(--success)";
    const ramColor = ram > 80 ? "var(--danger)" : ram > 50 ? "var(--warning)" : "var(--accent)";
    const diskColor = disk > 85 ? "var(--danger)" : disk > 65 ? "var(--warning)" : "var(--info)";
    const online = node.status === "online";

    return (
        <div className="page fade-in" style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <button onClick={() => navigate("/systems")} className="btn-ghost btn-icon" title="Back to Servers" style={{ marginTop: 1 }}>
                    <Icon name="chevronLeft" />
                </button>
                <div className="min-w-0" style={{ flex: 1 }}>
                    <PageHeader
                        title={node.name}
                        description={
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <StatusBadge tone={online ? "success" : "danger"}>{online ? "Online" : "Offline"}</StatusBadge>
                                <span className="mono" style={{ color: "var(--text-dim)" }}>{node.host}:{node.port}</span>
                            </span>
                        }
                        actions={
                            <>
                                <button className="btn-warning" disabled={!online || busy} onClick={() => setConfirmAction("restart")}>
                                    <Icon name="restart" /> {busy === "restart" ? "Restarting…" : "Restart agent"}
                                </button>
                                <button className="btn-ghost" onClick={doTest}>
                                    <Icon name="activity" /> Test
                                </button>
                                <button className="btn-ghost" onClick={() => setEditOpen(true)}>
                                    <Icon name="pencil" /> Edit
                                </button>
                                <button className="btn-ghost is-danger" onClick={() => setRemoving(node)}>
                                    <Icon name="trash" /> Remove
                                </button>
                                <button className="btn-primary" disabled={!online || busy} onClick={() => setConfirmAction("update")}>
                                    <Icon name="download" /> {busy === "update" ? "Updating…" : "Update agent"}
                                </button>
                            </>
                        }
                    />
                </div>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {testMsg && <Notice tone="info">{testMsg}</Notice>}
            {actionMsg && (
                <Notice tone={actionMsg.tone}>
                    <span style={{ whiteSpace: "pre-wrap" }}>{actionMsg.text}</span>
                </Notice>
            )}

            <div className="tab-bar" style={{ alignSelf: "flex-start", maxWidth: "100%" }}>
                {["Metrics", "Manage"].map((t) => (
                    <button key={t} className={`tab-item ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
                        {t}
                    </button>
                ))}
            </div>

            {tab === "Metrics" && <NodeMetrics nodeId={id} bots={nodeBots} />}

            {tab === "Manage" && (
            <>
            {/* Resource rings */}
            <Section title="Resources">
                {stats ? (
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-around", gap: 24, padding: "8px 0" }}>
                        <Ring percent={cpu} color={cpuColor} label="CPU" sub={stats.cpu?.cores ? `${stats.cpu.cores} cores` : stats.cpu?.model} />
                        <Ring percent={ram} color={ramColor} label="RAM" sub={`${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`} />
                        <Ring percent={disk} color={diskColor} label="Disk" sub={`${fmt(stats.disk?.freeBytes)} free of ${fmt(stats.disk?.totalBytes)}`} />
                    </div>
                ) : (
                    <p style={{ fontSize: 13, color: "var(--text-dim)", textAlign: "center", margin: 0 }}>No stats — node unreachable</p>
                )}
            </Section>

            {/* Agent info + hosted bots */}
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <Section title="Agent">
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
                </Section>

                <Section
                    title="PM2 processes"
                    hint={String(processes.length)}
                    actions={<span style={{ fontSize: 12, color: "var(--text-dim)" }}>{nodeBots.length} managed by panel</span>}
                    flush
                >
                    <div style={{ maxHeight: 420, overflowY: "auto" }}>
                        <DataTable flush columns={["Process", { label: "Memory", align: "right" }, { label: "CPU", align: "right" }]}>
                            {processes.map((p) => {
                                const st = p.pm2_env?.status;
                                // `bots` is already scoped to this node, so matching on pm2Name is enough.
                                const managed = bots.find((b) => b.pm2Name === p.name);
                                return (
                                    <tr key={p.pm_id}
                                        className={managed ? "row-click" : undefined}
                                        onClick={managed ? () => navigate(`/${managed.projectType === "website" ? "sites" : "bots"}/${managed._id}`) : undefined}
                                    >
                                        <td>
                                            <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                                                <span className="status-dot" style={{ background: PROC_STATUS_COLOR[st] || "var(--text-dim)" }} title={st} />
                                                <span className="mono" style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                                                {managed && (
                                                    <span className="badge" style={{ background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>panel</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="mono num" style={{ fontSize: 11, color: "var(--text-muted)" }}>{Math.round((p.monit?.memory || 0) / 1_048_576)} MB</td>
                                        <td className="mono num" style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.monit?.cpu ?? 0}%</td>
                                    </tr>
                                );
                            })}
                            {processes.length === 0 && (
                                <tr><td colSpan={3} style={{ padding: 28, textAlign: "center", color: "var(--text-dim)" }}>No PM2 processes</td></tr>
                            )}
                        </DataTable>
                    </div>
                </Section>
            </div>

            {/* pm2-logrotate — each node rotates its own PM2 logs */}
            <Section title="Log rotation" hint="pm2-logrotate — keeps PM2 logs from filling the disk">
                <LogRotateSection key={id} nodeId={id} />
            </Section>

            {/* Agent logs */}
            <Section
                title="Agent logs"
                flush
                actions={
                    <>
                        <select className="input" style={{ width: 110, padding: "5px 10px", fontSize: 12 }} value={logLines} onChange={(e) => setLogLines(parseInt(e.target.value))}>
                            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} lines</option>)}
                        </select>
                        <button className="btn-ghost btn-sm" onClick={fetchLogs}>
                            <Icon name="refresh" size={14} /> Refresh
                        </button>
                    </>
                }
            >
                <pre className="mono" style={{ margin: 0, padding: "14px 16px", fontSize: 11.5, lineHeight: 1.6, color: "var(--text-muted)", background: "var(--bg-base)", maxHeight: 380, overflowY: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {logs || "(empty)"}
                </pre>
            </Section>
            </>
            )}

            {/* Modals live outside the tab switch: their buttons are in the
                header, which shows on every tab. */}
            {editOpen && (
                <NodeModal node={node} onClose={() => setEditOpen(false)} onSaved={fetchAll} />
            )}

            {removeModal}

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
