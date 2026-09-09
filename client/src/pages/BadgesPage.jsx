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
    paid:          { label: "Đã thanh toán", color: "var(--text-muted)" },
    verifying:     { label: "Đang kiểm tra", color: "var(--accent)" },
    sending:       { label: "Đang gửi",      color: "var(--accent)" },
    sent:          { label: "Đã gửi",        color: "#3b82f6" },
    verified:      { label: "Hoàn tất",      color: "var(--success)" },
    verify_failed: { label: "Xác minh hụt",  color: "var(--warning)" },
    manual_review: { label: "Chờ duyệt",     color: "var(--warning)" },
    forfeited:     { label: "Tịch thu",      color: "var(--danger)" },
    refund_due:    { label: "Cần hoàn tiền", color: "var(--danger)" },
    token_dead:    { label: "Token chết",    color: "var(--danger)" },
    error:         { label: "Lỗi",           color: "var(--danger)" },
};

const fmtTime = (ts) => {
    if (!ts) return "—";
    try {
        return new Date(ts).toLocaleString("vi-VN", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
        });
    } catch {
        return "—";
    }
};

const fmtNum = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("vi-VN") : "—");
const unitVi = (u) => (u === "hours" ? "giờ" : "game");

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
                                không Nitro
                            </span>
                        )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                        {order.badgeKey === "game_time" ? "Game Time" : "Game Variety"} ·{" "}
                        <strong style={{ color: "var(--text)" }}>{order.tierName}</strong> ·{" "}
                        {fmtNum(order.threshold)} {unitVi(order.unit)} · {fmtNum(order.price)}đ
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                        khai {fmtNum(order.declaredValue)} · đọc được{" "}
                        <strong style={{ color: order.measuredValue === null ? "var(--text-dim)" : "var(--text-muted)" }}>
                            {fmtNum(order.measuredValue)}
                        </strong>
                        {order.measuredSource ? ` (${order.measuredSource})` : ""} · tạo {fmtTime(order.createdAt)}
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
                            xác minh {fmtTime(order.verifyAfter)}
                        </div>
                    )}
                    {order.status === "verified" && (
                        <div style={{ fontSize: 11, color: "var(--success)" }}>
                            {fmtNum(order.finalValue)} {unitVi(order.unit)}
                        </div>
                    )}
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {order.status === "manual_review" && (
                        <>
                            <Btn tone="primary" disabled={busy} onClick={() => onAction(order.orderId, "retry")}>
                                Chạy lại
                            </Btn>
                            <Btn tone="danger" disabled={busy} onClick={() => onAction(order.orderId, "forfeit")}>
                                Tịch thu
                            </Btn>
                            <Btn disabled={busy} onClick={() => onAction(order.orderId, "cancel")}>
                                Hoàn tiền
                            </Btn>
                        </>
                    )}
                    {(order.status === "sent" || order.status === "verify_failed") && (
                        <Btn disabled={busy} onClick={() => onAction(order.orderId, "verify")}>
                            Xác minh ngay
                        </Btn>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Pool reader ──────────────────────────────────────────────────────────────────

const READER_STATUS = {
    ok:        { label: "Hoạt động",     color: "var(--success)" },
    no_nitro:  { label: "Hết Nitro",     color: "var(--warning)" },
    dead:      { label: "Token chết",    color: "var(--danger)" },
    unknown:   { label: "Chưa kiểm tra", color: "var(--text-dim)" },
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
                            ? `${pool.healthy}/${pool.total} dùng được`
                            : "đang tải…"}
                        {pool && !pool.ok ? ` — ${pool.reason}` : ""}
                    </span>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                    <Btn disabled={busy || !readers.length} onClick={() => onAction(null, "verify-all")}>
                        Kiểm tra tất cả
                    </Btn>
                    <Btn tone="primary" onClick={() => setOpen((v) => !v)}>
                        {open ? "Đóng" : "Thêm reader"}
                    </Btn>
                </div>
            </div>

            {!pool?.ok && (
                <div style={{ fontSize: 11, color: "var(--warning)", marginBottom: 12 }}>
                    Không còn reader khoẻ — mọi đơn của khách <strong>không Nitro</strong> sẽ treo ở
                    "Chờ duyệt". Đơn của khách có Nitro vẫn chạy bình thường (đọc bằng token của họ).
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
                            Token (tài khoản phải có Nitro)
                        </div>
                        <input
                            type="password"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="Dán token Discord"
                            style={{
                                background: "var(--bg-input)", border: "1px solid var(--border)",
                                borderRadius: 8, padding: "8px 10px", color: "var(--text)",
                                fontSize: 13, outline: "none", width: "100%",
                            }}
                        />
                    </div>
                    <div style={{ flex: "1 1 140px" }}>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                            Tên gợi nhớ (tuỳ chọn)
                        </div>
                        <input
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                            placeholder="vd: acc chính"
                            style={{
                                background: "var(--bg-input)", border: "1px solid var(--border)",
                                borderRadius: 8, padding: "8px 10px", color: "var(--text)",
                                fontSize: 13, outline: "none", width: "100%",
                            }}
                        />
                    </div>
                    <Btn tone="primary" disabled={busy || !token.trim()} onClick={submit}>
                        Thêm
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
                                {r.uses ?? 0} lượt đọc · {r.failures ?? 0} lỗi
                                {r.lastUsedAt ? ` · dùng lần cuối ${fmtTime(r.lastUsedAt)}` : ""}
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
                                    đang nghỉ tới {fmtTime(r.cooldownUntil)}
                                </div>
                            )}
                            {!r.enabled && (
                                <div style={{ fontSize: 11, color: "var(--text-dim)" }}>đã tắt</div>
                            )}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                            <Btn disabled={busy} onClick={() => onAction(r.id, "verify")}>
                                Kiểm tra
                            </Btn>
                            <Btn
                                disabled={busy}
                                onClick={() => onAction(r.id, r.enabled ? "disable" : "enable")}
                            >
                                {r.enabled ? "Tắt" : "Bật"}
                            </Btn>
                            <Btn tone="danger" disabled={busy} onClick={() => onAction(r.id, "remove")}>
                                Xoá
                            </Btn>
                        </div>
                    </div>
                );
            })}

            {!readers.length && !open && (
                <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    Chưa có reader nào. Thêm ít nhất một tài khoản có Nitro để đọc được tiến độ badge
                    của khách không Nitro.
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
            if (action === "verify") await api.post(`/badges/${orderId}/verify`);
            else await api.post(`/badges/${orderId}/resolve`, { action });
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
                    Đơn hàng badge. Thanh toán nằm ở ArnTo-Auto; panel đọc tiến độ thật, gửi
                    /science rồi xác minh lại sau ~26 giờ.
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

            {/* Pool reader — hết reader khoẻ là mù với khách không Nitro, để ngay đầu trang */}
            <ReaderPool pool={pool} onAdd={onReaderAdd} onAction={onReaderAction} busy={busy} />

            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                {["", "manual_review", "sent", "verified", "forfeited"].map((s) => (
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
                        {s === "" ? "Tất cả" : (STATUS[s]?.label ?? s)}
                        {s === "manual_review" && pending > 0 ? ` (${pending})` : ""}
                    </button>
                ))}
            </div>

            <Card>
                {orders.length === 0 ? (
                    <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "8px 0" }}>
                        Chưa có đơn nào.
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
