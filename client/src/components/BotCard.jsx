import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { motion } from "framer-motion";

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
    online: {
        dot: "bg-emerald-400",
        text: "text-emerald-400",
        label: "Online",
    },
    stopped: { dot: "bg-rose-400", text: "text-rose-400", label: "Stopped" },
    errored: {
        dot: "bg-orange-400",
        text: "text-orange-400",
        label: "Errored",
    },
    launching: {
        dot: "bg-yellow-400",
        text: "text-yellow-400",
        label: "Starting",
    },
};

const getStyle = (s) =>
    STATUS_STYLES[s] ?? {
        dot: "bg-slate-500",
        text: "text-slate-400",
        label: s ?? "Unknown",
    };

const formatTimeLeft = (ms) => {
    if (ms <= 0) return "Expired";
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h left`;
    if (h > 0) return `${h}h ${m}m left`;
    return `${m}m left`;
};

// ── Component ──────────────────────────────────────────────────────────────

export default function BotCard({ bot, onRefresh }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const style = getStyle(bot.live?.status);
    const now = Date.now();
    const msLeft = bot.expiresAt ? bot.expiresAt - now : null;

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

    const isOnline = bot.live?.status === "online";
    const isStopped = bot.live?.status === "stopped" || !bot.live?.status;

    return (
        <>
        <motion.div 
            whileHover={{ y: -5 }}
            className="group relative"
        >
            {/* Card */}
            <div className="card flex flex-col gap-4 bg-slate-900/60 border-slate-800/80 hover:border-indigo-500/30 shadow-2xl">
                {/* Top row: name + status */}
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h3 className="font-bold text-slate-100 truncate group-hover:text-indigo-400 transition-colors">
                            {bot.name}
                        </h3>
                        <p className="text-[10px] text-slate-500 font-mono tracking-tight truncate mt-0.5">
                            {bot.buyerID} / {bot.botID}
                        </p>
                    </div>
                    {/* Status badge */}
                    <div className={`flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-full bg-slate-800/50 border border-slate-700/50 text-[10px] font-black uppercase tracking-widest ${style.text}`}>
                        <span className="relative flex h-2 w-2">
                            {isOnline && (
                                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${style.dot}`}></span>
                            )}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${style.dot}`}></span>
                        </span>
                        {style.label}
                    </div>
                </div>

                {/* Expiry */}
                {msLeft !== null && (
                    <div className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1.5 rounded-lg w-fit backdrop-blur-sm border ${
                        msLeft <= 0
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                            : msLeft < 3 * 86_400_000
                                ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                : "bg-slate-800/50 text-slate-400 border-slate-700/50"
                    }`}>
                        ⏳ {formatTimeLeft(msLeft)}
                    </div>
                )}

                {/* Stats row */}
                {isOnline && (
                    <div className="grid grid-cols-3 gap-2 bg-slate-950/40 p-2 rounded-lg border border-slate-800/50">
                        <div className="text-center">
                            <p className="text-[9px] text-slate-500 font-black uppercase">CPU</p>
                            <p className="text-xs text-indigo-400 font-mono">{bot.live.cpu ?? 0}%</p>
                        </div>
                        <div className="text-center border-x border-slate-800/50">
                            <p className="text-[9px] text-slate-500 font-black uppercase">RAM</p>
                            <p className="text-xs text-indigo-400 font-mono">
                                {bot.live.memory ? `${(bot.live.memory / 1_048_576).toFixed(0)}MB` : "—"}
                            </p>
                        </div>
                        <div className="text-center">
                            <p className="text-[9px] text-slate-500 font-black uppercase">Restarts</p>
                            <p className="text-xs text-indigo-400 font-mono">{bot.live.restarts ?? 0}</p>
                        </div>
                    </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-800/50">
                    {isStopped ? (
                        <button
                            className="btn-success text-[10px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider"
                            onClick={() => action("start")}
                            disabled={busy}
                        >
                            Start
                        </button>
                    ) : (
                        <button
                            className="btn-danger text-[10px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider"
                            onClick={() => action("stop")}
                            disabled={busy}
                        >
                            Stop
                        </button>
                    )}
                    <button
                        className="btn-warning text-[10px] py-1.5 px-3 flex-1 font-black uppercase tracking-wider"
                        onClick={() => action("restart")}
                        disabled={busy}
                    >
                        Restart
                    </button>
                    <button
                        className="btn-ghost text-[10px] py-1.5 px-3 font-black uppercase tracking-wider"
                        onClick={() => navigate(`/bots/${bot._id}`)}
                        disabled={busy}
                    >
                        🔍
                    </button>
                    <button
                        className="btn-danger bg-rose-600/10 hover:bg-rose-600/20 text-rose-500 border border-rose-500/20 text-[10px] py-1.5 px-3 ml-auto rounded-lg transition-all"
                        onClick={() => setConfirm({ action: "delete", label: "Delete" })}
                        disabled={busy}
                    >
                        🗑️
                    </button>
                </div>
            </div>
        </motion.div>

        {/* Delete confirm — rendered outside the card so it covers the full screen */}
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
