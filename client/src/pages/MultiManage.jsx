import { useState, useEffect, useMemo } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const STATUS_LABEL = {
    online: "Online", stopped: "Stopped", errored: "Errored", launching: "Launching"
};

const ACTIONS = [
    { key: "start",   label: "Start",   btnClass: "btn-success",  icon: "play" },
    { key: "stop",    label: "Stop",    btnClass: "btn-danger",   icon: "stop" },
    { key: "restart", label: "Restart", btnClass: "btn-warning",  icon: "restart" },
    { key: "install", label: "Install", btnClass: "btn-primary",  icon: "download" },
    { key: "update",  label: "Update",  btnClass: "btn-primary",  icon: "refresh" },
    { key: "remove",  label: "Remove",  btnClass: "btn-danger",   icon: "trash", danger: true },
];

function ActionIcon({ type }) {
    const s = { width: 13, height: 13 };
    if (type === "play") return (
        <svg viewBox="0 0 24 24" fill="currentColor" style={s}><polygon points="5 3 19 12 5 21 5 3" /></svg>
    );
    if (type === "stop") return (
        <svg viewBox="0 0 24 24" fill="currentColor" style={s}><rect x="3" y="3" width="18" height="18" rx="2" /></svg>
    );
    if (type === "restart") return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={s}>
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 .49-4.96" />
        </svg>
    );
    if (type === "download") return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={s}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    );
    if (type === "refresh") return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={s}>
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
    );
    if (type === "trash") return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={s}>
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6M9 6V4h6v2" />
        </svg>
    );
    return null;
}

function BotRow({ bot, selected, onToggle }) {
    const status = bot.live?.status || "stopped";
    const isOnline = status === "online";
    const isExpired = bot.expiresAt && bot.expiresAt <= Date.now();
    const statusColor = isOnline ? "var(--success)" : status === "errored" ? "#f97316" : "var(--text-dim)";

    return (
        <div
            onClick={onToggle}
            style={{
                display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                borderRadius: 8, cursor: "pointer", userSelect: "none",
                background: selected ? "rgba(99,102,241,0.1)" : "var(--bg-input)",
                border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                transition: "all 0.15s",
            }}
        >
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, flexShrink: 0, boxShadow: isOnline ? `0 0 5px ${statusColor}80` : 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {bot.name}
                    </span>
                    {isExpired && <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 3, background: "rgba(239,68,68,0.1)", color: "var(--danger)", flexShrink: 0 }}>Expired</span>}
                </div>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-dim)" }}>{bot.buyerID}</span>
            </div>
            {selected && (
                <svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" style={{ width: 14, height: 14, flexShrink: 0 }}>
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            )}
        </div>
    );
}

function GroupSection({ label, color, bots, selected, onToggleBot, onToggleGroup }) {
    const allSelected = bots.length > 0 && bots.every(b => selected.has(b._id));
    const someSelected = bots.some(b => selected.has(b._id));
    const onlineCount = bots.filter(b => b.live?.status === 'online').length;
    const selectedCount = bots.filter(b => selected.has(b._id)).length;

    return (
        <div className="card card-hover" style={{
            padding: 20, marginBottom: 12,
            border: `1px solid ${color ? color + '40' : 'var(--border)'}`,
            background: color
                ? `linear-gradient(135deg, var(--bg-card) 0%, ${color}05 100%)`
                : 'var(--bg-card)',
        }}>
            {/* Group header row */}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: bots.length > 0 ? 16 : 0 }}>
                {/* Colored dot */}
                <span style={{ width: 14, height: 14, borderRadius: "50%", background: color || '#64748b', flexShrink: 0, boxShadow: color ? `0 0 10px ${color}80` : 'none' }} />

                {/* Group name */}
                <span style={{ fontWeight: 700, fontSize: 15, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>

                {/* Online badge */}
                <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 10px", borderRadius: 99, background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)", whiteSpace: "nowrap" }}>
                    {onlineCount} online
                </span>

                {/* Bot count */}
                <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap", width: 56, textAlign: "right" }}>
                    {bots.length} bot{bots.length !== 1 ? 's' : ''}
                </span>

                {/* Selected count badge */}
                {someSelected && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", background: "rgba(99,102,241,0.12)", padding: "3px 10px", borderRadius: 99, border: "1px solid var(--accent-dim)", whiteSpace: "nowrap" }}>
                        {selectedCount} selected
                    </span>
                )}

                {/* Select all / deselect all */}
                <button
                    onClick={() => onToggleGroup(bots.map(b => b._id), !allSelected)}
                    className="btn-ghost"
                    style={{ padding: "4px 12px", fontSize: 12, color: allSelected ? "var(--danger)" : "var(--accent)", border: `1px solid ${allSelected ? "var(--danger-border)" : "var(--accent-dim)"}`, whiteSpace: "nowrap" }}
                >
                    {allSelected ? "Deselect all" : "Select all"}
                </button>
            </div>

            {/* Bot rows — always visible */}
            {bots.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", margin: 0 }}>No bots assigned to this group.</p>
            ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
                    {bots.map(bot => (
                        <BotRow key={bot._id} bot={bot} selected={selected.has(bot._id)} onToggle={() => onToggleBot(bot._id)} />
                    ))}
                </div>
            )}
        </div>
    );
}



