import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

// ─────────────────────────────────────────────────────────────────────────────
//  Supporters — ArnTo-Shop's paid helpers (hỗ trợ viên) and their salary.
//
//  Adding one here has ArnTo-Shop give them the Supporter role and DM them the
//  welcome text; removing takes the role back. The Staff role is the owner's,
//  handed out by hand — nothing here touches it. Salary comes from /done on the
//  shop; adjustments and payouts are made here or with /staff-* on Discord.
//  Every change is in the history. The logic lives in
//  server/services/supporterService.js.
// ─────────────────────────────────────────────────────────────────────────────

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const money = (n) => `${Number(n || 0).toLocaleString("vi-VN")}đ`;
const mask = (acct) => (acct && acct.length > 4 ? `•••${acct.slice(-4)}` : acct || "—");
const SNOWFLAKE = /^\d{17,20}$/;

const KIND = {
    joined: { text: "Joined", color: "var(--success)" },
    left: { text: "Left", color: "var(--text-dim)" },
    salary: { text: "Salary", color: "var(--success)" },
    add: { text: "Added", color: "var(--success)" },
    deduct: { text: "Deducted", color: "var(--danger)" },
    payout: { text: "Paid out", color: "var(--accent)" },
    import: { text: "Imported", color: "var(--text-muted)" },
};

