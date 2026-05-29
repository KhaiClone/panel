import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

const PRESET_COLORS = [
    '#5b73e8','#4F46E5','#2563EB','#0891B2','#059669',
    '#D97706','#DC2626','#DB2777','#9333EA','#64748B',
];

function GroupCard({ group, bots, onEdit, onDelete }) {
    const [open, setOpen] = useState(false);
    const onlineCount = bots.filter(b => b.live?.status === 'online').length;
    return (
        <div className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: group.color || '#64748b', flexShrink: 0 }}/>
                <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.name}</span>
                <span style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 99,
                    background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.25)", color: "#4ade80",
                }}>
                    {onlineCount} online
                </span>
                <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>{bots.length} bot{bots.length !== 1 ? 's' : ''}</span>
                <button onClick={() => onEdit(group)} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>Edit</button>
                <button onClick={() => onDelete(group)} className="btn-danger" style={{ padding: "4px 10px", fontSize: 12 }}>Delete</button>
                <button
                    onClick={() => setOpen(v => !v)}
                    style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 6, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-muted)", flexShrink: 0 }}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </button>
            </div>

            {open && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                    {bots.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-dim)" }}>No bots in this group.</p>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {bots.map(b => (
                                <div key={b._id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, background: "var(--bg-input)" }}>
                                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: b.live?.status === 'online' ? "#22c55e" : "#64748b", flexShrink: 0 }}/>
                                    <span style={{ fontSize: 13, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                                    <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{b.buyerID}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function GroupsPage() {
    const [groups, setGroups]   = useState([]);
    const [bots, setBots]       = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null);
    const [name, setName]       = useState('');
    const [color, setColor]     = useState(PRESET_COLORS[0]);
    const [saving, setSaving]   = useState(false);
    const [deleteTarget, setDeleteTarget] = useState(null);

    const fetchAll = useCallback(async () => {
        try {
            const [gr, br] = await Promise.all([api.get('/groups'), api.get('/bots')]);
            setGroups(gr.data); setBots(br.data);
        } catch {} finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const openNew  = () => { setName(''); setColor(PRESET_COLORS[0]); setEditing('new'); };
    const openEdit = (g) => { setName(g.name); setColor(g.color || PRESET_COLORS[0]); setEditing(g); };

    const save = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            if (editing === 'new') await api.post('/groups', { name: name.trim(), color });
            else await api.put(`/groups/${editing._id}`, { name: name.trim(), color });
            setEditing(null); fetchAll();
        } catch {} finally { setSaving(false); }
    };

    const deleteGroup = async (g) => {
        try { await api.delete(`/groups/${g._id}`); fetchAll(); } catch {}
        setDeleteTarget(null);
    };

    if (loading) {
        return (
            <div style={{ display: "flex", justifyContent: "center", padding: "80px 0" }}>
                <div style={{ width: 24, height: 24, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 0.8s linear infinite" }}/>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    return (
        <div style={{ padding: "20px 24px", maxWidth: 760, margin: "0 auto" }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Groups</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Organise your bots into labelled collections</p>
                </div>
                <button id="btn-new-group" className="btn-primary" onClick={openNew}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 13, height: 13 }}>
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    New Group
                </button>
            </div>

            {/* Edit/Create form */}
            {editing && (
                <div className="card" style={{ marginBottom: 16, borderColor: "rgba(91,115,232,0.3)" }}>
                    <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>
                        {editing === 'new' ? 'Create Group' : `Edit — ${editing.name}`}
                    </h2>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <div>
                            <label className="label">Group Name</label>
                            <input id="group-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Premium Bots" />
                        </div>
                        <div>
                            <label className="label">Color</label>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                                {PRESET_COLORS.map(c => (
                                    <button
                                        key={c}
                                        onClick={() => setColor(c)}
                                        style={{
                                            width: 24, height: 24, borderRadius: "50%", background: c, cursor: "pointer",
                                            border: "none", outline: color === c ? `2px solid ${c}` : "2px solid transparent",
                                            outlineOffset: 2, transform: color === c ? "scale(1.2)" : "scale(1)",
                                            transition: "transform 0.15s, outline 0.15s",
                                        }}
                                    />
                                ))}
                                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                                    style={{ width: 32, height: 32, borderRadius: 6, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 2 }}
                                    title="Custom color"
                                />
                            </div>
                        </div>
                        <div>
                            <label className="label">Preview</label>
                            <span style={{
                                display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px", borderRadius: 99,
                                fontSize: 12, fontWeight: 600,
                                background: `${color}18`, border: `1px solid ${color}40`, color,
                            }}>
                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: color }}/>
                                {name || 'Group Name'}
                            </span>
                        </div>
                        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
                            <button className="btn-primary" onClick={save} disabled={saving || !name.trim()}>
                                {saving ? '⏳ Saving…' : '💾 Save Group'}
                            </button>
                            <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Groups list */}
            {groups.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px 0", border: "1px dashed var(--border)", borderRadius: 10 }}>
                    <p style={{ fontSize: 32, marginBottom: 12 }}>🗂️</p>
                    <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No groups yet — create one to start organising.</p>
                    <button className="btn-primary" style={{ marginTop: 16 }} onClick={openNew}>Create Group</button>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {groups.map(g => (
                        <GroupCard key={g._id} group={g} bots={bots.filter(b => b.groupId === g._id)}
                            onEdit={openEdit} onDelete={setDeleteTarget} />
                    ))}
                </div>
            )}

            {/* Delete confirm */}
            {deleteTarget && (
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.6)" }}
                    onClick={() => setDeleteTarget(null)}>
                    <div className="card" style={{ maxWidth: 400, width: "100%", padding: 24 }} onClick={e => e.stopPropagation()}>
                        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Delete "{deleteTarget.name}"?</h2>
                        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
                            Bots in this group will become ungrouped. This cannot be undone.
                        </p>
                        <div style={{ display: "flex", gap: 8 }}>
                            <button className="btn-danger" style={{ flex: 1 }} onClick={() => deleteGroup(deleteTarget)}>Delete</button>
                            <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setDeleteTarget(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
