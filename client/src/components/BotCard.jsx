import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { motion } from "framer-motion";

// ── Helpers ────────────────────────────────────────────────────────────────
const STATUS_STYLES = {
    online:   { dot: "bg-emerald-400", ring: "rgba(52,211,153,0.25)", text: "text-emerald-400", label: "Online",   bg: "rgba(5,150,105,0.1)",  border: "rgba(16,185,129,0.2)" },
    stopped:  { dot: "bg-rose-400",    ring: "rgba(248,113,113,0.2)",  text: "text-rose-400",    label: "Stopped",  bg: "rgba(220,38,38,0.1)",  border: "rgba(239,68,68,0.2)"  },
    errored:  { dot: "bg-orange-400",  ring: "rgba(251,146,60,0.25)",  text: "text-orange-400",  label: "Errored",  bg: "rgba(234,88,12,0.1)",  border: "rgba(249,115,22,0.2)" },
    launching:{ dot: "bg-yellow-400",  ring: "rgba(250,204,21,0.2)",   text: "text-yellow-300",  label: "Starting", bg: "rgba(202,138,4,0.1)",  border: "rgba(234,179,8,0.2)"  },
};
const getStyle = (s) => STATUS_STYLES[s] ?? { dot: "bg-slate-500", ring: "rgba(100,116,139,0.2)", text: "text-slate-400", label: s ?? "Unknown", bg: "rgba(100,116,139,0.08)", border: "rgba(100,116,139,0.15)" };

