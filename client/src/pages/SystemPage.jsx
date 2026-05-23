import { useState, useEffect, useRef } from "react";
import api from "../api/client";
import TrendModal from "../components/TrendModal";
import { motion, AnimatePresence } from "framer-motion";

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${bytes} B`;
};

const clamp = (v) => Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 100) : 0;

// ── Big Ring gauge ──────────────────────────────────────────────────────────
function BigRing({ percent, color, label, sub }) {
    const r     = 52;
    const circ  = 2 * Math.PI * r;
    const safe  = clamp(percent);

    // Animate from fully-empty → real value on first mount, then on each update
    const [offset, setOffset] = useState(circ);
    useEffect(() => {
        const t = setTimeout(() => setOffset(circ - (safe / 100) * circ), 80);
        return () => clearTimeout(t);
    }, [safe, circ]);

    return (
        <div className="flex flex-col items-center gap-3">
            <div className="relative w-[130px] h-[130px] lg:w-[148px] lg:h-[148px]">
                <svg className="w-full h-full -rotate-90 overflow-visible" viewBox="0 0 120 120">
                    {/* Track */}
                    <circle cx="60" cy="60" r={r} fill="none"
                        stroke="rgba(255,255,255,0.05)" strokeWidth="11" />
                    {/* Glow halo — always visible at low opacity */}
                    <circle cx="60" cy="60" r={r} fill="none"
                        stroke={color} strokeWidth="11" strokeLinecap="round"
                        strokeDasharray={circ} strokeDashoffset={0}
                        style={{ opacity: 0.07 }} />
                    {/* Animated progress arc */}
                    <circle
                        cx="60" cy="60" r={r} fill="none"
                        stroke={color} strokeWidth="11" strokeLinecap="round"
                        strokeDasharray={circ}
                        strokeDashoffset={offset}
                        style={{
                            transition: "stroke-dashoffset 1s cubic-bezier(0.34,1.56,0.64,1)",
                            filter: `drop-shadow(0 0 14px ${color}99)`,
                        }}
                    />
                </svg>

                {/* Percent label */}
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <motion.span
                        key={safe}
                        initial={{ opacity: 0, scale: 0.75, y: 4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ type: "spring", stiffness: 280, damping: 22 }}
                        className="text-2xl lg:text-3xl font-black text-slate-100 leading-none"
                    >
                        {safe}%
                    </motion.span>
                </div>
            </div>

            <div className="text-center">
                <p className="text-sm font-bold text-slate-200">{label}</p>
                {sub && (
                    <p className="text-[10px] text-slate-500 mt-1 max-w-[150px] truncate">{sub}</p>
                )}
            </div>
        </div>
    );
}

// ── Stat row with mini progress bar ────────────────────────────────────────
function StatRow({ label, value, accent, barPercent, barColor }) {
    return (
        <div className="py-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">{label}</span>
                <span className={`text-xs font-semibold font-mono ${accent ?? "text-slate-200"}`}>{value}</span>
            </div>
            {barPercent != null && (
                <div className="mt-1.5 h-1 rounded-full overflow-hidden"
                    style={{ background: "rgba(255,255,255,0.06)" }}>
                    <motion.div
                        className="h-full rounded-full"
                        style={{ background: barColor ?? "#818cf8" }}
                        initial={{ width: "0%" }}
                        animate={{ width: `${clamp(barPercent)}%` }}
                        transition={{ duration: 0.9, ease: [0.34, 1.56, 0.64, 1] }}
                    />
                </div>
            )}
        </div>
    );
}

// ── Sparkline ──────────────────────────────────────────────────────────────
function Sparkline({ values, color, samples }) {
    if (values.length < 2) return null;
    const W = 200, H = 40;
    const pts = values.map((v, i) => {
        const x = (i / (values.length - 1)) * W;
        const y = H - (clamp(v) / 100) * H;
        return `${x},${y}`;
    });
    const gradId = `grad-${color.replace("#", "")}`;
    return (
        <div className="mt-3 rounded-xl p-2.5 cursor-pointer hover:brightness-110 transition-all"
            style={{ background: "rgba(6,11,20,0.6)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <svg viewBox="0 0 200 40" className="w-full h-8" style={{ overflow: "visible" }}>
                <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"   stopColor={color} stopOpacity="0.35" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                </defs>
                <path d={`M${pts.join("L")} L${W},${H} L0,${H} Z`}
                    fill={`url(#${gradId})`} />
                <path d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"
                    style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
                {/* Latest dot */}
                {pts.length > 0 && (() => {
                    const last = pts[pts.length - 1].split(",");
                    return (
                        <circle cx={last[0]} cy={last[1]} r="3" fill={color}
                            style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
                    );
                })()}
            </svg>
            <p className="text-[9px] text-slate-600 text-center mt-1">{samples} samples · click to expand</p>
        </div>
    );
}

