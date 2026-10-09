import { useEffect, useState } from "react";
import api from "../../api/client";
import { useData } from "../../context/DataContext";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Field, Icon, Notice } from "../../components/ui";
import ColorPicker, { PRESET_COLORS } from "./ColorPicker";

function TagChip({ name, color }) {
    return (
        <span className="chip" style={{ cursor: "default", color: "var(--text)" }}>
            <span className="chip-dot" style={{ background: color }} />
            {name || "Tag name"}
        </span>
    );
}

/** The Tags tab of the Bots page (it was /tags). */
export default function TagsPanel({ showNew, onNewClose }) {
    const { tags, bots, refresh } = useData();

    const [creating, setCreating] = useState(false);
    const [createName, setCreateName] = useState("");
    const [createColor, setCreateColor] = useState(PRESET_COLORS[0]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const [editId, setEditId] = useState(null);
    const [editName, setEditName] = useState("");
    const [editColor, setEditColor] = useState("");

    const [deleteTarget, setDeleteTarget] = useState(null);

    useEffect(() => {
        if (!showNew) return;
        setCreateName("");
        setCreateColor(PRESET_COLORS[0]);
        setError("");
        setCreating(true);
    }, [showNew]);

    const closeCreate = () => { setCreating(false); onNewClose?.(); };

    const usage = {};
    for (const bot of bots) {
        for (const tagId of bot.tags || []) usage[tagId] = (usage[tagId] || 0) + 1;
    }

    const run = async (fn, fallback) => {
        setBusy(true);
        setError("");
        try {
            await fn();
            refresh();
            return true;
        } catch (err) {
            setError(err.response?.data?.error || fallback);
            return false;
        } finally {
            setBusy(false);
        }
    };

    const create = async (e) => {
        e.preventDefault();
        if (!createName.trim()) return;
        if (await run(() => api.post("/tags", { name: createName.trim(), color: createColor }), "Could not create the tag")) closeCreate();
    };

    const save = async () => {
        if (await run(() => api.put(`/tags/${editId}`, { name: editName.trim(), color: editColor }), "Could not save the tag")) setEditId(null);
    };

    const remove = async () => {
        const t = deleteTarget;
        setDeleteTarget(null);
        await run(() => api.delete(`/tags/${t._id}`), "Could not delete the tag");
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {creating && (
                <form className="card slide-up" onSubmit={create} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>New tag</h2>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 16 }}>
                        <Field label="Name">
                            <input className="input" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="VIP, Testing…" maxLength={32} autoFocus />
                        </Field>
                        <Field label="Colour">
                            <ColorPicker value={createColor} onChange={setCreateColor} />
                        </Field>
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <TagChip name={createName.trim()} color={createColor} />
                        <span style={{ flex: 1 }} />
                        <button type="button" className="btn-ghost" onClick={closeCreate}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={busy || !createName.trim()}>
                            {busy ? "Creating…" : "Create tag"}
                        </button>
                    </div>
                </form>
            )}

            {error && <Notice tone="danger">{error}</Notice>}

            {tags.length === 0 ? (
                !creating && (
                    <EmptyState
                        icon="tag"
                        title="No tags yet"
                        description="Tags are labels you put on bots, then filter the Bots list by."
                        action={<button className="btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New tag</button>}
                    />
                )
            ) : (
                <DataTable minWidth={520} columns={["Tag", "Used by", ""]}>
                    {tags.map((tag) => {
                        const n = usage[tag._id] || 0;
                        if (editId === tag._id) {
                            return (
                                <tr key={tag._id} className="row-open">
                                    <td colSpan={3}>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
                                            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 16 }}>
                                                <Field label="Name">
                                                    <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={32} autoFocus />
                                                </Field>
                                                <Field label="Colour">
                                                    <ColorPicker value={editColor} onChange={setEditColor} />
                                                </Field>
                                            </div>
                                            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                                                <button className="btn-ghost btn-sm" onClick={() => setEditId(null)} disabled={busy}>Cancel</button>
                                                <button className="btn-primary btn-sm" onClick={save} disabled={busy || !editName.trim()}>
                                                    {busy ? "Saving…" : "Save"}
                                                </button>
                                            </div>
                                        </div>
                                    </td>
                                </tr>
                            );
                        }
                        return (
                            <tr key={tag._id}>
                                <td><TagChip name={tag.name} color={tag.color} /></td>
                                <td className="nowrap" style={{ color: "var(--text-muted)" }}>{n} bot{n === 1 ? "" : "s"}</td>
                                <td className="actions">
                                    <div className="row-actions">
                                        <button className="btn-ghost btn-sm" onClick={() => { setEditId(tag._id); setEditName(tag.name); setEditColor(tag.color); }}>
                                            <Icon name="pencil" size={14} /> Edit
                                        </button>
                                        <button className="btn-ghost btn-sm is-danger" onClick={() => setDeleteTarget(tag)}>
                                            <Icon name="trash" size={14} /> Delete
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </DataTable>
            )}

            {deleteTarget && (
                <ConfirmModal
                    title={`Delete the tag "${deleteTarget.name}"?`}
                    message={`It comes off the ${usage[deleteTarget._id] || 0} bot(s) that have it. This cannot be undone.`}
                    confirmText="Delete tag"
                    onConfirm={remove}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
