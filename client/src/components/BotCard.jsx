import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { useData } from "../context/DataContext";

const STATUS_STYLES = {
    online:    { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    stopped:   { color: "var(--danger)", bg: "var(--danger-bg)", border: "var(--danger-border)", label: "Stopped" },
    errored:   { color: "#F97316", bg: "rgba(249,115,22,0.15)", border: "rgba(249,115,22,0.3)", label: "Errored" },
    launching: { color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)", label: "Starting" },
};

const getStyle = (s) => STATUS_STYLES[s] ?? {
    color: "var(--text-muted)", bg: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.1)", label: s ?? "Unknown"
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
            <div className="card card-hover" style={{ 
                padding: "16px 20px", 
                display: "grid", 
                gridTemplateColumns: "1.5fr 1fr 1.2fr 1fr 1fr", 
                alignItems: "center", 
                gap: 16,
                marginBottom: 8,
                background: "var(--bg-card)"
            }}>
                {/* 1. Name & ID */}
                <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
                    <div style={{ 
                        width: 42, height: 42, borderRadius: 10, background: "var(--bg-input)", border: "1px solid var(--border)",
                        display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)", flexShrink: 0
                    }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 20, height: 20 }}>
                            <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>
                        </svg>
                    </div>
                    <div style={{ minWidth: 0 }}>
                        <h3 style={{ fontWeight: 600, fontSize: 15, color: "var(--text)", margin: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {bot.name}
                        </h3>
                        <p className="mono" style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {bot.buyerID} · {bot.botID}
                        </p>
                    </div>
                </div>

                {/* 2. Status & Expiry */}
                <div>
                    <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}>
                        <span className="status-dot" style={{ background: s.color }}/>
                        {s.label}
                    </span>
                    {msLeft !== null && (
                        <div style={{
                            display: "flex", alignItems: "center", gap: 5, marginTop: 6,
                            fontSize: 12, fontWeight: 500,
                            color: isExpired ? "var(--danger)" : isExpiringSoon ? "var(--warning)" : "var(--text-muted)"
                        }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                            </svg>
                            {isExpired ? "Expired" : `${formatTimeLeft(msLeft)} left`}
                        </div>
                    )}
                </div>

                {/* 3. Resources (CPU/RAM) */}
                <div style={{ display: "flex", gap: 20 }}>
                    {isOnline ? (
                        <>
                            <div>
                                <p style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>CPU</p>
                                <p className="mono" style={{ fontSize: 13, fontWeight: 500, color: cpuPct > 80 ? "var(--danger)" : "var(--text)" }}>{cpuPct}%</p>
                            </div>
                            <div>
                                <p style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>RAM</p>
                                <p className="mono" style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{ramMB} MB</p>
                            </div>
                        </>
                    ) : (
                        <span style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic" }}>Offline</span>
                    )}
                </div>

                {/* 4. Tags */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {botTags.slice(0, 3).map(tag => (
                        <span key={tag._id} className="badge" style={{
                            background: `${tag.color}15`, border: `1px solid ${tag.color}30`, color: tag.color,
                        }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", background: tag.color }}/>
                            {tag.name}
                        </span>
                    ))}
                    {botTags.length > 3 && (
                        <span className="badge" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>
                            +{botTags.length - 3}
                        </span>
                    )}
                </div>

                {/* 5. Actions */}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    {isStopped ? (
                        <button className="btn-success" style={{ padding: "6px 12px" }} onClick={() => action("start")} disabled={busy} title="Start">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        </button>
                    ) : (
                        <button className="btn-danger" style={{ padding: "6px 12px" }} onClick={() => action("stop")} disabled={busy} title="Stop">
                            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                        </button>
                    )}
                    <button className="btn-warning" style={{ padding: "6px 12px" }} onClick={() => action("restart")} disabled={busy} title="Restart">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                    </button>
                    <button className="btn-primary" style={{ padding: "6px 12px" }} onClick={() => navigate(`/bots/${bot._id}`)} disabled={busy} title="Manage">
                        Manage
                    </button>
                    <button className="btn-ghost" style={{ padding: "6px 10px", color: "var(--danger)" }} onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 16, height: 16 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    </button>
                </div>
            </div>

            {confirm?.action === "delete" && (
                <ConfirmModal
                    title={`Delete "${bot.name}"?`}
                    message={
                        bot.source === "local"
                            ? "This will stop the PM2 process and remove the bot from the panel.\n\nYour project folder stays safe on disk."
                            : "This will stop the PM2 process, remove the bot, and delete the project folder from disk.\n\nThis action is irreversible."
                    }
                    confirmText={bot.source === "local" ? "Remove from Panel" : "Delete permanently"}
                    onConfirm={handleDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}
