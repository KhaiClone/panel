import { useState } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const PRESET_COLORS = [
    "#5b73e8", "#4F46E5", "#0EA5E9", "#06B6D4", "#10B981",
    "#84CC16", "#EAB308", "#F97316", "#EF4444", "#EC4899",
    "#A855F7", "#6366F1", "#14B8A6", "#F59E0B", "#64748B",
];

const IconEdit = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);
const IconTrash = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
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
const IconPlus = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ width: 14, height: 14 }}>
        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
);
const IconTagEmpty = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 48, height: 48, color: 'var(--text-dim)' }}>
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
);

function ColorPicker({ value, onChange }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {PRESET_COLORS.map(c => (
                <button
                    key={c}
                    type="button"
                    onClick={() => onChange(c)}
                    style={{
                        width: 24, height: 24, borderRadius: "50%", background: c, cursor: "pointer", border: "none",
                        outline: value === c ? `2px solid ${c}` : "2px solid transparent",
                        outlineOffset: 3, transform: value === c ? "scale(1.15)" : "scale(1)",
                        transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                    title={c}
                />
            ))}
            <input type="color" value={value} onChange={e => onChange(e.target.value)}
                style={{ width: 32, height: 32, borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 4 }}
                title="Custom color"
            />
            <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{value}</span>
        </div>
    );
}

export default function TagsPage() {
    const { tags, bots, refresh } = useData();

    const [createName, setCreateName]   = useState("");
    const [createColor, setCreateColor] = useState("#5b73e8");
    const [creating, setCreating]       = useState(false);
    const [createErr, setCreateErr]     = useState("");

    const [editId, setEditId]       = useState(null);
    const [editName, setEditName]   = useState("");
    const [editColor, setEditColor] = useState("");
    const [saving, setSaving]       = useState(false);

    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting]         = useState(false);

    const usageMap = {};
    for (const bot of bots) {
        for (const tagId of (bot.tags || [])) {
            usageMap[tagId] = (usageMap[tagId] || 0) + 1;
        }
    }

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!createName.trim()) return;
        setCreating(true); setCreateErr("");
        try {
            await api.post("/tags", { name: createName.trim(), color: createColor });
            setCreateName(""); setCreateColor("#5b73e8");
            refresh();
        } catch (err) {
            setCreateErr(err.response?.data?.error || "Failed to create tag");
        } finally { setCreating(false); }
    };

    const startEdit = (tag) => { setEditId(tag._id); setEditName(tag.name); setEditColor(tag.color); };

    const handleSave = async () => {
        setSaving(true);
        try {
            await api.put(`/tags/${editId}`, { name: editName.trim(), color: editColor });
            setEditId(null); refresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to save tag");
        } finally { setSaving(false); }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            await api.delete(`/tags/${deleteTarget._id}`);
            setDeleteTarget(null); refresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to delete tag");
        } finally { setDeleting(false); }
    };

    return (
        <div className="fade-in" style={{ padding: "28px 32px", maxWidth: 1100, margin: "0 auto" }}>
            {/* Page Header */}
            <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Instance Tags</h1>
                <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6, margin: "6px 0 0 0" }}>
                    Manage taxonomy and visual labels for your bots.
                </p>
            </div>

            {/* Responsive style for mobile */}
            <style>{`
                @media (max-width: 720px) {
                    .tags-layout { grid-template-columns: 1fr !important; }
                    .tags-form-sticky { position: static !important; }
                }
            `}</style>

            <div className="tags-layout" style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 32, alignItems: "start" }}>

                {/* Left: Create Form (sticky) */}
                <div className="tags-form-sticky" style={{ position: "sticky", top: 28 }}>
                    <div className="card">
                        <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", margin: "0 0 20px 0", paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                            New Tag
                        </h2>
                        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <div>
                                <label className="label">Tag Name</label>
                                <input
                                    className="input"
                                    placeholder="e.g. Production, VIP, Testing…"
                                    value={createName}
                                    onChange={e => setCreateName(e.target.value)}
                                    maxLength={32}
                                />
                                {createName.trim() && (
                                    <div style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 8, background: `${createColor}15`, border: `1px solid ${createColor}30` }}>
                                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: createColor }} />
                                        <span style={{ fontWeight: 600, color: createColor, fontSize: 13 }}>{createName.trim()}</span>
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="label">Tag Color</label>
                                <ColorPicker value={createColor} onChange={setCreateColor} />
                            </div>

                            {createErr && (
                                <div style={{ fontSize: 13, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "10px 14px" }}>
                                    {createErr}
                                </div>
                            )}

                            <button type="submit" className="btn-primary" style={{ padding: "11px", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                                disabled={creating || !createName.trim()}>
                                {creating
                                    ? <><div style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} /> Creating…</>
                                    : <><IconPlus /> Create Tag</>
                                }
                            </button>
                        </form>
                    </div>
                </div>

                {/* Right: Tags List */}
                <div>
                    {/* Right header with count */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>Configured Tags</h2>
                        <span className="badge" style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent)", padding: "4px 12px", fontSize: 12 }}>
                            {tags.length} total
                        </span>
                    </div>

                    {tags.length === 0 ? (
                        <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed var(--border)", borderRadius: 16, background: "var(--bg-card)" }}>
                            <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}><IconTagEmpty /></div>
                            <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>No Tags Found</h3>
                            <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Create a tag on the left to start labelling your instances.</p>
                        </div>
                    ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            {tags.map(tag => {
                                const isEditing = editId === tag._id;
                                const usage = usageMap[tag._id] || 0;
                                return (
                                    <div key={tag._id} className="card card-hover" style={{ padding: 0, overflow: "hidden" }}>
                                        {/* Colored left accent strip */}
                                        <div style={{ display: "flex" }}>
                                            <div style={{ width: 3, flexShrink: 0, background: `linear-gradient(180deg, ${tag.color}, ${tag.color}60)` }} />
                                            <div style={{ flex: 1, padding: isEditing ? 20 : "16px 20px" }}>
                                                {isEditing ? (
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                                                        <div>
                                                            <label className="label">Name</label>
                                                            <input className="input" value={editName} onChange={e => setEditName(e.target.value)} maxLength={32} autoFocus />
                                                        </div>
                                                        <div>
                                                            <label className="label">Color</label>
                                                            <ColorPicker value={editColor} onChange={setEditColor} />
                                                        </div>
                                                        {editName.trim() && (
                                                            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", borderRadius: 8, background: `${editColor}15`, border: `1px solid ${editColor}30` }}>
                                                                <span style={{ width: 7, height: 7, borderRadius: "50%", background: editColor }} />
                                                                <span style={{ fontWeight: 600, color: editColor, fontSize: 12 }}>{editName.trim()}</span>
                                                            </div>
                                                        )}
                                                        <div style={{ display: "flex", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border-light)" }}>
                                                            <button className="btn-primary" style={{ flex: 1, padding: "9px", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                                                                onClick={handleSave} disabled={saving || !editName.trim()}>
                                                                {saving
                                                                    ? <><div style={{ width: 11, height: 11, borderRadius: "50%", border: "2px solid currentColor", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} /> Saving…</>
                                                                    : <><IconSave /> Save</>
                                                                }
                                                            </button>
                                                            <button className="btn-ghost" style={{ flex: 1, padding: "9px" }} onClick={() => setEditId(null)} disabled={saving}>Cancel</button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                                                        {/* Tag badge */}
                                                        <span style={{
                                                            display: "inline-flex", alignItems: "center", gap: 6,
                                                            padding: "5px 12px", borderRadius: 99, fontSize: 13, fontWeight: 600,
                                                            background: `${tag.color}20`, border: `1px solid ${tag.color}40`, color: tag.color
                                                        }}>
                                                            <span style={{ width: 7, height: 7, borderRadius: "50%", background: tag.color }} />
                                                            {tag.name}
                                                        </span>

                                                        {/* Usage */}
                                                        <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, background: "var(--bg-input)", padding: "3px 10px", borderRadius: 6 }}>
                                                            {usage} bot{usage !== 1 ? "s" : ""}
                                                        </span>

                                                        {/* Actions */}
                                                        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                                                            <button onClick={() => startEdit(tag)} className="btn-ghost" style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                                                                <IconEdit /> Edit
                                                            </button>
                                                            <button onClick={() => setDeleteTarget(tag)} className="btn-ghost"
                                                                style={{ padding: "7px 10px", display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--danger)" }}>
                                                                <IconTrash /> Delete
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {deleteTarget && (
                <ConfirmModal
                    title={`Delete tag "${deleteTarget.name}"?`}
                    message={`This will remove the tag from all ${usageMap[deleteTarget._id] || 0} bot(s) that use it. This action is irreversible.`}
                    confirmText="Delete Tag"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
