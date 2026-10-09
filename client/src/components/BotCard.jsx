import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import ConfirmModal from "./ConfirmModal";
import { useData } from "../context/DataContext";
import { Icon, StatusBadge } from "./ui";

const STATUS = {
    online:    { tone: "success", label: "Online" },
    stopped:   { tone: "neutral", label: "Stopped" },
    errored:   { tone: "danger",  label: "Errored" },
    launching: { tone: "warning", label: "Starting" },
};
const getStatus = (s) => STATUS[s] ?? { tone: "neutral", label: s ?? "Unknown" };

const formatTimeLeft = (ms) => {
    if (ms <= 0) return "Expired";
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
};

function Meter({ label, value, percent, color }) {
    return (
        <div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 11 }}>
                <span style={{ color: "var(--text-dim)" }}>{label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{value}</span>
            </div>
            <div style={{ height: 3, background: "var(--bg-input)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(percent, 100)}%`, background: color, borderRadius: 2, transition: "width 0.4s ease" }} />
            </div>
        </div>
    );
}

/**
 * One bot or service on the Bots page. With `selectable` the whole card is a
 * checkbox for the bulk actions, and the footer buttons step aside.
 */
export default function BotCard({ bot, onRefresh, selectable = false, selected = false, onToggleSelect }) {
    const navigate = useNavigate();
    const { tags: allTags } = useData();
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const botTags = (bot.tags || []).map(id => allTags.find(t => t._id === id)).filter(Boolean);
    const s = getStatus(bot.live?.status);
    const msLeft = bot.expiresAt ? bot.expiresAt - Date.now() : null;
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

    const typeLabel =
        bot.projectType === "website" ? (bot.websiteConfig?.mode === "fullstack" ? "Full-stack" : "Static")
        : bot.projectType === "service" ? "Service"
        : null;

    return (
        <>
            <div
                className={`card${selectable ? "" : " card-hover"}`}
                role={selectable ? "checkbox" : undefined}
                aria-checked={selectable ? selected : undefined}
                tabIndex={selectable ? 0 : undefined}
                onClick={selectable ? onToggleSelect : undefined}
                onKeyDown={selectable ? (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onToggleSelect(); } } : undefined}
                style={{
                    padding: 0,
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                    opacity: busy ? 0.7 : 1,
                    cursor: selectable ? "pointer" : undefined,
                    userSelect: selectable ? "none" : undefined,
                    borderColor: selected ? "var(--accent)" : undefined,
                    background: selected ? "var(--bg-hover)" : undefined,
                    transition: "opacity 0.2s, border-color 0.15s, background-color 0.15s",
                }}
            >
                <div style={{ padding: "14px 16px", flex: 1, display: "flex", flexDirection: "column", gap: 12 }}>

                    {/* Avatar (or checkbox) + name + status */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                        <div style={{
                            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                            background: "var(--bg-input)", border: "1px solid var(--border)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: selected ? "var(--accent-hover)" : "var(--text-muted)",
                        }}>
                            <Icon name={selectable ? (selected ? "checkboxOn" : "checkbox") : "bots"} />
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                            <h3 style={{
                                fontWeight: 500, fontSize: 14, color: "var(--text)", margin: 0,
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                                {bot.name}
                            </h3>
                            <p className="mono" style={{
                                fontSize: 11, color: "var(--text-dim)", margin: "2px 0 0",
                                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>
                                {bot.buyerID}
                            </p>
                        </div>

                        <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                    </div>

                    {/* Type, node, expiry */}
                    {(typeLabel || bot.nodeName || msLeft !== null) && (
                        <div className="meta-row" style={{ marginTop: 0, fontSize: 11 }}>
                            {typeLabel && <span>{typeLabel}</span>}
                            {bot.nodeName && (
                                <span title={`Running on node "${bot.nodeName}"`}>
                                    <Icon name="node" size={12} /> {bot.nodeName}
                                </span>
                            )}
                            {msLeft !== null && (
                                <span style={{ color: isExpired ? "var(--danger)" : isExpiringSoon ? "var(--warning)" : undefined }}>
                                    <Icon name="clock" size={12} />
                                    {isExpired ? "Expired" : `${formatTimeLeft(msLeft)} left`}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Resources */}
                    {isOnline ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <Meter
                                label="CPU"
                                value={`${cpuPct}%`}
                                percent={cpuPct}
                                color={cpuPct > 80 ? "var(--danger)" : cpuPct > 50 ? "var(--warning)" : "var(--accent)"}
                            />
                            <Meter label="RAM" value={`${ramMB} MB`} percent={ramPct} color="var(--info)" />
                        </div>
                    ) : (
                        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 0" }}>
                            Not running
                        </div>
                    )}

                    {/* Tags */}
                    {botTags.length > 0 && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                            {botTags.slice(0, 3).map(tag => (
                                <span key={tag._id} className="badge" style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                                    <span className="chip-dot" style={{ background: tag.color }} />
                                    {tag.name}
                                </span>
                            ))}
                            {botTags.length > 3 && (
                                <span className="badge" style={{ background: "var(--bg-input)", color: "var(--text-dim)" }}>
                                    +{botTags.length - 3}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer actions */}
                {!selectable && (
                    <div style={{
                        padding: "8px 12px",
                        borderTop: "1px solid var(--border)",
                        display: "flex",
                        gap: 4,
                        alignItems: "center",
                    }}>
                        {isStopped ? (
                            <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("start")} disabled={busy} title="Start">
                                <Icon name="play" size={14} />
                            </button>
                        ) : (
                            <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("stop")} disabled={busy} title="Stop">
                                <Icon name="stop" size={14} />
                            </button>
                        )}
                        <button className="btn-ghost btn-icon btn-sm" style={{ border: "none" }} onClick={() => action("restart")} disabled={busy} title="Restart">
                            <Icon name="restart" size={14} />
                        </button>
                        <button
                            className="btn-ghost btn-sm"
                            style={{ flex: 1, marginLeft: 4 }}
                            onClick={() => navigate(`/${bot.projectType === "website" ? "sites" : "bots"}/${bot._id}`)}
                            disabled={busy}
                        >
                            Manage
                        </button>
                        <button className="btn-ghost btn-icon btn-sm is-danger" style={{ border: "none" }} onClick={() => setConfirm({ action: "delete" })} disabled={busy} title="Delete">
                            <Icon name="trash" size={14} />
                        </button>
                    </div>
                )}
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
