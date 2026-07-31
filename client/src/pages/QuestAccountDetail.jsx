import { useNavigate, useParams, Link } from "react-router-dom";
import api from "../api/client";
import useQuestStream from "../hooks/useQuestStream";
import QuestCard from "../components/QuestCard";

const STATUS = {
    running: { label: "Đang chạy", color: "#3b82f6" },
    done: { label: "Đã xong", color: "#22c55e" },
    stopped: { label: "Đã dừng", color: "#9ca3af" },
    token_dead: { label: "Token lỗi", color: "#f59e0b" },
    error: { label: "Lỗi", color: "#ef4444" },
};
const btn = (bg) => ({
    padding: "7px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: bg,
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
});

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: 14,
    marginTop: 16,
};

export default function QuestAccountDetail() {
    const { accountId } = useParams();
    const navigate = useNavigate();
    const { accounts, live } = useQuestStream();

    const a = accounts.find((x) => x.accountId === accountId);
    const quests = Object.entries(live[accountId] || {});
    const st = a ? STATUS[a.status] || { label: a.status, color: "#9ca3af" } : null;

    const stop = () => api.post(`/quests/${accountId}/stop`).catch(() => {});
    const remove = () =>
        api
            .delete(`/quests/${accountId}`)
            .then(() => navigate("/quests"))
            .catch(() => {});

    return (
        <div style={{ padding: 20, maxWidth: 1000, margin: "0 auto" }}>
            <Link
                to="/quests"
                style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}
            >
                ‹ Danh sách account
            </Link>

            {!a ? (
                <p style={{ marginTop: 20, color: "var(--text-dim)" }}>Đang tải account…</p>
            ) : (
                <>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            marginTop: 14,
                            flexWrap: "wrap",
                        }}
                    >
                        <h1 style={{ fontSize: 22 }}>{a.username}</h1>
                        <span
                            style={{
                                fontSize: 12,
                                padding: "2px 10px",
                                borderRadius: 20,
                                background: st.color + "22",
                                color: st.color,
                            }}
                        >
                            {st.label}
                        </span>
                        <span style={{ flex: 1 }} />
                        {a.status === "running" && (
                            <button style={btn("#6b7280")} onClick={stop}>
                                Dừng
                            </button>
                        )}
                        <button style={btn("#ef4444")} onClick={remove}>
                            Xoá
                        </button>
                    </div>

                    <div style={{ display: "flex", gap: 20, marginTop: 8, fontSize: 13, color: "var(--text-muted)" }}>
                        <span>ID: <code style={{ color: "var(--text)" }}>{a.accountId}</code></span>
                        <span>Chế độ: {a.mode === "all" ? "Chạy tất cả" : `${a.selectedQuestIds.length} quest đã chọn`}</span>
                        <span>Đã hoàn thành: {a.completedCount}</span>
                    </div>
                    {a.error && (
                        <p style={{ fontSize: 13, color: "#f59e0b", marginTop: 8 }}>{a.error}</p>
                    )}

                    <h2 style={{ fontSize: 16, marginTop: 22 }}>Quest ({quests.length})</h2>
                    {quests.length === 0 ? (
                        <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 8 }}>
                            Chưa có quest nào đang chạy (hoặc đang chờ enroll).
                        </p>
                    ) : (
                        <div style={gridStyle}>
                            {quests.map(([qid, q]) => (
                                <QuestCard key={qid} q={{ ...q, id: qid }} progress={q} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
