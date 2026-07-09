import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");

const STATUS = {
    pending:   { label: "Pending",   color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)" },
    completed: { label: "Completed", color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)" },
    cancelled: { label: "Cancelled", color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)" },
};
const st = (s) => STATUS[s] || { label: s || "—", color: "var(--text-muted)", bg: "var(--bg-input)", border: "var(--border)" };

const SELLERS = [
    { id: "all", label: "All sellers" },
    { id: "427399742906040333", label: "ArnTo" },
    { id: "871329074046435338", label: "KhaiDev" },
];

function StatCard({ label, value, color }) {
    return (
        <div className="card" style={{ padding: "16px 20px", borderBottom: `2px solid ${color}` }}>
            <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 8px" }}>{label}</p>
            <p style={{ fontSize: 26, fontWeight: 800, color: "#fff", margin: 0, lineHeight: 1 }}>{value}</p>
        </div>
    );
}

const SELLER_COLOR = { "427399742906040333": "#22c55e", "871329074046435338": "#6366f1" };

function Metric({ label, value, color }) {
    return (
        <div style={{ textAlign: "center", minWidth: 64 }}>
            <p style={{ fontSize: 18, fontWeight: 800, color: color || "var(--text)", margin: 0, lineHeight: 1.1 }}>{value}</p>
            <p style={{ fontSize: 10, color: "var(--text-dim)", margin: "3px 0 0", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</p>
        </div>
    );
}

function SellerCard({ id, data }) {
    const color = SELLER_COLOR[id] || "var(--accent)";
    return (
        <div className="card" style={{ padding: "16px 20px", borderLeft: `3px solid ${color}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: color }} />
                    <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{data.name}</h3>
                </div>
                <div style={{ textAlign: "right" }}>
                    <p style={{ fontSize: 20, fontWeight: 800, color, margin: 0, lineHeight: 1 }}>{money(data.revenue)}</p>
                    <p style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 0", textTransform: "uppercase", letterSpacing: "0.05em" }}>Revenue</p>
                </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between" }}>
                <Metric label="Orders" value={data.total} />
                <Metric label="Pending" value={data.pending} color="var(--warning)" />
                <Metric label="Completed" value={data.completed} color="var(--success)" />
                <Metric label="Cancelled" value={data.cancelled} color="var(--danger)" />
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
            <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Orders (ArnTo-Shop)</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>View and process orders from the ArnTo-Shop bot.</p>
            </div>

            {error && (
                <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>
            )}

            {/* Aggregate stats (all sellers) */}
            {stats && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <StatCard label="Total orders" value={stats.total} color="var(--accent)" />
                    <StatCard label="Pending" value={stats.pending} color="var(--warning)" />
                    <StatCard label="Completed" value={stats.completed} color="var(--success)" />
                    <StatCard label="Cancelled" value={stats.cancelled} color="var(--danger)" />
                    <StatCard label="Revenue" value={money(stats.revenue)} color="#a78bfa" />
                </div>
            )}

            {/* Per-seller breakdown */}
            {stats?.bySeller && Object.keys(stats.bySeller).length > 0 && (
                <div>
                    <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 10px" }}>By seller</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                        {Object.entries(stats.bySeller).map(([id, data]) => (
                            <SellerCard key={id} id={id} data={data} />
                        ))}
                    </div>
                </div>
            )}

            {/* Filters */}
            <div className="card" style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 340 }}>
                    <input className="input" placeholder="Search order ID, product, buyer…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="tab-bar">
                    {["all", "pending", "completed", "cancelled"].map((f) => (
                        <button key={f} className={`tab-item ${statusFilter === f ? "active" : ""}`} onClick={() => setStatusFilter(f)}>
                            {f === "all" ? "All" : st(f).label}
                        </button>
                    ))}
                </div>
                <select className="input" style={{ width: "auto", padding: "7px 12px" }} value={sellerFilter} onChange={(e) => setSellerFilter(e.target.value)}>
                    {SELLERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-dim)" }}>{visible.length} / {orders.length}</span>
            </div>

            {/* Table */}
            {loading ? (
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : visible.length === 0 ? (
                <div className="card" style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 14, borderStyle: "dashed" }}>
                    No orders match.
                </div>
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
                            <thead>
                                <tr style={{ background: "var(--bg-input)", textAlign: "left" }}>
                                    {["Order ID", "Product", "Buyer", "Seller", "Price", "Date", "Status", ""].map((h) => (
                                        <th key={h} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {paged.map((o) => {
                                    const s = st(o.status);
                                    return (
                                        <tr key={o._id || o.orderId} style={{ borderTop: "1px solid var(--border-light)" }}>
                                            <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>{o.orderId}</td>
                                            <td style={{ padding: "10px 14px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</td>
                                            <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>
                                                {o.buyerTag || <span className="mono" style={{ color: "var(--text-dim)", fontSize: 11 }}>{o.buyerId}</span>}
                                            </td>
                                            <td style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>{o.sellerName}</td>
                                            <td className="mono" style={{ padding: "10px 14px", whiteSpace: "nowrap" }}>{money(o.price)}</td>
                                            <td style={{ padding: "10px 14px", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 12 }}>
                                                {o.orderDate ? new Date(o.orderDate).toLocaleDateString("vi-VN") : "—"}
                                            </td>
                                            <td style={{ padding: "10px 14px" }}>
                                                <span className="status-pill" style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color, fontSize: 11, padding: "3px 8px", whiteSpace: "nowrap" }}>
                                                    <span className="status-dot" style={{ background: s.color, width: 6, height: 6 }} />
                                                    {s.label}
                                                </span>
                                            </td>
                                            <td style={{ padding: "10px 14px", whiteSpace: "nowrap", textAlign: "right" }}>
                                                {o.status === "pending" && (
                                                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                                                        <button className="btn-success" style={{ padding: "4px 10px", fontSize: 12 }} disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "done" })}>
                                                            {busy === o.orderId ? "…" : "Complete"}
                                                        </button>
                                                        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12, color: "var(--danger)" }} disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "cancel" })}>
                                                            Cancel
                                                        </button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderTop: "1px solid var(--border-light)", flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                            {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, visible.length)} / {visible.length}
                        </span>
                        <select className="input" style={{ width: "auto", padding: "5px 10px", fontSize: 12 }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n}/page</option>)}
                        </select>
                        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} disabled={safePage <= 1} onClick={() => setPage(1)}>«</button>
                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
                            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 90, textAlign: "center" }}>Page {safePage} / {totalPages}</span>
                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next ›</button>
                            <button className="btn-ghost" style={{ padding: "5px 10px", fontSize: 12 }} disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>»</button>
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
                    onConfirm={doAction}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
