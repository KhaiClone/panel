import { useState, useEffect, useMemo } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const STATUS_LABEL = {
    online: "Online", stopped: "Stopped", errored: "Errored", launching: "Launching"
};

const ACTIONS = [
    { key: "start",   label: "Start",   btnClass: "btn-success" },
    { key: "stop",    label: "Stop",    btnClass: "btn-danger" },
    { key: "restart", label: "Restart", btnClass: "btn-warning" },
    { key: "install", label: "Install", btnClass: "btn-primary" },
    { key: "update",  label: "Update",  btnClass: "btn-primary" },
    { key: "remove",  label: "Remove",  btnClass: "btn-danger", danger: true },
];

function BotRow({ bot, selected, onToggle }) {
    const status = bot.live?.status || "stopped";
    const isOnline = status === "online";
    const isExpired = bot.expiresAt && bot.expiresAt <= Date.now();

    return (
        <label style={{
            display: "flex", alignItems: "center", gap: 12, padding: "8px 14px",
            background: selected ? "rgba(91,115,232,0.1)" : "var(--bg-input)",
            border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 8, cursor: "pointer", userSelect: "none", marginBottom: 6,
        }}>
            <input type="checkbox" checked={selected} onChange={onToggle} style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }} />
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: isOnline ? "var(--success)" : "var(--text-dim)", flexShrink: 0 }}/>
            <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {bot.name}
                </span>
                {isExpired && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(239,68,68,0.1)", color: "var(--danger)" }}>Expired</span>}
                <span className="mono" style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: "auto" }}>
                    {bot.buyerID} / {bot.botID}
                </span>
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: isOnline ? "var(--success)" : "var(--text-muted)", width: 70, textAlign: "right" }}>
                {STATUS_LABEL[status] || "Unknown"}
            </span>
        </label>
    );
}

function GroupSection({ label, color, bots, selected, onToggleBot, onToggleGroup }) {
    const [open, setOpen] = useState(true);
    const allSelected = bots.length > 0 && bots.every(b => selected.has(b._id));
    const someSelected = bots.some(b => selected.has(b._id));

    return (
        <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <input
                    type="checkbox"
                    checked={allSelected}
                    ref={input => { if (input) input.indeterminate = someSelected && !allSelected; }}
                    onChange={() => onToggleGroup(bots.map(b => b._id), !allSelected)}
                    style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }}
                />
                <button
                    onClick={() => setOpen(v => !v)}
                    style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, background: "none", border: "none", cursor: "pointer", padding: "4px 0" }}
                >
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: color || "#8892a4" }}/>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
                    <span style={{ fontSize: 12, color: "var(--text-dim)" }}>[{bots.length}]</span>
                    {someSelected && (
                        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "rgba(91,115,232,0.1)", padding: "2px 8px", borderRadius: 99 }}>
                            {bots.filter(b => selected.has(b._id)).length} selected
                        </span>
                    )}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14, color: "var(--text-dim)", marginLeft: "auto", transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}>
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </button>
            </div>
            {open && (
                <div style={{ paddingLeft: 26, borderLeft: `2px solid ${color ? color + '40' : 'var(--border)'}`, marginLeft: 7 }}>
                    {bots.map(bot => (
                        <BotRow key={bot._id} bot={bot} selected={selected.has(bot._id)} onToggle={() => onToggleBot(bot._id)} />
                    ))}
                </div>
            )}
        </div>
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
        <div style={{ padding: "20px 24px", maxWidth: 960, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Multi Manage</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Bulk operations on {bots.length} instances</p>
                </div>
                <button onClick={allFilteredSelected ? deselectAll : selectAll} className="btn-ghost" style={{ fontSize: 12 }}>
                    {allFilteredSelected ? "Deselect All" : "Select All"}
                </button>
            </div>

            {/* Toolbar */}
            <div className="card" style={{ marginBottom: 20, borderColor: hasSelection ? "var(--accent)" : "var(--border)", transition: "border-color 0.2s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: hasSelection ? "var(--accent)" : "var(--text-dim)" }}/>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: hasSelection ? "var(--accent)" : "var(--text-muted)" }}>
                        {selected.size} Bot{selected.size !== 1 ? 's' : ''} Selected
                    </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {ACTIONS.map(a => (
                        <button
                            key={a.key}
                            className={a.btnClass}
                            style={{ flex: "1 1 120px", padding: "10px 0" }}
                            disabled={!hasSelection || busy}
                            onClick={() => handleAction(a.key)}
                        >
                            {busy === a.key ? "⏳ Processing…" : a.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Filters */}
            <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
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
                                    display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 99,
                                    fontSize: 12, fontWeight: 500, cursor: "pointer",
                                    background: active ? `${tag.color}18` : "var(--bg-input)",
                                    border: `1px solid ${active ? tag.color + "40" : "var(--border)"}`,
                                    color: active ? tag.color : "var(--text-muted)",
                                }}
                            >
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? tag.color : "var(--text-dim)" }}/>
                                {tag.name}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Lists */}
            {filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 0", border: "1px dashed var(--border)", borderRadius: 10, color: "var(--text-muted)", fontSize: 13 }}>
                    No bots match your filters.
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

            {/* Modals */}
            {confirm?.action === "remove" && (
                <ConfirmModal
                    title="Bulk Delete Bots"
                    message={`Are you sure you want to permanently delete the ${selected.size} selected bot(s)?\nThis will remove PM2 processes and project directories. This cannot be undone.`}
                    confirmText="Delete Selected"
                    onConfirm={() => { setConfirm(null); executeBulk("remove"); }}
                    onCancel={() => setConfirm(null)}
                />
            )}

            {results && (
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.6)" }}>
                    <div className="card" style={{ maxWidth: 600, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 0 }}>
                        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Bulk {lastAction} Results</h2>
                            <button onClick={() => setResults(null)} className="btn-ghost" style={{ padding: "4px 8px" }}>✕</button>
                        </div>
                        <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 10 }}>
                            {results.map(r => (
                                <div key={r.botId} style={{
                                    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8,
                                    background: r.status === "ok" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
                                    border: `1px solid ${r.status === "ok" ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)"}`,
                                }}>
                                    <span style={{ fontSize: 16 }}>{r.status === "ok" ? "✅" : "❌"}</span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</p>
                                        <p className="mono" style={{ fontSize: 11, color: r.status === "ok" ? "#4ade80" : "#f87171", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.message}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