const formatTimeLeft = (ms) => {
    if (ms <= 0) return "Expired";
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

// ── Component ──────────────────────────────────────────────────────────────
export default function BotCard({ bot, onRefresh }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const style = getStyle(bot.live?.status);
    const now = Date.now();
    const msLeft = bot.expiresAt ? bot.expiresAt - now : null;
    const isOnline = bot.live?.status === "online";
    const isStopped = bot.live?.status === "stopped" || !bot.live?.status;
    const isExpiringSoon = msLeft !== null && msLeft > 0 && msLeft < 3 * 86_400_000;
    const isExpired = msLeft !== null && msLeft <= 0;

    const action = async (endpoint) => {
        setBusy(true);
        try {
            await api.post(`/bots/${bot._id}/${endpoint}`);
            onRefresh();
        } catch (err) {
            alert(err.response?.data?.error || `Failed: ${endpoint}`);
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async () => {
        setConfirm(null);
        setBusy(true);
        try {
            await api.delete(`/bots/${bot._id}`);
            onRefresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to delete");
        } finally {
            setBusy(false);
        }
    };

    const cpuPct = bot.live?.cpu ?? 0;
    const ramMB = bot.live?.memory ? Math.round(bot.live.memory / 1_048_576) : 0;

    return (
        <>
            <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 400, damping: 28 }} className="relative group">
                <div
                    className="relative rounded-2xl overflow-hidden flex flex-col gap-0 transition-all duration-300"
                    style={{
                        background: "linear-gradient(160deg, rgba(17,24,39,0.95) 0%, rgba(10,15,28,0.95) 100%)",
                        border: `1px solid ${isOnline ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.06)"}`,
                        boxShadow: isOnline
                            ? "0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(52,211,153,0.06)"
                            : "0 4px 24px rgba(0,0,0,0.3)",
                    }}
                >
                    {/* Status accent bar top */}
                    <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-2xl transition-opacity duration-300 opacity-0 group-hover:opacity-100"
                        style={{ background: `linear-gradient(90deg, ${style.dot.includes("emerald") ? "#34d399" : style.dot.includes("rose") ? "#f87171" : style.dot.includes("orange") ? "#fb923c" : "#fbbf24"}, transparent)` }} />

                    {/* Card body */}
                    <div className="p-4 flex flex-col gap-3.5">
                        {/* Header row */}
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                                <h3 className="font-bold text-sm text-slate-100 truncate leading-tight group-hover:text-violet-300 transition-colors">
                                    {bot.name}
                                </h3>
                                <p className="text-[10px] text-slate-600 font-mono tracking-tight truncate mt-0.5">
                                    {bot.buyerID} · {bot.botID}
                                </p>
                            </div>
                            {/* Status badge */}
                            <div className="flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.08em]"
                                style={{ background: style.bg, border: `1px solid ${style.border}`, color: style.text.replace("text-", "") }}>
                                <span className="relative flex h-1.5 w-1.5">
                                    {isOnline && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-70 ${style.dot}`} />}
                                    <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${style.dot}`} />
                                </span>
                                <span className={style.text}>{style.label}</span>
                            </div>
                        </div>

                        {/* Expiry tag */}
                        {msLeft !== null && (
                            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg w-fit text-[9px] font-bold uppercase tracking-wider"
                                style={{
                                    background: isExpired ? "rgba(220,38,38,0.1)" : isExpiringSoon ? "rgba(217,119,6,0.1)" : "rgba(255,255,255,0.03)",
                                    border: `1px solid ${isExpired ? "rgba(239,68,68,0.2)" : isExpiringSoon ? "rgba(245,158,11,0.2)" : "rgba(255,255,255,0.06)"}`,
                                    color: isExpired ? "#f87171" : isExpiringSoon ? "#fbbf24" : "#64748b",
                                }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                                </svg>
                                {isExpired ? "Expired" : `${formatTimeLeft(msLeft)} left`}
                            </div>
                        )}

                        {/* Resource mini-stats (online only) */}
                        {isOnline && (
                            <div className="grid grid-cols-3 gap-2 rounded-xl p-2.5"
                                style={{ background: "rgba(6,11,20,0.6)", border: "1px solid rgba(255,255,255,0.04)" }}>
                                {[
                                    { label: "CPU", value: `${cpuPct}%`, color: cpuPct > 80 ? "#f87171" : cpuPct > 50 ? "#fb923c" : "#818cf8" },
                                    { label: "RAM", value: ramMB ? `${ramMB}MB` : "—", color: "#818cf8" },
                                    { label: "Restarts", value: bot.live?.restarts ?? 0, color: "#94a3b8" },
                                ].map(({ label, value, color }) => (
                                    <div key={label} className="text-center">
                                        <p className="text-[8px] text-slate-600 font-black uppercase tracking-wider">{label}</p>
                                        <p className="text-xs font-black font-mono mt-0.5" style={{ color }}>{value}</p>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex flex-wrap gap-1.5 pt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                            {isStopped ? (
                                <button className="btn-success text-[9px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider" onClick={() => action("start")} disabled={busy}>
                                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                                    Start
                                </button>
                            ) : (
                                <button className="btn-danger text-[9px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider" onClick={() => action("stop")} disabled={busy}>
                                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                                    Stop
                                </button>
                            )}
                            <button className="btn-warning text-[9px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider" onClick={() => action("restart")} disabled={busy}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                                    <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
                                </svg>
                                Restart
                            </button>
                            <button className="btn-ghost text-[9px] py-1.5 px-2.5 font-black" onClick={() => navigate(`/bots/${bot._id}`)} disabled={busy} title="View Details">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                                </svg>
                            </button>
                            <button
                                className="text-[9px] py-1.5 px-2.5 font-black rounded-lg transition-all"
                                style={{ background: "rgba(220,38,38,0.08)", color: "#f87171", border: "1px solid rgba(239,68,68,0.15)" }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.18)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(220,38,38,0.08)"; }}
                                onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                    <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </motion.div>

            {confirm?.action === "delete" && (
                <ConfirmModal
                    title={`Delete "${bot.name}"?`}
                    message={
                        bot.source === "local"
                            ? "This will stop the PM2 process and remove the bot from the panel.\n\n📂 Your project folder will NOT be deleted — it stays safe on disk."
                            : "This will stop the PM2 process, remove the bot from the panel, and delete the project folder from disk.\n\n⚠️ This action is irreversible."
                    }
                    confirmText={bot.source === "local" ? "Remove from Panel" : "Delete permanently"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}
