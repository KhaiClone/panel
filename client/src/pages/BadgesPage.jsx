import { useCallback, useEffect, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  Auto Badge — đơn hàng + duyệt tay.
//
//  Đơn treo ở "manual_review" là những đơn KHÔNG tự quyết được: reader chết,
//  rate-limit, 404, hoặc panel restart giữa lúc đang gửi. Cố ý không tự động hoá
//  chỗ này — tự tịch thu tiền khách khi hạ tầng của mình hỏng là kịch bản tệ nhất.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS = {
    paid:          { label: "Paid",          color: "var(--text-muted)" },
    verifying:     { label: "Verifying",     color: "var(--accent)" },
    sending:       { label: "Sending",       color: "var(--accent)" },
    sent:          { label: "Done",          color: "var(--success)" },
    manual_review: { label: "Needs review",  color: "var(--warning)" },
    forfeited:     { label: "Forfeited",     color: "var(--danger)" },
    refund_due:    { label: "Refund due",    color: "var(--danger)" },
    token_dead:    { label: "Token dead",    color: "var(--danger)" },
    error:         { label: "Error",         color: "var(--danger)" },
};

const fmtTime = (ts) => {
    if (!ts) return "—";
    try {
        return new Date(ts).toLocaleString("en-GB", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        });
    } catch {
        return "—";
    }
};

const fmtNum = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("vi-VN") : "—");
const unitVi = (u) => (u === "hours" ? "hours" : u === "house" ? "house" : "games");
const badgeVi = (k) =>
    ({ game_time: "Game Time", game_variety: "Game Variety", hypesquad: "HypeSquad", streaming: "Streaming" })[k] ??
    k;

function Card({ children, style }) {
    return (
        <div
            style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 18,
                backdropFilter: "var(--glass-blur)",
                ...style,
            }}
        >
            {children}
        </div>
    );
}

function Btn({ children, onClick, tone = "default", disabled }) {
    const bg =
        tone === "danger" ? "var(--danger-bg)"
        : tone === "primary" ? "var(--accent)"
        : "var(--bg-input)";
    const fg = tone === "danger" ? "var(--danger)" : "var(--text)";
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            style={{
                background: bg,
                border: `1px solid ${tone === "danger" ? "var(--danger-border)" : "var(--border)"}`,
                borderRadius: 8,
                padding: "6px 12px",
                color: fg,
                fontSize: 12,
                fontWeight: 500,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.5 : 1,
            }}
        >
            {children}
        </button>
    );
}

