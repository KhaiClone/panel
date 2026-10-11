import { useCallback, useEffect, useState } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { DataTable, EmptyState, Field, Icon, Modal, Notice, PageHeader, SearchInput, StatCard, StatusBadge } from "../components/ui";

// ─────────────────────────────────────────────────────────────────────────────
//  CTV (cộng tác viên) — ArnTo-Shop's resellers: they buy at the CTV price and
//  sell on in their own shops, paying order by order like any buyer.
//
//  Adding one here has ArnTo-Shop give them the CTV role and DM them the welcome
//  text; removing takes the role back. Their orders are not kept here: they are
//  read from the shop's orders, which the shop stamps when the buyer holds the
//  CTV role. The CTV prices are the owner's price channel on Discord. The logic
//  lives in server/services/resellerService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB") : "—");
const money = (n) => `${Number(n || 0).toLocaleString("vi-VN")}đ`;
const monthName = (m) => (m ? new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "");
const SNOWFLAKE = /^\d{17,20}$/;
// The month the figures start on: this one, in Vietnam (UTC+7) like the server's.
const thisMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);

const STATUS = {
    pending: { label: "Pending", tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
};
const st = (s) => STATUS[s] || { label: s || "—", tone: "neutral" };

/** A timestamp ⇄ the value of an <input type="date"> (local day). */
const toDay = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fromDay = (s) => (s ? new Date(`${s}T00:00:00`).getTime() : null);

// ── Building blocks ──────────────────────────────────────────────────────────

function Who({ tag, id }) {
    return (
        <>
            <div>{tag || "—"}</div>
            <div className="mono cell-sub">{id}</div>
        </>
    );
}

function Actions({ onCancel, busy, label, disabled }) {
    return (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn-ghost" onClick={onCancel}>
                Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={busy || disabled}>
                {busy ? "Working…" : label}
            </button>
        </div>
    );
}

/** What ArnTo-Shop did on Discord for a change made here. */
const discordText = (d, what) => {
    if (!d) return null;
    if (!d.sent) return { tone: "warning", text: `Saved, but ArnTo-Shop was not told: ${d.error}` };
    if (d.queued) return { tone: "success", text: `Saved. ArnTo-Shop will ${what} as soon as it reads the bus.` };
    const r = d.result || {};
    const parts = [];
    if (r.role === "added") parts.push("CTV role given");
    else if (r.role === "had") parts.push("they already had the CTV role");
    else if (r.role === "removed") parts.push("CTV role taken back");
    else if (r.role === "not_member") parts.push("they are not in the shop server — no role");
    else if (r.role) parts.push(`role: ${r.role}`);
    if (r.dm === "sent") parts.push("DM sent");
    else if (r.dm === "dm_blocked") parts.push("their DMs are closed");
    else if (r.dm) parts.push(`DM: ${r.dm}`);
    const ok = ["added", "had", "removed"].includes(r.role) && r.dm === "sent";
    return { tone: ok ? "success" : "warning", text: `Saved. ${parts.join(", ") || "ArnTo-Shop answered."}` };
};

// ── Forms ────────────────────────────────────────────────────────────────────

function ResellerModal({ initial, isNew, onClose, onDone }) {
    const [d, setD] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            if (isNew) {
                const { data } = await api.post("/resellers", { userId: d.userId.trim(), shop: d.shop, note: d.note });
                onDone(discordText(data.discord, "give the role and DM them"));
            } else {
                await api.put(`/resellers/${d.userId}`, { shop: d.shop, note: d.note, joinedAt: fromDay(d.since) });
                onDone({ tone: "success", text: "Saved." });
            }
            onClose();
        } catch (err) {
            setError(errMsg(err, "Could not save"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={isNew ? "New CTV" : `Edit ${initial.userTag || initial.userId}`} onClose={onClose} width={480}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {isNew && (
                    <Field label="Discord user ID" hint="ArnTo-Shop gives them the CTV role and DMs them the welcome text (DM texts button).">
                        <input className="input mono" value={d.userId} onChange={(e) => set({ userId: e.target.value })} placeholder="953525563878948914" autoFocus />
                    </Field>
                )}
                <Field label="Their shop (optional)" hint="A name or a link — where they sell on.">
                    <input className="input" value={d.shop} maxLength={200} onChange={(e) => set({ shop: e.target.value })} placeholder="discord.gg/…" />
                </Field>
                <Field label="Note (optional)">
                    <input className="input" value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
                </Field>
                {!isNew && (
                    <Field label="CTV since" hint="Orders opened before the shop marked CTV orders count from this day. For CTVs copied from the role it is the day they joined the server — correct it if you know better.">
                        <input className="input" type="date" value={d.since} max={toDay(Date.now())} onChange={(e) => set({ since: e.target.value })} style={{ width: "auto" }} />
                    </Field>
                )}
                {error && <Notice tone="danger">{error}</Notice>}
                <Actions onCancel={onClose} busy={busy} label={isNew ? "Add CTV" : "Save"} disabled={isNew ? !SNOWFLAKE.test(d.userId.trim()) : !d.since} />
            </form>
        </Modal>
    );
}

function TextsModal({ onClose, onDone }) {
    const [d, setD] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        api.get("/resellers/settings")
            .then(({ data }) => setD(data))
            .catch((err) => setError(errMsg(err, "Could not load the texts")));
    }, []);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api.put("/resellers/settings", { welcome: d.welcome, farewell: d.farewell });
            onDone({ tone: "success", text: "DM texts saved." });
            onClose();
        } catch (err) {
            setError(errMsg(err, "Could not save"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="DM texts" onClose={onClose} width={640}>
            {!d ? (
                error ? <Notice tone="danger">{error}</Notice> : <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : (
                <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>
                        Variables: {d.vars.map((v) => <code key={v} className="mono" style={{ marginRight: 6 }}>{v}</code>)}— <code className="mono">{"{user}"}</code> is a mention. Discord markdown and{" "}
                        <code className="mono">{"<#channel>"}</code> links work (point them at your CTV price channel). Empty = the default text.
                    </p>
                    <Field label="Welcome — DMed when they become a CTV">
                        <textarea className="input" rows={10} value={d.welcome} maxLength={1900} onChange={(e) => setD({ ...d, welcome: e.target.value })} style={{ resize: "vertical", fontSize: 13, lineHeight: 1.5 }} />
                    </Field>
                    <Field label="Farewell — DMed when they are removed">
                        <textarea className="input" rows={6} value={d.farewell} maxLength={1900} onChange={(e) => setD({ ...d, farewell: e.target.value })} style={{ resize: "vertical", fontSize: 13, lineHeight: 1.5 }} />
                    </Field>
                    {error && <Notice tone="danger">{error}</Notice>}
                    <Actions onCancel={onClose} busy={busy} label="Save" />
                </form>
            )}
        </Modal>
    );
}

function SyncModal({ result, nameOf, onClose }) {
    const line = (label, ids, tone) =>
        ids?.length > 0 && (
            <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                <span style={{ fontWeight: 500, color: tone ? `var(--${tone})` : undefined }}>{label}:</span> {ids.map((x) => (typeof x === "string" ? nameOf(x) : `${x.tag || x.id}`)).join(", ")}
            </div>
        );
    const nothing = !result.given?.length && !result.missing?.length && !result.extra?.length && !result.failed?.length;
    return (
        <Modal title="CTV role check" onClose={onClose} width={520}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {nothing && <Notice tone="success">Every CTV has the role, and nobody else does.</Notice>}
                {line("Role given to", result.given, "success")}
                {line("Already had it", result.had)}
                {line("Not in the shop server", result.missing, "warning")}
                {line("Could not give it", result.failed, "danger")}
                {result.extra?.length > 0 && (
                    <>
                        {line("Hold the role but are not CTVs", result.extra, "warning")}
                        <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>Left as they are — add them here, or take the role away on Discord.</p>
                    </>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button className="btn-primary" onClick={onClose}>
                        OK
                    </button>
                </div>
            </div>
        </Modal>
    );
}

// ── Orders ───────────────────────────────────────────────────────────────────

function Orders({ userId, month, onClear, refreshKey }) {
    const [rows, setRows] = useState([]);
    const [allMonths, setAllMonths] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let alive = true;
        setLoading(true);
        api.get("/resellers/orders", { params: { userId: userId || undefined, month: allMonths ? "all" : month } })
            .then(({ data }) => alive && (setRows(data.orders || []), setError("")))
            .catch((err) => alive && setError(errMsg(err, "Could not load the orders")))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, [userId, month, allMonths, refreshKey]);

    return (
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>CTV orders</h2>
                {userId && (
                    <button className="chip active" title="Show every CTV's orders" onClick={onClear}>
                        {rows[0]?.buyerTag || userId} <Icon name="x" size={12} />
                    </button>
                )}
                <div className="tab-bar" style={{ marginLeft: "auto" }}>
                    <button className={`tab-item ${!allMonths ? "active" : ""}`} onClick={() => setAllMonths(false)}>
                        {monthName(month)}
                    </button>
                    <button className={`tab-item ${allMonths ? "active" : ""}`} onClick={() => setAllMonths(true)}>
                        All time
                    </button>
                </div>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !rows.length ? (
                <EmptyState compact icon="orders" title="No CTV orders" description={allMonths ? undefined : "Try All time, or another month."} />
            ) : (
                <DataTable minWidth={760} columns={["When", "CTV", "Order", "Seller", { label: "Price", align: "right" }, "Status"]}>
                    {rows.map((o) => {
                        const s = st(o.status);
                        return (
                            <tr key={o.orderId}>
                                <td className="muted top">{fmtDate(o.orderDate)}</td>
                                <td className="nowrap top">
                                    <Who tag={o.buyerTag} id={o.buyerId} />
                                </td>
                                <td className="top" style={{ maxWidth: 260 }}>
                                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</div>
                                    <div className="mono cell-sub">
                                        {o.orderId}
                                        {!o.stamped && <span title="Opened before the shop marked CTV orders — counted because it falls after “CTV since”"> · by date</span>}
                                    </div>
                                </td>
                                <td className="nowrap top">{o.sellerName}</td>
                                <td className="mono num top">{money(o.price)}</td>
                                <td className="top">
                                    <StatusBadge tone={s.tone}>{s.label}</StatusBadge>
                                </td>
                            </tr>
                        );
                    })}
                </DataTable>
            )}
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const emptyDraft = { userId: "", userTag: "", shop: "", note: "", since: "" };
const toDraft = (r) => ({ userId: r.userId, userTag: r.userTag || "", shop: r.shop || "", note: r.note || "", since: toDay(r.joinedAt) });

export default function ResellersPage() {
    const [status, setStatus] = useState(null);
    const [data, setData] = useState(null); // { month, months, ordersOnPanel, totals, resellers }
    const [month, setMonth] = useState(thisMonth);
    const [showRemoved, setShowRemoved] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [msg, setMsg] = useState(null);
    const [search, setSearch] = useState("");
    const [ordersOf, setOrdersOf] = useState(null);
    const [ordersKey, setOrdersKey] = useState(0);
    const [modal, setModal] = useState(null); // { type, reseller? }
    const [confirmRemove, setConfirmRemove] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState(null);

    const load = useCallback(async () => {
        try {
            const [s, list] = await Promise.all([api.get("/resellers/status"), api.get("/resellers", { params: { all: showRemoved ? 1 : undefined, month } })]);
            setStatus(s.data);
            setData(list.data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the CTVs"));
        } finally {
            setLoading(false);
        }
    }, [showRemoved, month]);

    useEffect(() => {
        load();
    }, [load]);

    const rows = data?.resellers || [];
    const nameOf = useCallback((id) => rows.find((r) => r.userId === id)?.userTag || id, [rows]);

    const done = (m) => {
        if (m) setMsg(m);
        setOrdersKey((k) => k + 1);
        load();
    };

    const remove = async () => {
        const r = confirmRemove;
        setConfirmRemove(null);
        try {
            const { data: out } = await api.delete(`/resellers/${r.userId}`);
            done(discordText(out.discord, "take the role back and DM them"));
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not remove") });
        }
    };

    const sync = async () => {
        setSyncing(true);
        try {
            const { data: out } = await api.post("/resellers/sync");
            setSyncResult(out);
            load();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not check the role") });
        } finally {
            setSyncing(false);
        }
    };

    const q = search.trim().toLowerCase();
    const visible = q ? rows.filter((r) => [r.userId, r.userTag, r.shop, r.note].some((v) => String(v || "").toLowerCase().includes(q))) : rows;
    const active = visible.filter((r) => r.active);
    const removed = visible.filter((r) => !r.active);
    const t = data?.totals;
    const share = t && t.shopRevenue > 0 ? Math.round((t.revenue / t.shopRevenue) * 1000) / 10 : null;

    const table = (list) => (
        <DataTable minWidth={900} columns={["CTV", "Their shop", { label: monthName(data.month), align: "right" }, { label: "All time", align: "right" }, "Last order", "CTV since", ""]}>
            {list.map((r) => (
                <tr key={r.userId} style={{ opacity: r.active ? 1 : 0.6 }}>
                    <td className="nowrap top">
                        <Who tag={r.userTag} id={r.userId} />
                        {r.note && <div className="cell-sub" style={{ color: "var(--text-muted)", maxWidth: 220, whiteSpace: "normal" }}>{r.note}</div>}
                    </td>
                    <td className="top" style={{ fontSize: 12, maxWidth: 220, wordBreak: "break-word" }}>{r.shop || <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                    <td className="num top">
                        {r.stats ? (
                            <>
                                <div className="mono" style={{ fontWeight: 600, color: r.stats.month.revenue > 0 ? "var(--text)" : "var(--text-dim)" }}>{money(r.stats.month.revenue)}</div>
                                <div className="cell-sub" style={{ color: "var(--text-dim)" }}>
                                    {r.stats.month.orders} order{r.stats.month.orders === 1 ? "" : "s"}
                                    {r.stats.month.pending > 0 && <span style={{ color: "var(--warning)" }}> · {r.stats.month.pending} pending</span>}
                                </div>
                            </>
                        ) : (
                            "—"
                        )}
                    </td>
                    <td className="num top">
                        {r.stats ? (
                            <>
                                <div className="mono">{money(r.stats.total.revenue)}</div>
                                <div className="cell-sub" style={{ color: "var(--text-dim)" }}>
                                    {r.stats.total.orders} order{r.stats.total.orders === 1 ? "" : "s"}
                                </div>
                            </>
                        ) : (
                            "—"
                        )}
                    </td>
                    <td className="muted top">{r.stats?.lastOrderAt ? fmtDay(r.stats.lastOrderAt) : "—"}</td>
                    <td className="muted top">
                        {fmtDay(r.joinedAt)}
                        {r.addedBy && <div className="cell-sub">by {r.addedBy}</div>}
                        {!r.active && <div>removed {fmtDay(r.leftAt)}</div>}
                    </td>
                    <td className="actions top">
                        <div className="row-actions">
                            <button className="btn-ghost btn-sm" onClick={() => setOrdersOf(r.userId)}>
                                Orders
                            </button>
                            <button className="btn-ghost btn-sm" onClick={() => setModal({ type: "edit", reseller: r })}>
                                Edit
                            </button>
                            {r.active ? (
                                <button className="btn-ghost btn-sm is-danger" title="Remove — the CTV role is taken back" onClick={() => setConfirmRemove(r)}>
                                    Remove
                                </button>
                            ) : (
                                <button className="btn-ghost btn-sm" onClick={() => setModal({ type: "new", reseller: r })}>
                                    Add again
                                </button>
                            )}
                        </div>
                    </td>
                </tr>
            ))}
        </DataTable>
    );

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <PageHeader
                title="CTV"
                description="Resellers (cộng tác viên): they buy at the CTV price and sell on in their own shops. Adding one gives the CTV role."
                actions={
                    <>
                        <button className="btn-ghost" disabled={syncing || !status?.handler} onClick={sync} title="Give the role to every CTV who lacks it; list who holds it without being one">
                            <Icon name="shieldCheck" /> {syncing ? "Checking…" : "Check roles"}
                        </button>
                        <button className="btn-ghost" onClick={() => setModal({ type: "texts" })}>
                            <Icon name="message" /> DM texts
                        </button>
                        <button className="btn-primary" onClick={() => setModal({ type: "new" })}>
                            <Icon name="plus" /> New CTV
                        </button>
                    </>
                }
            />

            {error && <Notice tone="danger">{error}</Notice>}
            {status && !status.imported && (
                <Notice>
                    ArnTo-Shop has not copied the members holding the CTV role here yet — it does on its first start with the new version (Pull &amp; Update, then restart). CTVs added here before that are
                    kept.
                </Notice>
            )}
            {status && !status.handler && (
                <Notice>
                    ArnTo-Shop has not announced <code className="mono">reseller.event</code> — update and restart the bot. Until then changes are saved here but nobody gets the role or a DM.
                </Notice>
            )}
            {status && status.handler && !status.busReady && <Notice>The panel's Discord bus is not ready — roles and DMs wait until it is.</Notice>}
            {data && !data.ordersOnPanel && <Notice>The shop's orders are not on the panel yet, so there are no order figures.</Notice>}
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

            {data && (
                <>
                    <div className="toolbar">
                        <select className="input" style={{ width: "auto" }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
                            {data.months.map((m) => (
                                <option key={m} value={m}>
                                    {monthName(m)}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
                        <StatCard label="CTVs" value={status?.active ?? "—"} />
                        <StatCard label="CTV revenue" value={t ? money(t.revenue) : "—"} hint={t ? `${t.orders} completed order${t.orders === 1 ? "" : "s"}` : undefined} />
                        <StatCard label="Share of shop revenue" value={share === null ? "—" : `${share}%`} hint={t ? `of ${money(t.shopRevenue)}` : undefined} />
                        <StatCard label="CTVs who bought" value={t ? t.buyers : "—"} tone={t && t.pending > 0 ? "warning" : undefined} hint={t && t.pending > 0 ? `${t.pending} order${t.pending === 1 ? "" : "s"} pending` : undefined} />
                    </div>
                </>
            )}

            <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="toolbar">
                    <SearchInput value={search} onChange={setSearch} placeholder="Search name, ID, shop, note…" style={{ flex: "1 1 200px", maxWidth: 320 }} />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                        <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
                        Show removed
                    </label>
                </div>
                {loading ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
                ) : !rows.length ? (
                    <EmptyState
                        compact
                        icon="resellers"
                        title="No CTVs yet"
                        description={<>Add one here, or run <code className="mono">/ctv-new</code> on ArnTo-Shop.</>}
                    />
                ) : (
                    <>
                        {active.length > 0 ? table(active) : <EmptyState compact icon="search" title="Nobody matches" />}
                        {showRemoved && removed.length > 0 && (
                            <>
                                <h3 className="section-title" style={{ margin: "6px 0 0" }}>Removed</h3>
                                {table(removed)}
                            </>
                        )}
                    </>
                )}
            </div>

            {data?.ordersOnPanel && <Orders userId={ordersOf} month={month} onClear={() => setOrdersOf(null)} refreshKey={ordersKey} />}

            {modal?.type === "new" && <ResellerModal initial={modal.reseller ? toDraft(modal.reseller) : emptyDraft} isNew onClose={() => setModal(null)} onDone={done} />}
            {modal?.type === "edit" && <ResellerModal initial={toDraft(modal.reseller)} onClose={() => setModal(null)} onDone={done} />}
            {modal?.type === "texts" && <TextsModal onClose={() => setModal(null)} onDone={done} />}
            {syncResult && <SyncModal result={syncResult} nameOf={nameOf} onClose={() => setSyncResult(null)} />}
            {confirmRemove && (
                <ConfirmModal
                    title={`Remove ${confirmRemove.userTag || confirmRemove.userId}?`}
                    message="ArnTo-Shop takes the CTV role back and DMs them the farewell text. Their orders stay counted, and they can be added again later."
                    confirmText="Remove"
                    onConfirm={remove}
                    onCancel={() => setConfirmRemove(null)}
                />
            )}
        </div>
    );
}
