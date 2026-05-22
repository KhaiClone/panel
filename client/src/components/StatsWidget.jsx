import { useData } from "../context/DataContext";

// ── Ring gauge ─────────────────────────────────────────────────────────────
function Ring({ percent, color, label, sub }) {
    const r = 34;
    const circ = 2 * Math.PI * r;
    const offset = circ - (Math.min(percent, 100) / 100) * circ;

    return (
        <div className="flex flex-col items-center gap-2.5">
            <div className="relative w-[88px] h-[88px]">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 88 88">
                    {/* Track */}
                    <circle cx="44" cy="44" r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
                    {/* Progress */}
                    <circle
                        cx="44" cy="44" r={r} fill="none"
                        stroke={color} strokeWidth="8" strokeLinecap="round"
                        strokeDasharray={circ} strokeDashoffset={offset}
                        style={{
                            transition: "stroke-dashoffset 0.8s cubic-bezier(0.34,1.56,0.64,1)",
                            filter: `drop-shadow(0 0 8px ${color}77)`,
                        }}
                    />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-base font-black text-slate-100">{percent}%</span>
                </div>
            </div>
            <div className="text-center">
                <p className="text-xs font-bold text-slate-300">{label}</p>
                {sub && <p className="text-[10px] text-slate-500 mt-0.5 max-w-[100px] truncate">{sub}</p>}
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
            <div className="card flex items-center justify-center h-36"
                style={{ background: "linear-gradient(135deg, rgba(17,24,39,0.9), rgba(13,21,37,0.9))" }}>
                <div className="relative w-8 h-8">
                    <div className="absolute inset-0 rounded-full" style={{ border: "2px solid rgba(124,58,237,0.15)" }} />
                    <div className="absolute inset-0 rounded-full border-t-violet-500 animate-spin" style={{ border: "2px solid transparent", borderTopColor: "#7C3AED" }} />
                </div>
            </div>
        );
    }

    const cpuColor  = stats.cpu.usagePercent  > 80 ? "#f87171" : stats.cpu.usagePercent  > 50 ? "#fb923c" : "#34d399";
    const ramColor  = stats.memory.usedPercent > 80 ? "#f87171" : stats.memory.usedPercent > 50 ? "#fb923c" : "#818cf8";
    const diskColor = stats.disk
        ? stats.disk.usedPercent > 85 ? "#f87171" : stats.disk.usedPercent > 65 ? "#fb923c" : "#38bdf8"
        : "#64748b";

    const ramSub  = `${fmt(stats.memory.usedBytes)} / ${fmt(stats.memory.totalBytes)}`;
    const diskSub = stats.disk ? `${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}` : null;

    return (
        <div className="card" style={{ background: "linear-gradient(135deg, rgba(17,24,39,0.92), rgba(13,21,37,0.92))" }}>
            <div className="flex items-center gap-2 mb-5">
                <div className="w-6 h-6 rounded-lg flex items-center justify-center"
                    style={{ background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.2)" }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                </div>
                <h2 className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">System Resources</h2>
                <span className="ml-auto flex items-center gap-1 text-[9px] font-bold text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live
                </span>
            </div>
            <div className="flex items-center justify-around flex-wrap gap-6">
                <Ring percent={stats.cpu.usagePercent}    color={cpuColor}  label="CPU"  sub={stats.cpu.temperature ? `${stats.cpu.temperature}°C` : "Load"} />
                <Ring percent={stats.memory.usedPercent}  color={ramColor}  label="RAM"  sub={ramSub} />
                {stats.disk ? (
                    <Ring percent={stats.disk.usedPercent} color={diskColor} label="Disk" sub={diskSub} />
                ) : (
                    <div className="flex flex-col items-center gap-2.5 opacity-30">
                        <div className="w-[88px] h-[88px] rounded-full flex items-center justify-center"
                            style={{ border: "8px solid rgba(255,255,255,0.05)" }}>
                            <span className="text-slate-600 text-[10px] font-bold uppercase">N/A</span>
                        </div>
                        <p className="text-xs font-bold text-slate-500">Disk</p>
                    </div>
                )}
            </div>
        </div>
    );
}
