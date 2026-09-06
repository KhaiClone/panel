import { useCallback, useEffect, useState } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ─────────────────────────────────────────────────────────────────────────────
//  Proxy Pool — the proxies YOU give the panel, plus the switches that decide
//  which sources a feature egresses through.
//
//  Not to be confused with /proxy ("Egress Proxy"), which pins a BOT's public IP
//  to a VPS. This page is about the panel's own outbound traffic: Auto Quest
//  today, more features later (a proxy carries `uses` for exactly that).
// ─────────────────────────────────────────────────────────────────────────────

const PROTOCOLS = ["http", "https", "socks4", "socks5"];

const EMPTY_FORM = {
    label: "",
    protocol: "http",
    host: "",
    port: "",
    username: "",
    password: "",
    type: "static",
    rotateUrl: "",
    rotateMinIntervalSec: 60,
    rotateIdleIntervalSec: 0,
    enabled: true,
    note: "",
};

const fmtTime = (ts) => {
    if (!ts) return "—";
    try {
        return new Date(ts).toLocaleString("en-GB", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
};

// ── Small building blocks ────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            style={{
                width: 40,
                height: 22,
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: checked ? "var(--accent)" : "var(--bg-input)",
                position: "relative",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
                transition: "background 0.15s",
                flexShrink: 0,
            }}
        >
            <span
                style={{
                    position: "absolute",
                    top: 2,
                    left: checked ? 20 : 2,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.15s",
                }}
            />
        </button>
    );
}

function Badge({ children, color = "var(--text-dim)" }) {
    return (
        <span
            className="badge"
            style={{ background: color + "22", color, border: `1px solid ${color}33` }}
        >
            {children}
        </span>
    );
}

// ── Settings: which sources Auto Quest draws from ────────────────────────────