function OrderRow({ order, onAction, busy }) {
    const st = STATUS[order.status] ?? { label: order.status, color: "var(--text-muted)" };
    const pct = order.total ? Math.round((order.sent / order.total) * 100) : 0;

    return (
        <div style={{ borderTop: "1px solid var(--border-light)", padding: "12px 0" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                        {order.username}
                        <span style={{ color: "var(--text-dim)", fontWeight: 400, marginLeft: 6, fontSize: 11 }}>
                            {order.accountId}
                        </span>
                        {!order.hasNitro && (
                            <span
                                style={{
                                    marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 4,
                                    background: "var(--warning-bg)", color: "var(--warning)",
                                }}
                            >
                                no Nitro
                            </span>
                        )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                        {badgeVi(order.badgeKey)} ·{" "}
                        <strong style={{ color: "var(--text)" }}>{order.tierName}</strong>
                        {order.threshold == null
                            ? ""
                            : ` · ${fmtNum(order.threshold)} ${unitVi(order.unit)}`}{" "}
                        · {fmtNum(order.price)}đ
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                        {order.kind === "choice" ? "current house" : "declared"}{" "}
                        {order.kind === "choice" ? "" : fmtNum(order.declaredValue)} · measured{" "}
                        <strong style={{ color: order.measuredValue === null ? "var(--text-dim)" : "var(--text-muted)" }}>
                            {fmtNum(order.measuredValue)}
                        </strong>
                        {order.measuredSource ? ` (${order.measuredSource})` : ""} · created {fmtTime(order.createdAt)}
                    </div>
                    {order.error && (
                        <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{order.error}</div>
                    )}
                </div>

                <div style={{ flex: "0 0 130px", textAlign: "right" }}>
                    <div style={{ color: st.color, fontSize: 12, fontWeight: 500 }}>{st.label}</div>
                    {order.status === "sending" && (
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            {order.sent}/{order.total} ({pct}%)
                        </div>
                    )}
                    {order.status === "sent" && (
                        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
                            {order.sent}/{order.total}
                            {order.kind === "choice" ? "" : " · badge shows up in ~1 day"}
                        </div>
                    )}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {order.status === "manual_review" && (
                        <>
                            <Btn tone="primary" disabled={busy} onClick={() => onAction(order.orderId, "retry")}>
                                Retry
                            </Btn>
                            <Btn tone="danger" disabled={busy} onClick={() => onAction(order.orderId, "forfeit")}>
                                Forfeit
                            </Btn>
                            <Btn disabled={busy} onClick={() => onAction(order.orderId, "cancel")}>
                                Refund
                            </Btn>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Pool reader ──────────────────────────────────────────────────────────────────

const READER_STATUS = {
    ok:        { label: "Working",       color: "var(--success)" },
    no_nitro:  { label: "Nitro lapsed",  color: "var(--warning)" },
    dead:      { label: "Token dead",    color: "var(--danger)" },
    unknown:   { label: "Not checked",   color: "var(--text-dim)" },
};

function ReaderPool({ pool, onAdd, onAction, busy }) {
    const [token, setToken] = useState("");
    const [label, setLabel] = useState("");
    const [open, setOpen] = useState(false);

    const submit = async () => {
        if (!token.trim()) return;
        await onAdd(token.trim(), label.trim());
        setToken("");
        setLabel("");
    };

    const readers = pool?.readers ?? [];

    return (
        <Card style={{ marginBottom: 16 }}>
            <div
                style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 10, flexWrap: "wrap", marginBottom: readers.length || open ? 14 : 0,
                }}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                        style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: pool?.ok ? "var(--success)" : "var(--danger)",
                        }}
                    />
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Reader pool</span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {pool
                            ? `${pool.healthy}/${pool.total} usable`
                            : "loading…"}
                        {pool && !pool.ok ? ` — ${pool.reason}` : ""}
                    </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                    <Btn disabled={busy || !readers.length} onClick={() => onAction(null, "verify-all")}>
                        Check all
                    </Btn>
                    <Btn tone="primary" onClick={() => setOpen((v) => !v)}>
                        {open ? "Close" : "Add reader"}
                    </Btn>
                </div>
            </div>

            {!pool?.ok && (
                <div style={{ fontSize: 11, color: "var(--warning)", marginBottom: 12 }}>
                    No healthy reader left — every order from a buyer <strong>without Nitro</strong> will wait in
                    "Needs review". Orders from buyers with Nitro still run normally (read with their own token).
                </div>
            )}

            {open && (
                <div
                    style={{
                        display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap",
                        alignItems: "flex-end",
                    }}
                >
                    <div style={{ flex: "2 1 280px" }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                            Token (the account must have Nitro)
                        </div>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="Paste a Discord token"
                            style={{
                                background: "var(--bg-input)", border: "1px solid var(--border)",
                                borderRadius: 8, padding: "8px 10px", color: "var(--text)",
                                fontSize: 13, outline: "none", width: "100%",
                            }}
                        />
                    </div>
                    <div style={{ flex: "1 1 140px" }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                            Label (optional)
                        </div>
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="e.g. main account"
                            style={{
                                background: "var(--bg-input)", border: "1px solid var(--border)",
                                borderRadius: 8, padding: "8px 10px", color: "var(--text)",
                                fontSize: 13, outline: "none", width: "100%",
                            }}
                        />
                    </div>
                    <Btn tone="primary" disabled={busy || !token.trim()} onClick={submit}>
                        Add
                    </Btn>
                </div>
            )}

            {readers.map((r) => {
                const st = READER_STATUS[r.status] ?? READER_STATUS.unknown;
                return (
                    <div
                        key={r.id}
                        style={{
                            borderTop: "1px solid var(--border-light)", padding: "10px 0",
                            display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
                        }}
                    >
                        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>
                                {r.label}
                                <span
                                    style={{
                                        color: "var(--text-dim)", fontWeight: 400,
                                        marginLeft: 6, fontSize: 11,
                                    }}
                                >
                                    {r.username} · {r.accountId}
                                </span>
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
                                {r.uses ?? 0} reads · {r.failures ?? 0} failures
                                {r.lastUsedAt ? ` · last used ${fmtTime(r.lastUsedAt)}` : ""}
                            </div>
                            {r.lastError && (
                                <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 2 }}>
                                    {r.lastError}
                                </div>
                            )}
                        </div>
                        <div style={{ flex: "0 0 110px", textAlign: "right" }}>
                            <div style={{ color: st.color, fontSize: 12 }}>{st.label}</div>
                            {r.onCooldown && (
                                <div style={{ fontSize: 11, color: "var(--warning)" }}>
                                    cooling down until {fmtTime(r.cooldownUntil)}
                                </div>
                            )}
                            {!r.enabled && (
                                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>disabled</div>
                            )}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                            <Btn disabled={busy} onClick={() => onAction(r.id, "verify")}>
                                Check
                            </Btn>
                            <Btn
                                disabled={busy}
                                onClick={() => onAction(r.id, r.enabled ? "disable" : "enable")}
                            >
                                {r.enabled ? "Disable" : "Enable"}
                            </Btn>
                            <Btn tone="danger" disabled={busy} onClick={() => onAction(r.id, "remove")}>
                                Remove
                            </Btn>
                        </div>
                    </div>
                );
            })}

            {!readers.length && !open && (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    No reader yet. Add at least one account with Nitro to read the badge progress of
                    buyers without Nitro.
                </div>
            )}
        </Card>
    );
}

export default function BadgesPage() {
    const [orders, setOrders] = useState([]);
    const [pool, setPool] = useState(null);
    const [filter, setFilter] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            const [o, r] = await Promise.all([
                api.get("/badges", { params: filter ? { status: filter } : {} }),
                api.get("/badges/readers"),
            ]);
            setOrders(o.data);
            setPool(r.data);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        }
    }, [filter]);

    useEffect(() => {
        load();
        const id = setInterval(load, 10_000);
        return () => clearInterval(id);
    }, [load]);

    const onAction = async (orderId, action) => {
        setBusy(true);
        setError("");
        try {
            await api.post(`/badges/${orderId}/resolve`, { action });
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setBusy(false);
        }
    };

    const onReaderAction = async (id, action) => {
        setBusy(true);
        setError("");
        try {
            if (action === "verify-all") await api.post("/badges/readers/verify-all");
            else if (action === "verify") await api.post(`/badges/readers/${id}/verify`);
            else if (action === "enable") await api.patch(`/badges/readers/${id}`, { enabled: true });
            else if (action === "disable") await api.patch(`/badges/readers/${id}`, { enabled: false });
            else if (action === "remove") await api.delete(`/badges/readers/${id}`);
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setBusy(false);
        }
    };

    const onReaderAdd = async (token, label) => {
        setBusy(true);
        setError("");
        try {
            await api.post("/badges/readers", { token, label });
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally {
            setBusy(false);
        }
    };

    const pending = orders.filter((o) => o.status === "manual_review").length;

    return (
        <div style={{ padding: 24, maxWidth: 1100 }}>
            <div style={{ marginBottom: 18 }}>
                <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Auto Badge</h1>
                <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "6px 0 0" }}>
                    Badge orders. Payment happens on ArnTo-Auto; the panel reads the real progress, then
                    sends — once sent, the order is done. Press "Verify now" if you need to cross-check.
                </p>
            </div>

            {error && (
                <div
                    style={{
                        background: "var(--danger-bg)", border: "1px solid var(--danger-border)",
                        color: "var(--danger)", borderRadius: 8, padding: "10px 14px",
                        fontSize: 13, marginBottom: 14,
                    }}
                >
                    {error}
                </div>
            )}

            {/* Reader pool — with no healthy reader the panel is blind to buyers without Nitro, so it sits at the top */}
            <ReaderPool pool={pool} onAdd={onReaderAdd} onAction={onReaderAction} busy={busy} />

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {["", "manual_review", "sent", "forfeited"].map((s) => (
                    <button
                        key={s || "all"}
                        type="button"
                        onClick={() => setFilter(s)}
                        style={{
                            background: filter === s ? "var(--accent-dim)" : "var(--bg-input)",
                            border: `1px solid ${filter === s ? "var(--accent)" : "var(--border)"}`,
                            borderRadius: 999, padding: "4px 12px", color: "var(--text)",
                            fontSize: 12, cursor: "pointer",
                        }}
                    >
                        {s === "" ? "All" : (STATUS[s]?.label ?? s)}
                        {s === "manual_review" && pending > 0 ? ` (${pending})` : ""}
                    </button>
                ))}
            </div>

            <Card>
                {orders.length === 0 ? (
                    <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "8px 0" }}>
                        No orders yet.
                    </div>
                ) : (
                    orders.map((o) => (
                        <OrderRow key={o.orderId} order={o} onAction={onAction} busy={busy} />
                    ))
                )}
            </Card>
        </div>
    );
}
