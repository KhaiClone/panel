import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";
import { DataTable, EmptyState, Icon, Notice, PageHeader, SearchInput, StatCard, StatusBadge } from "../components/ui";

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");

const STATUS = {
    pending:   { label: "Pending",   tone: "warning" },
    completed: { label: "Completed", tone: "success" },
    cancelled: { label: "Cancelled", tone: "danger" },
};
const st = (s) => STATUS[s] || { label: s || "—", tone: "neutral" };

const SELLERS = [
    { id: "all", label: "All sellers" },
    { id: "427399742906040333", label: "ArnTo" },
    { id: "871329074046435338", label: "KhaiDev" },
];

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
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
                    Revenue <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginLeft: 6 }}>{money(data.revenue)}</span>
                </p>
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

export default function OrdersPage() {
    const [orders, setOrders] = useState([]);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [sellerFilter, setSellerFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [confirm, setConfirm] = useState(null); // { order, action }
    const [busy, setBusy] = useState(null); // orderId being acted on
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);

    const fetchData = useCallback(async () => {
        try {
            const [ordersRes, statsRes] = await Promise.all([
                api.get("/shop/orders"),
                api.get("/shop/orders/stats"),
            ]);
            setOrders(ordersRes.data.orders || []);
            setStats(statsRes.data);
            setError("");
        } catch (err) {
            setError(err.response?.data?.error || "Could not connect to ArnTo-Shop");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const int = setInterval(fetchData, 15_000);
        return () => clearInterval(int);
    }, [fetchData]);

    const doAction = async () => {
        const { order, action } = confirm;
        setConfirm(null);
        setBusy(order.orderId);
        try {
            await api.post(`/shop/orders/${order.orderId}/${action}`);
            await fetchData();
        } catch (err) {
            alert(err.response?.data?.error || `Could not ${action === "done" ? "complete" : "cancel"} the order`);
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

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeader title="Orders" description="Orders placed through the ArnTo-Shop bot. Complete or cancel the pending ones here or on Discord." />

            {error && <Notice tone="danger">{error}</Notice>}

            {/* Aggregate stats (all sellers) */}
            {stats && (
                <div className="stat-grid">
                    <StatCard label="Total orders" value={stats.total} />
                    <StatCard label="Pending" value={stats.pending} tone="warning" />
                    <StatCard label="Completed" value={stats.completed} tone="success" />
                    <StatCard label="Cancelled" value={stats.cancelled} tone="danger" />
                    <StatCard label="Revenue" value={money(stats.revenue)} />
                </div>
            )}

            {/* Per-seller breakdown */}
            {stats?.bySeller && Object.keys(stats.bySeller).length > 0 && (
                <div>
                    <p className="section-title" style={{ margin: "0 0 10px" }}>By seller</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                        {Object.entries(stats.bySeller).map(([id, data]) => (
                            <SellerCard key={id} data={data} />
                        ))}
                    </div>
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
                            return (
                                <tr key={o._id || o.orderId}>
                                    <td className="mono nowrap">{o.orderId}</td>
                                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</td>
                                    <td className="nowrap">
                                        {o.buyerTag || <span className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>{o.buyerId}</span>}
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
                                        {o.status === "pending" && o.source !== "decoGift" && (
                                            <div className="row-actions">
                                                <button className="btn-success btn-sm" disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "done" })}>
                                                    {busy === o.orderId ? "Working…" : "Complete"}
                                                </button>
                                                <button className="btn-ghost btn-sm is-danger" disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "cancel" })}>
                                                    Cancel
                                                </button>
                                            </div>
                                        )}
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
                    title={confirm.action === "done" ? `Complete order "${confirm.order.orderId}"?` : `Cancel order "${confirm.order.orderId}"?`}
                    message={
                        confirm.action === "done"
                            ? `Product: ${confirm.order.name}\nPrice: ${money(confirm.order.price)}\n\nThe bot will DM the buyer, post a notice in the ticket, add to their spend total and assign the buyer role — same as pressing ✅ on Discord.`
                            : `Product: ${confirm.order.name}\n\nThe bot will DM the buyer about the cancellation and post a notice in the ticket — same as pressing ❌ on Discord.`
                    }
                    confirmText={confirm.action === "done" ? "Complete" : "Cancel order"}
                    danger={confirm.action !== "done"}
                    onConfirm={doAction}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
