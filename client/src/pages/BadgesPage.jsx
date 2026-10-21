import { useCallback, useEffect, useState } from "react";
import api from "../api/client";
import { useAuth, usePageAccess } from "../context/AuthContext";
import ManualBadgeModal from "../components/ManualBadgeModal";
import { EmptyState, Icon, Notice, PageHeader, StatusBadge } from "../components/ui";
import { fmtNum, money } from "../utils/format";

// ─────────────────────────────────────────────────────────────────────────────
//  Auto Badge — orders + manual review.
//
//  Orders held in "manual_review" are the ones that could NOT be settled on their
//  own: Discord would not answer with the progress after payment, a send was
//  refused mid-way, or the panel restarted mid-send. Deliberately not automated — forfeiting a
//  customer's money because our own infrastructure broke is the worst outcome.
//
//  The owner can also add an account by hand (ManualBadgeModal): a free order with
//  source "manual" that runs the same way. It can only be retried or cancelled.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS = {
    paid:          { label: "Paid",          tone: "neutral" },
    verifying:     { label: "Verifying",     tone: "accent" },
    sending:       { label: "Sending",       tone: "accent" },
    sent:          { label: "Done",          tone: "success" },
    manual_review: { label: "Needs review",  tone: "warning" },
    forfeited:     { label: "Forfeited",     tone: "danger" },
    refund_due:    { label: "Refund due",    tone: "danger" },
    token_dead:    { label: "Token dead",    tone: "danger" },
    error:         { label: "Error",         tone: "danger" },
    cancelled:     { label: "Cancelled",     tone: "neutral" },
};

// Filter chips: a status, or "manual" for the orders added by hand.
const FILTERS = ["", "manual_review", "sent", "forfeited", "manual"];
const filterLabel = (f) => (f === "" ? "All" : f === "manual" ? "By hand" : (STATUS[f]?.label ?? f));

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

const unitVi = (u) => (u === "hours" ? "hours" : u === "house" ? "house" : "games");
const badgeVi = (k) =>
    ({ game_time: "Game Time", game_variety: "Game Variety", hypesquad: "HypeSquad", streaming: "Streaming" })[k] ??
    k;

function Card({ children, style }) {
    return (
        <div className="card" style={{ padding: 18, ...style }}>
            {children}
        </div>
    );
}

const BTN_CLASS = { primary: "btn-primary", danger: "btn-danger", default: "btn-ghost" };

function Btn({ children, onClick, tone = "default", disabled }) {
    return (
        <button type="button" onClick={onClick} disabled={disabled} className={`${BTN_CLASS[tone] || BTN_CLASS.default} btn-sm`}>
            {children}
        </button>
    );
}

function Tag({ children, bg, color }) {
    return (
        <span style={{ marginLeft: 8, fontSize: 10, padding: "1px 6px", borderRadius: 4, background: bg, color }}>
            {children}
        </span>
    );
}

function OrderRow({ order, onAction, busy }) {
    const { canEdit } = usePageAccess("badges");
    const st = STATUS[order.status] ?? { label: order.status, tone: "neutral" };
    const pct = order.total ? Math.round((order.sent / order.total) * 100) : 0;
    const manual = order.source === "manual";
    // Same rule as badgeService._reviewable: an "error" order that sent nothing can be retried.
    const reviewable = order.status === "manual_review" || (order.status === "error" && !order.sent);

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
                            <Tag bg="var(--warning-bg)" color="var(--warning)">
                                no Nitro
                            </Tag>
                        )}
                        {manual && (
                            <Tag bg="var(--info-bg)" color="var(--info)">
                                by hand
                            </Tag>
                        )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                        {badgeVi(order.badgeKey)} ·{" "}
                        <strong style={{ color: "var(--text)" }}>{order.tierName}</strong>
                        {order.threshold == null
                            ? ""
                            : ` · ${fmtNum(order.threshold)} ${unitVi(order.unit)}`}{" "}
                        · {manual ? "free" : money(order.price)}
                        {order.reseller ? " (reseller price)" : ""}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                        {/* "declared" only exists on orders from before game badges went Nitro-only */}
                        {order.declaredValue != null ? `declared ${fmtNum(order.declaredValue)} · ` : ""}
                        measured{" "}
                        <strong style={{ color: order.measuredValue === null ? "var(--text-dim)" : "var(--text-muted)" }}>
                            {fmtNum(order.measuredValue)}
                        </strong>
                        {order.measuredSource
                            ? ` (${order.measuredSource === "empty" ? "no badges yet" : order.measuredSource})`
                            : ""}{" "}
                        · created {fmtTime(order.createdAt)}
                    </div>
                    {order.note && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{order.note}</div>
                    )}
                    {order.error && (
                        <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 4 }}>{order.error}</div>
                    )}
                </div>

                <div style={{ flex: "0 0 130px", textAlign: "right" }}>
                    <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
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
                    {canEdit && reviewable && manual && (
                        <>
                            <Btn tone="primary" disabled={busy} onClick={() => onAction(order.orderId, "retry")}>
                                Retry
                            </Btn>
                            <Btn disabled={busy} onClick={() => onAction(order.orderId, "cancel")}>
                                Cancel
                            </Btn>
                        </>
                    )}
                    {canEdit && reviewable && !manual && (
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

export default function BadgesPage() {
    const { isOwner } = useAuth();
    const [adding, setAdding] = useState(false);
    const [orders, setOrders] = useState([]);
    const [filter, setFilter] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            const params = filter === "manual" ? { source: "manual" } : filter ? { status: filter } : {};
            const { data } = await api.get("/badges", { params });
            setOrders(data);
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

    const pending = orders.filter((o) => o.status === "manual_review").length;

    return (
        <div className="page fade-in" style={{ maxWidth: 1100 }}>
            <div style={{ marginBottom: 20 }}>
                <PageHeader
                    title="Auto Badge"
                    description="Badge orders. Payment happens on ArnTo-Auto. Game Time and Game Variety are sold to every account, Nitro or not: the panel reads the buyer's progress with their own token (an account with no badges yet counts as 0), then sends — once sent, the order is done."
                    actions={
                        isOwner && (
                            <button type="button" className="btn-primary" title="A free order — no payment" onClick={() => setAdding(true)}>
                                <Icon name="plus" /> Add account by hand
                            </button>
                        )
                    }
                />
            </div>

            {error && (
                <div style={{ marginBottom: 14 }}>
                    <Notice tone="danger">{error}</Notice>
                </div>
            )}

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {FILTERS.map((s) => (
                    <button
                        key={s || "all"}
                        type="button"
                        onClick={() => setFilter(s)}
                        className={`chip${filter === s ? " active" : ""}`}
                    >
                        {filterLabel(s)}
                        {s === "manual_review" && pending > 0 ? ` (${pending})` : ""}
                    </button>
                ))}
            </div>

            {orders.length === 0 ? (
                <EmptyState compact icon="badges" title="No orders yet" />
            ) : (
                <Card>
                    {orders.map((o) => (
                        <OrderRow key={o.orderId} order={o} onAction={onAction} busy={busy} />
                    ))}
                </Card>
            )}

            {adding && <ManualBadgeModal onClose={() => setAdding(false)} onCreated={load} />}
        </div>
    );
}
