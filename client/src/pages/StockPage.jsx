import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ─────────────────────────────────────────────────────────────────────────────
//  Stock — goods kept ready (accounts, keys…) for ArnTo-assistant to DM.
//
//  Staff run /giao on the assistant (or press "Deliver" here): the panel picks a
//  random item and the assistant DMs it to the buyer. Delivered items leave the
//  stock and stay in the history; a closed DM puts the item back. Product types
//  with reminders on remind the buyer at 72/47/24 h and at expiry, like a bot's
//  renewal. The logic lives in server/services/stockService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");

const slugify = (s) =>
    String(s || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[đĐ]/g, "d")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);

// A copy of stockService.formatItem — only for the DM preview.
const formatItem = (content, fields, separator) => {
    if (!fields.length) return { text: content };
    const byLine = content.includes("\n");
    const glue = byLine ? "\n" : separator || ":";
    const parts = content.split(glue);
    const out = fields
        .map((name, i) => ({ name, value: (i === fields.length - 1 ? parts.slice(i).join(glue) : parts[i] || "").trim() }))
        .filter((f) => f.value);
    return out.length ? { fields: out } : { text: content };
};
const parseFields = (s) =>
    String(s || "")
        .split("|")
        .map((f) => f.trim())
        .filter(Boolean);

const timeLeft = (ts) => {
    if (!ts) return null;
    const ms = ts - Date.now();
    if (ms <= 0) return { text: "Expired", color: "var(--danger)" };
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) return { text: `${days} day${days === 1 ? "" : "s"} left`, color: days <= 3 ? "var(--warning)" : "var(--success)" };
    return { text: `${Math.ceil(ms / 3_600_000)} h left`, color: "var(--danger)" };
};

// ── Building blocks ──────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled, title }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            title={title}
            onClick={(e) => {
                e.stopPropagation();
                onChange(!checked);
            }}
            style={{
                width: 40,
                height: 22,
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: checked ? "var(--accent)" : "var(--bg-input)",
                position: "relative",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.4 : 1,
                transition: "background 0.15s",
                flexShrink: 0,
            }}
        >
            <span style={{ position: "absolute", top: 2, left: checked ? 20 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
        </button>
    );
}

function Field({ label, hint, children }) {
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
            {children}
            {hint && <span style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{hint}</span>}
        </label>
    );
}

function Notice({ tone = "warning", children }) {
    return (
        <div style={{ padding: "10px 14px", borderRadius: 8, background: `var(--${tone}-bg)`, color: `var(--${tone})`, border: `1px solid var(--${tone}-border)`, fontSize: 13, lineHeight: 1.5 }}>
            {children}
        </div>
    );
}

