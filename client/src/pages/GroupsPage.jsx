import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

const PRESET_COLORS = [
    '#5b73e8', '#4F46E5', '#2563EB', '#0891B2', '#059669',
    '#D97706', '#DC2626', '#DB2777', '#9333EA', '#64748B',
];

const IconPlus = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);
const IconEdit = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13 }}>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);
const IconTrash = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 13, height: 13 }}>
        <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
        <path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
    </svg>
);
const IconSave = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
        <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
    </svg>
);
const IconChevronDown = ({ open }) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
        style={{ width: 14, height: 14, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
        <polyline points="6 9 12 15 18 9" />
    </svg>
);
const IconWarning = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 22, height: 22 }}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
);
const IconFolders = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, color: 'var(--text-dim)' }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <path d="M12 11v6" /><path d="M9 14h6" />
    </svg>
);

function GroupCard({ group, bots, onEdit, onDelete }) {
    const onlineCount = bots.filter(b => b.live?.status === 'online').length;
    return (
        <div className="card card-hover" style={{ padding: 0, overflow: 'hidden', border: `1px solid ${group.color}30` }}>
            {/* Colored top strip */}
            <div style={{ height: 4, background: `linear-gradient(90deg, ${group.color}, ${group.color}60)` }} />
            <div style={{ padding: '16px 20px' }}>
                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                    <span style={{
                        width: 12, height: 12, borderRadius: '50%', background: group.color,
                        boxShadow: `0 0 8px ${group.color}60`, flexShrink: 0
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {group.name}
                    </span>
                    <span className="badge" style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)', fontSize: 11 }}>
                        {onlineCount} online
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{bots.length} total</span>
                </div>

                {/* Mini bot list preview */}
                {bots.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
                        {bots.slice(0, 4).map(b => (
                            <div key={b._id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                                <span style={{
                                    width: 6, height: 6, borderRadius: '50%',
                                    background: b.live?.status === 'online' ? 'var(--success)' : 'var(--danger)', flexShrink: 0
                                }} />
                                <span style={{ fontSize: 12, color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {b.name}
                                </span>
                            </div>
                        ))}
                        {bots.length > 4 && (
                            <span style={{ fontSize: 11, color: 'var(--text-dim)', paddingLeft: 14 }}>+{bots.length - 4} more</span>
                        )}
                    </div>
                ) : (
                    <p style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: 16 }}>
                        No bots assigned yet
                    </p>
                )}

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
                    <button onClick={() => onEdit(group)} className="btn-ghost"
                        style={{ flex: 1, padding: '7px 0', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <IconEdit /> Edit
                    </button>
                    <button onClick={() => onDelete(group)} className="btn-ghost"
                        style={{ flex: 1, padding: '7px 0', fontSize: 12, color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <IconTrash /> Delete
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function GroupsPage() {
    const [groups, setGroups]   = useState([]);
    const [bots, setBots]       = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null);   // null | 'new' | groupObj
    const [formOpen, setFormOpen] = useState(false);
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

    const openNew = () => {
        setName(''); setColor(PRESET_COLORS[0]); setEditing('new'); setFormOpen(true);
    };
    const openEdit = (g) => {
        setName(g.name); setColor(g.color || PRESET_COLORS[0]); setEditing(g); setFormOpen(true);
    };
    const closeForm = () => { setEditing(null); setFormOpen(false); };

    const save = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            if (editing === 'new') await api.post('/groups', { name: name.trim(), color });
            else await api.put(`/groups/${editing._id}`, { name: name.trim(), color });
            closeForm(); fetchAll();
        } catch {} finally { setSaving(false); }
    };

    const deleteGroup = async (g) => {
        try { await api.delete(`/groups/${g._id}`); fetchAll(); } catch {}
        setDeleteTarget(null);
    };

    if (loading) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '80px 0' }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'spin 1s linear infinite' }} />
            </div>
        );
    }

    return (
        <div className="fade-in" style={{ padding: '28px 32px', maxWidth: 1100, margin: '0 auto' }}>

            {/* Page Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28 }}>
                <div>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', margin: 0, letterSpacing: '-0.02em' }}>Bot Groups</h1>
                    <p style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 6, margin: '6px 0 0 0' }}>
                        Organise your instances into categorised collections.
                    </p>
                </div>
                <button className="btn-primary" onClick={openNew} style={{ padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <IconPlus /> New Group
                </button>
            </div>

            {/* Collapsible Create/Edit Form */}
            {formOpen && (
                <div className="card slide-up" style={{ marginBottom: 28, border: '1px solid var(--accent-dim)' }}>
                    {/* Form Header */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-light)' }}>
                        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                            {editing === 'new' ? 'Create New Group' : `Edit: ${editing?.name}`}
                        </h2>
                        <button onClick={closeForm} className="btn-ghost" style={{ padding: '4px 10px', fontSize: 13 }}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
                        {/* Left: Name + preview */}
                        <div>
                            <label className="label">Group Name</label>
                            <input
                                className="input"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                placeholder="e.g. Production Cluster"
                                autoFocus
                            />
                            {name.trim() && (
                                <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, background: `${color}15`, border: `1px solid ${color}30` }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                                    <span style={{ fontWeight: 600, color, fontSize: 13 }}>{name}</span>
                                </div>
                            )}
                        </div>

                        {/* Right: Color picker */}
                        <div>
                            <label className="label">Theme Color</label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                                {PRESET_COLORS.map(c => (
                                    <button
                                        key={c}
                                        onClick={() => setColor(c)}
                                        style={{
                                            width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                                            border: 'none', outline: color === c ? `2px solid ${c}` : '2px solid transparent',
                                            outlineOffset: 3, transform: color === c ? 'scale(1.15)' : 'scale(1)',
                                            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                        }}
                                    />
                                ))}
                                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                                    style={{ width: 36, height: 36, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-input)', padding: 4 }} />
                            </div>
                        </div>
                    </div>

                    {/* Save / Cancel */}
                    <div style={{ display: 'flex', gap: 12, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border-light)' }}>
                        <button className="btn-primary" style={{ padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8 }}
                            onClick={save} disabled={saving || !name.trim()}>
                            {saving
                                ? <><div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} /> Saving…</>
                                : <><IconSave /> Save Group</>
                            }
                        </button>
                        <button className="btn-ghost" style={{ padding: '10px 20px' }} onClick={closeForm}>Cancel</button>
                    </div>
                </div>
            )}

            {/* Groups Grid */}
            {groups.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '80px 20px', border: '1px dashed var(--border)', borderRadius: 16, background: 'var(--bg-card)' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}><IconFolders /></div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>No Groups Configured</h3>
                    <p style={{ fontSize: 14, color: 'var(--text-muted)', maxWidth: 380, margin: '0 auto' }}>
                        Create groups to logically organize your bot instances and apply collective management.
                    </p>
                    <button className="btn-primary" style={{ marginTop: 24, padding: '10px 24px', display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={openNew}>
                        <IconPlus /> Create First Group
                    </button>
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 20 }}>
                    {groups.map(g => (
                        <GroupCard
                            key={g._id}
                            group={g}
                            bots={bots.filter(b => b.groupId === g._id)}
                            onEdit={openEdit}
                            onDelete={setDeleteTarget}
                        />
                    ))}
                </div>
            )}

            {/* Delete Confirm Modal */}
            {deleteTarget && (
                <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
                    <div className="card slide-up" style={{ maxWidth: 420, width: '100%', padding: 32 }} onClick={e => e.stopPropagation()}>
                        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', marginBottom: 20 }}>
                            <IconWarning />
                        </div>
                        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 10, letterSpacing: '-0.01em' }}>
                            Delete &ldquo;{deleteTarget.name}&rdquo;?
                        </h2>
                        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 28, lineHeight: 1.6 }}>
                            Bots currently assigned to this group will become ungrouped. This action cannot be undone.
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button className="btn-ghost" style={{ flex: 1, padding: 12 }} onClick={() => setDeleteTarget(null)}>Cancel</button>
                            <button className="btn-danger" style={{ flex: 1, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                                onClick={() => deleteGroup(deleteTarget)}>
                                <IconTrash /> Delete Group
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
