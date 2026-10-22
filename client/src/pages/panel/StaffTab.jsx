// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Staff: who else may use the panel, and which pages.
//
//  Staff sign in with their own Discord account — there is no password to hand
//  to someone else. Holding the Staff role in the server is required (checked
//  at login and every 10 minutes); the panel never gives or takes that role.
//  One session per person at a time; sign-ins (a new device flagged) and every
//  change they make also go to the panel log channel (DISCORD_PANEL_LOG_WEBHOOK).
//  Everything is enforced by the server
//  (server/services/staffService.js, middleware/auth.js).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useMemo } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, StatusBadge } from "../../components/ui";
import Section from "./Section";

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const SNOWFLAKE = /^\d{15,25}$/;
const LEVELS = [
    ["none", "None"],
    ["view", "View"],
    ["edit", "Edit"],
];

const avatarUrl = (s) => (s.avatar ? `https://cdn.discordapp.com/avatars/${s.userId}/${s.avatar}.png?size=64` : null);

function Avatar({ s, size = 28 }) {
    const url = avatarUrl(s);
    return (
        <span style={{ width: size, height: size, borderRadius: "50%", background: "var(--bg-active)", display: "inline-flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0, fontSize: 12, fontWeight: 600 }}>
            {url ? <img src={url} alt="" style={{ width: "100%", height: "100%" }} /> : (s.userTag || "?")[0].toUpperCase()}
        </span>
    );
}

// ── Discord login settings ───────────────────────────────────────────────────

function LoginSettings({ settings, onSaved }) {
    const [d, setD] = useState(() => ({ clientId: settings.clientId, clientSecret: "", redirectUri: settings.redirectUri, guildId: settings.guildId, roleId: settings.roleId }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);
    const set = (patch) => { setD((cur) => ({ ...cur, ...patch })); setSaved(false); };

    const save = async (e) => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
            await api.put("/staff/settings", d);
            setD((cur) => ({ ...cur, clientSecret: "" }));
            setSaved(true);
            onSaved();
        } catch (err) {
            setError(errMsg(err, "Could not save"));
        } finally { setBusy(false); }
    };

    return (
        <Section
            icon="lock"
            title="Discord login"
            hint="How staff sign in"
            actions={<StatusBadge tone={settings.configured ? "success" : "warning"}>{settings.configured ? "Ready" : "Not set up"}</StatusBadge>}
        >
            <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {!settings.configured && (
                    <Notice tone="warning">
                        In the Discord Developer Portal, open the application (the panel's own bot is fine) → OAuth2: copy its Client ID and
                        Client Secret here, and add the redirect URL below under Redirects — exactly the same text.
                    </Notice>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                    <Field label="Client ID">
                        <input className="input mono" value={d.clientId} onChange={(e) => set({ clientId: e.target.value.trim() })} placeholder="1300000000000000000" />
                    </Field>
                    <Field label="Client Secret" hint={settings.hasSecret ? "Stored (encrypted). Leave empty to keep it." : "Never shown again once saved."}>
                        <input className="input mono" type="password" autoComplete="new-password" value={d.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder={settings.hasSecret ? "•••••••• (stored)" : ""} />
                    </Field>
                </div>
                <Field
                    label="Redirect URL"
                    hint="The launcher's address + /auth/discord/callback. Discord sends people there and the launcher forwards them to whichever panel is active — so moving the panel needs no change in Discord."
                >
                    <input className="input mono" value={d.redirectUri} onChange={(e) => set({ redirectUri: e.target.value.trim() })} placeholder="https://panel.thunderbolt.io.vn/auth/discord/callback" />
                </Field>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                    <Field label="Server ID" hint="Where the Staff role is checked.">
                        <input className="input mono" value={d.guildId} onChange={(e) => set({ guildId: e.target.value.trim() })} />
                    </Field>
                    <Field label="Staff role ID" hint="Required to sign in, never given or taken by the panel.">
                        <input className="input mono" value={d.roleId} onChange={(e) => set({ roleId: e.target.value.trim() })} />
                    </Field>
                </div>
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button type="submit" className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                    {saved && <span style={{ fontSize: 12, color: "var(--success)" }}>Saved</span>}
                </div>
            </form>
        </Section>
    );
}

// ── Add / edit someone ───────────────────────────────────────────────────────

// `grants` are the parts of a page held back unless ticked (server:
// staffService.GRANTS); a tick shows under its page once that page is given.
function PermsGrid({ pages, grants, perms, held, onChange, onGrant }) {
    const sections = useMemo(() => {
        const out = [];
        for (const p of pages) {
            let s = out.find((x) => x.label === p.section);
            if (!s) out.push((s = { label: p.section, pages: [] }));
            s.pages.push(p);
        }
        return out;
    }, [pages]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {sections.map((s) => (
                <div key={s.label}>
                    <p style={{ fontSize: 11, fontWeight: 500, color: "var(--text-dim)", margin: "0 0 6px" }}>{s.label}</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {s.pages.map((p) => (
                            <div key={p.key}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                                    <span style={{ fontSize: 13 }}>{p.label}</span>
                                    <div className="tab-bar">
                                        {LEVELS.map(([k, label]) => (
                                            <button
                                                type="button"
                                                key={k}
                                                className={`tab-item ${(perms[p.key] || "none") === k ? "active" : ""}`}
                                                onClick={() => onChange(p.key, k)}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {(perms[p.key] || "none") !== "none" &&
                                    grants.filter((g) => g.page === p.key).map((g) => (
                                        <label key={g.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0 12px", cursor: "pointer" }}>
                                            <input type="checkbox" checked={held.includes(g.key)} onChange={(e) => onGrant(g.key, e.target.checked)} />
                                            {g.label}
                                            {g.hint && <span style={{ color: "var(--text-dim)" }}>— {g.hint}</span>}
                                        </label>
                                    ))}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function StaffModal({ pages, grants, member, onClose, onSaved }) {
    const adding = !member;
    const [d, setD] = useState(() => ({ userId: member?.userId || "", note: member?.note || "", perms: { ...(member?.perms || {}) }, grants: [...(member?.grants || [])] }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));
    const perms = Object.fromEntries(Object.entries(d.perms).filter(([, v]) => v && v !== "none"));
    // A grant whose page was set back to None goes with it (the server drops it too).
    const held = d.grants.filter((k) => perms[grants.find((g) => g.key === k)?.page]);
    const toggleGrant = (key, on) => setD((cur) => ({ ...cur, grants: on ? [...cur.grants.filter((k) => k !== key), key] : cur.grants.filter((k) => k !== key) }));

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true); setError("");
        try {
            if (adding) await api.post("/staff", { userId: d.userId.trim(), note: d.note, perms, grants: held });
            else await api.put(`/staff/${member.userId}`, { note: d.note, perms, grants: held });
            onSaved();
        } catch (err) {
            setError(errMsg(err, "Could not save"));
            setBusy(false);
        }
    };

    return (
        <Modal title={adding ? "Give someone panel access" : `Access of ${member.userTag || member.userId}`} onClose={onClose} width={480}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {adding && (
                    <Field label="Discord user ID" hint="They sign in with this Discord account, and need the Staff role in the server.">
                        <input className="input mono" value={d.userId} onChange={(e) => set({ userId: e.target.value.trim() })} placeholder="953525563878948914" autoFocus />
                    </Field>
                )}
                <div>
                    <p style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)", margin: "0 0 8px" }}>Pages</p>
                    <PermsGrid
                        pages={pages}
                        grants={grants}
                        perms={d.perms}
                        held={held}
                        onChange={(page, level) => setD((cur) => ({ ...cur, perms: { ...cur.perms, [page]: level } }))}
                        onGrant={toggleGrant}
                    />
                    <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "10px 0 0", lineHeight: 1.5 }}>
                        View: they see the page. Edit: they can also change it. Servers, Bots, Terminal, the network pages and Panel Settings stay yours.
                    </p>
                </div>
                <Field label="Note">
                    <input className="input" value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
                </Field>
                {error && <Notice tone="danger">{error}</Notice>}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
                    <button type="submit" className="btn-primary" disabled={busy || (adding && !SNOWFLAKE.test(d.userId.trim()))}>
                        {busy ? "Saving…" : adding ? "Add" : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Activity ─────────────────────────────────────────────────────────────────

function Activity({ staff, refreshKey }) {
    const [who, setWho] = useState("");
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");
    const names = useMemo(() => Object.fromEntries(staff.map((s) => [s.userId, s.userTag || s.userId])), [staff]);

    useEffect(() => {
        api.get("/staff/audit", { params: { userId: who || undefined, limit: 100 } })
            .then((r) => { setRows(r.data); setError(""); })
            .catch((err) => setError(errMsg(err, "Could not load the activity")));
    }, [who, refreshKey]);

    return (
        <Section
            icon="history"
            title="Activity"
            hint="Sign-ins and every change staff made, newest first"
            flush
            actions={
                <select className="input" style={{ width: "auto", padding: "4px 8px", fontSize: 12 }} value={who} onChange={(e) => setWho(e.target.value)}>
                    <option value="">Everyone</option>
                    {staff.map((s) => <option key={s.userId} value={s.userId}>{s.userTag || s.userId}</option>)}
                </select>
            }
        >
            {error ? (
                <div style={{ padding: 16 }}><Notice tone="danger">{error}</Notice></div>
            ) : !rows ? (
                <div style={{ padding: 16, fontSize: 13, color: "var(--text-dim)" }}>Loading…</div>
            ) : rows.length === 0 ? (
                <EmptyState compact icon="history" title="Nothing yet" description="Sign-ins and changes show up here." />
            ) : (
                <DataTable flush columns={["When", "Who", "What", { label: "Result", align: "right" }]} minWidth={560}>
                    {rows.map((r) => (
                        <tr key={r.id}>
                            <td className="nowrap muted">{fmtDate(r.at)}</td>
                            <td className="nowrap">{names[r.userId] || r.userId}</td>
                            <td className="mono" style={{ fontSize: 12 }}>
                                {r.action}
                                {r.ip && <span className="cell-sub">{r.ip}</span>}
                            </td>
                            <td className="num">
                                {r.status == null ? "" : <StatusBadge tone={r.status < 400 ? "success" : "danger"}>{r.status}</StatusBadge>}
                            </td>
                        </tr>
                    ))}
                </DataTable>
            )}
        </Section>
    );
}

// ── The tab ──────────────────────────────────────────────────────────────────

export default function StaffTab() {
    const [data, setData] = useState(null); // { staff, pages, settings }
    const [error, setError] = useState("");
    const [modal, setModal] = useState(null); // { member? }
    const [confirm, setConfirm] = useState(null);
    const [refreshKey, setRefreshKey] = useState(0);

    const load = useCallback(async () => {
        try {
            const { data: d } = await api.get("/staff");
            setData(d);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load staff"));
        }
    }, []);

    useEffect(() => { load(); }, [load]);
    // Who is online changes on its own.
    useEffect(() => {
        const t = setInterval(load, 30_000);
        return () => clearInterval(t);
    }, [load]);

    const changed = () => { load(); setRefreshKey((k) => k + 1); };

    const pageLabel = useMemo(() => Object.fromEntries((data?.pages || []).map((p) => [p.key, p.label])), [data]);

    const act = async (fn, fallback) => {
        try {
            await fn();
            changed();
        } catch (err) {
            setError(errMsg(err, fallback));
        } finally { setConfirm(null); }
    };

    if (!data) {
        return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</div>;
    }
    const { staff, pages, grants, settings } = data;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {modal && <StaffModal pages={pages} grants={grants} member={modal.member} onClose={() => setModal(null)} onSaved={() => { setModal(null); changed(); }} />}
            {confirm && <ConfirmModal {...confirm} onCancel={() => setConfirm(null)} />}

            <LoginSettings settings={settings} onSaved={load} />

            {error && <Notice tone="danger">{error}</Notice>}

            <Section
                icon="users"
                title="Staff"
                hint="One session per person — signing in elsewhere ends the other one"
                flush
                actions={<button className="btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" /> Add</button>}
            >
                {staff.length === 0 ? (
                    <EmptyState compact icon="users" title="Nobody else yet" description="Add someone by their Discord user ID and pick the pages they may use." />
                ) : (
                    <DataTable flush columns={["Person", "Pages", "Status", ""]} minWidth={680}>
                        {staff.map((s) => {
                            const given = pages.filter((p) => s.perms[p.key]);
                            return (
                                <tr key={s.userId}>
                                    <td>
                                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                            <Avatar s={s} />
                                            <div style={{ minWidth: 0 }}>
                                                <div>{s.userTag || <span className="muted">not signed in yet</span>}</div>
                                                <span className="cell-sub mono">{s.userId}{s.note ? ` · ${s.note}` : ""}</span>
                                            </div>
                                        </div>
                                    </td>
                                    <td style={{ fontSize: 12 }}>
                                        {given.length === 0 ? (
                                            <span className="muted">No pages</span>
                                        ) : (
                                            given.map((p) => (
                                                <span key={p.key} style={{ display: "inline-block", marginRight: 10 }}>
                                                    {pageLabel[p.key]} <span style={{ color: s.perms[p.key] === "edit" ? "var(--accent-hover)" : "var(--text-dim)" }}>{s.perms[p.key]}</span>
                                                    {grants.filter((g) => g.page === p.key && s.grants?.includes(g.key)).map((g) => (
                                                        <span key={g.key} style={{ color: "var(--text-dim)" }}> + {g.label.toLowerCase()}</span>
                                                    ))}
                                                </span>
                                            ))
                                        )}
                                    </td>
                                    <td className="nowrap">
                                        {s.online ? (
                                            <>
                                                <StatusBadge tone="success">Signed in</StatusBadge>
                                                <span className="cell-sub">since {fmtDate(s.online.since)}{s.online.ip ? ` · ${s.online.ip}` : ""}</span>
                                            </>
                                        ) : (
                                            <>
                                                <StatusBadge tone="neutral">Signed out</StatusBadge>
                                                <span className="cell-sub">last login {fmtDate(s.lastLoginAt)}</span>
                                            </>
                                        )}
                                    </td>
                                    <td className="actions">
                                        <button className="btn-ghost btn-sm" onClick={() => setModal({ member: s })} title="Pages and note"><Icon name="pencil" /></button>
                                        {s.online && (
                                            <button
                                                className="btn-ghost btn-sm"
                                                title="Sign this session out"
                                                onClick={() => setConfirm({
                                                    title: `Sign ${s.userTag || s.userId} out?`,
                                                    message: "Their session ends now. They can sign in again with Discord unless you also remove them.",
                                                    confirmText: "Sign out",
                                                    onConfirm: () => act(() => api.delete(`/staff/sessions/${s.online.id}`), "Could not sign them out"),
                                                })}
                                            >
                                                <Icon name="logout" />
                                            </button>
                                        )}
                                        <button
                                            className="btn-ghost btn-sm"
                                            title="Remove their access"
                                            onClick={() => setConfirm({
                                                title: `Remove ${s.userTag || s.userId}?`,
                                                message: "Their session ends now and they can no longer sign in. Their activity stays in the log. Their Staff role in the server is not touched.",
                                                confirmText: "Remove",
                                                onConfirm: () => act(() => api.delete(`/staff/${s.userId}`), "Could not remove them"),
                                            })}
                                        >
                                            <Icon name="trash" />
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </DataTable>
                )}
            </Section>

            <Activity staff={staff} refreshKey={refreshKey} />
        </div>
    );
}