function Modal({ title, onClose, children, width = 560 }) {
    return createPortal(
        <div className="modal-overlay" onClick={onClose}>
            <div
                className="card slide-up modal-card-mobile"
                style={{ maxWidth: width, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: 24, position: "relative", zIndex: 1001 }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
                    <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{title}</h3>
                    <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={onClose}>
                        ✕
                    </button>
                </div>
                {children}
            </div>
        </div>,
        document.body,
    );
}

function Secret({ text, shown, onToggle }) {
    return (
        <span
            className="mono"
            onClick={onToggle}
            title={shown ? "Click to hide" : "Click to show"}
            style={{ cursor: "pointer", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12, color: shown ? "var(--text)" : "var(--text-dim)" }}
        >
            {shown ? text : "••••••••••••"}
        </span>
    );
}

const th = { padding: "9px 12px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap", textAlign: "left" };
const td = { padding: "9px 12px", verticalAlign: "top" };

// ── Product settings (create + edit) ─────────────────────────────────────────

const emptyDraft = { name: "", code: "", enabled: true, title: "", message: "", fields: "", separator: ":", multiline: false, reminders: { enabled: false, days: 30 } };
const toDraft = (p) => ({ ...p, fields: (p.fields || []).join(" | "), reminders: { ...p.reminders } });
const fromDraft = (d) => ({ ...d, fields: parseFields(d.fields), reminders: { enabled: d.reminders.enabled, days: Number(d.reminders.days) } });

function ProductForm({ initial, defaultMessage, isNew, onSave, saving }) {
    const [d, setD] = useState(initial);
    const [codeTouched, setCodeTouched] = useState(!isNew);
    const [sample, setSample] = useState("");
    useEffect(() => setD(initial), [initial]);
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));

    const fields = parseFields(d.fields);
    const preview = sample.trim() ? formatItem(sample.trim(), fields, d.separator) : null;

    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave(fromDraft(d));
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
                <Field label="Product name">
                    <input
                        className="input"
                        value={d.name}
                        maxLength={100}
                        placeholder="Nitro Boost 1 month"
                        onChange={(e) => set({ name: e.target.value, ...(codeTouched ? {} : { code: slugify(e.target.value) }) })}
                    />
                </Field>
                <Field label="Code (used in /giao)" hint="a-z, 0-9, - and _">
                    <input
                        className="input mono"
                        value={d.code}
                        maxLength={32}
                        placeholder="nitro-1m"
                        onChange={(e) => {
                            setCodeTouched(true);
                            set({ code: e.target.value.toLowerCase() });
                        }}
                    />
                </Field>
            </div>

            <Field label="DM title" hint="Empty = the product name">
                <input className="input" value={d.title} maxLength={256} placeholder={d.name || "Product name"} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="DM message" hint="Empty = the default thank-you note. Discord markdown, <#channel> and <@user> work.">
                <textarea className="input" rows={3} value={d.message} maxLength={2000} placeholder={defaultMessage} onChange={(e) => set({ message: e.target.value })} style={{ resize: "vertical", fontSize: 13, lineHeight: 1.5 }} />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(90px, 1fr)", gap: 12 }}>
                <Field label="Field labels (optional)" hint="Separated by |. With labels each item is split into fields; without, it is sent as-is.">
                    <input className="input" value={d.fields} placeholder="Gmail | Password | Hash" onChange={(e) => set({ fields: e.target.value })} />
                </Field>
                <Field label="Separator" hint="Single-line items">
                    <input className="input mono" value={d.separator} maxLength={5} onChange={(e) => set({ separator: e.target.value })} />
                </Field>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, cursor: "pointer" }}>
                <Toggle checked={d.multiline} onChange={(v) => set({ multiline: v })} />
                <span>
                    Multi-line items
                    <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)" }}>
                        When adding stock, items are separated by a blank line. With field labels, each line is one field.
                    </span>
                </span>
            </label>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
                <Toggle checked={d.reminders.enabled} onChange={(v) => set({ reminders: { ...d.reminders, enabled: v } })} />
                <span>Remind of expiry after</span>
                <input
                    className="input"
                    type="number"
                    min={1}
                    max={3650}
                    value={d.reminders.days}
                    disabled={!d.reminders.enabled}
                    onChange={(e) => set({ reminders: { ...d.reminders, days: e.target.value } })}
                    style={{ width: 90 }}
                />
                <span>days from delivery</span>
                <span style={{ flexBasis: "100%", fontSize: 11, color: "var(--text-dim)" }}>
                    The buyer is reminded 72, 47 and 24 hours before expiry and at expiry — by DM (ArnTo-Auto) and a ping in the alert channel, like a bot's renewal reminder.
                </span>
            </div>

            <Field label="Preview with a sample item">
                <textarea className="input mono" rows={d.multiline ? 3 : 1} value={sample} placeholder={d.multiline ? "user\npass" : "mail@gmail.com:matkhau:hash"} onChange={(e) => setSample(e.target.value)} style={{ resize: "vertical", fontSize: 12 }} />
            </Field>
            {preview && (
                <div style={{ borderLeft: "4px solid var(--accent)", background: "var(--bg-input)", borderRadius: 6, padding: "10px 14px", fontSize: 13 }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>{d.title || d.name || "Product name"}</div>
                    <div style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap", marginBottom: 8, fontSize: 12 }}>{d.message || defaultMessage}</div>
                    {preview.fields ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 24px" }}>
                            {preview.fields.map((f) => (
                                <div key={f.name}>
                                    <div style={{ fontSize: 12, fontWeight: 700 }}>{f.name}:</div>
                                    <div className="mono" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{f.value}</div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{preview.text}</pre>
                    )}
                </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="submit" className="btn-primary" disabled={saving || !d.name.trim() || !d.code.trim()} style={{ padding: "8px 18px" }}>
                    {saving ? "Saving…" : isNew ? "Create product" : "Save"}
                </button>
            </div>
        </form>
    );
}

// ── Stock tab ────────────────────────────────────────────────────────────────

function StockTab({ product, onChanged }) {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [text, setText] = useState("");
    const [allowDup, setAllowDup] = useState(false);
    const [adding, setAdding] = useState(false);
    const [msg, setMsg] = useState(null);
    const [showAll, setShowAll] = useState(false);
    const [shown, setShown] = useState(() => new Set());
    const [search, setSearch] = useState("");
    const [confirm, setConfirm] = useState(null); // { kind: "one", item } | { kind: "all" }
    const [limit, setLimit] = useState(100);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get(`/stock/products/${product.id}/items`);
            setItems(data.items || []);
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not load the stock") });
        } finally {
            setLoading(false);
        }
    }, [product.id]);

    useEffect(() => {
        setLoading(true);
        setShown(new Set());
        setLimit(100);
    }, [product.id]);

    // Reload when the counts change too — an item was just delivered with /giao.
    useEffect(() => {
        load();
    }, [load, product.counts.available, product.counts.reserved]);

    const add = async () => {
        setAdding(true);
        setMsg(null);
        try {
            const { data } = await api.post(`/stock/products/${product.id}/items`, { text, allowDuplicates: allowDup });
            setMsg({ tone: "success", text: `Added ${data.added} item(s)${data.duplicates ? `, skipped ${data.duplicates} duplicate(s)` : ""}.` });
            setText("");
            await load();
            onChanged();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not add the items") });
        } finally {
            setAdding(false);
        }
    };

    const doDelete = async () => {
        const c = confirm;
        setConfirm(null);
        try {
            if (c.kind === "all") await api.delete(`/stock/products/${product.id}/items`);
            else await api.delete(`/stock/products/${product.id}/items/${c.item.id}`);
            await load();
            onChanged();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not delete") });
        }
    };

    const toggleShown = (id) =>
        setShown((cur) => {
            const next = new Set(cur);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const pending = useMemo(() => (product.multiline ? text.split(/\n[ \t]*\n/) : text.split("\n")).filter((s) => s.trim()).length, [text, product.multiline]);
    const q = search.trim().toLowerCase();
    const visible = q ? items.filter((i) => i.content.toLowerCase().includes(q)) : items;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Field
                    label="Add stock"
                    hint={product.multiline ? "An item may span several lines — separate items with a blank line." : "One item per line."}
                >
                    <textarea
                        className="input mono"
                        rows={5}
                        value={text}
                        spellCheck={false}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={product.multiline ? "user1\npass1\n\nuser2\npass2" : "mail1@gmail.com:pass1\nmail2@gmail.com:pass2"}
                        style={{ resize: "vertical", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre", overflowX: "auto" }}
                    />
                </Field>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
                        <input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} />
                        Allow duplicates (by default an item already in stock or delivered is skipped)
                    </label>
                    <button className="btn-primary" style={{ marginLeft: "auto", padding: "7px 16px" }} disabled={adding || !pending} onClick={add}>
                        {adding ? "Adding…" : `Add ${pending || ""} item${pending === 1 ? "" : "s"}`}
                    </button>
                </div>
                {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <input className="input" style={{ flex: "1 1 200px", maxWidth: 300 }} placeholder="Search the stock…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", cursor: "pointer" }}>
                    <Toggle checked={showAll} onChange={setShowAll} /> Show contents
                </label>
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
                    {visible.length} / {items.length} items
                </span>
                <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12, color: "var(--danger)" }} disabled={!product.counts.available} onClick={() => setConfirm({ kind: "all" })}>
                    Delete all
                </button>
            </div>

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !items.length ? (
                <div className="card" style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13, borderStyle: "dashed" }}>
                    The stock is empty — paste items in the box above.
                </div>
            ) : (
                <div style={{ overflowX: "auto", border: "1px solid var(--border-light)", borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 520 }}>
                        <thead>
                            <tr style={{ background: "var(--bg-input)" }}>
                                <th style={th}>#</th>
                                <th style={th}>Content</th>
                                <th style={th}>Added</th>
                                <th style={th}>Status</th>
                                <th style={th} />
                            </tr>
                        </thead>
                        <tbody>
                            {visible.slice(0, limit).map((i) => (
                                <tr key={i.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                                    <td className="mono" style={{ ...td, color: "var(--text-dim)", fontSize: 11 }}>{i.id}</td>
                                    <td style={{ ...td, maxWidth: 420 }}>
                                        <Secret text={i.content} shown={showAll || shown.has(i.id)} onToggle={() => toggleShown(i.id)} />
                                    </td>
                                    <td style={{ ...td, whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 12 }}>{fmtDate(i.addedAt)}</td>
                                    <td style={{ ...td, whiteSpace: "nowrap", fontSize: 12 }}>
                                        {i.status === "reserved" ? <span style={{ color: "var(--warning)" }}>Delivering</span> : <span style={{ color: "var(--success)" }}>Available</span>}
                                    </td>
                                    <td style={{ ...td, textAlign: "right" }}>
                                        {i.status === "available" && (
                                            <button className="btn-ghost" style={{ padding: "3px 9px", fontSize: 12, color: "var(--danger)" }} onClick={() => setConfirm({ kind: "one", item: i })}>
                                                Delete
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {visible.length > limit && (
                        <div style={{ padding: 10, textAlign: "center", borderTop: "1px solid var(--border-light)" }}>
                            <button className="btn-ghost" style={{ padding: "5px 14px", fontSize: 12 }} onClick={() => setLimit((n) => n + 200)}>
                                Show more ({visible.length - limit})
                            </button>
                        </div>
                    )}
                </div>
            )}

            {confirm && (
                <ConfirmModal
                    title={confirm.kind === "all" ? `Delete all stock of "${product.name}"?` : "Delete this item?"}
                    message={
                        confirm.kind === "all"
                            ? `${product.counts.available} undelivered item(s) will be deleted. The delivery history stays.`
                            : "The item will be removed from the stock. This cannot be undone."
                    }
                    confirmText="Delete"
                    onConfirm={doDelete}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}

// ── History tab ──────────────────────────────────────────────────────────────

function HistoryTab({ product, refreshKey }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [shown, setShown] = useState(() => new Set());
    const [extend, setExtend] = useState(null); // delivery
    const [days, setDays] = useState(30);
    const [busy, setBusy] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/stock/deliveries", { params: { productId: product.id } });
            setRows(data.deliveries || []);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the history"));
        } finally {
            setLoading(false);
        }
    }, [product.id]);

    useEffect(() => {
        setLoading(true);
        load();
    }, [load, refreshKey]);

    const act = async (id, fn) => {
        setBusy(id);
        try {
            const { data } = await fn();
            setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...data } : r)));
        } catch (err) {
            alert(errMsg(err, "Action failed"));
        } finally {
            setBusy(null);
        }
    };

    const doExtend = async () => {
        const d = extend;
        setExtend(null);
        await act(d.id, () => api.post(`/stock/deliveries/${d.id}/extend`, { days: Number(days) }));
    };

    const q = search.trim().toLowerCase();
    const visible = q
        ? rows.filter((r) => [r.id, r.buyerId, r.buyerTag, r.staffTag].some((v) => String(v || "").toLowerCase().includes(q)))
        : rows;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <input className="input" style={{ flex: "1 1 200px", maxWidth: 320 }} placeholder="Search delivery ID, buyer, staff…" value={search} onChange={(e) => setSearch(e.target.value)} />
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)" }}>
                    {visible.length} / {rows.length} deliveries
                </span>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !rows.length ? (
                <div className="card" style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13, borderStyle: "dashed" }}>
                    Nothing delivered yet.
                </div>
            ) : (
                <div style={{ overflowX: "auto", border: "1px solid var(--border-light)", borderRadius: 8 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 820 }}>
                        <thead>
                            <tr style={{ background: "var(--bg-input)" }}>
                                {["ID", "Buyer", "Delivered by", "Delivered", "Expires", "Content", "Remind", ""].map((h) => (
                                    <th key={h} style={th}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((r) => {
                                const left = timeLeft(r.expiresAt);
                                return (
                                    <tr key={r.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                                        <td className="mono" style={{ ...td, whiteSpace: "nowrap" }}>{r.id}</td>
                                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                                            <div>{r.buyerTag || "—"}</div>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{r.buyerId}</div>
                                        </td>
                                        <td style={{ ...td, whiteSpace: "nowrap", fontSize: 12 }}>
                                            {r.staffTag || "—"}
                                            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{r.via === "discord" ? "/giao" : "Panel"}</div>
                                        </td>
                                        <td style={{ ...td, whiteSpace: "nowrap", fontSize: 12, color: "var(--text-dim)" }}>
                                            {r.status === "pending" ? <span style={{ color: "var(--warning)" }}>Delivering…</span> : fmtDate(r.deliveredAt)}
                                        </td>
                                        <td style={{ ...td, whiteSpace: "nowrap", fontSize: 12 }}>
                                            {r.expiresAt ? (
                                                <>
                                                    <div>{fmtDate(r.expiresAt)}</div>
                                                    <div style={{ fontSize: 11, color: left.color }}>{left.text}</div>
                                                </>
                                            ) : (
                                                <span style={{ color: "var(--text-dim)" }}>None</span>
                                            )}
                                        </td>
                                        <td style={{ ...td, maxWidth: 280 }}>
                                            {r.content != null && (
                                                <Secret
                                                    text={r.content}
                                                    shown={shown.has(r.id)}
                                                    onToggle={() =>
                                                        setShown((cur) => {
                                                            const next = new Set(cur);
                                                            if (next.has(r.id)) next.delete(r.id);
                                                            else next.add(r.id);
                                                            return next;
                                                        })
                                                    }
                                                />
                                            )}
                                        </td>
                                        <td style={td}>
                                            {r.expiresAt && r.status === "delivered" && (
                                                <Toggle
                                                    checked={r.reminders}
                                                    disabled={busy === r.id || !product.reminders.enabled}
                                                    title={product.reminders.enabled ? "Expiry reminders for this delivery" : "Expiry reminders are off for this product"}
                                                    onChange={(v) => act(r.id, () => api.post(`/stock/deliveries/${r.id}/reminders`, { enabled: v }))}
                                                />
                                            )}
                                        </td>
                                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                                            {r.status === "delivered" && (
                                                <button
                                                    className="btn-ghost"
                                                    style={{ padding: "3px 9px", fontSize: 12 }}
                                                    disabled={busy === r.id}
                                                    onClick={() => {
                                                        setDays(product.reminders.days || 30);
                                                        setExtend(r);
                                                    }}
                                                >
                                                    Extend
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {extend && (
                <Modal title={`Extend delivery ${extend.id}`} onClose={() => setExtend(null)} width={400}>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6 }}>
                        Adds days to the current expiry (or counts from now if it has passed). The reminder milestones start over.
                    </p>
                    <Field label="Days">
                        <input className="input" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
                    </Field>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                        <button className="btn-ghost" onClick={() => setExtend(null)}>Cancel</button>
                        <button className="btn-primary" disabled={!(Number(days) >= 1)} onClick={doExtend}>Extend</button>
                    </div>
                </Modal>
            )}
        </div>
    );
}

// ── Deliver from the panel ───────────────────────────────────────────────────

const REASONS = {
    dm_blocked: "The buyer has DMs closed — the item went back to stock. Ask them to open DMs, then deliver again.",
    unknown_user: "ArnTo-assistant could not find this user — the item went back to stock.",
    stale: "ArnTo-assistant got the command too late and did not deliver — the item went back to stock.",
};

function DeliverModal({ products, initialId, onClose, onDone }) {
    const [productId, setProductId] = useState(initialId || products[0]?.id || "");
    const [buyerId, setBuyerId] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const product = products.find((p) => p.id === productId);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setResult(null);
        try {
            const { data } = await api.post("/stock/deliver", { productId, buyerId: buyerId.trim() }, { timeout: 70_000 });
            setResult(
                data.delivered
                    ? { tone: "success", text: `Delivered "${data.product}" — ID ${data.deliveryId}. ${data.remaining} item(s) left in stock.` }
                    : { tone: "warning", text: REASONS[data.reason] || `Not delivered (${data.reason}) — the item went back to stock.` },
            );
            onDone();
        } catch (err) {
            setResult({ tone: "danger", text: errMsg(err, "Could not deliver") });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title="Deliver" onClose={onClose} width={440}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Field label="Product">
                    <select className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
                        {products.map((p) => (
                            <option key={p.id} value={p.id} disabled={!p.enabled}>
                                {p.name} — {p.counts.available} left
                                {p.enabled ? "" : " (off)"}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Buyer's Discord ID" hint="ArnTo-assistant DMs one random item to this user.">
                    <input className="input mono" value={buyerId} onChange={(e) => setBuyerId(e.target.value)} placeholder="871329074046435338" autoFocus />
                </Field>
                {result && <Notice tone={result.tone}>{result.text}</Notice>}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
                    <button type="submit" className="btn-primary" disabled={busy || !product?.enabled || !product?.counts.available || !/^\d{17,20}$/.test(buyerId.trim())}>
                        {busy ? "Delivering…" : "Deliver"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StockPage() {
    const [products, setProducts] = useState([]);
    const [defaultMessage, setDefaultMessage] = useState("");
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [selectedId, setSelectedId] = useState(null);
    const [tab, setTab] = useState("stock");
    const [creating, setCreating] = useState(false);
    const [deliverFor, setDeliverFor] = useState(null); // product id | "" | null
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [historyKey, setHistoryKey] = useState(0);

    const load = useCallback(async () => {
        try {
            const [p, s] = await Promise.all([api.get("/stock/products"), api.get("/stock/status")]);
            setProducts(p.data.products || []);
            setDefaultMessage(p.data.defaultMessage || "");
            setStatus(s.data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the stock"));
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
        if (!products.length) setSelectedId(null);
        else if (!products.some((p) => p.id === selectedId)) setSelectedId(products[0].id);
    }, [products, selectedId]);

    const selected = products.find((p) => p.id === selectedId) || null;
    const selectedDraft = useMemo(() => (selected ? toDraft(selected) : null), [selected?.id, selected?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const create = async (body) => {
        setSaving(true);
        try {
            const { data } = await api.post("/stock/products", body);
            setCreating(false);
            await load();
            setSelectedId(data.id);
            setTab("stock");
        } catch (err) {
            alert(errMsg(err, "Could not create the product"));
        } finally {
            setSaving(false);
        }
    };

    const save = async (body) => {
        setSaving(true);
        setSaveMsg(null);
        try {
            await api.put(`/stock/products/${selected.id}`, body);
            await load();
            setSaveMsg({ tone: "success", text: "Saved." });
        } catch (err) {
            setSaveMsg({ tone: "danger", text: errMsg(err, "Could not save") });
        } finally {
            setSaving(false);
        }
    };

    const toggleEnabled = async (p, enabled) => {
        try {
            await api.put(`/stock/products/${p.id}`, { enabled });
            await load();
        } catch (err) {
            alert(errMsg(err, "Could not change it"));
        }
    };

    const remove = async () => {
        setConfirmDelete(false);
        try {
            await api.delete(`/stock/products/${selected.id}`);
            await load();
        } catch (err) {
            alert(errMsg(err, "Could not delete"));
        }
    };

    const needsDm = products.some((p) => p.reminders?.enabled);

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Stock</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        Goods ready for automatic delivery — run <code className="mono">/giao</code> on ArnTo-assistant and it DMs one random item to the buyer.
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-ghost" style={{ padding: "8px 14px" }} disabled={!products.length} onClick={() => setDeliverFor(selectedId || "")}>
                        Deliver
                    </button>
                    <button className="btn-primary" style={{ padding: "8px 14px" }} onClick={() => setCreating(true)}>
                        + Product
                    </button>
                </div>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {status && !status.deliverer && (
                <Notice>
                    ArnTo-assistant has not announced <code className="mono">stock.deliver</code> yet — update the bot (Pull &amp; Update) and restart it before delivering.
                </Notice>
            )}
            {status && status.deliverer && !status.busReady && <Notice>The panel's Discord bus is not ready — deliveries are not possible right now.</Notice>}
            {status && needsDm && !status.dmSender && (
                <Notice>No bot handles DMs (ArnTo-Auto) — expiry reminders will only ping in the alert channel.</Notice>
            )}
            {status && needsDm && !status.alertWebhook && <Notice>DISCORD_ALERT_WEBHOOK is not set — expiry reminders will only go by DM.</Notice>}

            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !products.length ? (
                <div className="card" style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 14, borderStyle: "dashed" }}>
                    No products yet. Press <b>+ Product</b> to start.
                </div>
            ) : (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {products.map((p) => {
                            const active = p.id === selectedId;
                            return (
                                <div
                                    key={p.id}
                                    className="card"
                                    onClick={() => {
                                        setSelectedId(p.id);
                                        setSaveMsg(null);
                                    }}
                                    style={{
                                        padding: "12px 14px",
                                        cursor: "pointer",
                                        borderColor: active ? "var(--accent)" : undefined,
                                        opacity: p.enabled ? 1 : 0.6,
                                    }}
                                >
                                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                                            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.code}</div>
                                        </div>
                                        <Toggle checked={p.enabled} title={p.enabled ? "On — turn off to hide it from /giao" : "Off"} onChange={(v) => toggleEnabled(p, v)} />
                                    </div>
                                    <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 12 }}>
                                        <span style={{ color: p.counts.available ? "var(--success)" : "var(--danger)" }}>
                                            <b>{p.counts.available}</b> in stock
                                        </span>
                                        <span style={{ color: "var(--text-dim)" }}>
                                            <b>{p.counts.delivered}</b> delivered
                                        </span>
                                        {p.reminders?.enabled && <span style={{ color: "var(--text-dim)" }}>⏰ {p.reminders.days} days</span>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {selected && (
                        <div className="card" style={{ padding: 18, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{selected.name}</h2>
                                <div className="tab-bar" style={{ marginLeft: "auto" }}>
                                    {[
                                        ["stock", `Stock (${selected.counts.available})`],
                                        ["history", `History (${selected.counts.delivered})`],
                                        ["settings", "Settings"],
                                    ].map(([id, label]) => (
                                        <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <button className="btn-primary" style={{ padding: "7px 14px" }} disabled={!selected.enabled || !selected.counts.available} onClick={() => setDeliverFor(selected.id)}>
                                    Deliver
                                </button>
                            </div>

                            {tab === "stock" && <StockTab product={selected} onChanged={load} />}
                            {tab === "history" && <HistoryTab product={selected} refreshKey={`${historyKey}-${selected.counts.delivered}`} />}
                            {tab === "settings" && (
                                <>
                                    <ProductForm initial={selectedDraft} defaultMessage={defaultMessage} onSave={save} saving={saving} />
                                    {saveMsg && <Notice tone={saveMsg.tone}>{saveMsg.text}</Notice>}
                                    <div style={{ borderTop: "1px solid var(--border-light)", paddingTop: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                        <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1 }}>
                                            Deleting a product also deletes its stock and delivery history; its deliveries get no more expiry reminders.
                                        </span>
                                        <button className="btn-danger" style={{ padding: "7px 14px" }} onClick={() => setConfirmDelete(true)}>
                                            Delete product
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}

            {creating && (
                <Modal title="New product" onClose={() => setCreating(false)}>
                    <ProductForm initial={emptyDraft} defaultMessage={defaultMessage} isNew onSave={create} saving={saving} />
                </Modal>
            )}

            {deliverFor !== null && (
                <DeliverModal
                    products={products}
                    initialId={deliverFor}
                    onClose={() => setDeliverFor(null)}
                    onDone={() => {
                        load();
                        setHistoryKey((k) => k + 1);
                    }}
                />
            )}

            {confirmDelete && selected && (
                <ConfirmModal
                    title={`Delete product "${selected.name}"?`}
                    message={`${selected.counts.available} item(s) in stock and ${selected.counts.delivered} delivery record(s) will be deleted. This cannot be undone.`}
                    confirmText="Delete"
                    onConfirm={remove}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}
