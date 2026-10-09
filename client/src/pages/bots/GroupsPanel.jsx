import { Fragment, useEffect, useState } from "react";
import api from "../../api/client";
import { useData } from "../../context/DataContext";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Field, Icon, Notice, StatusBadge } from "../../components/ui";
import ColorPicker, { PRESET_COLORS } from "./ColorPicker";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The Groups tab of the Bots page (it was /groups). Groups are shared with
 * Sites, so a group's members count both.
 */
export default function GroupsPanel({ showNew, onNewClose }) {
    const { groups, bots, refresh } = useData();
    const [editing, setEditing] = useState(null); // null | "new" | group
    const [name, setName] = useState("");
    const [color, setColor] = useState(PRESET_COLORS[0]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [openId, setOpenId] = useState(null);
    const [deleteTarget, setDeleteTarget] = useState(null);

    const openNew = () => { setName(""); setColor(PRESET_COLORS[0]); setError(""); setEditing("new"); };
    const openEdit = (g) => { setName(g.name); setColor(g.color || PRESET_COLORS[0]); setError(""); setEditing(g); };
    const close = () => { setEditing(null); onNewClose?.(); };

    useEffect(() => { if (showNew) openNew(); }, [showNew]);

    const save = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setSaving(true);
        setError("");
        try {
            if (editing === "new") await api.post("/groups", { name: name.trim(), color });
            else await api.put(`/groups/${editing._id}`, { name: name.trim(), color });
            close();
            refresh();
        } catch (err) {
            setError(err.response?.data?.error || "Could not save the group");
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        const g = deleteTarget;
        setDeleteTarget(null);
        try {
            await api.delete(`/groups/${g._id}`);
            refresh();
        } catch (err) {
            setError(err.response?.data?.error || "Could not delete the group");
        }
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {editing && (
                <form className="card slide-up" onSubmit={save} style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{editing === "new" ? "New group" : `Edit "${editing.name}"`}</h2>
                    <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr)", gap: 16 }}>
                        <Field label="Name">
                            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production" maxLength={40} autoFocus />
                        </Field>
                        <Field label="Colour" hint="Marks the group's section on the Bots and Sites pages.">
                            <ColorPicker value={color} onChange={setColor} />
                        </Field>
                    </div>
                    {error && <Notice tone="danger">{error}</Notice>}
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button type="button" className="btn-ghost" onClick={close}>Cancel</button>
                        <button type="submit" className="btn-primary" disabled={saving || !name.trim()}>
                            {saving ? "Saving…" : editing === "new" ? "Create group" : "Save"}
                        </button>
                    </div>
                </form>
            )}

            {!editing && error && <Notice tone="danger">{error}</Notice>}

            {groups.length === 0 ? (
                !editing && (
                    <EmptyState
                        icon="folder"
                        title="No groups yet"
                        description="Groups sort the Bots and Sites lists into sections, one per customer or purpose."
                        action={<button className="btn-primary" onClick={openNew}><Icon name="plus" /> New group</button>}
                    />
                )
            ) : (
                <DataTable minWidth={560} columns={["Group", "Members", "Online", ""]}>
                    {groups.map((g) => {
                        const members = bots.filter((b) => b.groupId === g._id);
                        const sites = members.filter((b) => b.projectType === "website").length;
                        const online = members.filter((b) => b.live?.status === "online").length;
                        const open = openId === g._id;
                        return (
                            <Fragment key={g._id}>
                                <tr
                                    className={`row-click${open ? " row-open" : ""}`}
                                    tabIndex={0}
                                    aria-expanded={open}
                                    onClick={() => setOpenId(open ? null : g._id)}
                                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(open ? null : g._id); } }}
                                >
                                    <td>
                                        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                                            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} style={{ color: "var(--text-dim)" }} />
                                            <span className="chip-dot" style={{ width: 8, height: 8, background: g.color || "var(--text-dim)" }} />
                                            <span style={{ fontWeight: 500 }}>{g.name}</span>
                                        </span>
                                    </td>
                                    <td className="nowrap" style={{ color: "var(--text-muted)" }}>
                                        {plural(members.length - sites, "bot")}
                                        {sites > 0 && ` · ${plural(sites, "site")}`}
                                    </td>
                                    <td>
                                        <StatusBadge tone={online ? "success" : "neutral"}>{online} online</StatusBadge>
                                    </td>
                                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                                        <div className="row-actions">
                                            <button className="btn-ghost btn-sm" onClick={() => openEdit(g)}><Icon name="pencil" size={14} /> Edit</button>
                                            <button className="btn-ghost btn-sm is-danger" onClick={() => setDeleteTarget(g)}><Icon name="trash" size={14} /> Delete</button>
                                        </div>
                                    </td>
                                </tr>
                                {open && (
                                    <tr className="row-detail">
                                        <td colSpan={4}>
                                            <div style={{ padding: "12px 16px" }}>
                                                {members.length === 0 ? (
                                                    <p style={{ fontSize: 13, color: "var(--text-dim)", margin: 0 }}>Nothing in this group yet. Pick it in a bot's settings.</p>
                                                ) : (
                                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6 }}>
                                                        {members.map((b) => (
                                                            <div key={b._id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, background: "var(--bg-card)", border: "1px solid var(--border)" }}>
                                                                <span className="status-dot" style={{ width: 6, height: 6, background: b.live?.status === "online" ? "var(--success)" : "var(--text-dim)" }} />
                                                                <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                                                                <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{b.botID}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </Fragment>
                        );
                    })}
                </DataTable>
            )}

            {deleteTarget && (
                <ConfirmModal
                    title={`Delete the group "${deleteTarget.name}"?`}
                    message="Bots and sites in it become ungrouped. They keep running."
                    confirmText="Delete group"
                    onConfirm={remove}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    );
}
