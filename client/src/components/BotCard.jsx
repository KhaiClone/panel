import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";

// ── Helpers ────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
    online: {
        dot: "bg-emerald-400",
        text: "text-emerald-400",
        label: "Online",
    },
    stopped: { dot: "bg-red-400", text: "text-red-400", label: "Stopped" },
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
    const [busy, setBusy] = useState(false); // action in-flight
    const [confirm, setConfirm] = useState(null); // { action, label }

    const style = getStyle(bot.live?.status);
    const now = Date.now();
    const msLeft = bot.expiresAt ? bot.expiresAt - now : null;

    // ── Action helpers ────────────────────────────────────────────────────────
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
            {/* Card */}
            <div className="card flex flex-col gap-4 hover:border-slate-600 transition-colors">
                {/* Top row: name + status */}
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <h3 className="font-semibold text-slate-100 truncate">
                            {bot.name}
                        </h3>
                        <p className="text-xs text-slate-500 font-mono truncate">
                            {bot.buyerID} / {bot.botID}
                        </p>
                    </div>
                    {/* Status badge */}
                    <div
                        className={`flex items-center gap-1.5 shrink-0 text-xs font-medium ${style.text}`}
                    >
                        <span
                            className={`w-2 h-2 rounded-full ${style.dot} ${isOnline ? "animate-pulse" : ""}`}
                        />
                        {style.label}
                    </div>
                </div>

                {/* Expiry */}
                {msLeft !== null && (
                    <div
                        className={`text-xs px-2.5 py-1.5 rounded-lg w-fit ${
                            msLeft <= 0
                                ? "bg-red-900/40 text-red-400 border border-red-800"
                                : msLeft < 3 * 86_400_000
                                  ? "bg-amber-900/40 text-amber-400 border border-amber-800"
                                  : "bg-slate-700 text-slate-400"
                        }`}
                    >
                        ⏳ {formatTimeLeft(msLeft)}
                    </div>
                )}

                {/* Stats row */}
                {bot.live?.status === "online" && (
                    <div className="flex gap-4 text-xs text-slate-500">
                        <span>
                            CPU:{" "}
                            <span className="text-slate-300">
                                {bot.live.cpu ?? 0}%
                            </span>
                        </span>
                        <span>
                            RAM:{" "}
                            <span className="text-slate-300">
                                {bot.live.memory
                                    ? `${(bot.live.memory / 1_048_576).toFixed(0)} MB`
                                    : "—"}
                            </span>
                        </span>
                        <span>
                            ↺{" "}
                            <span className="text-slate-300">
                                {bot.live.restarts ?? 0}
                            </span>
                        </span>
                    </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-700">
                    {isStopped && (
                        <button
                            className="btn-success text-xs py-1.5 px-3"
                            onClick={() => action("start")}
                            disabled={busy}
                        >
                            ▶ Start
                        </button>
                    )}
                    {isOnline && (
                        <button
                            className="btn-danger text-xs py-1.5 px-3"
                            onClick={() => action("stop")}
                            disabled={busy}
                        >
                            ⏹ Stop
                        </button>
                    )}
                    <button
                        className="btn-warning text-xs py-1.5 px-3"
                        onClick={() => action("restart")}
                        disabled={busy}
                    >
                        🔄 Restart
                    </button>
                    <button
                        className="btn-ghost text-xs py-1.5 px-3"
                        onClick={() => navigate(`/bots/${bot._id}`)}
                        disabled={busy}
                    >
                        🔍 Details
                    </button>
                    <button
                        className="btn-danger text-xs py-1.5 px-3 ml-auto"
                        onClick={() =>
                            setConfirm({ action: "delete", label: "Delete" })
                        }
                        disabled={busy}
                    >
                        🗑
                    </button>
                </div>
            </div>

            {/* Delete confirm */}
            {confirm?.action === "delete" && (
                <ConfirmModal
                    title={`Delete "${bot.name}"?`}
                    message="This will stop the bot, remove it from PM2, and permanently delete its source folder. This cannot be undone."
                    confirmText="Delete"
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}
