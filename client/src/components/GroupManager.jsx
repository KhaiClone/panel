import { useState, useEffect } from "react";
import api from "../api/client";
import { EmptyState, Field, Icon, Modal, Notice } from "./ui";
import ColorPicker, { PRESET_COLORS } from "../pages/bots/ColorPicker";

// ── Main Component ─────────────────────────────────────────────────────────
export default function GroupManager({ onClose, onChanged }) {
    const [groups, setGroups] = useState([]);
    const [loading, setLoading] = useState(true);

    // New group form
    const [newName, setNewName] = useState("");
    const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
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

    return (
        <Modal title="Manage groups" onClose={onClose} width={480}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {error && <Notice tone="danger">{error}</Notice>}

                {/* Existing groups */}
                {loading ? (
                    <div style={{ display: "flex", justifyContent: "center", padding: "24px 0" }}>
                        <span className="spinner" style={{ width: 22, height: 22 }} />
                    </div>
                ) : groups.length === 0 ? (
                    <EmptyState compact icon="folder" title="No groups yet" description="Create one below." />
                ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                        {groups.map((g) =>
                            editing?.id === g._id ? (
                                /* Inline edit row */
                                <li
                                    key={g._id}
                                    style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 8, border: "1px solid var(--border-focus)", background: "var(--bg-input)" }}
                                >
                                    <input
                                        className="input"
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
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <button
                                            className="btn-primary btn-sm"
                                            onClick={handleSave}
                                            disabled={saving}
                                        >
                                            {saving ? "Saving…" : "Save"}
                                        </button>
                                        <button
                                            className="btn-ghost btn-sm"
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
                                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 6px 6px 12px", borderRadius: 8, border: "1px solid var(--border)" }}
                                >
                                    <span className="chip-dot" style={{ width: 8, height: 8, background: g.color }} />
                                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {g.name}
                                    </span>
                                    <button
                                        className="btn-ghost btn-icon btn-sm"
                                        title="Edit"
                                        onClick={() =>
                                            setEditing({
                                                id: g._id,
                                                name: g.name,
                                                color: g.color,
                                            })
                                        }
                                    >
                                        <Icon name="pencil" size={14} />
                                    </button>
                                    <button
                                        className="btn-ghost btn-icon btn-sm is-danger"
                                        title="Delete"
                                        onClick={() => handleDelete(g)}
                                    >
                                        <Icon name="trash" size={14} />
                                    </button>
                                </li>
                            ),
                        )}
                    </ul>
                )}

                {/* Create new group */}
                <form
                    onSubmit={handleCreate}
                    style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 16, borderTop: "1px solid var(--border)" }}
                >
                    <p className="section-title" style={{ margin: 0 }}>New group</p>
                    <Field label="Name">
                        <input
                            className="input"
                            placeholder="Group name…"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                        />
                    </Field>
                    {/* Not a Field: its <label> would pass a click on the caption to the first swatch */}
                    <div>
                        <span className="label">Colour</span>
                        <ColorPicker
                            value={newColor}
                            onChange={setNewColor}
                        />
                    </div>
                    <button
                        type="submit"
                        className="btn-primary"
                        style={{ width: "100%" }}
                        disabled={creating || !newName.trim()}
                    >
                        {!creating && <Icon name="plus" />}
                        {creating ? "Creating…" : "Create group"}
                    </button>
                </form>
            </div>
        </Modal>
    );
}
