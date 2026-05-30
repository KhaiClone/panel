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
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
            {PRESET_COLORS.map(c => (
                <button
                    key={c}
                    type="button"
                    onClick={() => onChange(c)}
                    style={{
                        width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: "none",
                        outline: value === c ? `2px solid ${c}` : "2px solid transparent",
                        outlineOffset: 3, transform: value === c ? "scale(1.15)" : "scale(1)",
                        transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                    }}
                    title={c}
                />
            ))}
            <input type="color" value={value} onChange={e => onChange(e.target.value)}
                style={{ width: 36, height: 36, borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "var(--bg-input)", padding: 4 }}
                title="Custom color"
            />
            <span className="mono" style={{ fontSize: 13, color: "var(--text-dim)", marginLeft: 8 }}>{value}</span>
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
        <div className="fade-in" style={{ padding: "32px", maxWidth: 1000, margin: "0 auto" }}>

            {/* Header */}
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 32 }}>
                <div>
                    <h1 style={{ fontSize: 26, fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.02em" }}>Instance Tags</h1>
                    <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 6 }}>
                        Manage taxonomy and visual labels for your bots.
                    </p>
                </div>
                <span className="badge" style={{ background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent)", padding: "6px 16px", fontSize: 14 }}>
                    {tags.length} Configured Tags
                </span>
            </div>

            {/* Create form */}
            <div className="card" style={{ marginBottom: 32, border: "1px solid var(--border)" }}>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 20, paddingBottom: 16, borderBottom: "1px solid var(--border-light)" }}>
                    Create New Tag
                </h2>
                <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, alignItems: "start" }}>
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
                                <div style={{ marginTop: 16, padding: "16px 20px", background: "var(--bg-input)", borderRadius: 8, border: "1px solid var(--border)" }}>
                                    <label className="label" style={{ marginBottom: 12 }}>Live Preview</label>
                                    <span className="badge" style={{
                                        background: `${createColor}20`, border: `1px solid ${createColor}40`, color: createColor, padding: "6px 14px", fontSize: 13
                                    }}>
                                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: createColor }}/>
                                        {createName.trim()}
                                    </span>
                                </div>
                            )}
                        </div>
                        
                        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <div>
                                <label className="label">Tag Color</label>
                                <ColorPicker value={createColor} onChange={setCreateColor} />
                            </div>
                            
                            {createErr && (
                                <div style={{ fontSize: 13, color: "var(--danger)", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", borderRadius: 8, padding: "12px 16px" }}>
                                    {createErr}
                                </div>
                            )}
                            
                            <button type="submit" className="btn-primary" style={{ padding: "12px", marginTop: "auto" }} disabled={creating || !createName.trim()}>
                                {creating ? "Creating…" : "➕ Create Tag"}
                            </button>
                        </div>
                    </div>
                </form>
            </div>

            {/* Tags list */}
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 16 }}>Existing Tags</h2>
            
            {tags.length === 0 ? (
                <div style={{ textAlign: "center", padding: "80px 20px", border: "1px dashed var(--border)", borderRadius: 16, background: "var(--bg-card)" }}>
                    <div style={{ fontSize: 48, marginBottom: 16, filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.2))" }}>🏷️</div>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>No Tags Found</h3>
                    <p style={{ fontSize: 14, color: "var(--text-muted)" }}>Create a tag above to start labelling your instances.</p>
                </div>
            ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 16 }}>
                    {tags.map(tag => {
                        const isEditing = editId === tag._id;
                        const usage = usageMap[tag._id] || 0;
                        return (
                            <div key={tag._id} className="card card-hover" style={{ padding: 0, overflow: "hidden" }}>
                                {isEditing ? (
                                    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
                                        <div>
                                            <label className="label">Name</label>
                                            <input className="input" value={editName} onChange={e => setEditName(e.target.value)} maxLength={32} autoFocus />
                                        </div>
                                        <div>
                                            <label className="label">Color</label>
                                            <ColorPicker value={editColor} onChange={setEditColor} />
                                        </div>
                                        <div style={{ display: "flex", gap: 12, paddingTop: 16, borderTop: "1px solid var(--border-light)" }}>
                                            <button className="btn-primary" style={{ flex: 1, padding: "10px" }} onClick={handleSave} disabled={saving || !editName.trim()}>
                                                {saving ? "Saving…" : "💾 Save"}
                                            </button>
                                            <button className="btn-ghost" style={{ flex: 1, padding: "10px" }} onClick={() => setEditId(null)} disabled={saving}>Cancel</button>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                                            <span className="badge" style={{
                                                background: `${tag.color}20`, border: `1px solid ${tag.color}40`, color: tag.color, padding: "6px 14px", fontSize: 13
                                            }}>
                                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: tag.color }}/>
                                                {tag.name}
                                            </span>
                                            <span style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500, background: "var(--bg-input)", padding: "4px 10px", borderRadius: 6 }}>
                                                {usage} linked bot{usage !== 1 ? "s" : ""}
                                            </span>
                                        </div>
                                        <div style={{ display: "flex", gap: 8 }}>
                                            <button onClick={() => startEdit(tag)} className="btn-ghost" style={{ padding: "8px" }}>
                                                ✏️
                                            </button>
                                            <button onClick={() => setDeleteTarget(tag)} className="btn-ghost" style={{ padding: "8px", color: "var(--danger)" }}>
                                                🗑️
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
