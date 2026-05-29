import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { useData } from "../context/DataContext";

const STATUS_STYLES = {
    online:    { color: "#22c55e", bg: "rgba(34,197,94,0.1)",    border: "rgba(34,197,94,0.3)",   label: "Online"   },
    stopped:   { color: "#ef4444", bg: "rgba(239,68,68,0.1)",    border: "rgba(239,68,68,0.3)",   label: "Stopped"  },
    errored:   { color: "#f97316", bg: "rgba(249,115,22,0.1)",   border: "rgba(249,115,22,0.3)",  label: "Errored"  },
    launching: { color: "#f59e0b", bg: "rgba(245,158,11,0.1)",   border: "rgba(245,158,11,0.3)",  label: "Starting" },
};
const getStyle = (s) => STATUS_STYLES[s] ?? {
    color: "#8892a4", bg: "rgba(136,146,164,0.08)", border: "rgba(136,146,164,0.2)", label: s ?? "Unknown"
};

const formatTimeLeft = (ms) => {
    if (ms <= 0) return "Expired";
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

export default function BotCard({ bot, onRefresh }) {
    const navigate = useNavigate();
    const { tags: allTags } = useData();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const botTags = (bot.tags || []).map(id => allTags.find(t => t._id === id)).filter(Boolean);
    const s = getStyle(bot.live?.status);
    const now = Date.now();
    const msLeft = bot.expiresAt ? bot.expiresAt - now : null;
    const isOnline = bot.live?.status === "online";
    const isStopped = bot.live?.status === "stopped" || !bot.live?.status;
    const isExpiringSoon = msLeft !== null && msLeft > 0 && msLeft < 3 * 86_400_000;
    const isExpired = msLeft !== null && msLeft <= 0;
    const cpuPct = bot.live?.cpu ?? 0;
    const ramMB = bot.live?.memory ? Math.round(bot.live.memory / 1_048_576) : 0;

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

    return (
        <>
            <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14 }}>
                {/* Header */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <h3 style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {bot.name}
                        </h3>
                        <p className="mono" style={{ color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {bot.buyerID} · {bot.botID}
                        </p>
                    </div>
                    {/* Status badge */}
                    <span style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "3px 8px", borderRadius: 99,
                        fontSize: 11, fontWeight: 600, flexShrink: 0,
                        background: s.bg, border: `1px solid ${s.border}`, color: s.color,
                    }}>
                        <span style={{
                            width: 6, height: 6, borderRadius: "50%", background: s.color,
                            display: "inline-block", flexShrink: 0,
                        }}/>
                        {s.label}
                    </span>
                </div>

                {/* Tags */}
                {botTags.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {botTags.map(tag => (
                            <span key={tag._id} style={{
                                display: "inline-flex", alignItems: "center", gap: 4,
                                padding: "2px 7px", borderRadius: 99, fontSize: 11, fontWeight: 500,
                                background: `${tag.color}18`, border: `1px solid ${tag.color}40`, color: tag.color,
                            }}>
                                <span style={{ width: 5, height: 5, borderRadius: "50%", background: tag.color }}/>
                                {tag.name}
                            </span>
                        ))}
                    </div>
                )}

                {/* Expiry */}
                {msLeft !== null && (
                    <div style={{
                        display: "inline-flex", alignItems: "center", gap: 5,
                        padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 500, width: "fit-content",
                        background: isExpired ? "rgba(239,68,68,0.08)" : isExpiringSoon ? "rgba(245,158,11,0.08)" : "var(--bg-input)",
                        border: `1px solid ${isExpired ? "rgba(239,68,68,0.25)" : isExpiringSoon ? "rgba(245,158,11,0.25)" : "var(--border)"}`,
                        color: isExpired ? "#f87171" : isExpiringSoon ? "#fbbf24" : "var(--text-muted)",
                    }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12 }}>
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        {isExpired ? "Expired" : `${formatTimeLeft(msLeft)} left`}
                    </div>
                )}

                {/* Resource stats (online only) */}
                {isOnline && (
                    <div style={{
                        display: "grid", gridTemplateColumns: "repeat(3, 1fr)",
                        gap: 6, padding: "8px 10px", borderRadius: 7,
                        background: "var(--bg-input)", border: "1px solid var(--border)",
                    }}>
                        {[
                            { label: "CPU", value: `${cpuPct}%`, color: cpuPct > 80 ? "#f87171" : cpuPct > 50 ? "#fb923c" : "var(--text-muted)" },
                            { label: "RAM", value: ramMB ? `${ramMB}MB` : "—", color: "var(--text-muted)" },
                            { label: "Restarts", value: bot.live?.restarts ?? 0, color: "var(--text-muted)" },
                        ].map(({ label, value, color }) => (
                            <div key={label} style={{ textAlign: "center" }}>
                                <p style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</p>
                                <p className="mono" style={{ fontSize: 12, fontWeight: 700, color, marginTop: 2 }}>{value}</p>
                            </div>
                        ))}
                    </div>
                )}

                {/* Actions */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                    {isStopped ? (
                        <button className="btn-success" style={{ flex: 1, fontSize: 12 }} onClick={() => action("start")} disabled={busy}>
                            ▶ Start
                        </button>
                    ) : (
                        <button className="btn-danger" style={{ flex: 1, fontSize: 12 }} onClick={() => action("stop")} disabled={busy}>
                            ⏹ Stop
                        </button>
                    )}
                    <button className="btn-warning" style={{ flex: 1, fontSize: 12 }} onClick={() => action("restart")} disabled={busy}>
                        ↺ Restart
                    </button>
                    <button className="btn-ghost" style={{ fontSize: 12, padding: "7px 10px" }} onClick={() => navigate(`/bots/${bot._id}`)} disabled={busy} title="View Details">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                        </svg>
                    </button>
                    <button
                        className="btn-danger"
                        style={{ fontSize: 12, padding: "7px 10px" }}
                        onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
                    </button>
                </div>
            </div>

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
