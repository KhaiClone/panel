import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import Sparkline from "../components/Sparkline";
import NodeModal from "../components/NodeModal";
import RangeTabs from "../components/RangeTabs";
import { RemovalStatus, removalActive } from "../components/RemoveNodeModal";
import { fmtBytes, fmtPercent } from "../components/MetricChart";
import { DataTable, Icon, Notice, PageHeader, StatCard, StatusBadge } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Servers (/systems) — every VPS side by side, one row each.
//
//  Live values come from /api/nodes (which already carries each node's stats),
//  the trend behind them from /api/nodes/history in a single request for all
//  nodes. Clicking a row opens that node's detail page.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE_POLL_MS = 8000;
const HISTORY_POLL_MS = 60_000;

const barTone = (pct) => (pct >= 90 ? "danger" : pct >= 75 ? "warning" : "success");
const barColor = (pct) => `var(--${barTone(pct)})`;

const fmtUptime = (s) => {
    if (!Number.isFinite(s)) return "—";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

const REMOVAL_LABEL = {
    running: ["Cleaning up the VPS…", "warning"],
    done: ["VPS cleaned up", "success"],
    failed: ["VPS clean-up stopped", "danger"],
    lost: ["No word from the VPS", "danger"],
};

/** Nodes removed in the last day — the VPS clean-up keeps going after its modal is closed. */
function RecentRemovals({ removals }) {
    const [open, setOpen] = useState(null);
    if (!removals.length) return null;
    return (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontSize: 14, fontWeight: 600 }}>
                Removed nodes <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-dim)" }}>last 24 h</span>
            </div>
            {removals.map((r) => {
                const [label, tone] = r.vps ? REMOVAL_LABEL[r.vps.status] || [r.vps.status, "neutral"] : ["Panel only", "neutral"];
                return (
                    <div key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <div
                            onClick={() => setOpen(open === r.id ? null : r.id)}
                            style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", cursor: "pointer", fontSize: 13 }}
                        >
                            <span style={{ fontWeight: 600 }}>{r.name}</span>
                            <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.host}</span>
                            <span style={{ flex: 1 }} />
                            <StatusBadge tone={tone}>{label}</StatusBadge>
                            <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                                {new Date(r.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <Icon name={open === r.id ? "chevronDown" : "chevronRight"} size={14} style={{ color: "var(--text-dim)" }} />
                        </div>
                        {open === r.id && (
                            <div style={{ padding: "0 16px 14px" }}>
                                <RemovalStatus removal={r} />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

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

export default function SystemsPage() {
    const navigate = useNavigate();
    const [nodes, setNodes] = useState([]);
    const [hist, setHist] = useState({});
    const [range, setRange] = useState("6h");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [addOpen, setAddOpen] = useState(false);
    const [wg, setWg] = useState({ busy: false, msg: null });
    const [removals, setRemovals] = useState([]);

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

    // Faster while a removal is still going, slow otherwise.
    const removing = removals.some(removalActive);
    useEffect(() => {
        const load = () => api.get("/nodes/removals").then((r) => setRemovals(r.data)).catch(() => {});
        load();
        const t = setInterval(load, removing ? 3000 : 30_000);
        return () => clearInterval(t);
    }, [removing]);

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
        <div className="page fade-in" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Servers"
                description="Every VPS the panel manages. Select one to see its full history."
                actions={
                    <>
                        <button className="btn-ghost" onClick={syncWg} disabled={wg.busy}>
                            <Icon name="refresh" /> {wg.busy ? "Syncing…" : "Sync WireGuard"}
                        </button>
                        <button className="btn-primary" onClick={() => setAddOpen(true)}>
                            <Icon name="plus" /> Add node
                        </button>
                        <RangeTabs value={range} onChange={setRange} />
                    </>
                }
            />

            {wg.msg && <Notice tone="info">{wg.msg}</Notice>}

            {error && <Notice tone="danger">{error}</Notice>}

            <div className="stat-grid">
                <StatCard
                    label="Nodes"
                    value={`${totals.nodesOnline}/${totals.nodesTotal}`}
                    hint="online"
                    tone={totals.nodesOnline === totals.nodesTotal ? "success" : "warning"}
                />
                <StatCard label="Projects" value={totals.bots} hint="across all nodes" />
                <StatCard label="CPU" value={totals.cpu === null ? "—" : fmtPercent(totals.cpu)} hint="weighted by cores" tone={totals.cpu === null ? undefined : barTone(totals.cpu)} />
                <StatCard label="Memory" value={totals.ram === null ? "—" : fmtPercent(totals.ram)} hint={totals.ramText} tone={totals.ram === null ? undefined : barTone(totals.ram)} />
                <StatCard label="Disk" value={totals.disk === null ? "—" : fmtPercent(totals.disk)} hint={totals.diskText} tone={totals.disk === null ? undefined : barTone(totals.disk)} />
            </div>

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <DataTable flush minWidth={880} columns={["System", "CPU", "Memory", "Disk", "Network", "Uptime", "Projects"]}>
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
                                className="row-click"
                                onClick={() => navigate(`/nodes/${n._id}`)}
                                style={{ opacity: offline ? 0.55 : 1 }}
                            >
                                <td>
                                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                                        <span className="status-dot" style={{ background: dot }} title={n.status} />
                                        <div className="min-w-0">
                                            <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                                                {n.name}
                                                {n.isPanelNode && (
                                                    <span className="badge" style={{ marginLeft: 8, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>panel</span>
                                                )}
                                            </div>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                                {offline ? n.status : (s?.cpu?.model ? String(s.cpu.model).slice(0, 34) : n.host)}
                                            </div>
                                        </div>
                                    </div>
                                </td>
                                <td><MetricCell percent={s?.cpu?.usagePercent} points={h.cpu} /></td>
                                <td><MetricCell percent={s?.memory?.usedPercent} points={h.ram} /></td>
                                <td><MetricCell percent={s?.disk?.usedPercent} points={h.disk} /></td>
                                <td className="mono nowrap" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                    {s?.network ? (
                                        <>
                                            <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="Received">
                                                <Icon name="arrowDown" size={12} style={{ color: "var(--success)" }} /> {fmtBytes(s.network.rxBytesPerSec)}/s
                                            </div>
                                            <div style={{ display: "flex", alignItems: "center", gap: 4 }} title="Sent">
                                                <Icon name="arrowUp" size={12} style={{ color: "var(--info)" }} /> {fmtBytes(s.network.txBytesPerSec)}/s
                                            </div>
                                        </>
                                    ) : "—"}
                                </td>
                                <td className="mono nowrap" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                    {fmtUptime(s?.uptime)}
                                </td>
                                <td className="mono" style={{ fontWeight: 600 }}>{n.botCount ?? 0}</td>
                            </tr>
                        );
                    })}
                </DataTable>
            </div>

            <RecentRemovals removals={removals} />

            {addOpen && (
                <NodeModal node={null} onClose={() => setAddOpen(false)} onSaved={loadNodes} />
            )}
        </div>
    );
}
