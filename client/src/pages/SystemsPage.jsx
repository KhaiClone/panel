import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import Sparkline from "../components/Sparkline";
import NodeModal from "../components/NodeModal";
import { fmtBytes, fmtPercent } from "../components/MetricChart";

// ─────────────────────────────────────────────────────────────────────────────
//  Systems — every VPS side by side, one row each.
//
//  Live values come from /api/nodes (which already carries each node's stats),
//  the trend behind them from /api/nodes/history in a single request for all
//  nodes. Clicking a row opens that node's detail page.
// ─────────────────────────────────────────────────────────────────────────────

const RANGES = [
    { key: "1h", label: "1H" },
    { key: "6h", label: "6H" },
    { key: "24h", label: "24H" },
    { key: "7d", label: "7D" },
    { key: "30d", label: "30D" },
];

const LIVE_POLL_MS = 8000;
const HISTORY_POLL_MS = 60_000;

const barColor = (pct) =>
    pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--warning)" : "var(--success)";

const fmtUptime = (s) => {
    if (!Number.isFinite(s)) return "—";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/** A percentage cell: number, bar, and the trend behind it. */
function MetricCell({ percent, points, width = 96 }) {
    const pct = Number.isFinite(percent) ? percent : null;
    const color = pct === null ? "var(--text-dim)" : barColor(pct);
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 46 }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: 600, color }}>
                    {pct === null ? "—" : fmtPercent(pct)}
                </div>
                <div style={{ height: 3, borderRadius: 2, background: "var(--bg-input)", marginTop: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, height: "100%", background: color, transition: "width .4s ease" }} />
                </div>
            </div>
            <Sparkline values={points} color={color} width={width} height={26} range={[0, 100]} />
        </div>
    );
}

function StatTile({ label, value, sub, color = "var(--text)" }) {
    return (
        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--text-muted)", fontWeight: 600 }}>
                {label}
            </span>
            <span className="mono" style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{value}</span>
            {sub && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{sub}</span>}
        </div>
    );
}