function PoolSettings({ pool, onChange, saving }) {
    if (!pool) return null;
    const s = pool.settings;
    const sourceLabel =
        pool.activeSource === "proxy"
            ? `${pool.activeCount} of your proxies`
            : pool.activeSource === "node"
              ? `${pool.activeCount} VPS node(s)`
              : "nothing — Auto Quest runs from the panel's own IP";

    const Row = ({ title, desc, field, count }) => (
        <div
            style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 0",
                borderTop: "1px solid var(--border-light)",
            }}
        >
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    {title} <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>({count})</span>
                </p>
                <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{desc}</p>
            </div>
            <Toggle
                checked={!!s[field]}
                disabled={saving}
                onChange={(v) => onChange({ [field]: v })}
            />
        </div>
    );

    return (
        <div className="card" style={{ padding: "18px 20px", marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Auto Quest egress</h2>
                <Badge color="var(--accent)">Using {sourceLabel}</Badge>
            </div>
            <Row
                title="My proxies"
                desc="The proxies registered below."
                field="useCustomProxies"
                count={pool.customProxies.length}
            />
            <Row
                title="VPS nodes as proxy"
                desc="Every enabled agent node doubles as an egress IP."
                field="useNodes"
                count={pool.nodes.length}
            />
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "12px 0 0",
                    borderTop: "1px solid var(--border-light)",
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        When both are on
                    </p>
                    <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                        A fallback order picks one source and uses it alone; “Mix” treats every
                        entry as one flat pool.
                    </p>
                </div>
                <select
                    className="input"
                    style={{ width: 190 }}
                    value={s.priority}
                    disabled={saving}
                    onChange={(e) => onChange({ priority: e.target.value })}
                >
                    <option value="custom">My proxies first</option>
                    <option value="nodes">VPS nodes first</option>
                    <option value="mixed">Mix both</option>
                </select>
            </div>
        </div>
    );
}

// ── Add / edit form ──────────────────────────────────────────────────────────

function ProxyModal({ proxy, onClose, onSaved }) {
    const isEdit = !!proxy;
    const [form, setForm] = useState(
        proxy
            ? {
                  ...EMPTY_FORM,
                  ...proxy,
                  password: "", // never round-trips; blank keeps the stored one
                  rotateUrl: proxy.rotateUrl || "",
                  note: proxy.note || "",
              }
            : EMPTY_FORM,
    );
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const set = (field) => (e) => {
        const val = e.target.type === "checkbox" ? e.target.checked : e.target.value;
        setForm((f) => ({ ...f, [field]: val }));
    };

    const submit = async (e) => {
        e.preventDefault();
        setError("");
        setSaving(true);
        const body = { ...form, port: parseInt(form.port, 10) };
        // Omitting password on edit is what tells the server to keep the stored one.
        if (isEdit && !form.password) delete body.password;
        try {
            if (isEdit) await api.patch(`/proxies/${proxy._id}`, body);
            else await api.post("/proxies", body);
            onSaved();
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || "Could not save this proxy.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div
                className="card slide-up modal-card-mobile"
                style={{ width: "100%", maxWidth: 560, padding: 0, maxHeight: "90vh", overflowY: "auto" }}
            >
                <div
                    style={{
                        padding: "18px 24px",
                        borderBottom: "1px solid var(--border-light)",
                        display: "flex",
                        alignItems: "center",
                    }}
                >
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>
                        {isEdit ? `Edit “${proxy.label}”` : "Add proxy"}
                    </h2>
                    <button
                        onClick={onClose}
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}
                    >
                        ✕
                    </button>
                </div>

                {/* autoComplete="off" throughout: the browser reads host/username/password
                    as a login form and silently autofills them. That produced a credential
                    the proxy rejected with 407 and no clue why. */}
                <form
                    onSubmit={submit}
                    autoComplete="off"
                    style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
                >
                    <div>
                        <label className="label">Label</label>
                        <input
                            className="input"
                            placeholder="defaults to host:port"
                            value={form.label}
                            onChange={set("label")}
                        />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 12 }} className="grid-1-mobile">
                        <div>
                            <label className="label">Protocol</label>
                            <select className="input" value={form.protocol} onChange={set("protocol")}>
                                {PROTOCOLS.map((p) => (
                                    <option key={p} value={p}>
                                        {p}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label className="label">Host *</label>
                            <input className="input mono" value={form.host} onChange={set("host")} required />
                        </div>
                        <div>
                            <label className="label">Port *</label>
                            <input
                                className="input mono"
                                type="number"
                                min="1"
                                max="65535"
                                value={form.port}
                                onChange={set("port")}
                                required
                            />
                        </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="grid-1-mobile">
                        <div>
                            <label className="label">Username</label>
                            <input
                                className="input mono"
                                name="proxy-user"
                                autoComplete="off"
                                spellCheck={false}
                                value={form.username}
                                onChange={set("username")}
                            />
                        </div>
                        <div>
                            <label className="label">
                                Password {isEdit && proxy.hasPassword ? "(blank = keep current)" : ""}
                            </label>
                            <input
                                className="input mono"
                                // "new-password" is the one value Chrome actually honours here;
                                // "off" alone is ignored on password inputs.
                                type="password"
                                name="proxy-pass"
                                autoComplete="new-password"
                                spellCheck={false}
                                value={form.password}
                                onChange={set("password")}
                            />
                        </div>
                    </div>

                    <div>
                        <label className="label">Type</label>
                        <div style={{ display: "flex", gap: 10 }}>
                            {[
                                { v: "static", t: "Static", d: "One fixed exit IP." },
                                { v: "rotating", t: "Rotating", d: "IP changes via a link." },
                            ].map((o) => (
                                <button
                                    key={o.v}
                                    type="button"
                                    onClick={() => setForm((f) => ({ ...f, type: o.v }))}
                                    style={{
                                        flex: 1,
                                        textAlign: "left",
                                        padding: "10px 12px",
                                        borderRadius: 10,
                                        cursor: "pointer",
                                        background: form.type === o.v ? "var(--accent)22" : "var(--bg-input)",
                                        border: `1px solid ${form.type === o.v ? "var(--accent)" : "var(--border)"}`,
                                        color: "var(--text)",
                                    }}
                                >
                                    <span style={{ fontSize: 13, fontWeight: 700 }}>{o.t}</span>
                                    <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>
                                        {o.d}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {form.type === "rotating" && (
                        <>
                            <div>
                                <label className="label">Rotate link *</label>
                                <input
                                    className="input mono"
                                    placeholder="https://provider.example/api/changeip?key=…"
                                    value={form.rotateUrl}
                                    onChange={set("rotateUrl")}
                                    required
                                />
                                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                                    The panel fetches this to change the exit IP. It only ever does so
                                    between runs — never while a quest is using the proxy.
                                </p>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="grid-1-mobile">
                                <div>
                                    <label className="label">Min seconds between rotations</label>
                                    <input
                                        className="input mono"
                                        type="number"
                                        min="0"
                                        value={form.rotateMinIntervalSec}
                                        onChange={set("rotateMinIntervalSec")}
                                    />
                                </div>
                                <div>
                                    <label className="label">Idle auto-rotate (sec, 0 = off)</label>
                                    <input
                                        className="input mono"
                                        type="number"
                                        min="0"
                                        value={form.rotateIdleIntervalSec}
                                        onChange={set("rotateIdleIntervalSec")}
                                    />
                                </div>
                            </div>
                        </>
                    )}

                    <div>
                        <label className="label">Note</label>
                        <input className="input" value={form.note} onChange={set("note")} />
                    </div>

                    <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text)" }}>
                        <input type="checkbox" checked={form.enabled} onChange={set("enabled")} />
                        Enabled (available to the pool)
                    </label>

                    {error && (
                        <p style={{ fontSize: 13, color: "var(--danger)", margin: 0 }}>{error}</p>
                    )}

                    <div style={{ display: "flex", gap: 12 }}>
                        <button type="button" className="btn-ghost" style={{ flex: 1 }} onClick={onClose}>
                            Cancel
                        </button>
                        <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={saving}>
                            {saving ? "Saving…" : isEdit ? "Save" : "Add"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── Bulk import ──────────────────────────────────────────────────────────────

function BulkModal({ onClose, onSaved }) {
    const [text, setText] = useState("");
    const [protocol, setProtocol] = useState("http");
    const [result, setResult] = useState(null);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        setError("");
        setSaving(true);
        try {
            const { data } = await api.post("/proxies/bulk", {
                text,
                defaults: { protocol, type: "static" },
            });
            setResult(data);
            onSaved();
        } catch (err) {
            setError(err.response?.data?.error || "Import failed.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="modal-overlay">
            <div
                className="card slide-up modal-card-mobile"
                style={{ width: "100%", maxWidth: 560, padding: 0, maxHeight: "90vh", overflowY: "auto" }}
            >
                <div
                    style={{
                        padding: "18px 24px",
                        borderBottom: "1px solid var(--border-light)",
                        display: "flex",
                        alignItems: "center",
                    }}
                >
                    <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, flex: 1 }}>Bulk import</h2>
                    <button
                        onClick={onClose}
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18 }}
                    >
                        ✕
                    </button>
                </div>
                <form onSubmit={submit} style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                        <label className="label">One proxy per line</label>
                        <textarea
                            className="input mono"
                            rows={9}
                            style={{ resize: "vertical" }}
                            placeholder={"host:port\nhost:port:user:pass\nsocks5://user:pass@host:port"}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            required
                        />
                        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "6px 0 0" }}>
                            Everything imports as a static proxy. Rotating ones need their own rotate
                            link, so add or edit those individually.
                        </p>
                    </div>
                    <div>
                        <label className="label">Protocol for lines without one</label>
                        <select className="input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                            {PROTOCOLS.map((p) => (
                                <option key={p} value={p}>
                                    {p}
                                </option>
                            ))}
                        </select>
                    </div>

                    {error && <p style={{ fontSize: 13, color: "var(--danger)", margin: 0 }}>{error}</p>}

                    {result && (
                        <div
                            style={{
                                fontSize: 13,
                                background: "var(--bg-input)",
                                border: "1px solid var(--border)",
                                borderRadius: 10,
                                padding: 12,
                            }}
                        >
                            <p style={{ margin: 0, color: "var(--success)" }}>
                                Added {result.created.length} proxy(ies).
                            </p>
                            {result.errors?.length > 0 && (
                                <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--warning)" }}>
                                    {result.errors.map((e, i) => (
                                        <li key={i} className="mono" style={{ fontSize: 12 }}>
                                            {e.line} — {e.error}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    <div style={{ display: "flex", gap: 12 }}>
                        <button type="button" className="btn-ghost" style={{ flex: 1 }} onClick={onClose}>
                            {result ? "Close" : "Cancel"}
                        </button>
                        <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={saving}>
                            {saving ? "Importing…" : "Import"}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── One row ──────────────────────────────────────────────────────────────────

function ProxyRow({ p, state, onTest, onRotate, onToggle, onEdit, onDelete }) {
    const rotating = p.type === "rotating";
    return (
        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <p
                            style={{
                                margin: 0,
                                fontSize: 14,
                                fontWeight: 700,
                                color: "var(--text)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {p.label}
                        </p>
                        <Badge color={rotating ? "#a78bfa" : "var(--text-dim)"}>
                            {rotating ? "Rotating" : "Static"}
                        </Badge>
                        {!p.enabled && <Badge color="var(--warning)">Disabled</Badge>}
                        {p.busy && <Badge color="var(--accent)">In use</Badge>}
                    </div>
                    <p className="mono" style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
                        {p.protocol}://{p.username ? `${p.username}:***@` : ""}
                        {p.host}:{p.port}
                    </p>
                </div>
                <Toggle checked={p.enabled} onChange={(v) => onToggle(p, v)} />
            </div>

            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--text-dim)" }}>
                <span>
                    IP:{" "}
                    <span className="mono" style={{ color: p.lastIp ? "var(--success)" : "var(--text-dim)" }}>
                        {p.lastIp || "unknown"}
                    </span>
                </span>
                <span>Checked {fmtTime(p.lastCheckedAt)}</span>
                {rotating && <span>Rotated {fmtTime(p.lastRotatedAt)}</span>}
                {p.lastError && <span style={{ color: "var(--danger)" }}>{p.lastError}</span>}
                {p.lastRotateError && (
                    <span style={{ color: "var(--warning)" }}>rotate: {p.lastRotateError}</span>
                )}
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => onTest(p)}>
                    {state?.testing ? "Testing…" : "Test IP"}
                </button>
                {rotating && (
                    <button
                        className="btn-ghost"
                        style={{ padding: "6px 12px", fontSize: 12 }}
                        disabled={p.busy}
                        title={p.busy ? "A run is using this proxy right now" : undefined}
                        onClick={() => onRotate(p)}
                    >
                        {state?.rotating ? "Rotating…" : "Rotate now"}
                    </button>
                )}
                <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => onEdit(p)}>
                    Edit
                </button>
                <button
                    className="btn-ghost"
                    style={{ padding: "6px 12px", fontSize: 12, color: "var(--danger)" }}
                    onClick={() => onDelete(p)}
                >
                    Delete
                </button>
                {state?.msg && (
                    <span style={{ fontSize: 12, alignSelf: "center", color: state.ok ? "var(--success)" : "var(--danger)" }}>
                        {state.msg}
                    </span>
                )}
            </div>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function ProxiesPage() {
    const [proxies, setProxies] = useState([]);
    const [pool, setPool] = useState(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [savingSettings, setSavingSettings] = useState(false);
    const [rowState, setRowState] = useState({}); // proxyId -> { testing, rotating, msg, ok }
    const [editing, setEditing] = useState(undefined); // undefined = closed, null = new
    const [bulkOpen, setBulkOpen] = useState(false);
    const [confirm, setConfirm] = useState(null);

    const load = useCallback(async () => {
        setErr(null);
        try {
            const [listRes, poolRes] = await Promise.all([
                api.get("/proxies"),
                api.get("/proxies/settings/quest"),
            ]);
            setProxies(listRes.data.proxies || []);
            setPool(poolRes.data);
        } catch (e) {
            setErr(e.response?.data?.error || "Failed to load proxies.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // The pool view carries the live "in use" flag, so merge it onto the list.
    const busyIds = new Set((pool?.customProxies || []).filter((p) => p.busy).map((p) => p.id));
    const rows = proxies.map((p) => ({ ...p, busy: busyIds.has(p._id) }));

    const saveSettings = async (patch) => {
        setSavingSettings(true);
        try {
            const { data } = await api.patch("/proxies/settings/quest", patch);
            setPool(data);
        } catch (e) {
            setErr(e.response?.data?.error || "Failed to save settings.");
        } finally {
            setSavingSettings(false);
        }
    };

    const mark = (id, patch) => setRowState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

    const test = async (p) => {
        mark(p._id, { testing: true, msg: null });
        try {
            const { data } = await api.post(`/proxies/${p._id}/test`);
            mark(p._id, {
                testing: false,
                ok: data.ok,
                msg: data.ok ? `${data.ip} · ${data.latencyMs}ms` : data.error,
            });
            load();
        } catch (e) {
            mark(p._id, { testing: false, ok: false, msg: e.response?.data?.error || "Test failed." });
        }
    };

    const rotate = async (p) => {
        mark(p._id, { rotating: true, msg: null });
        try {
            const { data } = await api.post(`/proxies/${p._id}/rotate`);
            mark(p._id, {
                rotating: false,
                ok: data.ok,
                msg: data.ok ? "New IP requested" : data.error || `Skipped (${data.skipped})`,
            });
            load();
        } catch (e) {
            mark(p._id, { rotating: false, ok: false, msg: e.response?.data?.error || "Rotate failed." });
        }
    };

    const toggle = async (p, enabled) => {
        setProxies((prev) => prev.map((x) => (x._id === p._id ? { ...x, enabled } : x)));
        try {
            await api.patch(`/proxies/${p._id}`, { enabled });
            load();
        } catch (e) {
            setErr(e.response?.data?.error || "Failed to update proxy.");
            load();
        }
    };

    const doDelete = async (p) => {
        setConfirm(null);
        try {
            await api.delete(`/proxies/${p._id}`);
            load();
        } catch (e) {
            setErr(e.response?.data?.error || "Failed to delete proxy.");
        }
    };

    return (
        <div className="fade-in page-compact">
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: 20,
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Proxy Pool</h1>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                        Proxies the panel egresses through. Used by Auto Quest; other features can
                        opt in later.
                    </p>
                </div>
                <button className="btn-ghost" onClick={() => setBulkOpen(true)}>
                    Bulk import
                </button>
                <button className="btn-primary" onClick={() => setEditing(null)}>
                    + Add proxy
                </button>
            </div>

            {err && (
                <div
                    className="card"
                    style={{ padding: "12px 16px", marginBottom: 16, color: "var(--danger)", fontSize: 13 }}
                >
                    {err}
                </div>
            )}

            <PoolSettings pool={pool} onChange={saveSettings} saving={savingSettings} />

            {loading ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>
            ) : rows.length === 0 ? (
                <div className="card" style={{ padding: 40, textAlign: "center" }}>
                    <p style={{ margin: 0, fontSize: 14, color: "var(--text-muted)" }}>
                        No proxies yet.
                    </p>
                    <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-dim)" }}>
                        Until you add one, Auto Quest falls back to whatever is left switched on
                        above.
                    </p>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {rows.map((p) => (
                        <ProxyRow
                            key={p._id}
                            p={p}
                            state={rowState[p._id]}
                            onTest={test}
                            onRotate={rotate}
                            onToggle={toggle}
                            onEdit={setEditing}
                            onDelete={(x) => setConfirm(x)}
                        />
                    ))}
                </div>
            )}

            {editing !== undefined && (
                <ProxyModal proxy={editing} onClose={() => setEditing(undefined)} onSaved={load} />
            )}
            {bulkOpen && <BulkModal onClose={() => setBulkOpen(false)} onSaved={load} />}
            {confirm && (
                <ConfirmModal
                    title="Delete proxy"
                    message={`Remove “${confirm.label}” from the pool? Runs already using it keep their connection until they finish.`}
                    confirmText="Delete"
                    onConfirm={() => doDelete(confirm)}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
