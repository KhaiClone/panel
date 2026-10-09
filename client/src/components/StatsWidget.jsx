import { useData } from "../context/DataContext";
import { Icon } from "./ui";

const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

function ProgressBar({ percent, color }) {
    const pct = Math.min(Math.max(percent ?? 0, 0), 100);
    return (
        <div style={{ background: "var(--bg-hover)", borderRadius: 3, height: 4, overflow: "hidden" }}>
            <div style={{
                width: `${pct}%`, height: "100%", borderRadius: 3,
                background: color,
                transition: "width 0.4s ease",
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

    const cpuColor  = cpu  > 80 ? "var(--danger)" : cpu  > 50 ? "var(--warning)" : "var(--success)";
    const ramColor  = ram  > 80 ? "var(--danger)" : ram  > 50 ? "var(--warning)" : "var(--info)";
    const diskColor = disk !== null ? (disk > 85 ? "var(--danger)" : disk > 65 ? "var(--warning)" : "var(--accent)") : "var(--text-dim)";

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
        <div className="card" style={{ padding: 16 }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Icon name="activity" style={{ color: "var(--text-muted)" }} />
                    <span style={{ fontWeight: 500, fontSize: 13, color: "var(--text)" }}>Panel host</span>
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>the VPS that runs the panel</span>
                </div>
                <span className="status-badge">
                    <span className="status-dot" style={{ background: "var(--success)" }}/>
                    Live
                </span>
            </div>

            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {metrics.map(({ label, value, sub, percent, color }) => (
                    <div
                        key={label}
                        style={{
                            display: "flex", flexDirection: "column", gap: 8,
                            padding: "12px 14px", borderRadius: 8,
                            background: "var(--bg-input)",
                            border: "1px solid var(--border)",
                        }}
                    >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>{label}</span>
                            <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{value}</span>
                        </div>
                        <ProgressBar percent={percent} color={color} />
                        {sub && (
                            <p className="mono" style={{ fontSize: 11, color: "var(--text-dim)", margin: 0 }}>{sub}</p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
