import { useState, useEffect, useRef } from "react";
import api from "../api/client";
import TrendModal from "../components/TrendModal";

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

const clamp = (v) => Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 100) : 0;

function BigRing({ percent, color, label, sub }) {
    const safe = clamp(percent);
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div style={{ position: "relative", width: 140, height: 140, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: `conic-gradient(${color} ${safe}%, var(--bg-input) ${safe}%)` }}>
                <div style={{ width: 120, height: 120, borderRadius: "50%", background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 28, fontWeight: 800, color: "var(--text)" }}>{safe}%</span>
                </div>
            </div>
            <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", margin: "0 0 2px 0" }}>{label}</p>
                {sub && <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</p>}
            </div>
        </div>
    );
}

function StatRow({ label, value, accent, barPercent, barColor }) {
    return (
        <div style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: accent || "var(--text)" }}>{value}</span>
            </div>
            {barPercent != null && (
                <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: "var(--bg-input)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${clamp(barPercent)}%`, background: barColor || "var(--accent)", transition: "width 0.5s ease" }} />
                </div>
            )}
        </div>
    );
}

function Sparkline({ values, color, samples }) {
    if (values.length < 2) return null;
    const W = 200, H = 40;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - (clamp(v) / 100) * H}`);
    const gradId = `grad-${color.replace("#", "")}`;
    return (
        <div style={{ marginTop: 12, borderRadius: 8, padding: 10, background: "var(--bg-input)", border: "1px solid var(--border)", cursor: "pointer" }}>
            <svg viewBox="0 0 200 40" style={{ width: "100%", height: 32, overflow: "visible" }}>
                <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path d={`M${pts.join("L")} L${W},${H} L0,${H} Z`} fill={`url(#${gradId})`} />
                <path d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {pts.length > 0 && <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="3" fill={color} />}
            </svg>
            <p style={{ fontSize: 10, color: "var(--text-dim)", textAlign: "center", margin: "4px 0 0 0" }}>{samples} samples · click to expand</p>
        </div>
    );
}

export default function SystemPage() {
    const [stats, setStats] = useState(null);
    const [trendModal, setTrendModal] = useState(null);
    const [history, setHistory] = useState(() => {
        try { const saved = localStorage.getItem("bp_sys_history"); return saved ? JSON.parse(saved) : []; }
        catch { return []; }
    });
    const firstLoad = useRef(true);

    const fetchStats = () => {
        api.get("/system/stats").then(r => {
            setStats(r.data);
            setHistory(h => {
                const next = [...h.slice(-59), { ...r.data, _ts: Date.now() }];
                try { localStorage.setItem("bp_sys_history", JSON.stringify(next)); } catch {}
                return next;
            });
            firstLoad.current = false;
        }).catch(() => {});
    };

    useEffect(() => {
        fetchStats();
        const int = setInterval(fetchStats, 4000);
        return () => clearInterval(int);
    }, []);

    if (!stats) {
        return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Fetching metrics…</div>;
    }

    const cpu = clamp(stats.cpu?.usagePercent);
    const ram = clamp(stats.memory?.usedPercent);
    const disk = stats.disk ? clamp(stats.disk.usedPercent) : null;

    const cpuColor = cpu > 80 ? "#ef4444" : cpu > 50 ? "#f59e0b" : "#10b981";
    const ramColor = ram > 80 ? "#ef4444" : ram > 50 ? "#f59e0b" : "#6366f1";
    const diskColor = disk !== null ? (disk > 85 ? "#ef4444" : disk > 65 ? "#f59e0b" : "#0ea5e9") : "#64748b";

    const cpuVals = history.map(s => clamp(s.cpu?.usagePercent));
    const ramVals = history.map(s => clamp(s.memory?.usedPercent));

    return (
        <div style={{ padding: "20px 24px", maxWidth: 960, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
            <div>
                <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>System Monitor</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0 0", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981" }}/>
                    Live server stats — refreshes every 4s
                </p>
            </div>

            <div className="card" style={{ padding: 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Resource Overview</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-around", gap: 32 }}>
                    <BigRing percent={cpu} color={cpuColor} label="CPU Load" sub={stats.cpu?.model ?? (stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Processor")} />
                    <BigRing percent={ram} color={ramColor} label="Memory" sub={`${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`} />
                    {disk !== null ? (
                        <BigRing percent={disk} color={diskColor} label={`Disk (${stats.disk.mount})`} sub={`${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}`} />
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, opacity: 0.5 }}>
                            <div style={{ width: 140, height: 140, borderRadius: "50%", border: "12px solid var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-muted)" }}>N/A</span>
                            </div>
                            <p style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Disk</p>
                        </div>
                    )}
                </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
                <div className="card" style={{ padding: 20 }}>
                    <h3 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 16px 0" }}>CPU Details</h3>
                    <StatRow label="Usage" value={`${cpu}%`} accent={cpuColor} barPercent={cpu} barColor={cpuColor} />
                    <StatRow label="Model" value={stats.cpu?.model ?? "—"} />
                    <StatRow label="Temperature" value={stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Unavailable"} />
                    {history.length > 1 && <div onClick={() => setTrendModal("cpu")}><Sparkline values={cpuVals} color={cpuColor} samples={history.length} /></div>}
                </div>
                <div className="card" style={{ padding: 20 }}>
                    <h3 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 16px 0" }}>Memory Details</h3>
                    <StatRow label="Usage" value={`${ram}%`} accent={ramColor} barPercent={ram} barColor={ramColor} />
                    <StatRow label="Used" value={fmt(stats.memory?.usedBytes)} />
                    <StatRow label="Free" value={fmt(stats.memory?.freeBytes)} />
                    <StatRow label="Total" value={fmt(stats.memory?.totalBytes)} />
                    {history.length > 1 && <div onClick={() => setTrendModal("mem")}><Sparkline values={ramVals} color={ramColor} samples={history.length} /></div>}
                </div>
                <div className="card" style={{ padding: 20 }}>
                    <h3 style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 16px 0" }}>Disk Details</h3>
                    {stats.disk ? (
                        <>
                            <StatRow label="Usage" value={`${disk}%`} accent={diskColor} barPercent={disk} barColor={diskColor} />
                            <StatRow label="Mount" value={stats.disk.mount} />
                            <StatRow label="Filesystem" value={stats.disk.fs} />
                            <StatRow label="Used" value={fmt(stats.disk.usedBytes)} />
                            <StatRow label="Free" value={fmt(stats.disk.freeBytes)} />
                            <StatRow label="Total" value={fmt(stats.disk.totalBytes)} />
                        </>
                    ) : (
                        <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "20px 0" }}>Disk info unavailable</p>
                    )}
                </div>
            </div>

            {trendModal === "cpu" && <TrendModal title="CPU" color={cpuColor} data={history} valueKey="cpu" onClose={() => setTrendModal(null)} />}
            {trendModal === "mem" && <TrendModal title="RAM" color={ramColor} data={history} valueKey="mem" onClose={() => setTrendModal(null)} />}
        </div>
    );
}
