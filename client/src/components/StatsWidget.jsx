import { useData } from "../context/DataContext";

// ── Circular progress ring ─────────────────────────────────────────────────
function Ring({ percent, color, label, sub }) {
    const r = 36;
    const circ = 2 * Math.PI * r;
    const offset = circ - (percent / 100) * circ;

    return (
        <div className="flex flex-col items-center gap-2">
            <div className="relative w-24 h-24">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 88 88">
                    <circle cx="44" cy="44" r={r} fill="none" stroke="#334155" strokeWidth="8" />
                    <circle
                        cx="44" cy="44" r={r} fill="none"
                        stroke={color} strokeWidth="8" strokeLinecap="round"
                        strokeDasharray={circ} strokeDashoffset={offset}
                        style={{ transition: "stroke-dashoffset 0.6s ease" }}
                    />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold text-slate-100">{percent}%</span>
                </div>
            </div>
            <div className="text-center">
                <p className="text-sm font-semibold text-slate-200">{label}</p>
                {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
            </div>
        </div>
    );
}

const fmt = (bytes) => {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

export default function StatsWidget() {
    const { stats } = useData();

    if (!stats) {
        return (
            <div className="card flex items-center justify-center h-40">
                <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
            </div>
        );
    }

    const cpuColor = stats.cpu.usagePercent > 80 ? "#f87171" : stats.cpu.usagePercent > 50 ? "#fb923c" : "#34d399";
    const ramColor = stats.memory.usedPercent > 80 ? "#f87171" : stats.memory.usedPercent > 50 ? "#fb923c" : "#818cf8";
    const diskColor = stats.disk
        ? stats.disk.usedPercent > 85 ? "#f87171" : stats.disk.usedPercent > 65 ? "#fb923c" : "#38bdf8"
        : "#64748b";

    const ramSub = `${fmt(stats.memory.usedBytes)} / ${fmt(stats.memory.totalBytes)}`;
    const diskSub = stats.disk ? `${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}` : null;

    return (
        <div className="card">
            <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-5">
                System Resources
            </h2>
            <div className="flex items-center justify-around flex-wrap gap-6">
                <Ring
                    percent={stats.cpu.usagePercent}
                    color={cpuColor}
                    label="CPU"
                    sub={stats.cpu.temperature ? `${stats.cpu.temperature}°C` : "Load"}
                />
                <Ring percent={stats.memory.usedPercent} color={ramColor} label="RAM" sub={ramSub} />
                {stats.disk ? (
                    <Ring percent={stats.disk.usedPercent} color={diskColor} label="Disk" sub={diskSub} />
                ) : (
                    <div className="flex flex-col items-center gap-2 opacity-40">
                        <div className="w-24 h-24 rounded-full border-4 border-slate-700 flex items-center justify-center">
                            <span className="text-slate-500 text-xs">N/A</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-500">Disk</p>
                    </div>
                )}
            </div>
        </div>
    );
}
