import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ─────────────────────────────────────────────────────────────────────────────
//  Ticket Menus — what a customer picks in a new ArnTo-Shop ticket: a service
//  (which category the ticket moves to, how the seller is pinged), then one of
//  its products or "Khác" (the channel's name, the seller). /menu on ArnTo-Shop
//  edits the same menus. The logic lives in server/services/ticketMenuService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const ALL = "__all";

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

/** A Unicode emoji as it is, a server emoji from Discord's CDN. */
function Emoji({ value, size = 18 }) {
    if (!value) return <span style={{ width: size, display: "inline-block" }} />;
    const m = /^<(a?):\w+:(\d+)>$/.exec(value);
    if (m) return <img src={`https://cdn.discordapp.com/emojis/${m[2]}.${m[1] ? "gif" : "webp"}?size=48`} width={size} height={size} alt="" style={{ flexShrink: 0 }} />;
    return <span style={{ fontSize: size - 2, lineHeight: 1, flexShrink: 0 }}>{value}</span>;
}

const IconButton = ({ title, onClick, disabled, children }) => (
    <button type="button" className="btn-ghost" title={title} disabled={disabled} onClick={onClick} style={{ padding: "3px 8px", fontSize: 12 }}>
        {children}
    </button>
);

/** Roughly what Discord shows when the select menu is open. */
function SelectPreview({ placeholder, options }) {
    return (
        <div style={{ background: "#2b2d31", borderRadius: 8, padding: 10, color: "#dbdee1", fontSize: 13 }}>
            <div style={{ background: "#1e1f22", borderRadius: 4, padding: "8px 10px", color: "#949ba4", marginBottom: 6 }}>{placeholder}</div>
            <div style={{ background: "#1e1f22", borderRadius: 4, maxHeight: 260, overflowY: "auto" }}>
                {options.map((o, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderTop: i ? "1px solid #2b2d31" : "none" }}>
                        <Emoji value={o.emoji} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ color: "#f2f3f5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.label}</div>
                            {o.description && <div style={{ fontSize: 11, color: "#949ba4", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.description}</div>}
                        </div>
                    </div>
                ))}
                {!options.length && <div style={{ padding: "8px 10px", color: "#949ba4" }}>(empty — the customer is told there is nothing here)</div>}
            </div>
        </div>
    );
}

// ── Forms ────────────────────────────────────────────────────────────────────

function ServiceForm({ initial, isNew, pingVars, onSave, saving }) {
    const [f, setF] = useState(initial);
    const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave(f);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Name in the menu">
                    <input className="input" value={f.label} onChange={set("label")} maxLength={100} placeholder="Mua Sắm" autoFocus={isNew} required />
                </Field>
                <Field label="Key" hint={isNew ? "a-z, 0-9, - and _ — cannot change later" : "Fixed"}>
                    <input className="input mono" value={f.key} onChange={set("key")} maxLength={32} placeholder="buy" disabled={!isNew} required />
                </Field>
                <Field label="Emoji" hint="A Unicode emoji, or a server emoji: <:name:id>">
                    <input className="input mono" value={f.emoji} onChange={set("emoji")} placeholder="🛒" />
                </Field>
                <Field label="Category to move the ticket to" hint="Empty: the seller's own category (Khác & sellers)">
                    <input className="input mono" value={f.category} onChange={set("category")} placeholder="1397481540799168522" />
                </Field>
            </div>
            <Field label="Description (under the name in the menu)">
                <input className="input" value={f.description} onChange={set("description")} maxLength={100} />
            </Field>
            <Field label="Seller ping" hint={<>Sent once the customer picks a product. Variables: {pingVars.map((v) => <code key={v} className="mono" style={{ marginRight: 6 }}>{v}</code>)}— {"{staff}"} is the staff role.</>}>
                <textarea className="input" rows={3} value={f.ping} onChange={set("ping")} maxLength={1500} placeholder="Empty: a default ping" />
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Toggle checked={f.enabled} onChange={set("enabled")} /> Shown in the menu
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving…" : isNew ? "Create service" : "Save"}
                </button>
            </div>
        </form>
    );
}