export default function SystemsPage() {
    const navigate = useNavigate();
    const [nodes, setNodes] = useState([]);
    const [hist, setHist] = useState({});
    const [range, setRange] = useState("6h");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [addOpen, setAddOpen] = useState(false);
    const [wg, setWg] = useState({ busy: false, msg: null });

    const loadNodes = useCallback(async () => {
        try {
            const { data } = await api.get("/nodes");
            setNodes(data);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || "Could not load nodes");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadHistory = useCallback(async (r) => {
        try {
            const { data } = await api.get("/nodes/history", { params: { range: r } });
            setHist(data.nodes || {});
        } catch { /* sparklines are decoration — a failure must not blank the page */ }
    }, []);

    useEffect(() => {
        loadNodes();
        const t = setInterval(loadNodes, LIVE_POLL_MS);
        return () => clearInterval(t);
    }, [loadNodes]);

    // Recompute the WireGuard mesh and push it to every node. A whole-fleet
    // action, so it belongs on the fleet view rather than on one node's page.
    const syncWg = async () => {
        setWg({ busy: true, msg: null });
        try {
            const { data } = await api.post("/nodes/wg/sync");
            const okCount = (data.results || []).filter((r) => r.ok).length;
            const failed = (data.results || []).filter((r) => !r.ok);
            setWg({
                busy: false,
                msg: failed.length
                    ? `${okCount} synced, ${failed.length} failed: ${failed.map((f) => `${f.node} (${f.error})`).join("; ")}`
                    : `Mesh synced to ${okCount} node${okCount === 1 ? "" : "s"}.`,
            });
        } catch (err) {
            setWg({ busy: false, msg: err.response?.data?.error || "WireGuard sync failed" });
        }
    };

    useEffect(() => {
        loadHistory(range);
        const t = setInterval(() => loadHistory(range), HISTORY_POLL_MS);
        return () => clearInterval(t);
    }, [range, loadHistory]);

    // Totals are computed from real byte counts, not by averaging percentages:
    // averaging would weigh a 4GB node the same as a 31GB one.
    const totals = useMemo(() => {
        const online = nodes.filter((n) => n.status === "online" && n.stats);
        const sum = (pick) => online.reduce((acc, n) => acc + (pick(n.stats) || 0), 0);
        const ramTotal = sum((s) => s.memory?.totalBytes);
        const ramUsed = sum((s) => s.memory?.usedBytes);
        const diskTotal = sum((s) => s.disk?.totalBytes);
        const diskUsed = sum((s) => s.disk?.usedBytes);
        const cores = sum((s) => s.cpu?.cores) || online.length;
        const cpuWeighted = online.reduce((a, n) => a + (n.stats.cpu?.usagePercent || 0) * (n.stats.cpu?.cores || 1), 0);
        return {
            nodesOnline: online.length,
            nodesTotal: nodes.length,
            bots: nodes.reduce((a, n) => a + (n.botCount || 0), 0),
            cpu: cores ? cpuWeighted / cores : null,
            ram: ramTotal ? (ramUsed / ramTotal) * 100 : null,
            ramText: ramTotal ? `${fmtBytes(ramUsed)} / ${fmtBytes(ramTotal)}` : null,
            disk: diskTotal ? (diskUsed / diskTotal) * 100 : null,
            diskText: diskTotal ? `${fmtBytes(diskUsed)} / ${fmtBytes(diskTotal)}` : null,
        };
    }, [nodes]);

    return (
        <div className="page fade-in">
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
                <div className="min-w-0">
                    <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Systems</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "6px 0 0" }}>
                        Every VPS the panel manages. Select one to see its full history.
                    </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={syncWg} disabled={wg.busy}>
                    {wg.busy ? "Syncing…" : "Sync WireGuard"}
                </button>
                <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setAddOpen(true)}>
                    + Add node
                </button>
                <div className="tab-bar" style={{ display: "flex", gap: 4 }}>
                    {RANGES.map((r) => (
                        <button
                            key={r.key}
                            className={`tab-item${range === r.key ? " active" : ""}`}
                            style={{ fontSize: 12, padding: "5px 12px" }}
                            onClick={() => setRange(r.key)}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
                </div>
            </div>

            {wg.msg && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 13, marginBottom: 16 }}>
                    {wg.msg}
                </div>
            )}

            {error && (
                <div style={{ padding: "10px 14px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13, marginBottom: 16 }}>
                    {error}
                </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
                <StatTile
                    label="Nodes"
                    value={`${totals.nodesOnline}/${totals.nodesTotal}`}
                    sub="online"
                    color={totals.nodesOnline === totals.nodesTotal ? "var(--success)" : "var(--warning)"}
                />
                <StatTile label="Projects" value={totals.bots} sub="across all nodes" />
                <StatTile label="CPU" value={totals.cpu === null ? "—" : fmtPercent(totals.cpu)} sub="weighted by cores" color={totals.cpu === null ? "var(--text)" : barColor(totals.cpu)} />
                <StatTile label="Memory" value={totals.ram === null ? "—" : fmtPercent(totals.ram)} sub={totals.ramText} color={totals.ram === null ? "var(--text)" : barColor(totals.ram)} />
                <StatTile label="Disk" value={totals.disk === null ? "—" : fmtPercent(totals.disk)} sub={totals.diskText} color={totals.disk === null ? "var(--text)" : barColor(totals.disk)} />
            </div>

            <div className="card" style={{ padding: 0, overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: 880, borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                        <tr style={{ borderBottom: "1px solid var(--border)" }}>
                            {["System", "CPU", "Memory", "Disk", "Network", "Uptime", "Projects"].map((h, i) => (
                                <th
                                    key={h}
                                    style={{
                                        textAlign: i === 0 ? "left" : "left",
                                        padding: "11px 16px",
                                        fontSize: 11,
                                        fontWeight: 600,
                                        letterSpacing: ".08em",
                                        textTransform: "uppercase",
                                        color: "var(--text-muted)",
                                        whiteSpace: "nowrap",
                                    }}
                                >
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {loading && (
                            <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: "var(--text-muted)" }}>Loading…</td></tr>
                        )}
                        {!loading && nodes.length === 0 && (
                            <tr><td colSpan={7} style={{ padding: 28, textAlign: "center", color: "var(--text-muted)" }}>No nodes registered yet.</td></tr>
                        )}
                        {nodes.map((n) => {
                            const h = hist[n._id] || {};
                            const s = n.stats;
                            const offline = n.status !== "online";
                            const dot = offline ? (n.status === "disabled" ? "var(--text-dim)" : "var(--danger)") : "var(--success)";
                            return (
                                <tr
                                    key={n._id}
                                    onClick={() => navigate(`/nodes/${n._id}`)}
                                    style={{ borderBottom: "1px solid var(--border)", cursor: "pointer", opacity: offline ? 0.55 : 1 }}
                                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-input)")}
                                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                                >
                                    <td style={{ padding: "13px 16px" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: offline ? "none" : "0 0 8px var(--success)" }} />
                                            <div className="min-w-0">
                                                <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                                                    {n.name}
                                                    {n.isPanelNode && (
                                                        <span className="badge" style={{ marginLeft: 8, fontSize: 10 }}>panel</span>
                                                    )}
                                                </div>
                                                <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                                    {offline ? n.status : (s?.cpu?.model ? String(s.cpu.model).slice(0, 34) : n.host)}
                                                </div>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={{ padding: "13px 16px" }}><MetricCell percent={s?.cpu?.usagePercent} points={h.cpu} /></td>
                                    <td style={{ padding: "13px 16px" }}><MetricCell percent={s?.memory?.usedPercent} points={h.ram} /></td>
                                    <td style={{ padding: "13px 16px" }}><MetricCell percent={s?.disk?.usedPercent} points={h.disk} /></td>
                                    <td className="mono" style={{ padding: "13px 16px", fontSize: 12, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                                        {s?.network ? (
                                            <>
                                                <div style={{ color: "var(--success)" }}>↓ {fmtBytes(s.network.rxBytesPerSec)}/s</div>
                                                <div style={{ color: "var(--accent)" }}>↑ {fmtBytes(s.network.txBytesPerSec)}/s</div>
                                            </>
                                        ) : "—"}
                                    </td>
                                    <td className="mono" style={{ padding: "13px 16px", fontSize: 12, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                                        {fmtUptime(s?.uptime)}
                                    </td>
                                    <td className="mono" style={{ padding: "13px 16px", fontSize: 13, fontWeight: 600 }}>{n.botCount ?? 0}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {addOpen && (
                <NodeModal node={null} onClose={() => setAddOpen(false)} onSaved={loadNodes} />
            )}
        </div>
    );
}
