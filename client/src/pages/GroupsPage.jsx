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
        <div className="card card-hover" style={{ padding: 20, marginBottom: 12, border: `1px solid ${group.color}40`, background: `linear-gradient(135deg, var(--bg-card) 0%, ${group.color}05 100%)` }}>
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ width: 14, height: 14, borderRadius: "50%", background: group.color || '#64748b', flexShrink: 0, boxShadow: `0 0 10px ${group.color}80` }}/>
                <span style={{ fontWeight: 700, fontSize: 16, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.name}</span>
                
                <span style={{
                    fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 99,
                    background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success)",
                }}>
                    {onlineCount} online
                </span>
                
                <span style={{ fontSize: 13, color: "var(--text-muted)", whiteSpace: "nowrap", width: 60, textAlign: "right" }}>{bots.length} bot{bots.length !== 1 ? 's' : ''}</span>
                
                <button onClick={() => onEdit(group)} className="btn-ghost" style={{ padding: "6px 14px", fontSize: 13 }}>Edit</button>
                <button onClick={() => onDelete(group)} className="btn-ghost" style={{ padding: "6px 14px", fontSize: 13, color: "var(--danger)" }}>Delete</button>
                <button
                    onClick={() => setOpen(v => !v)}
                    style={{ background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "var(--text-muted)", flexShrink: 0, transition: "all 0.2s" }}
                    onMouseOver={e => e.currentTarget.style.background = "var(--bg-surface)"}
                    onMouseOut={e => e.currentTarget.style.background = "var(--bg-input)"}
                >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)" }}>
                        <polyline points="6 9 12 15 18 9"/>
                    </svg>
                </button>
            </div>

            {open && (
                <div className="slide-up" style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed var(--border)" }}>
                    {bots.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--text-dim)", fontStyle: "italic", textAlign: "center" }}>No bots assigned to this group yet.</p>
                    ) : (
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: 8 }}>
                            {bots.map(b => (
                                <div key={b._id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)" }}>
                                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: b.live?.status === 'online' ? "var(--success)" : "var(--danger)", flexShrink: 0 }}/>
                                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                                    <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{b.botID}</span>
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
                <div style={{ width: 40, height: 40, borderRadius: "50%", border: "4px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}/>
            </div>
        );
    }

    return (
        <div className="fade-in page" style={{ maxWidth: 1000 }}>

            {/* Header */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 32, gap: 16 }}>
                <div style={{ flex: 1 }}>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Bot Groups</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6 }}>Organise your instances into categorised collections.</p>
                </div>
                <button className="btn-primary" onClick={openNew} style={{ padding: "10px 20px" }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14, marginRight: 8, display: "inline-block" }}>
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    New Group
                </button>
            </div>

            {/* Edit/Create form */}
            {editing && (
                <div className="card slide-up" style={{ marginBottom: 24, border: "1px solid var(--accent-dim)" }}>
                    <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                        {editing === 'new' ? 'Create New Group' : `Edit Group: ${editing.name}`}
                    </h2>
                    
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                            <div>
                                <label className="label">Group Name</label>
                                <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Production Cluster" />
                            </div>
                            <div>
                                <label className="label">Theme Color</label>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                                    {PRESET_COLORS.map(c => (
                                        <button
                                            key={c}
                                            onClick={() => setColor(c)}
                                            style={{
                                                width: 32, height: 32, borderRadius: "50%", background: c, cursor: "pointer",
                                                border: "none", outline: color === c ? `2px solid ${c}` : "2px solid transparent",
                                                outlineOffset: 3, transform: color === c ? "scale(1.15)" : "scale(1)",
                                                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                                            }}
                                        />
                                    ))}
                                    <input type="color" value={color} onChange={e => setColor(e.target.value)}
                                        style={{ width: 40, height: 40, borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 4 }}
                                    />
                                </div>
                            </div>
                        </div>
                        
                        <div style={{ background: "var(--bg-input)", padding: 20, borderRadius: 12, border: "1px solid var(--border)" }}>
                            <label className="label">Live Preview</label>
                            <div style={{
                                marginTop: 16, padding: "16px 20px", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 12,
                                background: `${color}15`, border: `1px solid ${color}40`,
                            }}>
                                <span style={{ width: 12, height: 12, borderRadius: "50%", background: color, boxShadow: `0 0 10px ${color}` }}/>
                                <span style={{ fontSize: 16, fontWeight: 700, color }}>{name || 'Group Name'}</span>
                            </div>
                            
                            <div style={{ display: "flex", gap: 12, marginTop: "auto", paddingTop: 32 }}>
                                <button className="btn-primary" style={{ flex: 1, padding: 12 }} onClick={save} disabled={saving || !name.trim()}>
                                    {saving ? '⏳ Saving…' : '💾 Save Group'}
                                </button>
                                <button className="btn-ghost" style={{ flex: 1, padding: 12 }} onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Groups list */}
            {groups.length === 0 ? (
                <div style={{ textAlign: "center", padding: "80px 20px", border: "1px dashed var(--border)", borderRadius: 16, background: "var(--bg-card)" }}>
                    <div style={{ fontSize: 48, marginBottom: 16, filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.2))" }}>🗂️</div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>No Groups Configured</h3>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", maxWidth: 400, margin: "0 auto" }}>Create groups to logically organize your bot instances and apply collective management.</p>
                    <button className="btn-primary" style={{ marginTop: 24, padding: "10px 24px" }} onClick={openNew}>Create First Group</button>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                    {groups.map(g => (
                        <GroupCard key={g._id} group={g} bots={bots.filter(b => b.groupId === g._id)} onEdit={openEdit} onDelete={setDeleteTarget} />
                    ))}
                </div>
            )}

            {/* Delete confirm */}
            {deleteTarget && (
                <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
                    <div className="card slide-up" style={{ maxWidth: 420, width: "100%", padding: 32 }} onClick={e => e.stopPropagation()}>
                        <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--danger-bg)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--danger)", marginBottom: 20 }}>
                            <span style={{ fontSize: 24 }}>⚠️</span>
                        </div>
                        <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 12, letterSpacing: "-0.01em" }}>Delete Group: "{deleteTarget.name}"?</h2>
                        <p style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 32, lineHeight: 1.6 }}>
                            Bots currently assigned to this group will become ungrouped. This action cannot be undone.
                        </p>
                        <div style={{ display: "flex", gap: 12 }}>
                            <button className="btn-ghost" style={{ flex: 1, padding: 12 }} onClick={() => setDeleteTarget(null)}>Cancel</button>
                            <button className="btn-danger" style={{ flex: 1, padding: 12 }} onClick={() => deleteGroup(deleteTarget)}>Delete Group</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