function ProductForm({ initial, isNew, services, sellers, onSave, saving }) {
    const [f, setF] = useState(initial);
    const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    const known = sellers.some((s) => s.id === f.sellerId);
    const [customSeller, setCustomSeller] = useState(!!f.sellerId && !known);
    const toggleService = (key) => setF((x) => ({ ...x, services: x.services.includes(key) ? x.services.filter((k) => k !== key) : [...x.services, key] }));
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave(f);
            }}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Name">
                    <input className="input" value={f.name} onChange={set("name")} maxLength={100} placeholder="Nitro Boost 1 tháng" autoFocus={isNew} required />
                </Field>
                <Field label="Emoji" hint="A Unicode emoji, or a server emoji: <:name:id>">
                    <input className="input mono" value={f.emoji} onChange={set("emoji")} placeholder="🛒" />
                </Field>
                <Field label="Seller" hint="Pinged in the ticket; their category is used unless the service has one">
                    {customSeller ? (
                        <input className="input mono" value={f.sellerId} onChange={set("sellerId")} placeholder="Discord ID" />
                    ) : (
                        <select
                            className="input"
                            value={f.sellerId}
                            onChange={(e) => (e.target.value === "__custom" ? (setCustomSeller(true), setF((x) => ({ ...x, sellerId: "" }))) : set("sellerId")(e))}
                        >
                            <option value="">— nobody (staff only) —</option>
                            {sellers.map((s) => (
                                <option key={s.id} value={s.id}>
                                    {s.name}
                                </option>
                            ))}
                            <option value="__custom">Another Discord ID…</option>
                        </select>
                    )}
                </Field>
                <Field label="Channel name suffix" hint="ticket-123-<suffix>; empty: from the name">
                    <input className="input mono" value={f.suffix} onChange={set("suffix")} maxLength={40} placeholder="nitro-1m" />
                </Field>
            </div>
            <Field label="Description (under the name in the menu)">
                <input className="input" value={f.description} onChange={set("description")} maxLength={100} />
            </Field>
            <Field label="In the menus of">
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {services.map((s) => (
                        <label key={s.key} className="card" style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", fontSize: 13, cursor: "pointer" }}>
                            <input type="checkbox" checked={f.services.includes(s.key)} onChange={() => toggleService(s.key)} />
                            <Emoji value={s.emoji} size={16} /> {s.label}
                        </label>
                    ))}
                    {!services.length && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No services yet.</span>}
                </div>
            </Field>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <Toggle checked={f.enabled} onChange={set("enabled")} /> Shown in the menus
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving…" : isNew ? "Add product" : "Save"}
                </button>
            </div>
        </form>
    );
}

