import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";

// ── Color presets ──────────────────────────────────────────────────────────
const COLOR_PRESETS = [
    "#6366f1", // indigo
    "#8b5cf6", // violet
    "#ec4899", // pink
    "#f59e0b", // amber
    "#10b981", // emerald
    "#3b82f6", // blue
    "#ef4444", // red
    "#f97316", // orange
];

function ColorPicker({ value, onChange }) {
    return (
        <div className="flex gap-2 flex-wrap mt-1">
            {COLOR_PRESETS.map((c) => (
                <button
                    key={c}
                    type="button"
                    onClick={() => onChange(c)}
                    title={c}
                    style={{ background: c }}
                    className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                        value === c
                            ? "border-white scale-110"
                            : "border-transparent"
                    }`}
                />
            ))}
        </div>
    );
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function GroupManager({ onClose, onChanged }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    // New group form
    const [newName, setNewName] = useState("");
    const [newColor, setNewColor] = useState(COLOR_PRESETS[0]);
    const [creating, setCreating] = useState(false);

    // Inline edit state: { id, name, color }
    const [editing, setEditing] = useState(null);
    const [saving, setSaving] = useState(false);

    const [error, setError] = useState("");

    const load = async () => {
        try {
            const { data } = await api.get("/groups");
            setGroups(data);
        } catch {
            // silently ignore
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
    }, []);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newName.trim()) return;
        setCreating(true);
        setError("");
        try {
            await api.post("/groups", {
                name: newName.trim(),
                color: newColor,
            });
            setNewName("");
            await load();
            onChanged?.();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to create group");
        } finally {
            setCreating(false);
        }
    };

    const handleSave = async () => {
        if (!editing) return;
        setSaving(true);
        setError("");
        try {
            await api.put(`/groups/${editing.id}`, {
                name: editing.name.trim(),
                color: editing.color,
            });
            setEditing(null);
            await load();
            onChanged?.();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (group) => {
        if (
            !window.confirm(
                `Delete group "${group.name}"? Bots in this group will become ungrouped.`,
            )
        )
            return;
        try {
            await api.delete(`/groups/${group._id}`);
            await load();
            onChanged?.();
        } catch (err) {
            setError(err.response?.data?.error || "Failed to delete");
        }
    };

    return createPortal(
        /* Backdrop */
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
            <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-md shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
                    <h2 className="text-lg font-semibold text-slate-100">
                        🗂️ Manage Groups
                    </h2>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-slate-300 text-xl leading-none"
                    >
                        ✕
                    </button>
                </div>

                <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
                    {/* Error */}
                    {error && (
                        <div className="bg-red-900/40 border border-red-700 text-red-400 text-sm rounded-lg px-3 py-2">
                            {error}
                        </div>
                    )}

                    {/* Existing groups */}
                    {loading ? (
                        <div className="flex justify-center py-6">
                            <div className="animate-spin h-6 w-6 border-4 border-indigo-500 border-t-transparent rounded-full" />
                        </div>
                    ) : groups.length === 0 ? (
                        <p className="text-slate-500 text-sm text-center py-4">
                            No groups yet. Create one below.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {groups.map((g) =>
                                editing?.id === g._id ? (
                                    /* Inline edit row */
                                    <li
                                        key={g._id}
                                        className="bg-slate-700/60 rounded-lg p-3 space-y-2"
                                    >
                                        <input
                                            className="input text-sm w-full"
                                            value={editing.name}
                                            onChange={(e) =>
                                                setEditing((prev) => ({
                                                    ...prev,
                                                    name: e.target.value,
                                                }))
                                            }
                                        />
                                        <ColorPicker
                                            value={editing.color}
                                            onChange={(c) =>
                                                setEditing((prev) => ({
                                                    ...prev,
                                                    color: c,
                                                }))
                                            }
                                        />
                                        <div className="flex gap-2 pt-1">
                                            <button
                                                className="btn-primary text-xs py-1 px-3"
                                                onClick={handleSave}
                                                disabled={saving}
                                            >
                                                {saving ? "Saving…" : "Save"}
                                            </button>
                                            <button
                                                className="btn-ghost text-xs py-1 px-3"
                                                onClick={() => setEditing(null)}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </li>
                                ) : (
                                    /* Normal row */
                                    <li
                                        key={g._id}
                                        className="flex items-center gap-3 bg-slate-700/40 rounded-lg px-3 py-2"
                                    >
                                        <span
                                            className="w-3 h-3 rounded-full shrink-0"
                                            style={{ background: g.color }}
                                        />
                                        <span className="flex-1 text-sm text-slate-200 truncate">
                                            {g.name}
                                        </span>
                                        <button
                                            className="text-slate-500 hover:text-slate-200 text-xs px-2"
                                            onClick={() =>
                                                setEditing({
                                                    id: g._id,
                                                    name: g.name,
                                                    color: g.color,
                                                })
                                            }
                                        >
                                            ✏️
                                        </button>
                                        <button
                                            className="text-red-500 hover:text-red-400 text-xs px-2"
                                            onClick={() => handleDelete(g)}
                                        >
                                            🗑
                                        </button>
                                    </li>
                                ),
                            )}
                        </ul>
                    )}

                    {/* Create new group */}
                    <form
                        onSubmit={handleCreate}
                        className="border-t border-slate-700 pt-4 space-y-3"
                    >
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                            New Group
                        </p>
                        <input
                            className="input text-sm w-full"
                            placeholder="Group name…"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                        />
                        <div>
                            <p className="text-xs text-slate-500 mb-1">Color</p>
                            <ColorPicker
                                value={newColor}
                                onChange={setNewColor}
                            />
                        </div>
                        <button
                            type="submit"
                            className="btn-primary text-sm w-full"
                            disabled={creating || !newName.trim()}
                        >
                            {creating ? "Creating…" : "➕ Create Group"}
                        </button>
                    </form>
                </div>
            </div>
        </div>,
        document.body,
    );
}
