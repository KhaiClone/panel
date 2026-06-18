import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { useData } from "../context/DataContext";

const STATUS_STYLES = {
    online:    { color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)", label: "Online" },
    stopped:   { color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)",  label: "Stopped" },
    errored:   { color: "#F97316", bg: "rgba(249,115,22,0.15)", border: "rgba(249,115,22,0.3)",    label: "Errored" },
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
    const ramMB  = bot.live?.memory ? Math.round(bot.live.memory / 1_048_576) : 0;
    
    // Parse memory limit
    let limitMB = 1024;
    if (bot.maxMemory) {
        const m = bot.maxMemory.match(/^(\d+)(K|M|G)?$/i);
        if (m) {
            const v = parseInt(m[1]);
            const u = (m[2] || 'M').toUpperCase();
            if (u === 'K') limitMB = v / 1024;
            else if (u === 'G') limitMB = v * 1024;
            else limitMB = v;
        }
    }
    const ramPct = Math.round((ramMB / limitMB) * 100);

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
            <div
                className="card card-hover"
                style={{
                    padding: 0,
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                    position: "relative",
                    opacity: busy ? 0.7 : 1,
                    transition: "opacity 0.2s",
                }}
            >
                {/* Colored status strip at top */}
                <div style={{
                    height: 3,
                    background: `linear-gradient(90deg, ${s.color}, transparent)`,
                    flexShrink: 0,
                }} />

                {/* Card body */}
                <div style={{ padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>

                    {/* Row 1: Avatar + Name + Status pill */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        {/* Bot icon avatar */}
                        <div style={{
                            width: 38, height: 38, borderRadius: 10,
                            background: "var(--bg-input)", border: "1px solid var(--border)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: "var(--accent)", flexShrink: 0,
                        }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 18, height: 18 }}>
                                <rect x="2" y="3" width="20" height="14" rx="2"/>
                                <line x1="8" y1="21" x2="16" y2="21"/>
                                <line x1="12" y1="17" x2="12" y2="21"/>
                            </svg>
                        </div>

                        {/* Name + buyer */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                <h3 style={{
                                    fontWeight: 700, fontSize: 14, color: "var(--text)", margin: 0,
                                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                                }}>
                                    {bot.name}
                                </h3>
                                {bot.projectType === "website" && (
                                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4, background: "rgba(34,197,94,0.12)", color: "#4ade80", border: "1px solid rgba(34,197,94,0.25)", flexShrink: 0 }}>
                                        {bot.websiteConfig?.mode === "fullstack" ? "Full-Stack" : "Static"}
                                    </span>
                                )}
                                {bot.projectType === "service" && (
                                    <span style={{ fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: 4, background: "rgba(167,139,250,0.12)", color: "#a78bfa", border: "1px solid rgba(167,139,250,0.25)", flexShrink: 0 }}>
                                        Service
                                    </span>
                                )}
                            </div>
                            <p className="mono" style={{
                                fontSize: 11, color: "var(--text-dim)", marginTop: 2,
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                                {bot.buyerID}
                            </p>
                        </div>

                        {/* Status pill — compact */}
                        <span className="status-pill" style={{
                            background: s.bg,
                            border: `1px solid ${s.border}`,
                            color: s.color,
                            fontSize: 11,
                            padding: "3px 8px",
                            flexShrink: 0,
                        }}>
                            <span className="status-dot" style={{ background: s.color, width: 6, height: 6 }} />
                            {s.label}
                        </span>
                    </div>

                    {/* Row 2: Expiry (only if set) */}
                    {msLeft !== null && (
                        <div style={{
                            display: "flex", alignItems: "center", gap: 5,
                            fontSize: 11, fontWeight: 500,
                            color: isExpired ? "var(--danger)" : isExpiringSoon ? "var(--warning)" : "var(--text-dim)",
                            background: "var(--bg-input)", borderRadius: 6,
                            padding: "4px 8px", width: "fit-content",
                        }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 12, height: 12, flexShrink: 0 }}>
                                <circle cx="12" cy="12" r="10"/>
                                <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            {isExpired ? "Expired" : `${formatTimeLeft(msLeft)} left`}
                        </div>
                    )}

                    {/* Row 3: Resource mini-bars */}
                    {isOnline ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {/* CPU bar */}
                            <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>CPU</span>
                                    <span className="mono" style={{ fontSize: 10, color: cpuPct > 80 ? "var(--danger)" : "var(--text-muted)" }}>{cpuPct}%</span>
                                </div>
                                <div style={{ height: 3, background: "var(--bg-input)", borderRadius: 2, overflow: "hidden" }}>
                                    <div style={{
                                        height: "100%",
                                        width: `${Math.min(cpuPct, 100)}%`,
                                        background: cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--accent)",
                                        borderRadius: 2,
                                        transition: "width 0.4s ease",
                                    }} />
                                </div>
                            </div>
                            {/* RAM bar */}
                            <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em" }}>RAM</span>
                                    <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>{ramMB} MB</span>
                                </div>
                                <div style={{ height: 3, background: "var(--bg-input)", borderRadius: 2, overflow: "hidden" }}>
                                    <div style={{
                                        height: "100%",
                                        width: `${Math.min(ramPct, 100)}%`,
                                        background: "#60A5FA",
                                        borderRadius: 2,
                                        transition: "width 0.4s ease",
                                    }} />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{
                            fontSize: 11, color: "var(--text-dim)", fontStyle: "italic",
                            textAlign: "center", padding: "6px 0",
                        }}>
                            — Offline —
                        </div>
                    )}

                    {/* Row 4: Tags */}
                    {botTags.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {botTags.slice(0, 3).map(tag => (
                                <span key={tag._id} className="badge" style={{
                                    background: `${tag.color}18`,
                                    border: `1px solid ${tag.color}30`,
                                    color: tag.color,
                                    fontSize: 10,
                                    padding: "2px 7px",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 4,
                                }}>
                                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: tag.color, flexShrink: 0 }} />
                                    {tag.name}
                                </span>
                            ))}
                            {botTags.length > 3 && (
                                <span className="badge" style={{
                                    background: "var(--bg-input)", color: "var(--text-dim)",
                                    fontSize: 10, padding: "2px 7px",
                                }}>
                                    +{botTags.length - 3}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Card footer: action buttons */}
                <div style={{
                    padding: "10px 18px",
                    borderTop: "1px solid var(--border-light)",
                    display: "flex",
                    gap: 6,
                    background: "rgba(0,0,0,0.15)",
                }}>
                    {isStopped ? (
                        <button
                            className="btn-success"
                            style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                            onClick={() => action("start")}
                            disabled={busy}
                            title="Start"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                                <polygon points="5 3 19 12 5 21 5 3"/>
                            </svg>
                        </button>
                    ) : (
                        <button
                            className="btn-danger"
                            style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                            onClick={() => action("stop")}
                            disabled={busy}
                            title="Stop"
                        >
                            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
                                <rect x="6" y="6" width="12" height="12" rx="2"/>
                            </svg>
                        </button>
                    )}

                    <button
                        className="btn-warning"
                        style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
                        onClick={() => action("restart")}
                        disabled={busy}
                        title="Restart"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                            <path d="M3 3v5h5"/>
                        </svg>
                    </button>

                    <button
                        className="btn-primary"
                        style={{ flex: 1, padding: "5px 10px", fontSize: 12 }}
                        onClick={() => navigate(`/bots/${bot._id}`)}
                        disabled={busy}
                    >
                        Manage
                    </button>

                    <button
                        className="btn-ghost"
                        style={{ padding: "5px 8px", color: "var(--danger)", fontSize: 12, display: "flex", alignItems: "center" }}
                        onClick={() => setConfirm({ action: "delete" })}
                        disabled={busy}
                        title="Delete"
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                        </svg>
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
