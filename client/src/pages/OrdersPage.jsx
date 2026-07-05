import { useState, useEffect, useCallback } from "react";
import api from "../api/client";
import ConfirmModal from "../components/ConfirmModal";

const money = (n) => (typeof n === "number" ? n.toLocaleString("vi-VN") + "đ" : "—");

const STATUS = {
    pending:   { label: "Đang chờ",   color: "var(--warning)", bg: "var(--warning-bg)", border: "var(--warning-border)" },
    completed: { label: "Hoàn thành", color: "var(--success)", bg: "var(--success-bg)", border: "var(--success-border)" },
    cancelled: { label: "Đã hủy",     color: "var(--danger)",  bg: "var(--danger-bg)",  border: "var(--danger-border)" },
};
const st = (s) => STATUS[s] || { label: s || "—", color: "var(--text-muted)", bg: "var(--bg-input)", border: "var(--border)" };

const SELLERS = [
    { id: "all", label: "Tất cả seller" },
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
            setError(err.response?.data?.error || "Không kết nối được ArnTo-Shop");
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
            alert(err.response?.data?.error || `Không thể ${action === "done" ? "hoàn thành" : "hủy"} đơn`);
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

    return (
        <div className="fade-in page" style={{ maxWidth: 1400, display: "flex", flexDirection: "column", gap: 20 }}>
            <div>
                <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Đơn hàng (ArnTo-Shop)</h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>Xem và xử lý đơn hàng từ bot ArnTo-Shop.</p>
            </div>

            {error && (
                <div style={{ padding: "12px 16px", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger)", border: "1px solid var(--danger-border)", fontSize: 13 }}>{error}</div>
            )}

            {/* Stats */}
            {stats && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                    <StatCard label="Tổng đơn" value={stats.total} color="var(--accent)" />
                    <StatCard label="Đang chờ" value={stats.pending} color="var(--warning)" />
                    <StatCard label="Hoàn thành" value={stats.completed} color="var(--success)" />
                    <StatCard label="Đã hủy" value={stats.cancelled} color="var(--danger)" />
                    <StatCard label="Doanh thu" value={money(stats.revenue)} color="#a78bfa" />
                </div>
            )}

            {/* Filters */}
            <div className="card" style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 340 }}>
                    <input className="input" placeholder="Tìm mã đơn, tên, khách…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
                <div className="tab-bar">
                    {["all", "pending", "completed", "cancelled"].map((f) => (
                        <button key={f} className={`tab-item ${statusFilter === f ? "active" : ""}`} onClick={() => setStatusFilter(f)}>
                            {f === "all" ? "Tất cả" : st(f).label}
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
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Đang tải…</p>
            ) : visible.length === 0 ? (
                <div className="card" style={{ padding: "48px 24px", textAlign: "center", color: "var(--text-dim)", fontSize: 14, borderStyle: "dashed" }}>
                    Không có đơn hàng nào khớp.
                </div>
            ) : (
                <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                    <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 720 }}>
                            <thead>
                                <tr style={{ background: "var(--bg-input)", textAlign: "left" }}>
                                    {["Mã đơn", "Sản phẩm", "Khách", "Seller", "Giá", "Ngày", "Trạng thái", ""].map((h) => (
                                        <th key={h} style={{ padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {visible.map((o) => {
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
                                                            {busy === o.orderId ? "…" : "Hoàn thành"}
                                                        </button>
                                                        <button className="btn-ghost" style={{ padding: "4px 10px", fontSize: 12, color: "var(--danger)" }} disabled={busy === o.orderId} onClick={() => setConfirm({ order: o, action: "cancel" })}>
                                                            Hủy
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
                </div>
            )}

            {confirm && (
                <ConfirmModal
                    title={confirm.action === "done" ? `Hoàn thành đơn "${confirm.order.orderId}"?` : `Hủy đơn "${confirm.order.orderId}"?`}
                    message={
                        confirm.action === "done"
                            ? `Sản phẩm: ${confirm.order.name}\nGiá: ${money(confirm.order.price)}\n\nBot sẽ DM khách, gửi thông báo vào ticket, cộng chi tiêu và gán role buyer — y như bấm ✅ trên Discord.`
                            : `Sản phẩm: ${confirm.order.name}\n\nBot sẽ DM khách báo hủy và gửi thông báo vào ticket — y như bấm ❌ trên Discord.`
                    }
                    confirmText={confirm.action === "done" ? "Hoàn thành" : "Hủy đơn"}
                    onConfirm={doAction}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </div>
    );
}
