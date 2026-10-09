import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, PageHeader, SearchInput, StatusBadge, Toggle } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  Vouchers — rewards the admin hands out and claims by hand.
//
//  A voucher is given to members here (ArnTo-assistant DMs them the code), or
//  shared as a code anyone may use. A member runs /voucher dung on the
//  assistant; the panel checks their uses left and records a pending use, and
//  the assistant posts a card with Claim / Reject in the claim channel. An
//  admin claims it there or here, then hands the reward over. Rejecting gives
//  the use back. The logic lives in server/services/voucherService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);
const limitText = (n) => (n ? String(n) : "∞");
const countsKey = (v) => `${v.counts.pending}-${v.counts.claimed}-${v.counts.rejected}`;
const SNOWFLAKE = /^\d{17,20}$/;

const STATUS = {
    pending: { text: "Waiting", tone: "warning" },
    claimed: { text: "Claimed", tone: "success" },
    rejected: { text: "Rejected", tone: "danger" },
};
const DM = {
    off: { text: "Not sent", tone: "neutral" },
    pending: { text: "Sending…", tone: "warning" },
    sent: { text: "Sent", tone: "success" },
    dm_blocked: { text: "DMs closed", tone: "danger" },
    unknown_user: { text: "Unknown user", tone: "danger" },
    failed: { text: "Failed", tone: "danger" },
};

// ── Building blocks ──────────────────────────────────────────────────────────

function Member({ tag, id }) {
    return (
        <>
            <div>{tag || "—"}</div>
            <div className="mono cell-sub">{id}</div>
        </>
    );
}

// ── Voucher settings (create + edit) ─────────────────────────────────────────

const emptyDraft = { name: "", code: "", description: "", audience: "granted", perUser: 1, total: 0, expiresAt: "", enabled: true };
const toDraft = (v) => ({ ...v, expiresAt: toLocalInput(v.expiresAt) });
const fromDraft = (d) => ({ ...d, perUser: Number(d.perUser) || 0, total: Number(d.total) || 0, expiresAt: fromLocalInput(d.expiresAt) });