const th = { padding: "9px 12px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap", textAlign: "left" };
const td = { padding: "9px 12px", verticalAlign: "top" };
const tableBox = { overflowX: "auto", border: "1px solid var(--border-light)", borderRadius: 8 };
const empty = { padding: "32px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13, borderStyle: "dashed" };
const small = { padding: "4px 10px", fontSize: 12 };

// ── Building blocks ──────────────────────────────────────────────────────────

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

function Modal({ title, onClose, children, width = 520 }) {
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

function Who({ tag, id }) {
    return (
        <>
            <div>{tag || "—"}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{id}</div>
        </>
    );
}

function Stat({ label, value, tone }) {
    return (
        <div className="card" style={{ padding: "12px 16px", minWidth: 150 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: tone ? `var(--${tone})` : undefined }}>{value}</div>
        </div>
    );
}

function Actions({ onCancel, busy, label, disabled, danger }) {
    return (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn-ghost" onClick={onCancel}>
                Cancel
            </button>
            <button type="submit" className={danger ? "btn-danger" : "btn-primary"} disabled={busy || disabled}>
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
    if (r.role === "added") parts.push("Supporter role given");
    else if (r.role === "had") parts.push("they already had the Supporter role");
    else if (r.role === "removed") parts.push("Supporter role taken back");
    else if (r.role === "not_member") parts.push("they are not in the shop server — no role");
    else if (r.role) parts.push(`role: ${r.role}`);
    if (r.dm === "sent") parts.push("DM sent");
    else if (r.dm === "dm_blocked") parts.push("their DMs are closed");
    else if (r.dm) parts.push(`DM: ${r.dm}`);
    const ok = ["added", "had", "removed"].includes(r.role) && r.dm === "sent";
    return { tone: ok ? "success" : "warning", text: `Saved. ${parts.join(", ") || "ArnTo-Shop answered."}` };
};

// ── Forms ────────────────────────────────────────────────────────────────────

function BankFields({ banks, d, set }) {
    const sorted = useMemo(() => [...banks].sort((a, b) => a.code.localeCompare(b.code)), [banks]);
    const known = sorted.some((b) => b.bin === d.bankBin);
    return (
        <>
            <Field label="Bank">
                <select
                    className="input"
                    value={known ? d.bankBin : ""}
                    onChange={(e) => {
                        const b = sorted.find((x) => x.bin === e.target.value);
                        set({ bankBin: b?.bin || "", bankCode: b?.code || "" });
                    }}
                >
                    <option value="">{d.bankCode && !known ? `${d.bankCode} (${d.bankBin})` : "— pick the bank —"}</option>
                    {sorted.map((b) => (
                        <option key={b.bin} value={b.bin}>
                            {b.code} — {b.name}
                        </option>
                    ))}
                </select>
            </Field>
            <div className="grid-1-mobile" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Account number">
                    <input className="input mono" value={d.accountNumber} onChange={(e) => set({ accountNumber: e.target.value })} />
                </Field>
                <Field label="Account name (optional)" hint="Shown on the transfer QR.">
                    <input className="input" value={d.accountName} onChange={(e) => set({ accountName: e.target.value })} placeholder="NGUYEN VAN A" />
                </Field>
            </div>
        </>
    );
}

function SupporterModal({ initial, isNew, banks, onClose, onDone }) {
    const [d, setD] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const body = { bankCode: d.bankCode, bankBin: d.bankBin, accountNumber: d.accountNumber, accountName: d.accountName, note: d.note };
            if (isNew) {
                const { data } = await api.post("/supporters", { userId: d.userId.trim(), ...body });
                onDone(discordText(data.discord, "give the role and DM them"));
            } else {
                await api.put(`/supporters/${d.userId}`, body);
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
        <Modal title={isNew ? "New supporter" : `Edit ${initial.userTag || initial.userId}`} onClose={onClose}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {isNew && (
                    <Field label="Discord user ID" hint="ArnTo-Shop gives them the Supporter role and DMs them the welcome text (DM texts button). The Staff role is yours to give by hand.">
                        <input className="input mono" value={d.userId} onChange={(e) => set({ userId: e.target.value })} placeholder="953525563878948914" autoFocus />
                    </Field>
                )}
                <BankFields banks={banks} d={d} set={set} />
                <Field label="Note (optional)">
                    <input className="input" value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
                </Field>
                {!banks.length && <Notice>The bank list could not be loaded from VietQR — try again in a moment.</Notice>}
                {error && <Notice tone="danger">{error}</Notice>}
                <Actions onCancel={onClose} busy={busy} label={isNew ? "Add supporter" : "Save"} disabled={(isNew && !SNOWFLAKE.test(d.userId.trim())) || !d.bankBin || !d.accountNumber.trim()} />
            </form>
        </Modal>
    );
}

function AdjustModal({ supporter, sellers, onClose, onDone }) {
    const [d, setD] = useState({ kind: "add", amount: "", sellerId: "", note: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const set = (patch) => setD((cur) => ({ ...cur, ...patch }));
    const amount = Math.round(Number(d.amount));
    const valid = Number.isFinite(amount) && amount > 0 && !(d.kind === "deduct" && amount > supporter.balance);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post(`/supporters/${supporter.userId}/credit`, { ...d, amount });
            onDone(discordText(data.discord, "DM them and post it in the salary log"));
            onClose();
        } catch (err) {
            setError(errMsg(err, "Could not change the balance"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={`Balance of ${supporter.userTag || supporter.userId}`} onClose={onClose} width={440}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="tab-bar">
                    {[
                        ["add", "+ Add"],
                        ["deduct", "− Deduct"],
                    ].map(([k, label]) => (
                        <button type="button" key={k} className={`tab-item ${d.kind === k ? "active" : ""}`} onClick={() => set({ kind: k })}>
                            {label}
                        </button>
                    ))}
                </div>
                <Field label="Amount (VND)" hint={`Now ${money(supporter.balance)}${valid ? ` → ${money(supporter.balance + (d.kind === "deduct" ? -amount : amount))}` : ""}. The balance never goes below 0.`}>
                    <input className="input mono" inputMode="numeric" value={d.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^\d]/g, "") })} autoFocus />
                </Field>
                <Field label="Owed by (optional)" hint="Whose share of the unpaid balance it changes.">
                    <select className="input" value={d.sellerId} onChange={(e) => set({ sellerId: e.target.value })}>
                        <option value="">— nobody in particular —</option>
                        {sellers.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}
                            </option>
                        ))}
                    </select>
                </Field>
                <Field label="Reason (optional)" hint="Shown to them in the DM and in the history.">
                    <input className="input" value={d.note} maxLength={300} onChange={(e) => set({ note: e.target.value })} />
                </Field>
                {error && <Notice tone="danger">{error}</Notice>}
                <Actions onCancel={onClose} busy={busy} label={d.kind === "deduct" ? "Deduct" : "Add"} disabled={!valid} danger={d.kind === "deduct"} />
            </form>
        </Modal>
    );
}

