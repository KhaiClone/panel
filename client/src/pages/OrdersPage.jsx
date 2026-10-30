import { useState, useEffect, useCallback, useRef } from "react";
import api from "../api/client";
import { useAuth, usePageAccess } from "../context/AuthContext";
import ConfirmModal from "../components/ConfirmModal";
import DecoGiftOrderModal from "../components/DecoGiftOrderModal";
import { DataTable, EmptyState, Icon, Modal, Notice, PageHeader, SearchInput, StatCard, StatusBadge } from "../components/ui";
import { fmtNum, money } from "../utils/format";

const STATUS = {
    pending:   { label: "Pending",   tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
};
const st = (s) => STATUS[s] || { label: s || "—", tone: "neutral" };

const VERB = { done: "complete", cancel: "cancel", delete: "delete" };

const confirmMessage = (action, order) => {
    if (action === "done") {
        return `Product: ${order.name}\nPrice: ${money(order.price)}\n\nThe bot will DM the buyer, post a notice in the ticket, add to their spend total and assign the buyer role — same as pressing ✅ on Discord.`;
    }
    if (action === "cancel") {
        return `Product: ${order.name}\n\nThe bot will DM the buyer about the cancellation and post a notice in the ticket — same as pressing ❌ on Discord.`;
    }
    return `Product: ${order.name}\nPrice: ${money(order.price)} · ${st(order.status).label}\n\nThe order is removed everywhere it counts: this list, the shop's monthly statistics, the buyer's order history${order.status === "completed" ? " and spend total" : ""}, and its message in the waiting list. The buyer is not told — same as /order-remove on Discord. This cannot be undone.`;
};

const SELLERS = [
    { id: "all", label: "All sellers" },
    { id: "427399742906040333", label: "ArnTo" },
    { id: "871329074046435338", label: "KhaiDev" },
];

const SOURCES = { decoGift: "Deco Gift — sold by ArnTo-Auto" };

// Statistics periods: "2026-10", "2026" or "all". Months are Vietnam's (UTC+7),
// like the server's (orderService getStats) and the shop's /thongke.
const thisMonth = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
const monthName = (m, opts = { month: "long", year: "numeric" }) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", opts);
const periodName = (p) => (p === "all" ? "All time" : p.length === 4 ? p : monthName(p));
const modeOf = (p) => (p === "all" ? "all" : p.length === 4 ? "year" : "month");

const fullDate = (ts) =>
    ts ? new Date(ts).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

function Metric({ label, value, tone }) {
    return (
        <div style={{ minWidth: 64 }}>
            <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                {tone && <span className="status-dot" style={{ width: 6, height: 6, background: `var(--${tone})` }} />}
                {label}
            </p>
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", margin: "2px 0 0" }}>{value}</p>
        </div>
    );
}

function SellerCard({ data }) {
    return (
        <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{data.name}</h3>
                {data.revenue !== undefined && (
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
                        Revenue <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginLeft: 6 }}>{money(data.revenue)}</span>
                    </p>
                )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between" }}>
                <Metric label="Orders" value={data.total} />
                <Metric label="Pending" value={data.pending} tone="warning" />
                <Metric label="Completed" value={data.completed} tone="success" />
                <Metric label="Cancelled" value={data.cancelled} tone="danger" />
                <Metric label="Buyers" value={data.buyers} />
            </div>
        </div>
    );
}

/** Month / Year / All time, and which one. `months` = every month with a figure, newest first. */
function PeriodPicker({ period, months, onChange }) {
    const mode = modeOf(period);
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    const list = mode === "month" ? months : years;
    const i = list.indexOf(period);
    const switchTo = (m) => {
        if (m === mode) return;
        if (m === "all") return onChange("all");
        if (m === "year") return onChange(mode === "month" ? period.slice(0, 4) : years[0]);
        // To months: the latest one of the year being looked at.
        onChange((mode === "year" && months.find((k) => k.startsWith(period))) || months[0]);
    };
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="tab-bar">
                {[["month", "Month"], ["year", "Year"], ["all", "All time"]].map(([k, label]) => (
                    <button key={k} className={`tab-item ${mode === k ? "active" : ""}`} onClick={() => switchTo(k)}>
                        {label}
                    </button>
                ))}
            </div>
            {mode !== "all" && (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button className="btn-ghost btn-icon btn-sm" title={`Previous ${mode}`} disabled={i < 0 || i >= list.length - 1} onClick={() => onChange(list[i + 1])}>
                        <Icon name="chevronLeft" />
                    </button>
                    <select className="input" style={{ width: "auto" }} value={period} onChange={(e) => onChange(e.target.value)} aria-label={mode === "month" ? "Month" : "Year"}>
                        {list.map((k) => <option key={k} value={k}>{periodName(k)}</option>)}
                    </select>
                    <button className="btn-ghost btn-icon btn-sm" title={`Next ${mode}`} disabled={i <= 0} onClick={() => onChange(list[i - 1])}>
                        <Icon name="chevronRight" />
                    </button>
                </div>
            )}
        </div>
    );
}