function SettingsForm({ initial, onSave, saving }) {
    const [other, setOther] = useState(initial.other);
    const [sellers, setSellers] = useState(initial.sellers.length ? initial.sellers : [{ id: "", name: "", category: "" }]);
    const setO = (k) => (e) => setOther((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
    const setS = (i, k) => (e) => setSellers((list) => list.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)));
    return (
        <form
            onSubmit={(e) => {
                e.preventDefault();
                onSave({ other, sellers: sellers.filter((s) => s.id.trim() || s.name.trim() || s.category.trim()) });
            }}
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 600 }}>
                    <Toggle checked={other.enabled} onChange={setO("enabled")} /> "Khác" — last option of every product menu
                </label>
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, opacity: other.enabled ? 1 : 0.5 }}>
                    <Field label="Name">
                        <input className="input" value={other.label} onChange={setO("label")} maxLength={100} />
                    </Field>
                    <Field label="Emoji">
                        <input className="input mono" value={other.emoji} onChange={setO("emoji")} />
                    </Field>
                    <Field label="Description">
                        <input className="input" value={other.description} onChange={setO("description")} maxLength={100} />
                    </Field>
                    <Field label="Seller to ping (Discord ID)">
                        <input className="input mono" value={other.sellerId} onChange={setO("sellerId")} />
                    </Field>
                    <Field label="Channel name suffix">
                        <input className="input mono" value={other.suffix} onChange={setO("suffix")} maxLength={40} />
                    </Field>
                </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--border-light)", paddingTop: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Sellers</div>
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    Names for the product form, and each seller's ticket category — used when the service has no category of its own.
                </div>
                {sellers.map((s, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8 }}>
                        <input className="input mono" placeholder="Discord ID" value={s.id} onChange={setS(i, "id")} />
                        <input className="input" placeholder="Name" value={s.name} onChange={setS(i, "name")} />
                        <input className="input mono" placeholder="Category ID" value={s.category} onChange={setS(i, "category")} />
                        <IconButton title="Remove" onClick={() => setSellers((list) => list.filter((_, j) => j !== i))}>
                            ✕
                        </IconButton>
                    </div>
                ))}
                <div>
                    <button type="button" className="btn-ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setSellers((l) => [...l, { id: "", name: "", category: "" }])}>
                        + Seller
                    </button>
                </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="btn-primary" disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                </button>
            </div>
        </form>
    );
}

const emptyService = { key: "", label: "", emoji: "", description: "", category: "", ping: "", enabled: true };
const emptyProduct = (services = []) => ({ name: "", description: "", emoji: "", sellerId: "", suffix: "", services, enabled: true });

// ── Products of one service (or all of them) ─────────────────────────────────

