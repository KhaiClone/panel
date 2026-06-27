import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString() : "—";
const fmtExpiry = (ts) => {
    if (!ts) return { label: "No expiry", color: "var(--text-muted)" };
    const diff = ts - Date.now();
    const days = Math.ceil(diff / 86400000);
    if (diff < 0) return { label: "Expired", color: "var(--danger)" };
    if (days <= 3) return { label: `${days}d left`, color: "var(--danger)" };
    if (days <= 7) return { label: `${days}d left`, color: "var(--warning)" };
    return { label: `${days}d left`, color: "var(--success)" };
};

// ── Sub-components ────────────────────────────────────────────────────────────
function Badge({ label, color, bg }) {
    return (
        <span style={{ padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600, color, background: bg || `${color}22`, border: `1px solid ${color}44` }}>
            {label}
        </span>
    );
}

function SlotBar({ used, max, label }) {
    if (max === null || max === undefined) return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{used} / ∞</span>;
    const pct = Math.min((used / max) * 100, 100);
    const color = pct >= 100 ? "var(--danger)" : pct >= 80 ? "var(--warning)" : "var(--success)";
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 60, height: 5, background: "var(--border)", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 99 }} />
            </div>
            <span style={{ fontSize: 11, color }}>{used}/{max} {label}</span>
        </div>
    );
}

// ── User Form (create / edit) ─────────────────────────────────────────────────
function UserForm({ initial, onSave, onCancel }) {
    const [form, setForm] = useState({
        username: initial?.username || "",
        password: "",
        role: initial?.role || "user",
        active: initial?.active !== false,
    });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    const handle = async (e) => {
        e.preventDefault();
        setErr("");
        if (!form.username.trim()) return setErr("Username is required");
        if (!initial && !form.password) return setErr("Password is required");
        setSaving(true);
        try {
            await onSave(form);
        } catch (ex) {
            setErr(ex.response?.data?.error || "Save failed");
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
                <label className="label">Username</label>
                <input className="input" value={form.username} onChange={e => set("username", e.target.value)} placeholder="john_doe" />
            </div>
            <div>
                <label className="label">{initial ? "New password (leave blank to keep)" : "Password"}</label>
                <input className="input" type="password" value={form.password} onChange={e => set("password", e.target.value)} placeholder={initial ? "••••••••" : "Enter password"} />
            </div>
            <div>
                <label className="label">Role</label>
                <select className="input" value={form.role} onChange={e => set("role", e.target.value)}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                </select>
            </div>
            {initial && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={form.active} onChange={e => set("active", e.target.checked)} />
                    <span style={{ fontSize: 13, color: "var(--text)" }}>Account active</span>
                </label>
            )}
            {err && <p style={{ color: "var(--danger)", fontSize: 12, margin: 0 }}>{err}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : initial ? "Update" : "Create"}</button>
            </div>
        </form>
    );
}