function MiniSpinner() {
    return (
        <div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
    );
}

export default function MultiManage() {
    const { bots, groups, tags, refresh } = useData();
    const [selected, setSelected] = useState(new Set());
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [selectedTags, setSelectedTags] = useState([]);
    const [busy, setBusy] = useState(null);
    const [results, setResults] = useState(null);
    const [confirm, setConfirm] = useState(null);
    const [lastAction, setLastAction] = useState("");

    const filtered = useMemo(() => bots.filter(b => {
        const ms = !search.trim() || b.name.toLowerCase().includes(search.toLowerCase()) || b.botID.toLowerCase().includes(search.toLowerCase()) || b.buyerID.toLowerCase().includes(search.toLowerCase());
        const mf = statusFilter === "all" || (statusFilter === "online" && b.live?.status === "online") || (statusFilter === "stopped" && b.live?.status !== "online");
        const mt = selectedTags.length === 0 || selectedTags.some(tid => (b.tags || []).includes(tid));
        return ms && mf && mt;
    }), [bots, search, statusFilter, selectedTags]);

    const groupMap = useMemo(() => Object.fromEntries(groups.map(g => [g._id, g])), [groups]);
    const botsByGroup = useMemo(() => groups.map(g => ({ group: g, bots: filtered.filter(b => b.groupId === g._id) })).filter(s => s.bots.length > 0), [groups, filtered]);
    const ungrouped = useMemo(() => filtered.filter(b => !b.groupId || !groupMap[b.groupId]), [filtered, groupMap]);

    const toggleBot = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const toggleGroup = (ids, add) => setSelected(prev => { const n = new Set(prev); ids.forEach(id => add ? n.add(id) : n.delete(id)); return n; });
    const selectAll = () => setSelected(new Set(filtered.map(b => b._id)));
    const deselectAll = () => setSelected(new Set());

    useEffect(() => {
        const ids = new Set(filtered.map(b => b._id));
        setSelected(prev => { const n = new Set([...prev].filter(id => ids.has(id))); return n.size !== prev.size ? n : prev; });
    }, [filtered]);

    const executeBulk = async (action) => {
        if (selected.size === 0) return;
        setBusy(action); setLastAction(ACTIONS.find(a => a.key === action)?.label || action);
        try {
            const { data } = await api.post(`/bulk/${action}`, { botIds: [...selected] });
            setResults(data.results);
            if (action === "remove") {
                const removed = new Set(data.results.filter(r => r.status === "ok").map(r => r.botId));
                setSelected(prev => new Set([...prev].filter(id => !removed.has(id))));
            }
            refresh();
        } catch (err) {
            setResults([{ botId: "-", name: "System Error", status: "error", message: err.response?.data?.error || err.message }]);
        } finally { setBusy(null); }
    };

    const handleAction = (action) => {
        if (action === "remove") setConfirm({ action: "remove" });
        else executeBulk(action);
    };

    const hasSelection = selected.size > 0;
    const allFilteredSelected = filtered.length > 0 && filtered.every(b => selected.has(b._id));

    return (
        <div className="fade-in" style={{ padding: "28px 32px", maxWidth: 960, margin: "0 auto" }}>

            {/* Page Header */}
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Multi-Manage</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", margin: "6px 0 0 0" }}>Bulk operations on {bots.length} instances</p>
                </div>
                <button onClick={allFilteredSelected ? deselectAll : selectAll} className="btn-ghost" style={{ fontSize: 12, padding: "8px 16px" }}>
                    {allFilteredSelected ? "Deselect All" : "Select All"}
                </button>
            </div>

            {/* Sticky Action Toolbar */}
            <div style={{
                position: "sticky", top: 16, zIndex: 10,
                background: "var(--bg-card)", backdropFilter: "blur(20px)",
                padding: "12px 20px", marginBottom: 24,
                borderRadius: 16,
                border: `1px solid ${hasSelection ? "var(--accent)" : "var(--border)"}`,
                boxShadow: hasSelection ? "0 10px 40px rgba(99,102,241,0.2)" : "0 10px 30px rgba(0,0,0,0.5)",
                transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16
            }}>
                <span style={{
                    fontSize: 14, fontWeight: 700,
                    color: hasSelection ? "var(--accent)" : "var(--text-dim)",
                    display: "flex", alignItems: "center", gap: 8,
                    transition: "color 0.2s"
                }}>
                    {hasSelection && (
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
                    )}
                    {selected.size} selected
                </span>
                
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    {ACTIONS.map(a => (
                        <button
                            key={a.key}
                            className={a.btnClass}
                            style={{ 
                                padding: "8px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 8,
                                opacity: !hasSelection || !!busy ? 0.6 : 1
                            }}
                            disabled={!hasSelection || !!busy}
                            onClick={() => handleAction(a.key)}
                        >
                            {busy === a.key
                                ? <><MiniSpinner /> Processing…</>
                                : <><ActionIcon type={a.icon} /> {a.label}</>
                            }
                        </button>
                    ))}
                </div>
            </div>

            {/* Filters */}
            <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
                <input
                    className="input"
                    style={{ flex: "1 1 200px" }}
                    placeholder="Search bots…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <select className="input" style={{ width: 140 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                    <option value="all">All Status</option>
                    <option value="online">Online Only</option>
                    <option value="stopped">Offline Only</option>
                </select>
            </div>

            {/* Tags filter */}
            {tags.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 20 }}>
                    {tags.map(tag => {
                        const active = selectedTags.includes(tag._id);
                        return (
                            <button
                                key={tag._id}
                                onClick={() => setSelectedTags(prev => prev.includes(tag._id) ? prev.filter(t => t !== tag._id) : [...prev, tag._id])}
                                style={{
                                    display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 99,
                                    fontSize: 12, fontWeight: 500, cursor: "pointer",
                                    background: active ? `${tag.color}18` : "var(--bg-input)",
                                    border: `1px solid ${active ? tag.color + "40" : "var(--border)"}`,
                                    color: active ? tag.color : "var(--text-muted)",
                                    transition: "all 0.15s",
                                }}
                            >
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? tag.color : "var(--text-dim)" }} />
                                {tag.name}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Bot List */}
            {filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: "48px 0", border: "1px dashed var(--border)", borderRadius: 12 }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 40, height: 40, color: "var(--text-dim)", marginBottom: 12 }}>
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", margin: 0 }}>No bots match your filters.</p>
                </div>
            ) : (
                <div>
                    {botsByGroup.map(({ group, bots: gb }) => (
                        <GroupSection key={group._id} label={group.name} color={group.color} bots={gb} selected={selected} onToggleBot={toggleBot} onToggleGroup={toggleGroup} />
                    ))}
                    {ungrouped.length > 0 && (
                        <GroupSection label="Ungrouped" color="#8892a4" bots={ungrouped} selected={selected} onToggleBot={toggleBot} onToggleGroup={toggleGroup} />
                    )}
                </div>
            )}

            {/* Confirm remove modal */}
            {confirm?.action === "remove" && (
                <ConfirmModal
                    title="Bulk Delete Bots"
                    message={`Are you sure you want to permanently delete the ${selected.size} selected bot(s)?\nThis will remove PM2 processes and project directories. This cannot be undone.`}
                    confirmText="Delete Selected"
                    onConfirm={() => { setConfirm(null); executeBulk("remove"); }}
                    onCancel={() => setConfirm(null)}
                />
            )}

            {/* Results Modal */}
            {results && (
                <div className="modal-overlay" onClick={() => setResults(null)}>
                    <div className="card slide-up" style={{ maxWidth: 620, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 0 }}
                        onClick={e => e.stopPropagation()}>
                        {/* Modal header */}
                        <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                                <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: "var(--text)" }}>Bulk {lastAction} Results</h2>
                                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "3px 0 0 0" }}>
                                    {results.filter(r => r.status === "ok").length} succeeded · {results.filter(r => r.status !== "ok").length} failed
                                </p>
                            </div>
                            <button onClick={() => setResults(null)} className="btn-ghost" style={{ padding: "6px 10px", display: "flex", alignItems: "center" }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        {/* Results list */}
                        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                            {results.map((r, i) => (
                                <div key={r.botId + i} style={{
                                    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8,
                                    background: r.status === "ok" ? "var(--success-bg)" : "var(--danger-bg)",
                                    borderLeft: `3px solid ${r.status === "ok" ? "var(--success)" : "var(--danger)"}`,
                                    border: `1px solid ${r.status === "ok" ? "var(--success-border)" : "var(--danger-border)"}`,
                                }}>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 16, height: 16, color: r.status === "ok" ? "var(--success)" : "var(--danger)", flexShrink: 0 }}>
                                        {r.status === "ok"
                                            ? <><polyline points="20 6 9 17 4 12" /></>
                                            : <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                                        }
                                    </svg>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: 0 }}>{r.name}</p>
                                        <p className="mono" style={{ fontSize: 11, color: r.status === "ok" ? "var(--success)" : "var(--danger)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", margin: "2px 0 0 0" }}>{r.message}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
                            <button onClick={() => setResults(null)} className="btn-primary" style={{ width: "100%", padding: 10 }}>Done</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