function VoucherForm({ initial, isNew, onSave, saving }) {
    const [d, setD] = useState(initial);
    useEffect(() => setD(initial), [initial]);
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave(fromDraft(d));
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
                <Field label="Reward" hint="What the member gets — shown in the DM and on the claim card.">
                    <input className="input" value={d.name} maxLength={100} placeholder="20k off the next order" onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <Field label="Code (typed in /voucher dung)" hint={isNew ? "Empty = a random 8-character code. A-Z, 0-9, - and _" : "Changing it makes the code already sent stop working."}>
                    <input className="input mono" value={d.code} maxLength={32} placeholder="TET2026" onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
                </Field>
            </div>

            <Field label="Details (optional)" hint="Conditions, how the reward is handed over… Discord markdown works.">
                <textarea className="input" rows={3} value={d.description} maxLength={1500} onChange={(e) => set({ description: e.target.value })} style={{ resize: "vertical", fontSize: 13, lineHeight: 1.5 }} />
            </Field>

            <Field label="Who can use it">
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                    {[
                        ["granted", "Only the members it is given to", "Give it to members under Members; anyone else typing the code is refused."],
                        ["public", "Anyone with the code", "Share the code yourself. Giving it to members still DMs them and can set their own limit."],
                    ].map(([value, label, hint]) => (
                        <label key={value} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
                            <input type="radio" name="audience" checked={d.audience === value} onChange={() => set({ audience: value })} style={{ marginTop: 3 }} />
                            <span>
                                {label}
                                <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
                <Field label="Uses per member" hint="0 = no limit. A member can get their own limit under Members.">
                    <input className="input" type="number" min={0} max={10000} value={d.perUser} onChange={(e) => set({ perUser: e.target.value })} />
                </Field>
                <Field label="Uses overall" hint="0 = no limit">
                    <input className="input" type="number" min={0} max={1000000} value={d.total} onChange={(e) => set({ total: e.target.value })} />
                </Field>
                <Field label="Expires (optional)" hint="Empty = never">
                    <input className="input" type="datetime-local" value={d.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} />
                </Field>
            </div>
            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
                Waiting and claimed uses count towards the limits; a rejected use is given back.
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="submit" className="btn-primary" disabled={saving || !d.name.trim()} style={{ padding: "8px 18px" }}>
                    {saving ? "Saving…" : isNew ? "Create voucher" : "Save"}
                </button>
            </div>
        </form>
    );
}

// ── Uses ─────────────────────────────────────────────────────────────────────

function UsesTable({ rows, showVoucher, busy, onClaim, onReject }) {
    return (
        <DataTable minWidth={showVoucher ? 860 : 760} columns={["ID", "Member", ...(showVoucher ? ["Voucher"] : []), "Note", "Requested", "Status", ""]}>
            {rows.map((r) => {
                const s = STATUS[r.status] || STATUS.pending;
                return (
                    <tr key={r.id}>
                        <td className="mono nowrap top">{r.id}</td>
                        <td className="nowrap top">
                            <Member tag={r.userTag} id={r.userId} />
                        </td>
                        {showVoucher && (
                            <td className="nowrap top">
                                <div>{r.voucherName || "—"}</div>
                                <div className="mono cell-sub">{r.voucherCode}</div>
                            </td>
                        )}
                        <td className="top" style={{ maxWidth: 260, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{r.note || <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                        <td className="muted top">{fmtDate(r.createdAt)}</td>
                        <td className="top">
                            <StatusBadge tone={s.tone}>{s.text}</StatusBadge>
                            {r.status !== "pending" && (
                                <div className="cell-sub" style={{ whiteSpace: "nowrap" }}>
                                    {r.via === "discord" ? `${r.staffTag || "—"} · Discord` : "Panel"} · {fmtDate(r.resolvedAt)}
                                </div>
                            )}
                            {r.reason && <div className="cell-sub" style={{ color: "var(--text-muted)" }}>{r.reason}</div>}
                        </td>
                        <td className="actions top">
                            {r.status === "pending" && (
                                <div className="row-actions">
                                    <button className="btn-primary btn-sm" disabled={busy === r.id} onClick={() => onClaim(r)}>
                                        Claim
                                    </button>
                                    <button className="btn-ghost btn-sm is-danger" disabled={busy === r.id} onClick={() => onReject(r)}>
                                        Reject
                                    </button>
                                </div>
                            )}
                        </td>
                    </tr>
                );
            })}
        </DataTable>
    );
}

function UsesTab({ voucher, refreshKey, actions }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [filter, setFilter] = useState("all");
    const [search, setSearch] = useState("");

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/vouchers/redemptions", { params: { voucherId: voucher.id } });
            setRows(data.redemptions || []);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the uses"));
        } finally {
            setLoading(false);
        }
    }, [voucher.id]);

    useEffect(() => {
        setLoading(true);
        load();
    }, [load, refreshKey]);

    const q = search.trim().toLowerCase();
    const visible = rows.filter(
        (r) => (filter === "all" || r.status === filter) && (!q || [r.id, r.userId, r.userTag, r.note, r.staffTag].some((v) => String(v || "").toLowerCase().includes(q))),
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="toolbar">
                <div className="tab-bar">
                    {["all", "pending", "claimed", "rejected"].map((f) => (
                        <button key={f} className={`tab-item ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
                            {f === "all" ? "All" : STATUS[f].text}
                        </button>
                    ))}
                </div>
                <SearchInput value={search} onChange={setSearch} placeholder="Search ID, member, note…" style={{ flex: "1 1 180px", maxWidth: 280 }} />
                <span className="toolbar-count">
                    {visible.length} / {rows.length} uses
                </span>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !rows.length ? (
                <EmptyState
                    compact
                    icon="voucher"
                    title="Nobody has used it yet"
                    description={<>Members run <code className="mono">/voucher dung ma:{voucher.code}</code> on ArnTo-assistant.</>}
                />
            ) : (
                <UsesTable rows={visible} busy={actions.busy} onClaim={(r) => actions.claim(r)} onReject={(r) => actions.reject(r)} />
            )}
        </div>
    );
}

// ── Members (grants) ─────────────────────────────────────────────────────────

function MembersTab({ voucher, status, refreshKey, onChanged }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [ids, setIds] = useState("");
    const [uses, setUses] = useState("");
    const [notify, setNotify] = useState(true);
    const [adding, setAdding] = useState(false);
    const [msg, setMsg] = useState(null);
    const [busy, setBusy] = useState(null);
    const [editing, setEditing] = useState(null); // { userId, uses }
    const [confirm, setConfirm] = useState(null); // grant
    const [search, setSearch] = useState("");

    const load = useCallback(async () => {
        try {
            const { data } = await api.get(`/vouchers/${voucher.id}/grants`);
            setRows(data.grants || []);
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not load the members") });
        } finally {
            setLoading(false);
        }
    }, [voucher.id]);

    useEffect(() => {
        setLoading(true);
        setMsg(null);
    }, [voucher.id]);

    // Reload when the uses change too — a member just used it, or a use was claimed / rejected.
    useEffect(() => {
        load();
    }, [load, refreshKey]);

    // DMs on their way: follow them until they settle.
    const sending = rows.some((r) => r.dm === "pending");
    useEffect(() => {
        if (!sending) return undefined;
        const t = setInterval(load, 4000);
        return () => clearInterval(t);
    }, [sending, load]);

    const found = useMemo(() => [...new Set(ids.match(/\d{17,20}/g) || [])], [ids]);

    const add = async () => {
        setAdding(true);
        setMsg(null);
        try {
            const { data } = await api.post(`/vouchers/${voucher.id}/grants`, { userIds: found, uses: uses === "" ? undefined : Number(uses), notify });
            const parts = [`Given to ${data.added} new member(s)${data.updated ? `, ${data.updated} already had it (limit updated)` : ""}.`];
            if (data.unknown.length) parts.push(`No Discord user: ${data.unknown.join(", ")}.`);
            if (data.dm === "queued") parts.push("ArnTo-assistant is DMing them the code.");
            if (data.dm === "unavailable") parts.push("ArnTo-assistant cannot DM right now — they were not notified.");
            setMsg({ tone: data.unknown.length || data.dm === "unavailable" ? "warning" : "success", text: parts.join(" ") });
            setIds("");
            await load();
            onChanged();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not give the voucher") });
        } finally {
            setAdding(false);
        }
    };

    const act = async (userId, fn) => {
        setBusy(userId);
        try {
            await fn();
            await load();
            onChanged();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Action failed") });
        } finally {
            setBusy(null);
        }
    };

    const saveUses = async () => {
        const e = editing;
        setEditing(null);
        await act(e.userId, () => api.put(`/vouchers/${voucher.id}/grants/${e.userId}`, { uses: e.uses === "" ? "" : Number(e.uses) }));
    };

    const q = search.trim().toLowerCase();
    const visible = q ? rows.filter((r) => [r.userId, r.userTag].some((v) => String(v || "").toLowerCase().includes(q))) : rows;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Field label="Give to members" hint="Discord IDs or mentions — one per line, or separated by commas / spaces. Up to 200 at a time.">
                    <textarea
                        className="input mono"
                        rows={3}
                        value={ids}
                        spellCheck={false}
                        onChange={(e) => setIds(e.target.value)}
                        placeholder={"871329074046435338\n427399742906040333"}
                        style={{ resize: "vertical", fontSize: 12, lineHeight: 1.6 }}
                    />
                </Field>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)" }}>
                        Uses each
                        <input
                            className="input"
                            type="number"
                            min={0}
                            max={10000}
                            value={uses}
                            placeholder={limitText(voucher.perUser)}
                            onChange={(e) => setUses(e.target.value)}
                            style={{ width: 80 }}
                            title="Empty = the voucher's uses per member. 0 = no limit."
                        />
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-muted)", cursor: "pointer" }}>
                        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                        DM them the code (ArnTo-assistant)
                    </label>
                    <button className="btn-primary" style={{ marginLeft: "auto", padding: "7px 16px" }} disabled={adding || !found.length} onClick={add}>
                        {adding ? "Giving…" : `Give to ${found.length || ""} member${found.length === 1 ? "" : "s"}`}
                    </button>
                </div>
                {notify && status && !status.dmSender && <Notice>ArnTo-assistant has not announced <code className="mono">voucher.granted</code> — members will not be DM'd.</Notice>}
                {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            </div>

            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Search member…" style={{ flex: "1 1 200px", maxWidth: 300 }} />
                <span className="toolbar-count">
                    {visible.length} / {rows.length} members
                </span>
            </div>

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !rows.length ? (
                <EmptyState
                    compact
                    icon="users"
                    title="Not given to anyone yet"
                    description={voucher.audience === "public" ? "Anyone with the code can use it." : "Nobody can use it until it is given to someone above."}
                />
            ) : (
                <DataTable minWidth={640} columns={["Member", "Uses", "DM", "Given", ""]}>
                    {visible.map((g) => {
                        const limit = g.uses ?? voucher.perUser;
                        const dm = DM[g.dm] || DM.off;
                        return (
                            <tr key={g.userId}>
                                <td className="nowrap top">
                                    <Member tag={g.userTag} id={g.userId} />
                                </td>
                                <td className="nowrap top">
                                    {editing?.userId === g.userId ? (
                                        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                                            <input
                                                className="input"
                                                type="number"
                                                min={0}
                                                autoFocus
                                                value={editing.uses}
                                                placeholder={limitText(voucher.perUser)}
                                                onChange={(e) => setEditing({ ...editing, uses: e.target.value })}
                                                onKeyDown={(e) => e.key === "Enter" && saveUses()}
                                                style={{ width: 70, padding: "4px 8px" }}
                                            />
                                            <button className="btn-primary btn-sm" onClick={saveUses}>Save</button>
                                            <button className="btn-ghost btn-icon btn-sm" title="Cancel" onClick={() => setEditing(null)}>
                                                <Icon name="x" size={14} />
                                            </button>
                                        </span>
                                    ) : (
                                        <span
                                            style={{ cursor: "pointer", color: limit && g.used >= limit ? "var(--danger)" : undefined }}
                                            title="Click to set this member's own limit (empty = the voucher's)"
                                            onClick={() => setEditing({ userId: g.userId, uses: g.uses ?? "" })}
                                        >
                                            <b>{g.used}</b> / {limitText(limit)}
                                            {g.uses !== null && <span style={{ fontSize: 11, color: "var(--text-dim)" }}> (own)</span>}
                                        </span>
                                    )}
                                </td>
                                <td className="top"><StatusBadge tone={dm.tone}>{dm.text}</StatusBadge></td>
                                <td className="muted top">{fmtDate(g.grantedAt)}</td>
                                <td className="actions top">
                                    <div className="row-actions">
                                        <button
                                            className="btn-ghost btn-sm"
                                            disabled={busy === g.userId || g.dm === "pending" || !status?.dmSender}
                                            onClick={() => act(g.userId, () => api.post(`/vouchers/${voucher.id}/grants/${g.userId}/dm`))}
                                        >
                                            {g.dm === "off" ? "DM" : "DM again"}
                                        </button>
                                        <button className="btn-ghost btn-sm is-danger" disabled={busy === g.userId} onClick={() => setConfirm(g)}>
                                            Remove
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </DataTable>
            )}

            {confirm && (
                <ConfirmModal
                    title={`Take the voucher back from ${confirm.userTag || confirm.userId}?`}
                    message={
                        voucher.audience === "public"
                            ? "They lose their own limit and fall back to the voucher's. Their past uses stay in the history."
                            : "They can no longer use it. Their past uses stay in the history."
                    }
                    confirmText="Remove"
                    onConfirm={() => {
                        const g = confirm;
                        setConfirm(null);
                        act(g.userId, () => api.delete(`/vouchers/${voucher.id}/grants/${g.userId}`));
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}

// ── Claim settings ───────────────────────────────────────────────────────────

function SettingsModal({ settings, onClose, onSaved }) {
    const [d, setD] = useState({ channelId: settings.channelId || "", pingRoleId: settings.pingRoleId || "", staffRoleIds: (settings.staffRoleIds || []).join(", ") });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));
    const bad = (v) => v.trim() && !SNOWFLAKE.test(v.trim());

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api.put("/vouchers/settings", { channelId: d.channelId.trim(), pingRoleId: d.pingRoleId.trim(), staffRoleIds: d.staffRoleIds });
            onSaved();
            onClose();
        } catch (err) {
            setError(errMsg(err, "Could not save"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Claim settings" onClose={onClose} width={480}>
            <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Field label="Claim channel ID" hint="Where ArnTo-assistant posts each use with Claim / Reject — a channel of the shop server. Empty = the channel the member typed the command in.">
                    <input className="input mono" value={d.channelId} onChange={(e) => set({ channelId: e.target.value })} placeholder="1205054570074480710" />
                </Field>
                <Field label="Role to ping (optional)" hint="Mentioned on every new card.">
                    <input className="input mono" value={d.pingRoleId} onChange={(e) => set({ pingRoleId: e.target.value })} />
                </Field>
                <Field label="Staff roles that may claim (optional)" hint="Role IDs, separated by commas. Administrators can always claim.">
                    <input className="input mono" value={d.staffRoleIds} onChange={(e) => set({ staffRoleIds: e.target.value })} placeholder="1246001516893175818" />
                </Field>
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={busy || bad(d.channelId) || bad(d.pingRoleId)}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function VouchersPage() {
    const [vouchers, setVouchers] = useState([]);
    const [pending, setPending] = useState([]);
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [tab, setTab] = useState("uses");
    const [creating, setCreating] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [rejecting, setRejecting] = useState(null); // redemption
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState(null);
    const [usesKey, setUsesKey] = useState(0);

    const load = useCallback(async () => {
        try {
            const [v, p, s] = await Promise.all([api.get("/vouchers"), api.get("/vouchers/redemptions", { params: { status: "pending" } }), api.get("/vouchers/status")]);
            setVouchers(v.data.vouchers || []);
            setPending(p.data.redemptions || []);
            setStatus(s.data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the vouchers"));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const t = setInterval(load, 15_000);
        return () => clearInterval(t);
    }, [load]);

    useEffect(() => {
        if (!vouchers.length) setSelectedId(null);
        else if (!vouchers.some((v) => v.id === selectedId)) setSelectedId(vouchers[0].id);
    }, [vouchers, selectedId]);

    const selected = vouchers.find((v) => v.id === selectedId) || null;
    const selectedDraft = useMemo(() => (selected ? toDraft(selected) : null), [selected?.id, selected?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const resolve = async (r, kind, body) => {
        setBusy(r.id);
        try {
            await api.post(`/vouchers/redemptions/${r.id}/${kind}`, body);
        } catch (err) {
            alert(errMsg(err, `Could not ${kind}`));
        } finally {
            setBusy(null);
            setUsesKey((k) => k + 1);
            load();
        }
    };
    const actions = {
        busy,
        claim: (r) => resolve(r, "claim"),
        reject: (r) => {
            setReason("");
            setRejecting(r);
        },
    };

    const create = async (body) => {
        setSaving(true);
        try {
            const { data } = await api.post("/vouchers", body);
            setCreating(false);
            await load();
            setSelectedId(data.id);
            setTab("members");
        } catch (err) {
            alert(errMsg(err, "Could not create the voucher"));
        } finally {
            setSaving(false);
        }
    };

    const save = async (body) => {
        setSaving(true);
        setSaveMsg(null);
        try {
            await api.put(`/vouchers/${selected.id}`, body);
            await load();
            setSaveMsg({ tone: "success", text: "Saved." });
        } catch (err) {
            setSaveMsg({ tone: "danger", text: errMsg(err, "Could not save") });
        } finally {
            setSaving(false);
        }
    };

    const toggleEnabled = async (v, enabled) => {
        try {
            await api.put(`/vouchers/${v.id}`, { enabled });
            await load();
        } catch (err) {
            alert(errMsg(err, "Could not change it"));
        }
    };

    const remove = async () => {
        setConfirmDelete(false);
        try {
            await api.delete(`/vouchers/${selected.id}`);
            await load();
        } catch (err) {
            alert(errMsg(err, "Could not delete"));
        }
    };

    const expired = (v) => v.expiresAt && v.expiresAt <= Date.now();

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <PageHeader
                title="Vouchers"
                description={<>Members use them with <code className="mono">/voucher dung</code> on ArnTo-assistant; an admin claims each use and hands the reward over.</>}
                actions={
                    <>
                        <button className="btn-ghost" disabled={!status} onClick={() => setShowSettings(true)}>
                            <Icon name="settings" /> Claim settings
                        </button>
                        <button className="btn-primary" onClick={() => setCreating(true)}>
                            <Icon name="plus" /> New voucher
                        </button>
                    </>
                }
            />

            {error && <Notice tone="danger">{error}</Notice>}
            {status && !status.dmSender && (
                <Notice>
                    ArnTo-assistant has not announced <code className="mono">voucher.granted</code> / <code className="mono">voucher.resolved</code> yet — update the bot (Pull &amp; Update) and
                    restart it. Until then members get no DM and claims made here do not update the card on Discord.
                </Notice>
            )}
            {status && status.dmSender && !status.busReady && <Notice>The panel's Discord bus is not ready — DMs and card updates wait until it is.</Notice>}
            {status && !status.settings.channelId && (
                <Notice>No claim channel set — each card goes to the channel the member typed the command in. Set one under Claim settings.</Notice>
            )}

            {pending.length > 0 && (
                <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                    <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                        <StatusBadge tone="warning" />
                        Waiting for a claim
                        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>{pending.length}</span>
                    </h2>
                    <UsesTable rows={pending} showVoucher busy={busy} onClaim={actions.claim} onReject={actions.reject} />
                </div>
            )}

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !vouchers.length ? (
                <EmptyState
                    icon="voucher"
                    title="No vouchers yet"
                    description="A voucher is a reward members claim with a code."
                    action={<button className="btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New voucher</button>}
                />
            ) : (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {vouchers.map((v) => {
                            const active = v.id === selectedId;
                            return (
                                <div
                                    key={v.id}
                                    className={`select-card${active ? " active" : ""}${v.enabled && !expired(v) ? "" : " off"}`}
                                    onClick={() => {
                                        setSelectedId(v.id);
                                        setSaveMsg(null);
                                    }}
                                >
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ fontWeight: 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{v.code}</div>
                                        </div>
                                        <Toggle checked={v.enabled} title={v.enabled ? "On — turn off to refuse new uses" : "Off"} onChange={(on) => toggleEnabled(v, on)} />
                                    </div>
                                    <div className="meta-row">
                                        {v.audience === "public" ? (
                                            <span title="Anyone with the code">
                                                <Icon name="globe" size={12} /> Anyone
                                            </span>
                                        ) : (
                                            <span title="Members it was given to">
                                                <Icon name="users" size={12} /> {v.counts.granted} member{v.counts.granted === 1 ? "" : "s"}
                                            </span>
                                        )}
                                        <span>
                                            {v.counts.used} / {limitText(v.total)} used
                                        </span>
                                        {v.counts.pending > 0 && <StatusBadge tone="warning" title="Waiting for a claim">{v.counts.pending} waiting</StatusBadge>}
                                        {v.expiresAt && <span style={{ color: expired(v) ? "var(--danger)" : undefined }}>{expired(v) ? "Expired" : `until ${fmtDate(v.expiresAt)}`}</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {selected && (
                        <div className="card" style={{ padding: 18, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <div style={{ minWidth: 0 }}>
                                    <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{selected.name}</h2>
                                    <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                        <span className="mono">{selected.code}</span> · {limitText(selected.perUser)} use{selected.perUser === 1 ? "" : "s"} per member
                                    </div>
                                </div>
                                <div className="tab-bar" style={{ marginLeft: "auto" }}>
                                    {[
                                        ["uses", `Uses (${selected.counts.used + selected.counts.rejected})`],
                                        ["members", `Members (${selected.counts.granted})`],
                                        ["settings", "Settings"],
                                    ].map(([id, label]) => (
                                        <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {tab === "uses" && <UsesTab voucher={selected} refreshKey={`${usesKey}-${countsKey(selected)}`} actions={actions} />}
                            {tab === "members" && <MembersTab voucher={selected} status={status} refreshKey={`${usesKey}-${countsKey(selected)}`} onChanged={load} />}
                            {tab === "settings" && (
                                <>
                                    <VoucherForm initial={selectedDraft} onSave={save} saving={saving} />
                                    {saveMsg && <Notice tone={saveMsg.tone}>{saveMsg.text}</Notice>}
                                    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1 }}>
                                            Deleting a voucher also deletes its members and its history. Turn it off instead to keep the history.
                                        </span>
                                        <button className="btn-danger" onClick={() => setConfirmDelete(true)}>
                                            Delete voucher
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {creating && (
                <Modal title="New voucher" onClose={() => setCreating(false)}>
                    <VoucherForm initial={emptyDraft} isNew onSave={create} saving={saving} />
                </Modal>
            )}

            {showSettings && status && <SettingsModal settings={status.settings} onClose={() => setShowSettings(false)} onSaved={load} />}

            {rejecting && (
                <Modal title={`Reject use ${rejecting.id}`} onClose={() => setRejecting(null)} width={420}>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6 }}>
                        The use is given back to {rejecting.userTag || rejecting.userId}, and ArnTo-assistant DMs them the reason.
                    </p>
                    <Field label="Reason (optional)">
                        <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />
                    </Field>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                        <button className="btn-ghost" onClick={() => setRejecting(null)}>Cancel</button>
                        <button
                            className="btn-danger"
                            onClick={() => {
                                const r = rejecting;
                                setRejecting(null);
                                resolve(r, "reject", { reason });
                            }}
                        >
                            Reject
                        </button>
                    </div>
                </Modal>
            )}

            {confirmDelete && selected && (
                <ConfirmModal
                    title={`Delete voucher "${selected.name}"?`}
                    message={`${selected.counts.granted} member(s) and ${selected.counts.used + selected.counts.rejected} use record(s) will be deleted. This cannot be undone.`}
                    confirmText="Delete"
                    onConfirm={remove}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}