function PayModal({ supporter, sellerName, onClose, onDone }) {
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const s = supporter;
    const qr = `https://img.vietqr.io/image/${s.bank.bin}-${encodeURIComponent(s.accountNumber)}-compact2.png?amount=${s.balance}${note ? `&addInfo=${encodeURIComponent(note)}` : ""}${
        s.accountName ? `&accountName=${encodeURIComponent(s.accountName)}` : ""
    }`;

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const { data } = await api.post(`/supporters/${s.userId}/payout`, { note });
            onDone(discordText(data.discord, "DM them and post it in the salary log"));
            onClose();
        } catch (err) {
            setError(errMsg(err, "Could not record the payout"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={`Pay ${s.userTag || s.userId}`} onClose={onClose} width={460}>
            <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", justifyContent: "center" }}>
                    <img src={qr} alt="VietQR" style={{ width: 260, maxWidth: "100%", borderRadius: 8, background: "#fff" }} />
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                    <div>
                        Bank: <b>{s.bank.code}</b> · <span className="mono">{s.accountNumber}</span>
                        {s.accountName ? ` · ${s.accountName}` : ""}
                    </div>
                    <div>
                        Amount: <b style={{ fontSize: 16 }}>{money(s.balance)}</b>
                    </div>
                    {s.owed.length > 0 && (
                        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                            Owed by: {s.owed.map((o) => `${sellerName(o.sellerId)} ${money(o.amount)}`).join(" · ")}
                        </div>
                    )}
                </div>
                <Field label="Transfer note (optional)" hint="Put on the QR, and sent to them in the DM.">
                    <input className="input" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} />
                </Field>
                <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>Transfer first, then press the button: the balance goes back to 0 and ArnTo-Shop tells them.</p>
                {error && <Notice tone="danger">{error}</Notice>}
                <Actions onCancel={onClose} busy={busy} label="I have transferred it" />
            </form>
        </Modal>
    );
}

