import { useState, useEffect } from "react";
import api from "../api/client";
import TrendModal from "../components/TrendModal";
import { useNode } from "../context/NodeContext";

// History now comes from the server-side sampler (24/7, every 15s, kept 1 week)
// via GET /system/history — no more browser-only localStorage ring buffer.
const RANGES = [
    { key: "1h", label: "1H" },
    { key: "6h", label: "6H" },
    { key: "24h", label: "24H" },
    { key: "7d", label: "7D" },
];

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

const clamp = (v) => Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 100) : 0;

function BigRing({ percent, color, label, sub }) {
    const safe = clamp(percent);
    const radius = 64;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (safe / 100) * circumference;

    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ position: "relative", width: 160, height: 160, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="160" height="160" style={{ position: "absolute", top: 0, left: 0, transform: "rotate(-90deg)", filter: `drop-shadow(0 0 12px ${color}40)` }}>
                    <circle cx="80" cy="80" r={radius} fill="none" stroke="var(--bg-input)" strokeWidth="12" />
                    <circle cx="80" cy="80" r={radius} fill="none" stroke={color} strokeWidth="12" strokeLinecap="round"
                            style={{ strokeDasharray: circumference, strokeDashoffset, transition: "stroke-dashoffset 1s ease-out" }} />
                </svg>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                    <span style={{ fontSize: 36, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>
                        {safe}<span style={{ fontSize: 18, color: "var(--text-muted)", marginLeft: 2 }}>%</span>
                    </span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", margin: "0 0 4px 0", letterSpacing: "0.02em" }}>{label}</p>
                {sub && <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</p>}
            </div>
        </div>
    );
}

function StatRow({ label, value, accent, barPercent, barColor }) {
    return (
        <div style={{ padding: "11px 0", borderBottom: "1px solid var(--border-light)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>{label}</span>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: accent || "var(--text)" }}>{value}</span>
            </div>
            {barPercent != null && (
                <div style={{ marginTop: 8, height: 5, borderRadius: 3, background: "var(--bg-input)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${clamp(barPercent)}%`, background: barColor || "var(--accent)", transition: "width 0.5s cubic-bezier(0.4, 0, 0.2, 1)", borderRadius: 3 }} />
                </div>
            )}
        </div>
    );
}

function Sparkline({ values, color, samples, onClick }) {
    if (values.length < 2) return null;
    const W = 200, H = 40;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - (clamp(v) / 100) * H}`);
    const gradId = `grad-${color.replace("#", "")}`;
    return (
        <div className="card-hover" onClick={onClick}
            style={{ marginTop: 16, borderRadius: 10, padding: 14, background: "var(--bg-input)", border: "1px solid var(--border)", cursor: "pointer", transition: "all 0.2s" }}>
            <svg viewBox="0 0 200 40" style={{ width: "100%", height: 40, overflow: "visible" }}>
                <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.4" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path d={`M${pts.join("L")} L${W},${H} L0,${H} Z`} fill={`url(#${gradId})`} />
                <path d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                {pts.length > 0 && <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="4" fill={color} stroke="var(--bg-input)" strokeWidth="1.5" />}
            </svg>
            <p style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center", margin: "10px 0 0 0", fontWeight: 500 }}>{samples} samples · Click to view history</p>
        </div>
    );
}

export default function SystemPage() {
    // The global header switcher (NodeContext) decides which node this page
    // shows — no page-local node tabs anymore.
    const { nodeId, selectedNode } = useNode();
    const [stats, setStats] = useState(null);   // live current stats (rings)
    const [history, setHistory] = useState([]); // server-recorded series
    const [range, setRange] = useState("6h");
    const [activeTab, setActiveTab] = useState("CPU");
    const [trendModal, setTrendModal] = useState(null);

    // Live rings — poll the selected node's current stats every 4s
    useEffect(() => {
        setStats(null);
        const poll = () => api.get("/system/stats").then(r => setStats(r.data)).catch(() => {});
        poll();
        const int = setInterval(poll, 4000);
        return () => clearInterval(int);
    }, [nodeId]);

    // Persistent history from the server sampler — refetch on node/range change,
    // then refresh every 30s.
    useEffect(() => {
        const load = () => api.get(`/system/history`, { params: { node: nodeId, range } })
            .then(r => setHistory(r.data)).catch(() => {});
        load();
        const int = setInterval(load, 30_000);
        return () => clearInterval(int);
    }, [nodeId, range]);

    if (!stats) {
        return (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60vh", gap: 16 }}>
                <div style={{ width: 48, height: 48, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
                <p style={{ fontSize: 15, color: "var(--text-muted)", fontWeight: 500 }}>Establishing telemetry connection…</p>
            </div>
        );
    }

    const cpu  = clamp(stats.cpu?.usagePercent);
    const ram  = clamp(stats.memory?.usedPercent);
    const disk = stats.disk ? clamp(stats.disk.usedPercent) : null;

    const cpuColor  = cpu  > 80 ? "#ef4444" : cpu  > 50 ? "#f59e0b" : "#10b981";
    const ramColor  = ram  > 80 ? "#ef4444" : ram  > 50 ? "#f59e0b" : "#6366f1";
    const diskColor = disk !== null ? (disk > 85 ? "#ef4444" : disk > 65 ? "#f59e0b" : "#0ea5e9") : "#64748b";

    const cpuVals = history.map(s => clamp(s.cpu));
    const ramVals = history.map(s => clamp(s.ram));

    return (
        <div className="fade-in page-compact" style={{ maxWidth: 1000, display: "flex", flexDirection: "column", gap: 28 }}>

            {/* Page Header */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div className="min-w-0">
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>System Monitor</h1>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                        <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>
                            {nodeId === "local" ? "Host server resource utilization." : `Node "${selectedNode?.name || nodeId}" resource utilization.`}
                        </p>
                        {stats.hostname && (
                            <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)", background: "var(--bg-input)", padding: "2px 8px", borderRadius: 5, border: "1px solid var(--border)" }}>
                                {stats.hostname}
                            </span>
                        )}
                    </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: "var(--success-bg)", border: "1px solid var(--success-border)", borderRadius: 99 }}>
                    <span className="status-dot" style={{ width: 8, height: 8, background: "var(--success)" }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--success)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Live Updates</span>
                    {stats.uptime != null && (
                        <span style={{ fontSize: 11, color: "var(--success)", opacity: 0.8, borderLeft: "1px solid var(--success-border)", paddingLeft: 8, marginLeft: 2 }}>
                            up {Math.floor(stats.uptime / 3600)}h {Math.floor((stats.uptime % 3600) / 60)}m
                        </span>
                    )}
                </div>
            </div>

            {/* BigRing Overview */}
            <div className="card slide-up" style={{ padding: 32, background: "linear-gradient(to right, var(--bg-card), var(--bg-surface))" }}>
                <h2 style={{ fontSize: 12, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 32 }}>Resource Overview</h2>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-around", gap: 32 }}>
                    <BigRing percent={cpu} color={cpuColor} label="CPU Load" sub={stats.cpu?.model ?? (stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Processor")} />
                    <BigRing percent={ram} color={ramColor} label="Memory Usage" sub={`${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`} />
                    {disk !== null ? (
                        <BigRing percent={disk} color={diskColor} label={`Disk (${stats.disk.mount})`} sub={`${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}`} />
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, opacity: 0.5 }}>
                            <div style={{ width: 160, height: 160, borderRadius: "50%", border: "12px solid var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-muted)" }}>N/A</span>
                            </div>
                            <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>Disk Unavailable</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Tabbed Detailed Metrics */}
            <div className="card slide-up" style={{ padding: 24 }}>
                <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <h3 style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", margin: 0 }}>Detailed Metrics</h3>
                        <div className="tab-bar" style={{ display: "inline-flex" }}>
                            {RANGES.map(r => (
                                <button key={r.key} className={`tab-item${range === r.key ? " active" : ""}`} onClick={() => setRange(r.key)} style={{ fontSize: 12, padding: "5px 12px" }}>
                                    {r.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="tab-bar" style={{ display: "inline-flex" }}>
                        {["CPU", "Memory", "Disk"].map(t => (
                            <button
                                key={t}
                                className={`tab-item${activeTab === t ? " active" : ""}`}
                                onClick={() => setActiveTab(t)}
                                style={{ fontSize: 13 }}
                            >
                                {t}
                            </button>
                        ))}
                    </div>
                </div>

                {/* CPU Tab */}
                {activeTab === "CPU" && (
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={cpuColor} strokeWidth="2" style={{ width: 16, height: 16 }}>
                                <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                                <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                                <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                                <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                                <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                            </svg>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>CPU Metrics</span>
                        </div>
                        <StatRow label="Current Usage"     value={`${cpu}%`}                                          accent={cpuColor} barPercent={cpu} barColor={cpuColor} />
                        <StatRow label="Model Processor"   value={stats.cpu?.model ?? "—"} />
                        <StatRow label="Core Temperature"  value={stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Unavailable"} />
                        {history.length > 1 && (
                            <Sparkline values={cpuVals} color={cpuColor} samples={history.length} onClick={() => setTrendModal("cpu")} />
                        )}
                    </div>
                )}

                {/* Memory Tab */}
                {activeTab === "Memory" && (
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={ramColor} strokeWidth="2" style={{ width: 16, height: 16 }}>
                                <rect x="2" y="6" width="20" height="12" rx="2" />
                                <line x1="6" y1="10" x2="6" y2="14" /><line x1="10" y1="10" x2="10" y2="14" />
                                <line x1="14" y1="10" x2="14" y2="14" /><line x1="18" y1="10" x2="18" y2="14" />
                            </svg>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Memory Metrics</span>
                        </div>
                        <StatRow label="Current Usage"    value={`${ram}%`}                   accent={ramColor} barPercent={ram} barColor={ramColor} />
                        <StatRow label="Allocated / Used" value={fmt(stats.memory?.usedBytes)} />
                        <StatRow label="Available / Free" value={fmt(stats.memory?.freeBytes)} />
                        <StatRow label="Total Capacity"   value={fmt(stats.memory?.totalBytes)} />
                        {history.length > 1 && (
                            <Sparkline values={ramVals} color={ramColor} samples={history.length} onClick={() => setTrendModal("mem")} />
                        )}
                    </div>
                )}

                {/* Disk Tab */}
                {activeTab === "Disk" && (
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={diskColor} strokeWidth="2" style={{ width: 16, height: 16 }}>
                                <ellipse cx="12" cy="5" rx="9" ry="3" />
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                            </svg>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Disk Metrics</span>
                        </div>
                        {stats.disk ? (
                            <>
                                <StatRow label="Current Usage"    value={`${disk}%`}                    accent={diskColor} barPercent={disk} barColor={diskColor} />
                                <StatRow label="Mount Point"      value={stats.disk.mount} />
                                <StatRow label="Filesystem Type"  value={stats.disk.fs} />
                                <StatRow label="Space Used"       value={fmt(stats.disk.usedBytes)} />
                                <StatRow label="Space Free"       value={fmt(stats.disk.freeBytes)} />
                                <StatRow label="Total Capacity"   value={fmt(stats.disk.totalBytes)} />
                            </>
                        ) : (
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 160, border: "1px dashed var(--border)", borderRadius: 10, background: "var(--bg-input)" }}>
                                <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>Disk telemetry unavailable</p>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {trendModal === "cpu" && <TrendModal title="CPU Utilization History"    color={cpuColor} data={history} valueKey="cpu" onClose={() => setTrendModal(null)} />}
            {trendModal === "mem" && <TrendModal title="Memory Utilization History" color={ramColor} data={history} valueKey="ram" onClose={() => setTrendModal(null)} />}
        </div>
    );
}
