import { useState } from "react";
import { useData } from "../context/DataContext";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { motion, AnimatePresence } from "framer-motion";

// ── Preset colour palette ──────────────────────────────────────────────────
const PRESET_COLORS = [
    "#7C3AED", "#4F46E5", "#0EA5E9", "#06B6D4", "#10B981",
    "#84CC16", "#EAB308", "#F97316", "#EF4444", "#EC4899",
    "#A855F7", "#6366F1", "#14B8A6", "#F59E0B", "#64748B",
];

// ── Tag pill preview ───────────────────────────────────────────────────────
function TagPill({ name, color }) {
    return (
        <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-[0.08em]"
            style={{
                background: `${color}18`,
                border: `1px solid ${color}40`,
                color,
            }}
        >
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
            {name}
        </span>
    );
}

// ── Main Page ──────────────────────────────────────────────────────────────
export default function TagsPage() {
    const { tags, bots, refresh } = useData();

    const [createName, setCreateName]   = useState("");
    const [createColor, setCreateColor] = useState("#7C3AED");
    const [creating, setCreating]       = useState(false);
    const [createErr, setCreateErr]     = useState("");

    const [editId, setEditId]       = useState(null);
    const [editName, setEditName]   = useState("");
    const [editColor, setEditColor] = useState("");
    const [saving, setSaving]       = useState(false);

    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting]         = useState(false);

    // Count bots per tag
    const usageMap = {};
    for (const bot of bots) {
        for (const tagId of (bot.tags || [])) {
            usageMap[tagId] = (usageMap[tagId] || 0) + 1;
        }
    }

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!createName.trim()) return;
        setCreating(true);
        setCreateErr("");
        try {
            await api.post("/tags", { name: createName.trim(), color: createColor });
            setCreateName("");
            setCreateColor("#7C3AED");
            refresh();
        } catch (err) {
            setCreateErr(err.response?.data?.error || "Failed to create tag");
        } finally {
            setCreating(false);
        }
    };

    const startEdit = (tag) => {
        setEditId(tag._id);
        setEditName(tag.name);
        setEditColor(tag.color);
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await api.put(`/tags/${editId}`, { name: editName.trim(), color: editColor });
            setEditId(null);
            refresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to save tag");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            await api.delete(`/tags/${deleteTarget._id}`);
            setDeleteTarget(null);
            refresh();
        } catch (err) {
            alert(err.response?.data?.error || "Failed to delete tag");
        } finally {
            setDeleting(false);
        }
    };

    const cardStyle = {
        background: "linear-gradient(135deg, rgba(17,24,39,0.95) 0%, rgba(13,21,37,0.95) 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
    };

    return (
        <div className="p-5 lg:p-7 space-y-7 max-w-4xl mx-auto">

            {/* ── Header ── */}
            <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
                <div>
                    <h1 className="text-2xl lg:text-3xl font-black text-slate-100 tracking-tight">Tags</h1>
                    <p className="text-xs text-slate-500 mt-1 font-medium">
                        Manage labels to categorize and filter your bots
                    </p>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold text-slate-400"
                    style={{ background: "rgba(124,58,237,0.08)", border: "1px solid rgba(124,58,237,0.15)" }}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-violet-400">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                        <line x1="7" y1="7" x2="7.01" y2="7"/>
                    </svg>
                    <span className="text-violet-400">{tags.length}</span>
                    <span>tags total</span>
                </div>
            </motion.div>

            {/* ── Create Tag Form ── */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="rounded-2xl p-5 space-y-4"
                style={cardStyle}
            >
                <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-[0.12em] pb-3"
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    Create New Tag
                </h2>

                <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
                    {/* Name input */}
                    <div className="flex-1 space-y-1.5">
                        <label className="label">Tag Name</label>
                        <input
                            id="tag-name-input"
                            className="input"
                            placeholder="e.g. Production, VIP, Testing…"
                            value={createName}
                            onChange={(e) => setCreateName(e.target.value)}
                            maxLength={32}
                        />
                    </div>

                    {/* Color picker */}
                    <div className="space-y-1.5">
                        <label className="label">Color</label>
                        <div className="flex items-center gap-2 flex-wrap">
                            <div className="flex flex-wrap gap-1.5 max-w-[220px]">
                                {PRESET_COLORS.map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        onClick={() => setCreateColor(c)}
                                        className="w-5 h-5 rounded-full transition-all duration-150"
                                        style={{
                                            background: c,
                                            outline: createColor === c ? `2px solid ${c}` : "none",
                                            outlineOffset: "2px",
                                            boxShadow: createColor === c ? `0 0 8px ${c}80` : "none",
                                            transform: createColor === c ? "scale(1.2)" : "scale(1)",
                                        }}
                                        title={c}
                                    />
                                ))}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <input
                                    type="color"
                                    value={createColor}
                                    onChange={(e) => setCreateColor(e.target.value)}
                                    className="w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent p-0.5"
                                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                                    title="Custom color"
                                />
                                <span className="text-[10px] font-mono text-slate-500">{createColor}</span>
                            </div>
                        </div>
                    </div>

                    <button
                        type="submit"
                        id="btn-create-tag"
                        className="btn-primary text-xs shrink-0 self-end"
                        disabled={creating || !createName.trim()}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                        </svg>
                        {creating ? "Creating…" : "Create Tag"}
                    </button>
                </form>

                {/* Preview */}
                {createName.trim() && (
                    <div className="flex items-center gap-2 pt-1">
                        <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Preview:</span>
                        <TagPill name={createName.trim()} color={createColor} />
                    </div>
                )}

                {createErr && (
                    <div className="text-xs text-rose-400 font-semibold px-3 py-2 rounded-lg"
                        style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
                        {createErr}
                    </div>
                )}
            </motion.div>

            {/* ── Tags List ── */}
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="space-y-2"
            >
                {tags.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 rounded-2xl"
                        style={{ border: "1px dashed rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.01)" }}>
                        <div className="text-4xl mb-4 opacity-20">🏷️</div>
                        <p className="text-slate-500 font-medium text-sm">No tags yet. Create one above.</p>
                    </div>
                ) : (
                    <AnimatePresence mode="popLayout">
                        {tags.map((tag, i) => {
                            const isEditing = editId === tag._id;
                            const usage = usageMap[tag._id] || 0;
                            return (
                                <motion.div
                                    key={tag._id}
                                    layout
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    transition={{ delay: i * 0.03 }}
                                    className="rounded-2xl overflow-hidden"
                                    style={cardStyle}
                                >
                                    {isEditing ? (
                                        /* ── Edit row ── */
                                        <div className="p-4 space-y-3">
                                            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
                                                <div className="flex-1 space-y-1.5">
                                                    <label className="label">Name</label>
                                                    <input
                                                        className="input"
                                                        value={editName}
                                                        onChange={(e) => setEditName(e.target.value)}
                                                        maxLength={32}
                                                        autoFocus
                                                    />
                                                </div>
                                                <div className="space-y-1.5">
                                                    <label className="label">Color</label>
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <div className="flex flex-wrap gap-1.5 max-w-[200px]">
                                                            {PRESET_COLORS.map((c) => (
                                                                <button
                                                                    key={c}
                                                                    type="button"
                                                                    onClick={() => setEditColor(c)}
                                                                    className="w-5 h-5 rounded-full transition-all duration-150"
                                                                    style={{
                                                                        background: c,
                                                                        outline: editColor === c ? `2px solid ${c}` : "none",
                                                                        outlineOffset: "2px",
                                                                        transform: editColor === c ? "scale(1.2)" : "scale(1)",
                                                                    }}
                                                                />
                                                            ))}
                                                        </div>
                                                        <input
                                                            type="color"
                                                            value={editColor}
                                                            onChange={(e) => setEditColor(e.target.value)}
                                                            className="w-8 h-8 rounded-lg cursor-pointer border-0 p-0.5"
                                                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 pt-1">
                                                <span className="text-[9px] text-slate-600 uppercase tracking-widest font-bold">Preview:</span>
                                                <TagPill name={editName || tag.name} color={editColor} />
                                            </div>
                                            <div className="flex gap-2 pt-1" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                                                <button className="btn-primary text-xs" onClick={handleSave} disabled={saving || !editName.trim()}>
                                                    {saving ? "Saving…" : "💾 Save"}
                                                </button>
                                                <button className="btn-ghost text-xs" onClick={() => setEditId(null)} disabled={saving}>
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        /* ── Normal row ── */
                                        <div className="flex items-center gap-4 px-4 py-3.5 group">
                                            {/* Color swatch */}
                                            <div className="w-3 h-3 rounded-full shrink-0" style={{ background: tag.color, boxShadow: `0 0 8px ${tag.color}60` }} />

                                            {/* Tag pill */}
                                            <TagPill name={tag.name} color={tag.color} />

                                            {/* Usage badge */}
                                            <span className="text-[10px] font-mono text-slate-600 ml-1"
                                                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6, padding: "2px 8px" }}>
                                                {usage} bot{usage !== 1 ? "s" : ""}
                                            </span>

                                            {/* Actions */}
                                            <div className="ml-auto flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    id={`btn-edit-tag-${tag._id}`}
                                                    onClick={() => startEdit(tag)}
                                                    className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-violet-400 transition-colors"
                                                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                                                    title="Edit tag"
                                                >
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                                    </svg>
                                                </button>
                                                <button
                                                    id={`btn-delete-tag-${tag._id}`}
                                                    onClick={() => setDeleteTarget(tag)}
                                                    className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 hover:text-rose-400 transition-colors"
                                                    style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
                                                    title="Delete tag"
                                                >
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                )}
            </motion.div>

            {/* ── Delete Confirm Modal ── */}
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
