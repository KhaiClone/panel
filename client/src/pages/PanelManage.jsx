import { useState, useEffect, useRef, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt = (bytes) => {
    if (!bytes && bytes !== 0) return "—";
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
};

const fmtUptime = (ts) => {
    if (!ts) return "—";
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ${min % 60}m`;
    const day = Math.floor(hr / 24);
    return `${day}d ${hr % 24}h`;
};

// ── Status config ──────────────────────────────────────────────────────────
const STATUS_MAP = {
    online: { label: "Online", color: "text-emerald-400", bg: "bg-emerald-500/10", ring: "ring-emerald-500/30", dot: "bg-emerald-400", glow: "shadow-emerald-500/20" },
    stopping: { label: "Stopping", color: "text-amber-400", bg: "bg-amber-500/10", ring: "ring-amber-500/30", dot: "bg-amber-400", glow: "shadow-amber-500/20" },
    stopped: { label: "Stopped", color: "text-slate-400", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-400", glow: "shadow-slate-500/20" },
    errored: { label: "Errored", color: "text-red-400", bg: "bg-red-500/10", ring: "ring-red-500/30", dot: "bg-red-400", glow: "shadow-red-500/20" },
    launching: { label: "Launching", color: "text-blue-400", bg: "bg-blue-500/10", ring: "ring-blue-500/30", dot: "bg-blue-400", glow: "shadow-blue-500/20" },
    not_found: { label: "Not Found", color: "text-slate-500", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-500", glow: "shadow-slate-500/20" },
    unknown: { label: "Unknown", color: "text-slate-500", bg: "bg-slate-500/10", ring: "ring-slate-500/30", dot: "bg-slate-500", glow: "shadow-slate-500/20" },
};

// ── Reconnect overlay ──────────────────────────────────────────────────────
function ReconnectOverlay({ onReconnected }) {
    const [dots, setDots] = useState("");
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const dotTimer = setInterval(() => {
            setDots((d) => (d.length >= 3 ? "" : d + "."));
        }, 500);
        return () => clearInterval(dotTimer);
    }, []);

    useEffect(() => {
        const timer = setInterval(async () => {
            setAttempt((a) => a + 1);
            try {
                await api.get("/panel/status");
                onReconnected();
            } catch {
                // still down
            }
        }, 2000);
        return () => clearInterval(timer);
    }, [onReconnected]);

    return (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-xl flex flex-col items-center justify-center gap-6">
            <div className="relative">
                <div className="w-20 h-20 rounded-full border-4 border-indigo-500/30 border-t-indigo-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-3xl">🔄</span>
                </div>
            </div>
            <div className="text-center space-y-2">
                <h2 className="text-xl font-bold text-slate-100">
                    Panel Restarting{dots}
                </h2>
                <p className="text-sm text-slate-400">
                    Waiting for the panel to come back online
                </p>
                <p className="text-xs text-slate-600">
                    Attempt #{attempt}
                </p>
            </div>
        </div>
    );
}

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, accent = "text-slate-100" }) {
    return (
        <div className="card group hover:scale-[1.02] transition-transform duration-200">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-800/80 flex items-center justify-center text-lg shrink-0 group-hover:scale-110 transition-transform">
                    {icon}
                </div>
                <div className="min-w-0">
                    <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{label}</p>
                    <p className={`text-lg font-bold ${accent} truncate`}>{value}</p>
                    {sub && <p className="text-[10px] text-slate-500 truncate">{sub}</p>}
                </div>
            </div>
        </div>
    );
}

// ── Action button ──────────────────────────────────────────────────────────
function ActionButton({ icon, label, description, onClick, loading, disabled, color = "indigo" }) {
    const colors = {
        indigo: "from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 shadow-indigo-600/20 disabled:from-indigo-900 disabled:to-indigo-900",
        amber: "from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 shadow-amber-600/20 disabled:from-amber-900 disabled:to-amber-900",
        rose: "from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 shadow-rose-600/20 disabled:from-rose-900 disabled:to-rose-900",
    };

    return (
        <button
            onClick={onClick}
            disabled={loading || disabled}
            className={`relative w-full p-4 rounded-xl bg-gradient-to-br ${colors[color]} shadow-lg text-left transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 group`}
        >
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-lg shrink-0">
                    {loading ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        icon
                    )}
                </div>
                <div className="min-w-0">
                    <p className="font-bold text-white text-sm">{label}</p>
                    <p className="text-[11px] text-white/60 truncate">{description}</p>
                </div>
            </div>
        </button>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main Page
// ═══════════════════════════════════════════════════════════════════════════
export default function PanelManage() {
    const [status, setStatus] = useState(null);
    const [logs, setLogs] = useState("");
    const [logsLoading, setLogsLoading] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [confirm, setConfirm] = useState(null);
    const [building, setBuilding] = useState(false);
    const [buildOutput, setBuildOutput] = useState(null);
    const logsEndRef = useRef(null);

    // ── Fetch status ───────────────────────────────────────────────────────
    const fetchStatus = useCallback(() => {
        api.get("/panel/status")
            .then((r) => setStatus(r.data))
            .catch(() => {});
    }, []);

    useEffect(() => {
        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // ── Fetch logs ─────────────────────────────────────────────────────────
    const fetchLogs = async () => {
        setLogsLoading(true);
        try {
            const r = await api.get("/panel/logs?lines=200");
            setLogs(r.data.logs || "No logs available");
        } catch {
            setLogs("Failed to fetch logs");
        } finally {
            setLogsLoading(false);
        }
    };

    useEffect(() => {
        if (showLogs) fetchLogs();
    }, [showLogs]);

    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs]);

    // ── Actions ────────────────────────────────────────────────────────────
    const handleRestart = () => {
        setConfirm({
            title: "Restart Panel",
            message: "The panel will restart. You'll lose connection for a few seconds while it comes back up. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                try {
                    await api.post("/panel/restart");
                    // Show reconnect overlay after a short delay
                    setTimeout(() => setReconnecting(true), 1000);
                } catch (err) {
                    alert("Failed to restart: " + (err.response?.data?.message || err.message));
                }
            },
        });
    };

    const handleRebuild = () => {
        setConfirm({
            title: "Rebuild & Restart Panel",
            message: "This will rebuild the client UI (may take 30-60 seconds) and then restart the panel. The panel stays online during the build. Continue?",
            onConfirm: async () => {
                setConfirm(null);
                setBuilding(true);
                setBuildOutput(null);
                try {
                    const r = await api.post("/panel/rebuild");
                    setBuildOutput({ success: true, output: r.data.buildOutput, message: r.data.message });
                    // Show reconnect overlay after a short delay
                    setTimeout(() => setReconnecting(true), 1000);
                } catch (err) {
                    const data = err.response?.data;
                    setBuildOutput({
                        success: false,
                        output: data?.buildOutput || err.message,
                        message: data?.message || "Build failed",
                    });
                } finally {
                    setBuilding(false);
                }
            },
        });
    };

    const handleReconnected = useCallback(() => {
        setReconnecting(false);
        fetchStatus();
        // Refresh the page to load potentially new assets
        window.location.reload();
    }, [fetchStatus]);

    // ── Render ─────────────────────────────────────────────────────────────
    const s = status ? STATUS_MAP[status.status] || STATUS_MAP.unknown : null;

    return (
        <div className="p-6 max-w-4xl mx-auto space-y-6">
            {/* Reconnect overlay */}
            {reconnecting && <ReconnectOverlay onReconnected={handleReconnected} />}

            {/* Confirm modal */}
            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    onConfirm={confirm.onConfirm}
                    onCancel={() => setConfirm(null)}
                />
            )}

            {/* Header */}
            <div>
                <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-bold text-slate-100">Panel Management</h1>
                    {s && (
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ring-1 ${s.bg} ${s.color} ${s.ring}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${s.dot} animate-pulse`} />
                            {s.label}
                        </span>
                    )}
                </div>
                <p className="text-sm text-slate-500 mt-1">
                    Manage the panel itself — restart, rebuild, and view logs
                </p>
            </div>

            {/* Status cards */}
            {status ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard
                        icon="📛"
                        label="PM2 Name"
                        value={status.name}
                        sub={status.pm_id !== null ? `ID: ${status.pm_id}` : null}
                    />
                    <StatCard
                        icon="⏱️"
                        label="Uptime"
                        value={fmtUptime(status.uptime)}
                        accent="text-indigo-400"
                    />
                    <StatCard
                        icon="🧠"
                        label="Memory"
                        value={fmt(status.memory)}
                        sub={`CPU: ${status.cpu}%`}
                        accent="text-blue-400"
                    />
                    <StatCard
                        icon="🔁"
                        label="Restarts"
                        value={status.restarts}
                        accent={status.restarts > 10 ? "text-amber-400" : "text-slate-100"}
                    />
                </div>
            ) : (
                <div className="flex justify-center py-8">
                    <div className="animate-spin h-8 w-8 border-4 border-indigo-500 border-t-transparent rounded-full" />
                </div>
            )}

            {/* Action buttons */}
            <div className="space-y-3">
                <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                    Actions
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ActionButton
                        icon="🔄"
                        label="Restart Panel"
                        description="Restart the PM2 process (~3s downtime)"
                        onClick={handleRestart}
                        color="indigo"
                    />
                    <ActionButton
                        icon="🏗️"
                        label="Rebuild & Restart"
                        description="Rebuild client UI, then restart (30-60s)"
                        onClick={handleRebuild}
                        loading={building}
                        color="amber"
                    />
                </div>
            </div>

            {/* Build output */}
            {buildOutput && (
                <div className={`card border ${buildOutput.success ? "border-emerald-500/30" : "border-red-500/30"}`}>
                    <div className="flex items-center gap-2 mb-3">
                        <span className="text-lg">{buildOutput.success ? "✅" : "❌"}</span>
                        <h3 className={`text-sm font-bold ${buildOutput.success ? "text-emerald-400" : "text-red-400"}`}>
                            {buildOutput.message}
                        </h3>
                        <button
                            onClick={() => setBuildOutput(null)}
                            className="ml-auto text-slate-500 hover:text-slate-300 text-xs"
                        >
                            Dismiss
                        </button>
                    </div>
                    {buildOutput.output && (
                        <pre className="text-xs text-slate-400 bg-slate-900/60 rounded-lg p-3 max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                            {buildOutput.output}
                        </pre>
                    )}
                </div>
            )}

            {/* Logs section */}
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                        Panel Logs
                    </h2>
                    <div className="flex items-center gap-2">
                        {showLogs && (
                            <button
                                onClick={fetchLogs}
                                disabled={logsLoading}
                                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
                            >
                                {logsLoading ? "Loading..." : "🔄 Refresh"}
                            </button>
                        )}
                        <button
                            onClick={() => setShowLogs((v) => !v)}
                            className="text-xs text-slate-400 hover:text-slate-200 transition-colors px-2 py-1 rounded bg-slate-800/60 hover:bg-slate-700/60"
                        >
                            {showLogs ? "Hide Logs" : "Show Logs"}
                        </button>
                    </div>
                </div>

                {showLogs && (
                    <div className="card p-0 overflow-hidden">
                        <pre className="text-xs text-slate-300 bg-slate-950 p-4 max-h-96 overflow-auto font-mono whitespace-pre-wrap leading-relaxed">
                            {logsLoading ? (
                                <span className="text-slate-500">Loading logs...</span>
                            ) : (
                                logs
                            )}
                            <div ref={logsEndRef} />
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