// ── Slot Form ─────────────────────────────────────────────────────────────────
function SlotForm({ userId, initial, onSave, onCancel }) {
    const [form, setForm] = useState({
        maxBots: initial?.maxBots ?? 5,
        maxSites: initial?.maxSites ?? 2,
        maxRamPerBot: initial?.maxRamPerBot || "",
        label: initial?.label || "",
        expiresAt: initial?.expiresAt
            ? new Date(initial.expiresAt).toISOString().slice(0, 10)
            : "",
    });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    const handle = async (e) => {
        e.preventDefault();
        setErr("");
        setSaving(true);
        try {
            await onSave({
                userId,
                maxBots: Number(form.maxBots),
                maxSites: Number(form.maxSites),
                maxRamPerBot: form.maxRamPerBot.trim() || null,
                label: form.label.trim(),
                expiresAt: form.expiresAt ? new Date(form.expiresAt).getTime() : null,
            });
        } catch (ex) {
            setErr(ex.response?.data?.error || "Save failed");
        } finally {
            setSaving(false);
        }
    };

    return (
        <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <div>
                    <label className="label">Max Bots</label>
                    <input className="input" type="number" min="0" value={form.maxBots} onChange={e => set("maxBots", e.target.value)} />
                </div>
                <div>
                    <label className="label">Max Sites</label>
                    <input className="input" type="number" min="0" value={form.maxSites} onChange={e => set("maxSites", e.target.value)} />
                </div>
            </div>
            <div>
                <label className="label">RAM limit per bot (e.g. 512M, 1G) — blank = no limit</label>
                <input className="input" value={form.maxRamPerBot} onChange={e => set("maxRamPerBot", e.target.value)} placeholder="512M" />
            </div>
            <div>
                <label className="label">Expiry date — blank = no expiry</label>
                <input className="input" type="date" value={form.expiresAt} onChange={e => set("expiresAt", e.target.value)} />
            </div>
            <div>
                <label className="label">Label / notes</label>
                <input className="input" value={form.label} onChange={e => set("label", e.target.value)} placeholder="Premium, Trial, etc." />
            </div>
            {err && <p style={{ color: "var(--danger)", fontSize: 12, margin: 0 }}>{err}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save Slot"}</button>
            </div>
        </form>
    );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
    return (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
            onClick={e => e.target === e.currentTarget && onClose()}>
            <div className="card slide-up" style={{ width: "100%", maxWidth: 460, padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h3>
                    <button onClick={onClose} className="btn-ghost" style={{ padding: 6, borderRadius: 6 }}>✕</button>
                </div>
                {children}
            </div>
        </div>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AdminUsersPage() {
    const [users, setUsers] = useState([]);
    const [slots, setSlots] = useState({}); // userId → slot
    const [loading, setLoading] = useState(true);
    const [modal, setModal] = useState(null); // { type: 'createUser'|'editUser'|'editSlot', data? }
    const [confirm, setConfirm] = useState(null);
    const [expandedUser, setExpandedUser] = useState(null);
    const [userBots, setUserBots] = useState({}); // userId → bots[]

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [uRes, sRes] = await Promise.all([
                api.get("/admin/users"),
                api.get("/admin/slots"),
            ]);
            setUsers(uRes.data);
            const slotMap = {};
            for (const s of sRes.data) slotMap[s.userId] = s;
            setSlots(slotMap);
        } catch {}
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const toggleExpand = async (userId) => {
        if (expandedUser === userId) { setExpandedUser(null); return; }
        setExpandedUser(userId);
        if (!userBots[userId]) {
            try {
                const r = await api.get(`/admin/users/${userId}/bots`);
                setUserBots(prev => ({ ...prev, [userId]: r.data }));
            } catch { setUserBots(prev => ({ ...prev, [userId]: [] })); }
        }
    };

    const handleCreateUser = async (form) => {
        await api.post("/admin/users", form);
        setModal(null);
        load();
    };

    const handleEditUser = async (form) => {
        await api.put(`/admin/users/${modal.data._id}`, form);
        setModal(null);
        load();
    };

    const handleDeleteUser = async (user) => {
        await api.delete(`/admin/users/${user._id}`);
        setConfirm(null);
        load();
    };

    const handleSaveSlot = async (data) => {
        await api.post("/admin/slots", data);
        setModal(null);
        load();
    };

    if (loading) return <div className="page" style={{ display: "flex", justifyContent: "center", padding: 60 }}><div className="spinner" /></div>;

    return (
        <div className="page fade-in" style={{ maxWidth: 900 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>User Management</h1>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>{users.length} user{users.length !== 1 ? "s" : ""} registered</p>
                </div>
                <button className="btn btn-primary" onClick={() => setModal({ type: "createUser" })}>+ New User</button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {users.map(u => {
                    const slot = slots[u._id];
                    const exp = slot?.expiresAt ? fmtExpiry(slot.expiresAt) : null;
                    const isExpanded = expandedUser === u._id;

                    return (
                        <div key={u._id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                            {/* User row */}
                            <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                                {/* Avatar */}
                                <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent), #8B5CF6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                                    {u.username[0].toUpperCase()}
                                </div>

                                {/* Info */}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                        <span style={{ fontWeight: 600, fontSize: 14 }}>{u.username}</span>
                                        <Badge label={u.role} color={u.role === "admin" ? "var(--accent-hover)" : "var(--text-muted)"} />
                                        {!u.active && <Badge label="Disabled" color="var(--danger)" />}
                                        {exp && <Badge label={exp.label} color={exp.color} />}
                                    </div>
                                    <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--text-dim)" }}>
                                        Joined {fmtDate(u.createdAt)} · Last login {fmtDate(u.lastLoginAt)}
                                    </p>
                                </div>

                                {/* Slot usage */}
                                {slot && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginRight: 8 }} className="hide-mobile">
                                        <SlotBar used={slot.usage?.bots || 0} max={slot.maxBots} label="bots" />
                                        <SlotBar used={slot.usage?.sites || 0} max={slot.maxSites} label="sites" />
                                    </div>
                                )}

                                {/* Actions */}
                                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }}
                                        onClick={() => setModal({ type: "editSlot", data: { userId: u._id, username: u.username, slot } })}>
                                        {slot ? "Edit Slot" : "+ Slot"}
                                    </button>
                                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }}
                                        onClick={() => setModal({ type: "editUser", data: u })}>
                                        Edit
                                    </button>
                                    <button className="btn" style={{ fontSize: 12, padding: "5px 10px", background: "rgba(239,68,68,0.08)", color: "var(--danger)", border: "1px solid rgba(239,68,68,0.2)" }}
                                        onClick={() => setConfirm({ action: () => handleDeleteUser(u), message: `Delete user "${u.username}"? Their bots will remain but be unowned.` })}>
                                        Delete
                                    </button>
                                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: "5px 10px" }}
                                        onClick={() => toggleExpand(u._id)}>
                                        {isExpanded ? "▲" : "▼"} Bots
                                    </button>
                                </div>
                            </div>

                            {/* Expanded bots list */}
                            {isExpanded && (
                                <div style={{ borderTop: "1px solid var(--border-light)", padding: "12px 18px", background: "var(--bg)" }}>
                                    {!userBots[u._id] ? (
                                        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Loading…</p>
                                    ) : userBots[u._id].length === 0 ? (
                                        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>No bots / sites yet.</p>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            {userBots[u._id].map(b => (
                                                <div key={b._id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "var(--bg-surface)", borderRadius: 8, border: "1px solid var(--border-light)" }}>
                                                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{b.name}</span>
                                                    <Badge label={b.projectType || "discord"} color="var(--text-muted)" />
                                                    <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{b.pm2Name}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}

                {users.length === 0 && (
                    <div className="card" style={{ padding: 40, textAlign: "center" }}>
                        <p style={{ color: "var(--text-muted)", margin: 0 }}>No users yet. Click "New User" to create one.</p>
                    </div>
                )}
            </div>

            {/* Modals */}
            {modal?.type === "createUser" && (
                <Modal title="Create User" onClose={() => setModal(null)}>
                    <UserForm onSave={handleCreateUser} onCancel={() => setModal(null)} />
                </Modal>
            )}

            {modal?.type === "editUser" && (
                <Modal title={`Edit: ${modal.data.username}`} onClose={() => setModal(null)}>
                    <UserForm initial={modal.data} onSave={handleEditUser} onCancel={() => setModal(null)} />
                </Modal>
            )}

            {modal?.type === "editSlot" && (
                <Modal title={`Slot for ${modal.data.username}`} onClose={() => setModal(null)}>
                    <SlotForm userId={modal.data.userId} initial={modal.data.slot} onSave={handleSaveSlot} onCancel={() => setModal(null)} />
                </Modal>
            )}

            {confirm && (
                <ConfirmModal
                    message={confirm.message}
                    onConfirm={confirm.action}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