function TextsModal({ onClose, onDone }) {
    const [d, setD] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        api.get("/supporters/settings")
            .then(({ data }) => setD(data))
            .catch((err) => setError(errMsg(err, "Could not load the texts")));
    }, []);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api.put("/supporters/settings", { welcome: d.welcome, farewell: d.farewell });
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
                        <code className="mono">{"<#channel>"}</code> links work. Empty = the default text.
                    </p>
                    <Field label="Welcome — DMed when they become a supporter">
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
                <b style={{ color: tone ? `var(--${tone})` : undefined }}>{label}:</b> {ids.map((x) => (typeof x === "string" ? nameOf(x) : `${x.tag || x.id}`)).join(", ")}
            </div>
        );
    const nothing = !result.given?.length && !result.missing?.length && !result.extra?.length && !result.failed?.length;
    return (
        <Modal title="Supporter role check" onClose={onClose} width={520}>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {nothing && <Notice tone="success">Every supporter has the role, and nobody else does.</Notice>}
                {line("Role given to", result.given, "success")}
                {line("Already had it", result.had)}
                {line("Not in the shop server", result.missing, "warning")}
                {line("Could not give it", result.failed, "danger")}
                {result.extra?.length > 0 && (
                    <>
                        {line("Hold the role but are not supporters", result.extra, "warning")}
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

// ── History ──────────────────────────────────────────────────────────────────

function History({ userId, onClear, sellerName, refreshKey }) {
    const [rows, setRows] = useState([]);
    const [kind, setKind] = useState("all");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let alive = true;
        setLoading(true);
        api.get("/supporters/ledger", { params: { userId: userId || undefined, kind: kind === "all" ? undefined : kind } })
            .then(({ data }) => alive && (setRows(data.entries || []), setError("")))
            .catch((err) => alive && setError(errMsg(err, "Could not load the history")))
            .finally(() => alive && setLoading(false));
        return () => {
            alive = false;
        };
    }, [userId, kind, refreshKey]);

    return (
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>History</h2>
                {userId && (
                    <button className="btn-ghost" style={small} onClick={onClear}>
                        {rows[0]?.userTag || userId} ✕
                    </button>
                )}
                <div className="tab-bar" style={{ marginLeft: "auto" }}>
                    {["all", "salary", "add", "deduct", "payout", "joined", "left"].map((k) => (
                        <button key={k} className={`tab-item ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                            {k === "all" ? "All" : KIND[k].text}
                        </button>
                    ))}
                </div>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : !rows.length ? (
                <div className="card" style={empty}>Nothing yet.</div>
            ) : (
                <div style={tableBox}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 820 }}>
                        <thead>
                            <tr style={{ background: "var(--bg-input)" }}>
                                {["When", "Supporter", "What", "Amount", "Balance", "Owed by / order", "Note", "By"].map((h) => (
                                    <th key={h} style={th}>{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((e) => {
                                const k = KIND[e.kind] || { text: e.kind };
                                return (
                                    <tr key={e.id} style={{ borderTop: "1px solid var(--border-light)" }}>
                                        <td style={{ ...td, whiteSpace: "nowrap", fontSize: 12, color: "var(--text-dim)" }}>{fmtDate(e.createdAt)}</td>
                                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                                            <Who tag={e.userTag} id={e.userId} />
                                        </td>
                                        <td style={{ ...td, color: k.color, fontWeight: 600, whiteSpace: "nowrap" }}>{k.text}</td>
                                        <td className="mono" style={{ ...td, whiteSpace: "nowrap", color: e.amount > 0 ? "var(--success)" : e.amount < 0 ? "var(--danger)" : "var(--text-dim)" }}>
                                            {e.amount ? `${e.amount > 0 ? "+" : "−"}${money(Math.abs(e.amount))}` : "—"}
                                        </td>
                                        <td className="mono" style={{ ...td, whiteSpace: "nowrap" }}>{money(e.balance)}</td>
                                        <td style={{ ...td, fontSize: 12, whiteSpace: "nowrap" }}>
                                            {e.sellerId ? sellerName(e.sellerId) : <span style={{ color: "var(--text-dim)" }}>—</span>}
                                            {e.orderId && <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>#{e.orderId}</div>}
                                        </td>
                                        <td style={{ ...td, fontSize: 12, maxWidth: 260, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.note || <span style={{ color: "var(--text-dim)" }}>—</span>}</td>
                                        <td style={{ ...td, fontSize: 12, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                                            {e.byTag || "—"}
                                            {e.via === "discord" && <span style={{ color: "var(--text-dim)" }}> · Discord</span>}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const emptyDraft = { userId: "", userTag: "", bankCode: "", bankBin: "", accountNumber: "", accountName: "", note: "" };
const toDraft = (s) => ({ userId: s.userId, userTag: s.userTag || "", bankCode: s.bank.code, bankBin: s.bank.bin, accountNumber: s.accountNumber, accountName: s.accountName || "", note: s.note || "" });

export default function SupportersPage() {
    const [status, setStatus] = useState(null);
    const [rows, setRows] = useState([]);
    const [banks, setBanks] = useState([]);
    const [showLeft, setShowLeft] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [msg, setMsg] = useState(null);
    const [search, setSearch] = useState("");
    const [historyOf, setHistoryOf] = useState(null);
    const [historyKey, setHistoryKey] = useState(0);
    const [modal, setModal] = useState(null); // { type, supporter? }
    const [confirmRemove, setConfirmRemove] = useState(null);
    const [syncing, setSyncing] = useState(false);
    const [syncResult, setSyncResult] = useState(null);

    const load = useCallback(async () => {
        try {
            const [st, list] = await Promise.all([api.get("/supporters/status"), api.get("/supporters", { params: { all: showLeft ? 1 : undefined } })]);
            setStatus(st.data);
            setRows(list.data.supporters || []);
            setError("");
        } catch (err) {
            setError(errMsg(err, "Could not load the supporters"));
        } finally {
            setLoading(false);
        }
    }, [showLeft]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        api.get("/supporters/banks")
            .then(({ data }) => setBanks(data.banks || []))
            .catch(() => setBanks([]));
    }, []);

    const sellers = status?.sellers || [];
    const sellerName = useCallback((id) => (id ? sellers.find((s) => s.id === id)?.name || id : "Other"), [sellers]);
    const nameOf = useCallback((id) => rows.find((r) => r.userId === id)?.userTag || id, [rows]);

    const done = (m) => {
        if (m) setMsg(m);
        setHistoryKey((k) => k + 1);
        load();
    };

    const remove = async () => {
        const s = confirmRemove;
        setConfirmRemove(null);
        try {
            const { data } = await api.delete(`/supporters/${s.userId}`);
            done(discordText(data.discord, "take the role back and DM them"));
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not remove") });
        }
    };

    const sync = async () => {
        setSyncing(true);
        try {
            const { data } = await api.post("/supporters/sync");
            setSyncResult(data);
            load();
        } catch (err) {
            setMsg({ tone: "danger", text: errMsg(err, "Could not check the role") });
        } finally {
            setSyncing(false);
        }
    };

    const q = search.trim().toLowerCase();
    const visible = q ? rows.filter((r) => [r.userId, r.userTag, r.note, r.bank.code].some((v) => String(v || "").toLowerCase().includes(q))) : rows;
    const active = visible.filter((r) => r.active);
    const left = visible.filter((r) => !r.active);

    const table = (list) => (
        <div style={tableBox}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 900 }}>
                <thead>
                    <tr style={{ background: "var(--bg-input)" }}>
                        {["Supporter", "Bank", "Balance", "Owed by", "Earned / paid", "Joined", ""].map((h, i) => (
                            <th key={`${h}-${i}`} style={th}>{h}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {list.map((s) => (
                        <tr key={s.userId} style={{ borderTop: "1px solid var(--border-light)", opacity: s.active ? 1 : 0.6 }}>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>
                                <Who tag={s.userTag} id={s.userId} />
                                {s.note && <div style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 220, whiteSpace: "normal" }}>{s.note}</div>}
                            </td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>
                                <div>{s.bank.code}</div>
                                <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }} title={s.accountNumber}>
                                    {mask(s.accountNumber)}
                                </div>
                            </td>
                            <td className="mono" style={{ ...td, whiteSpace: "nowrap", fontWeight: 700, color: s.balance > 0 ? "var(--warning)" : "var(--text-dim)" }}>{money(s.balance)}</td>
                            <td style={{ ...td, fontSize: 12, whiteSpace: "nowrap" }}>
                                {s.owed.length ? (
                                    s.owed.map((o) => (
                                        <div key={o.sellerId || "none"}>
                                            {sellerName(o.sellerId)} <span className="mono">{money(o.amount)}</span>
                                        </div>
                                    ))
                                ) : (
                                    <span style={{ color: "var(--text-dim)" }}>—</span>
                                )}
                            </td>
                            <td style={{ ...td, fontSize: 12, whiteSpace: "nowrap" }}>
                                <div className="mono">{money(s.earned)}</div>
                                <div style={{ color: "var(--text-dim)" }}>
                                    paid <span className="mono">{money(s.paid)}</span> · {s.orders} order{s.orders === 1 ? "" : "s"}
                                </div>
                            </td>
                            <td style={{ ...td, fontSize: 12, whiteSpace: "nowrap", color: "var(--text-dim)" }}>
                                {fmtDate(s.joinedAt)}
                                {!s.active && <div>left {fmtDate(s.leftAt)}</div>}
                            </td>
                            <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                                <div style={{ display: "inline-flex", gap: 6 }}>
                                    {s.active ? (
                                        <>
                                            <button className="btn-primary" style={small} disabled={s.balance <= 0} title={s.balance > 0 ? "Pay the whole balance" : "Nothing to pay"} onClick={() => setModal({ type: "pay", supporter: s })}>
                                                Pay
                                            </button>
                                            <button className="btn-ghost" style={small} title="Add or deduct" onClick={() => setModal({ type: "adjust", supporter: s })}>
                                                ±
                                            </button>
                                            <button className="btn-ghost" style={small} onClick={() => setModal({ type: "edit", supporter: s })}>
                                                Edit
                                            </button>
                                        </>
                                    ) : (
                                        <button className="btn-ghost" style={small} onClick={() => setModal({ type: "new", supporter: s })}>
                                            Add again
                                        </button>
                                    )}
                                    <button className="btn-ghost" style={small} onClick={() => setHistoryOf(s.userId)}>
                                        History
                                    </button>
                                    {s.active && (
                                        <button
                                            className="btn-danger"
                                            style={small}
                                            disabled={s.balance > 0}
                                            title={s.balance > 0 ? "Pay them first" : "Remove — the Supporter role is taken back"}
                                            onClick={() => setConfirmRemove(s)}
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Supporters</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0", maxWidth: 760, lineHeight: 1.5 }}>
                        ArnTo-Shop's paid helpers. Adding one gives them the <b>Supporter</b> role; salary comes from <code className="mono">/done</code>. The <b>Staff</b> role is yours to hand out on Discord — nothing here touches it.
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn-ghost" style={{ padding: "8px 14px" }} disabled={syncing || !status?.handler} onClick={sync} title="Give the role to every supporter who lacks it; list who holds it without being one">
                        {syncing ? "Checking…" : "Check roles"}
                    </button>
                    <button className="btn-ghost" style={{ padding: "8px 14px" }} onClick={() => setModal({ type: "texts" })}>
                        DM texts
                    </button>
                    <button className="btn-primary" style={{ padding: "8px 14px" }} onClick={() => setModal({ type: "new" })}>
                        + Supporter
                    </button>
                </div>
            </div>

            {error && <Notice tone="danger">{error}</Notice>}
            {status && !status.imported && (
                <Notice>
                    ArnTo-Shop has not copied its supporters here yet — it does on its first start with the new version (Pull &amp; Update, then restart). Supporters added here before that are kept; the shop's list is
                    added to them.
                </Notice>
            )}
            {status && !status.handler && (
                <Notice>
                    ArnTo-Shop has not announced <code className="mono">supporter.event</code> — update and restart the bot. Until then changes are saved here but nobody gets the role or a DM.
                </Notice>
            )}
            {status && status.handler && !status.busReady && <Notice>The panel's Discord bus is not ready — roles and DMs wait until it is.</Notice>}
            {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

            {status && (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <Stat label="Supporters" value={status.active} />
                    <Stat label="Owed in total" value={money(status.owed)} tone={status.owed > 0 ? "warning" : undefined} />
                </div>
            )}

            <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <input className="input" style={{ flex: "1 1 200px", maxWidth: 320 }} placeholder="Search name, ID, bank, note…" value={search} onChange={(e) => setSearch(e.target.value)} />
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", cursor: "pointer" }}>
                        <input type="checkbox" checked={showLeft} onChange={(e) => setShowLeft(e.target.checked)} />
                        Show those who left
                    </label>
                </div>
                {loading ? (
                    <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
                ) : !rows.length ? (
                    <div className="card" style={empty}>
                        No supporters yet. Press <b>+ Supporter</b>, or run <code className="mono">/staff-new</code> on ArnTo-Shop.
                    </div>
                ) : (
                    <>
                        {active.length > 0 ? table(active) : <div className="card" style={empty}>Nobody matches.</div>}
                        {showLeft && left.length > 0 && (
                            <>
                                <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-muted)", margin: "6px 0 0" }}>Left</h3>
                                {table(left)}
                            </>
                        )}
                    </>
                )}
            </div>

            <History userId={historyOf} onClear={() => setHistoryOf(null)} sellerName={sellerName} refreshKey={historyKey} />

            {modal?.type === "new" && (
                <SupporterModal initial={modal.supporter ? toDraft(modal.supporter) : emptyDraft} isNew banks={banks} onClose={() => setModal(null)} onDone={done} />
            )}
            {modal?.type === "edit" && <SupporterModal initial={toDraft(modal.supporter)} banks={banks} onClose={() => setModal(null)} onDone={done} />}
            {modal?.type === "adjust" && <AdjustModal supporter={modal.supporter} sellers={sellers} onClose={() => setModal(null)} onDone={done} />}
            {modal?.type === "pay" && <PayModal supporter={modal.supporter} sellerName={sellerName} onClose={() => setModal(null)} onDone={done} />}
            {modal?.type === "texts" && <TextsModal onClose={() => setModal(null)} onDone={done} />}
            {syncResult && <SyncModal result={syncResult} nameOf={nameOf} onClose={() => setSyncResult(null)} />}
            {confirmRemove && (
                <ConfirmModal
                    title={`Remove ${confirmRemove.userTag || confirmRemove.userId}?`}
                    message="ArnTo-Shop takes the Supporter role back and DMs them the farewell text. Their history stays, and they can be added again later. A Staff role, if they have one, is left alone."
                    confirmText="Remove"
                    onConfirm={remove}
                    onCancel={() => setConfirmRemove(null)}
                />
            )}
        </div>
    );
}