function ProductRows({ rows, all, services, sellers, scope, onEdit, onToggle, onMove, onDelete }) {
    const sellerName = (id) => sellers.find((s) => s.id === id)?.name || id;
    const label = (key) => services.find((s) => s.key === key)?.label || key;
    if (!rows.length) return <div style={{ padding: "24px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>No products here yet.</div>;
    return (
        <div className="table-responsive">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                    <tr style={{ color: "var(--text-dim)", fontSize: 11, textAlign: "left" }}>
                        {["", "Product", "Seller", "Channel", ...(scope === ALL ? ["Menus"] : []), "Shown", ""].map((h, i) => (
                            <th key={i} style={{ padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" }}>
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((p, i) => (
                        <tr key={p.id} style={{ borderTop: "1px solid var(--border-light)", opacity: p.enabled ? 1 : 0.55 }}>
                            <td style={{ padding: "6px 4px", whiteSpace: "nowrap" }}>
                                {/* Up/down swap with the neighbour shown here; the order is shared by every menu. */}
                                <IconButton title="Move up" disabled={!i} onClick={() => onMove(p, all.indexOf(rows[i - 1]))}>
                                    ↑
                                </IconButton>
                                <IconButton title="Move down" disabled={i === rows.length - 1} onClick={() => onMove(p, all.indexOf(rows[i + 1]))}>
                                    ↓
                                </IconButton>
                            </td>
                            <td style={{ padding: "6px 8px", minWidth: 180 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <Emoji value={p.emoji} />
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                                        {p.description && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{p.description}</div>}
                                    </div>
                                </div>
                            </td>
                            <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{p.sellerId ? sellerName(p.sellerId) : <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                            <td className="mono" style={{ padding: "6px 8px", fontSize: 12 }}>
                                {p.suffix}
                            </td>
                            {scope === ALL && (
                                <td style={{ padding: "6px 8px", fontSize: 12 }}>
                                    {p.services.length ? p.services.map(label).join(", ") : <span style={{ color: "var(--warning)" }}>none</span>}
                                </td>
                            )}
                            <td style={{ padding: "6px 8px" }}>
                                <Toggle checked={p.enabled} onChange={(v) => onToggle(p, v)} />
                            </td>
                            <td style={{ padding: "6px 4px", whiteSpace: "nowrap", textAlign: "right" }}>
                                <IconButton title="Edit" onClick={() => onEdit(p)}>
                                    Edit
                                </IconButton>
                                <IconButton title={scope === ALL ? "Delete" : "Delete, or take it out of this menu"} onClick={() => onDelete(p)}>
                                    ✕
                                </IconButton>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TicketMenusPage() {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState(null); // service key | ALL
    const [tab, setTab] = useState("products");
    const [modal, setModal] = useState(null); // { kind, item? }
    const [saving, setSaving] = useState(false);
    const [confirm, setConfirm] = useState(null); // { title, message, confirmText, run, extra? }

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/ticket-menus");
            setData(data);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the ticket menus"));
        }
    }, []);

    useEffect(() => {
        load();
        const t = setInterval(load, 20_000);
        return () => clearInterval(t);
    }, [load]);

    const services = data?.services || [];
    const products = data?.products || [];
    const sellers = data?.sellers || [];
    useEffect(() => {
        if (!data) return;
        if (selected !== ALL && !services.some((s) => s.key === selected)) setSelected(services[0]?.key || ALL);
    }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

    const service = services.find((s) => s.key === selected) || null;
    const rows = selected === ALL ? products : products.filter((p) => p.services.includes(selected));
    const shown = rows.filter((p) => p.enabled);

    /** Run a change, reload, close the modal; errors stay in an alert. */
    const run = async (fn, { close = true } = {}) => {
        setSaving(true);
        try {
            await fn();
            await load();
            if (close) setModal(null);
        } catch (err) {
            alert(errMsg(err, "Could not save"));
        } finally {
            setSaving(false);
        }
    };

    const saveService = (f) =>
        run(async () => {
            if (modal.item) await api.put(`/ticket-menus/services/${modal.item.key}`, f);
            else {
                await api.post("/ticket-menus/services", f);
                setSelected(f.key.trim().toLowerCase());
            }
        });
    const saveProduct = (f) => run(() => (modal.item ? api.put(`/ticket-menus/products/${modal.item.id}`, f) : api.post("/ticket-menus/products", f)));
    const toggleProduct = (p, enabled) => run(() => api.put(`/ticket-menus/products/${p.id}`, { enabled }), { close: false });
    const moveProduct = (p, position) => run(() => api.post(`/ticket-menus/products/${p.id}/move`, { position }), { close: false });
    const moveService = (s, position) => run(() => api.post(`/ticket-menus/services/${s.key}/move`, { position }), { close: false });
    const addExisting = (id) => {
        const p = products.find((x) => x.id === id);
        if (p) run(() => api.put(`/ticket-menus/products/${p.id}`, { services: [...p.services, selected] }), { close: false });
    };

    const askDeleteProduct = (p) =>
        setConfirm(
            selected === ALL || p.services.length <= 1
                ? {
                      title: `Delete "${p.name}"?`,
                      message: "It leaves every menu. Tickets already opened keep their channel name.",
                      confirmText: "Delete",
                      run: () => api.delete(`/ticket-menus/products/${p.id}`),
                  }
                : {
                      title: `Take "${p.name}" out of ${service?.label}?`,
                      message: `It stays in ${p.services.filter((k) => k !== selected).length} other menu(s). To delete it everywhere, use All products.`,
                      confirmText: "Take out",
                      run: () => api.put(`/ticket-menus/products/${p.id}`, { services: p.services.filter((k) => k !== selected) }),
                  },
        );

    const previewOptions = service
        ? [
              ...shown.map((p) => ({ label: p.name, description: p.description, emoji: p.emoji })),
              ...(data.other.enabled ? [{ label: data.other.label, description: data.other.description, emoji: data.other.emoji }] : []),
          ]
        : [];

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Ticket Menus</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
                        What a customer picks in a new ArnTo-Shop ticket: a service, then a product. <code className="mono">/menu</code> on ArnTo-Shop edits the same
                        menus.
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn-ghost" style={{ padding: "8px 14px" }} disabled={!data} onClick={() => setModal({ kind: "settings" })}>
                        Khác &amp; sellers
                    </button>
                    <button className="btn-ghost" style={{ padding: "8px 14px" }} disabled={!data} onClick={() => setModal({ kind: "product" })}>
                        + Product
                    </button>
                    <button className="btn-primary" style={{ padding: "8px 14px" }} disabled={!data} onClick={() => setModal({ kind: "service" })}>
                        + Service
                    </button>
                </div>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {data && !data.imported && (
                <Notice>
                    ArnTo-Shop has not brought its current menus over yet — update the bot (Pull &amp; Update) and restart it; on start it copies its services and
                    products here. Until then tickets use the bot's own menus.
                </Notice>
            )}
            {data?.imported && <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: -10 }}>Used by {data.ownerName || data.owner}.</div>}

            {!data ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : (
                <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {services.map((s, i) => (
                            <div
                                key={s.key}
                                className="card"
                                onClick={() => setSelected(s.key)}
                                style={{ padding: "10px 12px", cursor: "pointer", borderColor: s.key === selected ? "var(--accent)" : undefined, opacity: s.enabled ? 1 : 0.6 }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <Emoji value={s.emoji} />
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</div>
                                        <div style={{ fontSize: 11, color: s.products > data.limit ? "var(--danger)" : "var(--text-dim)" }}>
                                            <span className="mono">{s.key}</span> · {s.products} product{s.products === 1 ? "" : "s"}
                                        </div>
                                    </div>
                                    <div style={{ display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
                                        <IconButton title="Move up" disabled={!i} onClick={() => moveService(s, i - 1)}>
                                            ↑
                                        </IconButton>
                                        <IconButton title="Move down" disabled={i === services.length - 1} onClick={() => moveService(s, i + 1)}>
                                            ↓
                                        </IconButton>
                                    </div>
                                    <Toggle
                                        checked={s.enabled}
                                        title={s.enabled ? "Shown — turn off to hide it" : "Hidden"}
                                        onChange={(v) => run(() => api.put(`/ticket-menus/services/${s.key}`, { enabled: v }), { close: false })}
                                    />
                                </div>
                            </div>
                        ))}
                        {!services.length && (
                            <div className="card" style={{ padding: "24px 14px", textAlign: "center", color: "var(--text-dim)", fontSize: 13, borderStyle: "dashed" }}>
                                No services yet.
                            </div>
                        )}
                        <div
                            className="card"
                            onClick={() => setSelected(ALL)}
                            style={{ padding: "10px 12px", cursor: "pointer", borderColor: selected === ALL ? "var(--accent)" : undefined, fontSize: 13 }}
                        >
                            <b>All products</b> <span style={{ color: "var(--text-dim)" }}>· {products.length}</span>
                            {products.some((p) => !p.services.length) && <div style={{ fontSize: 11, color: "var(--warning)" }}>Some are in no menu</div>}
                        </div>
                    </div>

                    <div className="card" style={{ padding: 18, minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
                        {selected === ALL ? (
                            <>
                                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>All products</h2>
                                <ProductRows
                                    rows={products}
                                    all={products}
                                    services={services}
                                    sellers={sellers}
                                    scope={ALL}
                                    onEdit={(p) => setModal({ kind: "product", item: p })}
                                    onToggle={toggleProduct}
                                    onMove={moveProduct}
                                    onDelete={askDeleteProduct}
                                />
                            </>
                        ) : service ? (
                            <>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                    <Emoji value={service.emoji} size={22} />
                                    <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{service.label}</h2>
                                    <div className="tab-bar" style={{ marginLeft: "auto" }}>
                                        {[
                                            ["products", `Products (${rows.length})`],
                                            ["preview", "Preview"],
                                        ].map(([id, label]) => (
                                            <button key={id} className={`tab-item ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                    <button className="btn-ghost" style={{ padding: "6px 12px" }} onClick={() => setModal({ kind: "service", item: service })}>
                                        Edit service
                                    </button>
                                    <button
                                        className="btn-danger"
                                        style={{ padding: "6px 12px" }}
                                        onClick={() =>
                                            setConfirm({
                                                title: `Delete the service "${service.label}"?`,
                                                message: "It leaves the first menu. Its products stay (see All products) and keep their other menus.",
                                                confirmText: "Delete",
                                                run: () => api.delete(`/ticket-menus/services/${service.key}`),
                                            })
                                        }
                                    >
                                        Delete
                                    </button>
                                </div>
                                <div style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                                    <span>
                                        Moves the ticket to{" "}
                                        {service.category ? <code className="mono">{service.category}</code> : "the seller's category"}
                                    </span>
                                    {service.description && <span>“{service.description}”</span>}
                                </div>
                                {shown.length > data.limit && <Notice tone="danger">Discord menus take {data.limit} products here — turn some off.</Notice>}

                                {tab === "products" ? (
                                    <>
                                        <ProductRows
                                            rows={rows}
                                            all={products}
                                            services={services}
                                            sellers={sellers}
                                            scope={selected}
                                            onEdit={(p) => setModal({ kind: "product", item: p })}
                                            onToggle={toggleProduct}
                                            onMove={moveProduct}
                                            onDelete={askDeleteProduct}
                                        />
                                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                                            <button className="btn-primary" style={{ padding: "6px 12px" }} onClick={() => setModal({ kind: "product", preset: [selected] })}>
                                                + New product here
                                            </button>
                                            {products.some((p) => !p.services.includes(selected)) && (
                                                <select className="input" style={{ maxWidth: 260 }} value="" onChange={(e) => addExisting(e.target.value)}>
                                                    <option value="">Add an existing product…</option>
                                                    {products
                                                        .filter((p) => !p.services.includes(selected))
                                                        .map((p) => (
                                                            <option key={p.id} value={p.id}>
                                                                {p.name}
                                                            </option>
                                                        ))}
                                                </select>
                                            )}
                                        </div>
                                    </>
                                ) : (
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>1. Choose a service</div>
                                            <SelectPreview
                                                placeholder="Chọn dịch vụ"
                                                options={services.filter((s) => s.enabled).map((s) => ({ label: s.label, description: s.description, emoji: s.emoji }))}
                                            />
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>2. After picking “{service.label}”</div>
                                            <SelectPreview placeholder="Chọn sản phẩm" options={previewOptions} />
                                        </div>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div style={{ padding: "32px 0", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Press + Service to start.</div>
                        )}
                    </div>
                </div>
            )}

            {modal?.kind === "service" && (
                <Modal title={modal.item ? `Edit "${modal.item.label}"` : "New service"} onClose={() => setModal(null)}>
                    <ServiceForm initial={modal.item ? { ...emptyService, ...modal.item } : emptyService} isNew={!modal.item} pingVars={data.pingVars} onSave={saveService} saving={saving} />
                </Modal>
            )}
            {modal?.kind === "product" && (
                <Modal title={modal.item ? `Edit "${modal.item.name}"` : "New product"} onClose={() => setModal(null)}>
                    <ProductForm
                        initial={modal.item ? { ...emptyProduct(), ...modal.item } : emptyProduct(modal.preset || (service ? [service.key] : []))}
                        isNew={!modal.item}
                        services={services}
                        sellers={sellers}
                        onSave={saveProduct}
                        saving={saving}
                    />
                </Modal>
            )}
            {modal?.kind === "settings" && (
                <Modal title="Khác & sellers" onClose={() => setModal(null)} width={640}>
                    <SettingsForm initial={data} onSave={(body) => run(() => api.put("/ticket-menus/settings", body))} saving={saving} />
                </Modal>
            )}

            {confirm && (
                <ConfirmModal
                    title={confirm.title}
                    message={confirm.message}
                    confirmText={confirm.confirmText}
                    onConfirm={() => {
                        const c = confirm;
                        setConfirm(null);
                        run(c.run, { close: false });
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