// ── Section card ───────────────────────────────────────────────────────────
function SectionCard({ children, delay = 0 }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay, type: "spring", stiffness: 260, damping: 24 }}
            className="card"
        >
            {children}
        </motion.div>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function SystemPage() {
    const [stats, setStats]         = useState(null);
    const [trendModal, setTrendModal] = useState(null);
    const [history, setHistory]     = useState(() => {
        try {
            const saved = localStorage.getItem("bp_sys_history");
            return saved ? JSON.parse(saved) : [];
        } catch { return []; }
    });
    const firstLoad = useRef(true);

    const fetchStats = () => {
        api.get("/system/stats")
            .then((r) => {
                setStats(r.data);
                setHistory((h) => {
                    const next = [...h.slice(-59), { ...r.data, _ts: Date.now() }];
                    try { localStorage.setItem("bp_sys_history", JSON.stringify(next)); } catch {}
                    return next;
                });
                firstLoad.current = false;
            })
            .catch(() => {});
    };

    useEffect(() => {
        fetchStats();
        const interval = setInterval(fetchStats, 4_000);
        return () => clearInterval(interval);
    }, []);

    // ── Loading state ──────────────────────────────────────────────────────
    if (!stats) {
        return (
            <div className="flex flex-col items-center justify-center h-full pt-32 gap-4">
                <div className="relative w-12 h-12">
                    <div className="absolute inset-0 rounded-full"
                        style={{ border: "3px solid rgba(124,58,237,0.15)" }} />
                    <div className="absolute inset-0 rounded-full animate-spin"
                        style={{ border: "3px solid transparent", borderTopColor: "#7C3AED" }} />
                </div>
                <p className="text-xs text-slate-500 font-bold uppercase tracking-widest animate-pulse">
                    Fetching metrics…
                </p>
            </div>
        );
    }

    // ── Derived values ─────────────────────────────────────────────────────
    const cpu  = clamp(stats.cpu?.usagePercent);
    const ram  = clamp(stats.memory?.usedPercent);
    const disk = stats.disk ? clamp(stats.disk.usedPercent) : null;

    const cpuColor  = cpu  > 80 ? "#f87171" : cpu  > 50 ? "#fb923c" : "#34d399";
    const ramColor  = ram  > 80 ? "#f87171" : ram  > 50 ? "#fb923c" : "#818cf8";
    const diskColor = disk !== null
        ? disk > 85 ? "#f87171" : disk > 65 ? "#fb923c" : "#38bdf8"
        : "#64748b";

    const cpuVals = history.map((s) => clamp(s.cpu?.usagePercent));
    const ramVals = history.map((s) => clamp(s.memory?.usedPercent));

    return (
        <div className="p-5 lg:p-7 max-w-5xl mx-auto space-y-6">

            {/* Header */}
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
                <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">
                    System Monitor
                </h1>
                <p className="text-xs text-slate-500 mt-1 font-medium flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Live server stats — refreshes every 4s
                </p>
            </motion.div>

            {/* ── Resource overview ── */}
            <SectionCard delay={0.06}>
                <div className="flex items-center gap-2 mb-8">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center"
                        style={{ background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.2)" }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </svg>
                    </div>
                    <h2 className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                        Resource Overview
                    </h2>
                    <span className="ml-auto flex items-center gap-1.5 text-[9px] font-bold text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Live
                    </span>
                </div>

                <div className="flex flex-wrap items-center justify-around gap-10 py-4">
                    <BigRing
                        percent={cpu} color={cpuColor} label="CPU Load"
                        sub={stats.cpu?.model ?? (stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Processor")}
                    />
                    <BigRing
                        percent={ram} color={ramColor} label="Memory"
                        sub={`${fmt(stats.memory?.usedBytes)} / ${fmt(stats.memory?.totalBytes)}`}
                    />
                    {disk !== null ? (
                        <BigRing
                            percent={disk} color={diskColor} label={`Disk (${stats.disk.mount})`}
                            sub={`${fmt(stats.disk.usedBytes)} / ${fmt(stats.disk.totalBytes)}`}
                        />
                    ) : (
                        <div className="flex flex-col items-center gap-3 opacity-30">
                            <div className="w-[130px] h-[130px] rounded-full flex items-center justify-center"
                                style={{ border: "11px solid rgba(255,255,255,0.05)" }}>
                                <span className="text-slate-600 text-sm font-bold">N/A</span>
                            </div>
                            <p className="text-sm font-bold text-slate-500">Disk</p>
                        </div>
                    )}
                </div>
            </SectionCard>

            {/* ── Detail cards ── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                {/* CPU */}
                <SectionCard delay={0.1}>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-5 h-5 rounded-lg flex items-center justify-center"
                            style={{ background: `${cpuColor}18`, border: `1px solid ${cpuColor}22` }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={cpuColor} strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <rect x="4" y="4" width="16" height="16" rx="2"/>
                                <rect x="9" y="9" width="6" height="6"/>
                                <line x1="9"  y1="1"  x2="9"  y2="4"/>
                                <line x1="15" y1="1"  x2="15" y2="4"/>
                                <line x1="9"  y1="20" x2="9"  y2="23"/>
                                <line x1="15" y1="20" x2="15" y2="23"/>
                                <line x1="20" y1="9"  x2="23" y2="9"/>
                                <line x1="20" y1="14" x2="23" y2="14"/>
                                <line x1="1"  y1="9"  x2="4"  y2="9"/>
                                <line x1="1"  y1="14" x2="4"  y2="14"/>
                            </svg>
                        </div>
                        <h3 className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                            CPU Details
                        </h3>
                    </div>
                    <StatRow label="Usage"
                        value={`${cpu}%`}
                        accent={cpu > 80 ? "text-rose-400" : cpu > 50 ? "text-amber-400" : "text-emerald-400"}
                        barPercent={cpu} barColor={cpuColor}
                    />
                    <StatRow label="Model"       value={stats.cpu?.model ?? "—"} />
                    <StatRow label="Temperature" value={stats.cpu?.temperature ? `${stats.cpu.temperature}°C` : "Unavailable"} />
                    {history.length > 1 && (
                        <button className="w-full mt-1" onClick={() => setTrendModal("cpu")} title="Expand trend">
                            <Sparkline values={cpuVals} color={cpuColor} samples={history.length} />
                        </button>
                    )}
                </SectionCard>

                {/* RAM */}
                <SectionCard delay={0.14}>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-5 h-5 rounded-lg flex items-center justify-center"
                            style={{ background: `${ramColor}18`, border: `1px solid ${ramColor}22` }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={ramColor} strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <rect x="2" y="8" width="20" height="8" rx="2"/>
                                <line x1="6"  y1="8" x2="6"  y2="16"/>
                                <line x1="10" y1="8" x2="10" y2="16"/>
                                <line x1="14" y1="8" x2="14" y2="16"/>
                                <line x1="18" y1="8" x2="18" y2="16"/>
                                <line x1="4"  y1="4" x2="4"  y2="8"/>
                                <line x1="20" y1="4" x2="20" y2="8"/>
                            </svg>
                        </div>
                        <h3 className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                            Memory Details
                        </h3>
                    </div>
                    <StatRow label="Usage" value={`${ram}%`}
                        accent={ram > 80 ? "text-rose-400" : ram > 50 ? "text-amber-400" : "text-violet-400"}
                        barPercent={ram} barColor={ramColor}
                    />
                    <StatRow label="Used"  value={fmt(stats.memory?.usedBytes)} />
                    <StatRow label="Free"  value={fmt(stats.memory?.freeBytes)} />
                    <StatRow label="Total" value={fmt(stats.memory?.totalBytes)} />
                    {history.length > 1 && (
                        <button className="w-full mt-1" onClick={() => setTrendModal("mem")} title="Expand trend">
                            <Sparkline values={ramVals} color={ramColor} samples={history.length} />
                        </button>
                    )}
                </SectionCard>

                {/* Disk */}
                <SectionCard delay={0.18}>
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-5 h-5 rounded-lg flex items-center justify-center"
                            style={{ background: `${diskColor}18`, border: `1px solid ${diskColor}22` }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke={diskColor} strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                <ellipse cx="12" cy="5"  rx="9" ry="3"/>
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                            </svg>
                        </div>
                        <h3 className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                            Disk Details
                        </h3>
                    </div>
                    {stats.disk ? (
                        <>
                            <StatRow label="Usage" value={`${disk}%`}
                                accent={disk > 85 ? "text-rose-400" : disk > 65 ? "text-amber-400" : "text-sky-400"}
                                barPercent={disk} barColor={diskColor}
                            />
                            <StatRow label="Mount"      value={stats.disk.mount} />
                            <StatRow label="Filesystem" value={stats.disk.fs} />
                            <StatRow label="Used"       value={fmt(stats.disk.usedBytes)} />
                            <StatRow label="Free"       value={fmt(stats.disk.freeBytes)} />
                            <StatRow label="Total"      value={fmt(stats.disk.totalBytes)} />
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-8 opacity-40">
                            <svg viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="1.5" className="w-10 h-10 mb-3">
                                <ellipse cx="12" cy="5"  rx="9" ry="3"/>
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                            </svg>
                            <p className="text-xs text-slate-500">Disk info unavailable</p>
                        </div>
                    )}
                </SectionCard>
            </div>

            {/* Trend modals */}
            <AnimatePresence>
                {trendModal === "cpu" && (
                    <TrendModal key="cpu-trend" title="CPU" color={cpuColor}
                        data={history} valueKey="cpu" onClose={() => setTrendModal(null)} />
                )}
                {trendModal === "mem" && (
                    <TrendModal key="mem-trend" title="RAM" color={ramColor}
                        data={history} valueKey="mem" onClose={() => setTrendModal(null)} />
                )}
            </AnimatePresence>
        </div>
    );
}
