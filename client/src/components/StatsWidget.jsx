import { useData } from "../context/DataContext";

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

function ProgressBar({ percent, color }) {
    const pct = Math.min(Math.max(percent ?? 0, 0), 100);
    return (
        <div style={{ background: "var(--bg-input)", borderRadius: 4, height: 6, overflow: "hidden" }}>
            <div style={{
                width: `${pct}%`, height: "100%", borderRadius: 4,
                background: color, transition: "width 0.4s ease",
            }}/>
        </div>
    );
}

export default function StatsWidget() {
    const { stats } = useData();

    if (!stats) {
        return (
            <div className="card" style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-muted)", fontSize: 13 }}>
                <div style={{
                    width: 18, height: 18, borderRadius: "50%",
                    border: "2px solid var(--border)", borderTopColor: "var(--accent)",
                    animation: "spin 0.8s linear infinite",
                }}/>
                Loading system stats…
            </div>
        );
    }

    const cpu  = stats?.cpu?.usagePercent  ?? 0;
    const ram  = stats?.memory?.usedPercent ?? 0;
    const disk = stats?.disk?.usedPercent   ?? null;

    const cpuColor  = cpu  > 80 ? "#ef4444" : cpu  > 50 ? "#f97316" : "#22c55e";
    const ramColor  = ram  > 80 ? "#ef4444" : ram  > 50 ? "#f97316" : "#5b73e8";
    const diskColor = disk !== null ? (disk > 85 ? "#ef4444" : disk > 65 ? "#f97316" : "#38bdf8") : "#64748b";

    const metrics = [
        {
            label: "CPU",
            value: `${Math.round(cpu)}%`,
            sub: stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : null,
            percent: cpu,
            color: cpuColor,
        },
        {
            label: "Memory",
            value: `${Math.round(ram)}%`,
            sub: `${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`,
            percent: ram,
            color: ramColor,
        },
        {
            label: "Disk",
            value: disk !== null ? `${Math.round(disk)}%` : "N/A",
            sub: stats.disk ? `${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}` : null,
            percent: disk ?? 0,
            color: diskColor,
        },
    ];

    return (
        <div className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}>
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>System Resources</span>
                </div>
                <span style={{ fontSize: 11, color: "var(--success)", display: "flex", alignItems: "center", gap: 5, fontWeight: 500 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", display: "inline-block" }}/>
                    Live
                </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
                {metrics.map(({ label, value, sub, percent, color }) => (
                    <div key={label} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
                            <span className="mono" style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
                        </div>
                        <ProgressBar percent={percent} color={color} />
                        {sub && <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", marginTop: -4 }}>{sub}</p>}
                    </div>
                ))}
            </div>
        </div>
    );
}