/** A year by month, or all time by year. A row opens that month / year. */
function Breakdown({ rows, period, onPick }) {
    const byMonth = period !== "all";
    const withRevenue = rows.some((r) => r.revenue !== undefined);
    const bar = (r) => (withRevenue ? r.revenue : r.total);
    const top = Math.max(1, ...rows.map(bar));
    return (
        <div>
            <p className="section-title" style={{ margin: "0 0 10px" }}>{byMonth ? `${period} by month` : "By year"}</p>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <DataTable
                    flush
                    minWidth={640}
                    columns={[
                        byMonth ? "Month" : "Year",
                        { label: "Orders", align: "right" },
                        { label: "Pending", align: "right" },
                        { label: "Completed", align: "right" },
                        { label: "Cancelled", align: "right" },
                        { label: "Buyers", align: "right" },
                        ...(withRevenue ? [{ label: "Revenue", align: "right" }] : []),
                    ]}
                >
                    {rows.map((r) => (
                        <tr key={r.key} title={`Show ${periodName(r.key)}`} style={{ cursor: "pointer", color: r.total ? undefined : "var(--text-dim)" }} onClick={() => onPick(r.key)}>
                            <td className="nowrap" style={{ fontWeight: 500 }}>{byMonth ? monthName(r.key, { month: "long" }) : r.key}</td>
                            {["total", "pending", "completed", "cancelled", "buyers", ...(withRevenue ? ["revenue"] : [])].map((k) => (
                                <td key={k} className="mono num">
                                    {k === "revenue" ? money(r.revenue) : fmtNum(r[k])}
                                    {k === (withRevenue ? "revenue" : "total") && bar(r) > 0 && (
                                        <div style={{ height: 3, borderRadius: 2, background: "var(--accent)", opacity: 0.7, width: `${(bar(r) / top) * 100}%`, marginLeft: "auto", marginTop: 4 }} />
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </DataTable>
            </div>
        </div>
    );
}

/** What /info-order shows on Discord, and the rest of the record. */
function OrderModal({ order, canAct, canDelete, busy, onAction, onBuyerOrders, onClose }) {
    const s = st(order.status);
    const [copied, setCopied] = useState(false);
    const copyId = async () => {
        try {
            await navigator.clipboard.writeText(order.buyerId);
            setCopied(true);
        } catch { /* clipboard blocked — the ID is selectable */ }
    };
    const rows = [
        ["Status", <StatusBadge key="s" tone={s.tone}>{s.label}</StatusBadge>],
        ["Product", order.name],
        ["Price", <span key="p" className="mono">{money(order.price)}</span>],
        [
            "Buyer",
            <div key="b">
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    {order.buyerTag || <span style={{ color: "var(--text-dim)" }}>Unknown tag</span>}
                    {order.reseller === true && <StatusBadge tone="accent" title="Bought by a reseller">Reseller</StatusBadge>}
                </div>
                <div className="cell-sub" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span className="mono">{order.buyerId}</span>
                    <button type="button" className="btn-ghost btn-icon btn-sm" style={{ width: 22, height: 22, border: "none" }} title={copied ? "Copied" : "Copy user ID"} onClick={copyId}>
                        <Icon name={copied ? "check" : "copy"} size={12} />
                    </button>
                </div>
            </div>,
        ],
        ["Seller", order.sellerName],
        ["Ordered", fullDate(order.orderDate)],
        ["Source", SOURCES[order.source] || order.source || "Ticket"],
        order.externalId && ["Payment", <span key="x" className="mono">{order.externalId}</span>],
        order.items?.length > 0 && [
            "Items",
            <ul key="i" style={{ margin: 0, paddingLeft: 18 }}>
                {order.items.map((it, n) => (
                    <li key={n}>
                        {it.name}
                        {Number.isFinite(it.price) && <span className="mono" style={{ color: "var(--text-dim)" }}> · {money(it.price)}</span>}
                    </li>
                ))}
            </ul>,
        ],
    ].filter(Boolean);

    return (
        <Modal title={`Order ${order.orderId}`} onClose={onClose} width={520}>
            <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "10px 16px", fontSize: 13, alignItems: "baseline" }}>
                {rows.map(([label, value]) => (
                    <div key={label} style={{ display: "contents" }}>
                        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{label}</div>
                        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>{value}</div>
                    </div>
                ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 20 }}>
                <button className="btn-ghost btn-sm" onClick={() => onBuyerOrders(order.buyerId)}>
                    <Icon name="orders" size={14} /> This buyer's orders
                </button>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
                    {order.status === "pending" && order.source === "decoGift" && (
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Approve or cancel it in ArnTo-Auto's Deco Gift staff channel on Discord</span>
                    )}
                    {canAct && (
                        <>
                            <button className="btn-success btn-sm" disabled={busy} onClick={() => onAction("done")}>Complete</button>
                            <button className="btn-ghost btn-sm is-danger" disabled={busy} onClick={() => onAction("cancel")}>Cancel</button>
                        </>
                    )}
                    {canDelete && (
                        <button className="btn-ghost btn-sm is-danger" disabled={busy} onClick={() => onAction("delete")}>
                            <Icon name="trash" size={14} /> Delete
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    );
}

export default function OrdersPage() {
    const { canEdit } = usePageAccess("orders");
    const { isOwner } = useAuth(); // deleting rewrites revenue and history: owner only
    const [orders, setOrders] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [sellerFilter, setSellerFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [confirm, setConfirm] = useState(null); // { order, action }
    const [busy, setBusy] = useState(null); // orderId being acted on
    const [newDecoGift, setNewDecoGift] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const [period, setPeriod] = useState(thisMonth); // statistics: "2026-10" | "2026" | "all"
    const periodRef = useRef(period);
    const [openId, setOpenId] = useState(null); // order shown in the details dialog

    const loadStats = useCallback(async () => {
        const { data } = await api.get("/shop/orders/stats", { params: { period: periodRef.current } });
        // An answer for a period picked before the last click is dropped.
        if ((data.period || "all") === periodRef.current) setStats(data);
    }, []);

    const fetchData = useCallback(async () => {
        try {
            const [ordersRes] = await Promise.all([api.get("/shop/orders"), loadStats()]);
            setOrders(ordersRes.data.orders || []);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || "Could not connect to ArnTo-Shop");
        } finally {
            setLoading(false);
        }
    }, [loadStats]);

    useEffect(() => {
        fetchData();
        const int = setInterval(fetchData, 15_000);
        return () => clearInterval(int);
    }, [fetchData]);

    const pickPeriod = (p) => {
        periodRef.current = p;
        setPeriod(p);
        loadStats().catch((err) => setError(err.response?.data?.error || "Could not load the statistics"));
    };

    const doAction = async () => {
        const { order, action } = confirm;
        setConfirm(null);
        setBusy(order.orderId);
        try {
            if (action === "delete") {
                await api.delete(`/shop/orders/${order.orderId}`);
                setOpenId(null);
            } else await api.post(`/shop/orders/${order.orderId}/${action}`);
            await fetchData();
        } catch (err) {
            alert(err.response?.data?.error || `Could not ${VERB[action]} the order`);
        } finally {
            setBusy(null);
        }
    };

    const visible = orders.filter((o) => {
        const ms = statusFilter === "all" || o.status === statusFilter;
        const mse = sellerFilter === "all" || o.sellerId === sellerFilter;
        const q = search.trim().toLowerCase();
        const mq = !q ||
            o.orderId?.toLowerCase().includes(q) ||
            o.name?.toLowerCase().includes(q) ||
            o.buyerId?.includes(q) ||
            o.buyerTag?.toLowerCase().includes(q);
        return ms && mse && mq;
    });

    // Reset to the first page whenever the filtered set changes
    useEffect(() => { setPage(1); }, [statusFilter, sellerFilter, search, pageSize]);

    const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
    const safePage = Math.min(page, totalPages);
    const paged = visible.slice((safePage - 1) * pageSize, safePage * pageSize);

    // Who may do what to an order — the table row and the details dialog alike.
    const canActOn = (o) => canEdit && o.status === "pending" && o.source !== "decoGift";
    const canDeleteOrder = (o) => isOwner && o.source !== "decoGift";
    // The live record (the list refreshes every 15 s); gone once it is deleted.
    const opened = openId && orders.find((o) => o.orderId === openId);
    const statsStale = stats && (stats.period || "all") !== period;

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader
                title="Orders"
                description="Orders placed through the ArnTo-Shop bot. Complete or cancel the pending ones here or on Discord."
                actions={
                    canEdit && (
                        <button type="button" className="btn-primary" title="For a buyer who paid in a ticket — no QR" onClick={() => setNewDecoGift(true)}>
                            <Icon name="gift" /> New Deco Gift order
                        </button>
                    )
                }
            />

            {error && <Notice tone="danger">{error}</Notice>}

            {/* Statistics for the picked month / year / all time (orders placed
                in it). The server leaves revenue out for staff without the
                "See revenue" grant (Panel Settings → Staff). */}
            {stats && (
                <div style={{ display: "flex", flexDirection: "column", gap: 20, opacity: statsStale ? 0.55 : 1, transition: "opacity .15s" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{periodName(period)}</h2>
                        <PeriodPicker period={period} months={stats.months || [thisMonth()]} onChange={pickPeriod} />
                    </div>

                    {/* Revenue takes two columns: a year's or all time's amount
                        ("81,898,000 VND") does not fit in one. */}
                    <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                        <StatCard label="Total orders" value={fmtNum(stats.total)} hint={`${fmtNum(stats.buyers)} buyer${stats.buyers === 1 ? "" : "s"}`} />
                        <StatCard label="Pending" value={fmtNum(stats.pending)} tone="warning" />
                        <StatCard label="Completed" value={fmtNum(stats.completed)} tone="success" />
                        <StatCard label="Cancelled" value={fmtNum(stats.cancelled)} tone="danger" />
                        {stats.revenue !== undefined && (
                            <div style={{ gridColumn: "span 2", display: "grid" }}>
                                <StatCard label="Revenue" value={money(stats.revenue)} hint="Completed orders" />
                            </div>
                        )}
                    </div>

                    {/* Per-seller breakdown */}
                    {stats.bySeller && Object.keys(stats.bySeller).length > 0 && (
                        <div>
                            <p className="section-title" style={{ margin: "0 0 10px" }}>By seller</p>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                                {Object.entries(stats.bySeller).map(([id, data]) => (
                                    <SellerCard key={id} data={data} />
                                ))}
                            </div>
                        </div>
                    )}

                    {stats.breakdown?.length > 0 && <Breakdown rows={stats.breakdown} period={stats.period || "all"} onPick={pickPeriod} />}
                </div>
            )}

            {/* Filters */}
            <div className="toolbar">
                <SearchInput value={search} onChange={setSearch} placeholder="Search order ID, product, buyer…" style={{ flex: "1 1 220px", maxWidth: 340 }} />
                <div className="tab-bar">
                    {["all", "pending", "completed", "cancelled"].map((f) => (
                        <button key={f} className={`tab-item ${statusFilter === f ? "active" : ""}`} onClick={() => setStatusFilter(f)}>
                            {f === "all" ? "All" : st(f).label}
                        </button>
                    ))}
                </div>
                <select className="input" style={{ width: "auto" }} value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
                    {SELLERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <span className="toolbar-count">{visible.length} / {orders.length}</span>
            </div>

            {/* Table */}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : visible.length === 0 ? (
                <EmptyState
                    icon="orders"
                    title={orders.length ? "No orders match" : "No orders yet"}
                    description={orders.length ? "Try another status, seller or search." : "Orders appear here as soon as a buyer orders through ArnTo-Shop."}
                />
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <DataTable flush minWidth={720} columns={["Order ID", "Product", "Buyer", "Seller", { label: "Price", align: "right" }, "Date", "Status", ""]}>
                        {paged.map((o) => {
                            const s = st(o.status);
                            const canAct = canActOn(o);
                            const canDelete = canDeleteOrder(o);
                            return (
                                <tr key={o._id || o.orderId}>
                                    <td className="mono nowrap">
                                        <button
                                            type="button"
                                            className="mono"
                                            title="Show order details"
                                            style={{ background: "none", border: "none", padding: 0, font: "inherit", color: "var(--accent-hover)", cursor: "pointer" }}
                                            onClick={() => setOpenId(o.orderId)}
                                        >
                                            {o.orderId}
                                        </button>
                                    </td>
                                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</td>
                                    <td className="nowrap">
                                        {o.buyerTag || <span className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>{o.buyerId}</span>}
                                        {o.reseller === true && (
                                            <span style={{ marginLeft: 6 }}>
                                                <StatusBadge tone="accent" title="Bought by a reseller">Reseller</StatusBadge>
                                            </span>
                                        )}
                                    </td>
                                    <td className="nowrap">{o.sellerName}</td>
                                    <td className="mono num">{money(o.price)}</td>
                                    <td className="muted">
                                        {o.orderDate ? new Date(o.orderDate).toLocaleDateString("en-GB") : "—"}
                                    </td>
                                    <td><StatusBadge tone={s.tone}>{s.label}</StatusBadge></td>
                                    <td className="actions">
                                        {o.status === "pending" && o.source === "decoGift" && (
                                            // Finished in ArnTo-Auto's staff channel, which delivers the gift links first.
                                            <span title="Approve or cancel it in ArnTo-Auto's Deco Gift staff channel on Discord" style={{ fontSize: 12, color: "var(--text-dim)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                                                <Icon name="gift" size={14} /> Deco Gift · Discord
                                            </span>
                                        )}
                                        <div className="row-actions">
                                            <button className="btn-ghost btn-icon btn-sm" title="Order details" aria-label={`Details of order ${o.orderId}`} onClick={() => setOpenId(o.orderId)}>
                                                <Icon name="eye" size={14} />
                                            </button>
                                            {canAct && (
                                                <>
                                                    <button className="btn-success btn-sm" disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "done" })}>
                                                        {busy === o.orderId ? "Working…" : "Complete"}
                                                    </button>
                                                    <button className="btn-ghost btn-sm is-danger" disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "cancel" })}>
                                                        Cancel
                                                    </button>
                                                </>
                                            )}
                                            {canDelete && (
                                                <button className="btn-ghost btn-icon btn-sm is-danger" title="Delete order" aria-label={`Delete order ${o.orderId}`} disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "delete" })}>
                                                    <Icon name="trash" size={14} />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </DataTable>

                    {/* Pagination */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderTop: "1px solid var(--border)", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visible.length)} of {visible.length}
                        </span>
                        <select className="input" style={{ width: "auto", padding: "4px 8px", fontSize: 12 }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
                        </select>
                        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
                            <button className="btn-ghost btn-icon btn-sm" title="First page" disabled={safePage <= 1} onClick={() => setPage(1)}><Icon name="chevronsLeft" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Previous page" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}><Icon name="chevronLeft" /></button>
                            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 90, textAlign: "center" }}>Page {safePage} of {totalPages}</span>
                            <button className="btn-ghost btn-icon btn-sm" title="Next page" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}><Icon name="chevronRight" /></button>
                            <button className="btn-ghost btn-icon btn-sm" title="Last page" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}><Icon name="chevronsRight" /></button>
                        </div>
                    </div>
                </div>
            )}

            {confirm && (
                <ConfirmModal
                    title={`${VERB[confirm.action][0].toUpperCase()}${VERB[confirm.action].slice(1)} order "${confirm.order.orderId}"?`}
                    message={confirmMessage(confirm.action, confirm.order)}
                    confirmText={{ done: "Complete", cancel: "Cancel order", delete: "Delete order" }[confirm.action]}
                    danger={confirm.action !== "done"}
                    onConfirm={doAction}
                    onCancel={() => setConfirm(null)}
                />
            )}

            {opened && !confirm && (
                <OrderModal
                    order={opened}
                    canAct={canActOn(opened)}
                    canDelete={canDeleteOrder(opened)}
                    busy={busy === opened.orderId}
                    onAction={(action) => setConfirm({ order: opened, action })}
                    onBuyerOrders={(buyerId) => {
                        setOpenId(null);
                        setStatusFilter("all");
                        setSellerFilter("all");
                        setSearch(buyerId);
                    }}
                    onClose={() => setOpenId(null)}
                />
            )}

            {newDecoGift && <DecoGiftOrderModal onClose={() => setNewDecoGift(false)} onCreated={fetchData} />}
        </div>
    );
}
