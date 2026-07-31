import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import useQuestStream from "../hooks/useQuestStream";

const STATUS = {
    running: { label: "Đang chạy", color: "#3b82f6" },
    done: { label: "Đã xong", color: "#22c55e" },
    stopped: { label: "Đã dừng", color: "#9ca3af" },
    token_dead: { label: "Token lỗi", color: "#f59e0b" },
    error: { label: "Lỗi", color: "#ef4444" },
};

const btn = (bg, extra = {}) => ({
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: bg,
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    ...extra,
});

function StatusBadge({ status }) {
    const st = STATUS[status] || { label: status, color: "#9ca3af" };
    return (
        <span
            style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 20,
                background: st.color + "22",
                color: st.color,
                whiteSpace: "nowrap",
            }}
        >
            {st.label}
        </span>
    );
}

export default function QuestsPage() {
    const { accounts, live, reload } = useQuestStream();
    const navigate = useNavigate();

    // Temporary add-token (admin manually). Collapsed by default — the panel's main
    // role now is monitoring; token/run will come from arnto-auto via the API.
    const [showAdd, setShowAdd] = useState(false);
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    const runAll = async () => {
        if (!token.trim()) return;
        setBusy(true);
        setMsg(null);
        try {
            await api.post("/quests/start", { token: token.trim(), mode: "all" });
            setToken("");
            setMsg({ ok: true, text: "Đã bắt đầu." });
            reload();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || "Lỗi." });
        } finally {
            setBusy(false);
        }
    };

    const runningCount = accounts.filter((a) => a.status === "running").length;

    return (
        <div style={{ padding: 20, maxWidth: 1000, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
                <h1 style={{ fontSize: 22 }}>Auto Quest</h1>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                    {accounts.length} account · {runningCount} đang chạy
                </span>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
                Giám sát toàn bộ account đang chạy quest. Bấm một account để xem chi tiết các quest.
            </p>

            {/* Account list */}
            {accounts.length === 0 ? (
                <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Chưa có account nào.</p>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {accounts.map((a) => {
                        const qs = live[a.accountId] || {};
                        const total = Object.keys(qs).length;
                        const done = Object.values(qs).filter((q) => q.state === "done").length;
                        return (
                            <div
                                key={a.accountId}
                                onClick={() => navigate(`/quests/${a.accountId}`)}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 12,
                                    padding: "12px 14px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 10,
                                    cursor: "pointer",
                                    background: "var(--bg-card, transparent)",
                                }}
                            >
                                <span style={{ fontWeight: 600, minWidth: 120 }}>{a.username}</span>
                                <StatusBadge status={a.status} />
                                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                    {a.mode === "all" ? "Tất cả" : `${a.selectedQuestIds.length} quest`}
                                </span>
                                <span style={{ flex: 1 }} />
                                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                    {total > 0 ? `${done}/${total} quest` : `đã xong ${a.completedCount}`}
                                </span>
                                <span style={{ color: "var(--text-dim)", fontSize: 18 }}>›</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Temporary manual add */}
            <div style={{ marginTop: 28 }}>
                <button
                    onClick={() => setShowAdd((s) => !s)}
                    style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-dim)",
                        fontSize: 12,
                        cursor: "pointer",
                        padding: 0,
                    }}
                >
                    {showAdd ? "▾" : "▸"} Thêm account thủ công (tạm thời)
                </button>
                {showAdd && (
                    <div
                        style={{
                            marginTop: 10,
                            border: "1px solid var(--border)",
                            borderRadius: 10,
                            padding: 14,
                        }}
                    >
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                className="input"
                                style={{ flex: 1 }}
                                type="password"
                                placeholder="Token Discord"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                            />
                            <button style={btn("#22c55e")} disabled={busy || !token.trim()} onClick={runAll}>
                                Chạy tất cả
                            </button>
                        </div>
                        {msg && (
                            <p style={{ marginTop: 8, fontSize: 12, color: msg.ok ? "#22c55e" : "#ef4444" }}>
                                {msg.text}
                            </p>
                        )}
                        <p style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
                            Về sau token/chạy quest sẽ do arnto-auto gọi API panel sau khi thanh toán.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
