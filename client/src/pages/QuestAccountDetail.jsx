import { useNavigate, useParams, Link } from "react-router-dom";
import api from "../api/client";
import useQuestStream from "../hooks/useQuestStream";
import QuestCard from "../components/QuestCard";

const STATUS = {
    running: { label: "Running", color: "var(--accent)" },
    done: { label: "Completed", color: "var(--success)" },
    stopped: { label: "Stopped", color: "var(--text-dim)" },
    token_dead: { label: "Token error", color: "var(--warning)" },
    error: { label: "Error", color: "var(--danger)" },
    monthly: { label: "Monthly", color: "#a78bfa" },
    expired: { label: "Expired", color: "var(--text-dim)" },
};

const fmtDate = (iso) => {
    try {
        return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    } catch {
        return "—";
    }
};

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: 14,
    marginTop: 16,
};

function MetaItem({ label, children }) {
    return (
        <div>
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {label}
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{children}</p>
        </div>
    );
}

export default function QuestAccountDetail() {
    const { accountId } = useParams();
    const navigate = useNavigate();
    const { accounts, live } = useQuestStream();

    const a = accounts.find((x) => x.accountId === accountId);
    const quests = Object.entries(live[accountId] || {});
    const st = a ? STATUS[a.status] || { label: a.status, color: "var(--text-dim)" } : null;

    const doneCount = quests.filter(([, q]) => q.state === "done").length;

    const stop = () => api.post(`/quests/${accountId}/stop`).catch(() => {});
    const remove = () =>
        api
            .delete(`/quests/${accountId}`)
            .then(() => navigate("/quests"))
            .catch(() => {});

    const modeText =
        a?.mode === "all"
            ? "All quests"
            : a?.mode === "monthly"
              ? "Monthly plan"
              : `${a?.selectedQuestIds?.length || 0} selected`;

    return (
        <div className="page fade-in" style={{ maxWidth: 1100 }}>
            <Link to="/quests" className="btn-ghost" style={{ fontSize: 12.5, padding: "5px 12px" }}>
                ‹ Back to accounts
            </Link>

            {!a ? (
                <div className="card" style={{ marginTop: 16, padding: "40px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    Loading account…
                </div>
            ) : (
                <>
                    {/* ── Header card ── */}
                    <div className="card" style={{ marginTop: 16, padding: 20 }}>
                        <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                            <span
                                style={{ width: 46, height: 46, borderRadius: 12, background: "var(--bg-input)", border: "1px solid var(--border)", display: "grid", placeItems: "center", fontSize: 20, flexShrink: 0 }}
                            >
                                🎮
                            </span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                                <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--text)", margin: 0, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {a.username}
                                </h1>
                                <span
                                    className="status-pill"
                                    style={{ marginTop: 6, background: st.color + "22", color: st.color, border: `1px solid ${st.color}33` }}
                                >
                                    <span className="status-dot" style={{ background: st.color }} />
                                    {st.label}
                                </span>
                            </div>
                            <div className="mobile-wrap" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                {a.status === "running" && (
                                    <button className="btn-warning" onClick={stop}>
                                        ⏸ Stop
                                    </button>
                                )}
                                <button className="btn-danger" onClick={remove}>
                                    🗑 Remove
                                </button>
                            </div>
                        </div>

                        <div className="divider" />

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
                            <MetaItem label="Account ID">
                                <code className="mono" style={{ color: "var(--text)" }}>{a.accountId}</code>
                            </MetaItem>
                            <MetaItem label="Mode">{modeText}</MetaItem>
                            <MetaItem label="Completed">{a.completedCount ?? 0}</MetaItem>
                            {a.mode === "monthly" && a.monthlyExpiresAt && (
                                <MetaItem label="Expires">{fmtDate(a.monthlyExpiresAt)}</MetaItem>
                            )}
                        </div>

                        {a.error && (
                            <div
                                style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning)", fontSize: 12.5 }}
                            >
                                ⚠️ {a.error}
                            </div>
                        )}
                    </div>

                    {/* ── Quests ── */}
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 24 }}>
                        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>Quests</h2>
                        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                            {quests.length > 0 ? `${doneCount}/${quests.length} completed` : "none"}
                        </span>
                    </div>

                    {quests.length === 0 ? (
                        <div className="card" style={{ marginTop: 12, padding: "36px 20px", textAlign: "center" }}>
                            <p style={{ fontSize: 24, margin: "0 0 6px" }}>⏳</p>
                            <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
                                No quests running yet (or still enrolling).
                            </p>
                        </div>
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
