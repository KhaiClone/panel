import { useState } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const PRESET_COLORS = [
    "#5b73e8", "#4F46E5", "#0EA5E9", "#06B6D4", "#10B981",
    "#84CC16", "#EAB308", "#F97316", "#EF4444", "#EC4899",
    "#A855F7", "#6366F1", "#14B8A6", "#F59E0B", "#64748B",
];

function ColorPicker({ value, onChange }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            {PRESET_COLORS.map(c => (
                <button
                    key={c}
                    type="button"
                    onClick={() => onChange(c)}
                    style={{
                        width: 20, height: 20, borderRadius: "50%", background: c, cursor: "pointer", border: "none",
                        outline: value === c ? `2px solid ${c}` : "2px solid transparent",
                        outlineOffset: 2, transform: value === c ? "scale(1.2)" : "scale(1)",
                        transition: "transform 0.15s",
                    }}
                    title={c}
                />
            ))}
            <input type="color" value={value} onChange={e => onChange(e.target.value)}
                style={{ width: 28, height: 28, borderRadius: 6, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 2 }}
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
        <div style={{ padding: "20px 24px", maxWidth: 760, margin: "0 auto" }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--text)", margin: 0 }}>Tags</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                        Manage labels to categorize and filter your bots
                    </p>
                </div>
                <span style={{
                    fontSize: 12, fontWeight: 600, padding: "4px 12px", borderRadius: 99,
                    background: "rgba(91,115,232,0.1)", border: "1px solid rgba(91,115,232,0.25)", color: "var(--accent)",
                }}>
                    {tags.length} tags
                </span>
            </div>

            {/* Create form */}
            <div className="card" style={{ marginBottom: 20 }}>
                <h2 style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
                    Create New Tag
                </h2>
                <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                        <div style={{ flex: "1 1 200px" }}>
                            <label className="label">Tag Name</label>
                            <input
                                id="tag-name-input"
                                className="input"
                                placeholder="e.g. Production, VIP, Testing…"
                                value={createName}
                                onChange={e => setCreateName(e.target.value)}
                                maxLength={32}
                            />
                        </div>
                        <button type="submit" id="btn-create-tag" className="btn-primary" disabled={creating || !createName.trim()}>
                            {creating ? "Creating…" : "+ Create Tag"}
                        </button>
                    </div>
                    <div>
                        <label className="label">Color</label>
                        <ColorPicker value={createColor} onChange={setCreateColor} />
                    </div>
                    {createName.trim() && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>Preview:</span>
                            <span style={{
                                display: "inline-flex", alignItems: "center", gap: 5,
                                padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600,
                                background: `${createColor}18`, border: `1px solid ${createColor}40`, color: createColor,
                            }}>
                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: createColor }}/>
                                {createName.trim()}
                            </span>
                        </div>
                    )}
                    {createErr && (
                        <div style={{ fontSize: 13, color: "#f87171", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 7, padding: "8px 12px" }}>
                            {createErr}
                        </div>
                    )}
                </form>
            </div>

            {/* Tags list */}
            {tags.length === 0 ? (
                <div style={{ textAlign: "center", padding: "60px 0", border: "1px dashed var(--border)", borderRadius: 10 }}>
                    <p style={{ fontSize: 32, marginBottom: 12 }}>🏷️</p>
                    <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No tags yet. Create one above.</p>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    {tags.map(tag => {
                        const isEditing = editId === tag._id;
                        const usage = usageMap[tag._id] || 0;
                        return (
                            <div key={tag._id} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", marginBottom: 4 }}>
                                {isEditing ? (
                                    <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                                            <div style={{ flex: "1 1 200px" }}>
                                                <label className="label">Name</label>
                                                <input className="input" value={editName} onChange={e => setEditName(e.target.value)} maxLength={32} autoFocus />
                                            </div>
                                        </div>
                                        <div>
                                            <label className="label">Color</label>
                                            <ColorPicker value={editColor} onChange={setEditColor} />
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                            <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>Preview:</span>
                                            <span style={{
                                                display: "inline-flex", alignItems: "center", gap: 5,
                                                padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600,
                                                background: `${editColor}18`, border: `1px solid ${editColor}40`, color: editColor,
                                            }}>
                                                <span style={{ width: 6, height: 6, borderRadius: "50%", background: editColor }}/>
                                                {editName || tag.name}
                                            </span>
                                        </div>
                                        <div style={{ display: "flex", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
                                            <button className="btn-primary" style={{ fontSize: 12 }} onClick={handleSave} disabled={saving || !editName.trim()}>
                                                {saving ? "Saving…" : "💾 Save"}
                                            </button>
                                            <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditId(null)} disabled={saving}>Cancel</button>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
                                        <span style={{ width: 10, height: 10, borderRadius: "50%", background: tag.color, flexShrink: 0 }}/>
                                        <span style={{
                                            display: "inline-flex", alignItems: "center", gap: 5,
                                            padding: "3px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600,
                                            background: `${tag.color}18`, border: `1px solid ${tag.color}40`, color: tag.color,
                                        }}>
                                            <span style={{ width: 5, height: 5, borderRadius: "50%", background: tag.color }}/>
                                            {tag.name}
                                        </span>
                                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{usage} bot{usage !== 1 ? "s" : ""}</span>
                                        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                                            <button id={`btn-edit-tag-${tag._id}`} onClick={() => startEdit(tag)} className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
                                                Edit
                                            </button>
                                            <button id={`btn-delete-tag-${tag._id}`} onClick={() => setDeleteTarget(tag)} className="btn-danger" style={{ padding: "4px 10px", fontSize: 12 }}>
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

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
