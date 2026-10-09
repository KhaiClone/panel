import { useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import api from "../api/client";
import { EmptyState, Icon, Notice, PageHeader, StatCard, StatusBadge } from "../components/ui";
import useQuestStream from "../hooks/useQuestStream";
import QuestCard from "../components/QuestCard";

const STATUS = {
    running: { label: "Running", color: "var(--accent)" },
    paused: { label: "Paused", color: "var(--info)" },
    done: { label: "Completed", color: "var(--success)" },
    stopped: { label: "Stopped", color: "var(--text-dim)" },
    token_dead: { label: "Token error", color: "var(--warning)" },
    error: { label: "Error", color: "var(--danger)" },
    monthly: { label: "Monthly", color: "var(--violet)" },
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
};

export default function QuestAccountDetail() {
    const { accountId } = useParams();
    const navigate = useNavigate();
    const { accounts, live, reload } = useQuestStream();
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    const a = accounts.find((x) => x.accountId === accountId);
    const quests = Object.entries(live[accountId] || {});
    const st = a ? STATUS[a.status] || { label: a.status, color: "var(--text-dim)" } : null;

    const doneCount = quests.filter(([, q]) => q.state === "done").length;

    const stop = () => api.post(`/quests/${accountId}/stop`).catch(() => {});
    const runAgain = async () => {
        setBusy(true);
        setMsg(null);
        try {
            // Single account: relaunch from its stored token. Monthly: a pass for this account only.
            if (a.mode === "monthly") await api.post("/quests/control/run", { accountId });
            else await api.post(`/quests/${accountId}/resume`);
            setMsg({ ok: true, text: a.mode === "monthly" ? "Monthly run started." : "Started again." });
            reload();
        } catch (e) {
            setMsg({ ok: false, text: e.response?.data?.error || "Failed." });
        } finally {
            setBusy(false);
        }
    };
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

    const back = (
        <Link to="/quests" className="btn-ghost btn-icon" title="Back to accounts" style={{ marginTop: 1 }}>
            <Icon name="chevronLeft" />
        </Link>
    );

    if (!a) {
        return (
            <div className="page fade-in" style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 20 }}>
                {back}
                <div className="card" style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                    Loading account…
                </div>
            </div>
        );
    }

    return (
        <div className="page fade-in" style={{ maxWidth: 1100, display: "flex", flexDirection: "column", gap: 20 }}>
            {/* ── Header ── */}
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                {back}
                <div className="min-w-0" style={{ flex: 1 }}>
                    <PageHeader
                        title={a.username}
                        description={
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                <StatusBadge color={st.color}>{st.label}</StatusBadge>
                                <span className="mono" style={{ color: "var(--text-dim)" }}>{a.accountId}</span>
                            </span>
                        }
                        actions={
                            <>
                                {/* A monthly account runs inside the shared pass — stop that from /quests. */}
                                {a.status === "running" && a.mode !== "monthly" && (
                                    <button className="btn-warning" onClick={stop}>
                                        <Icon name="pause" /> Stop
                                    </button>
                                )}
                                {(a.mode === "monthly"
                                    ? a.status === "monthly"
                                    : ["stopped", "error", "token_dead", "done"].includes(a.status)) && (
                                    <button className="btn-success" disabled={busy} onClick={runAgain}>
                                        <Icon name="play" /> {a.mode === "monthly" ? "Run now" : "Run again"}
                                    </button>
                                )}
                                <button className="btn-danger" onClick={remove}>
                                    <Icon name="trash" /> Remove
                                </button>
                            </>
                        }
                    />
                </div>
            </div>

            {msg && <Notice tone={msg.ok ? "success" : "danger"}>{msg.text}</Notice>}
            {a.error && <Notice tone="warning">{a.error}</Notice>}

            <div className="stat-grid">
                <StatCard label="Mode" value={modeText} />
                <StatCard label="Completed" value={a.completedCount ?? 0} />
                {a.mode === "monthly" && a.monthlyExpiresAt && (
                    <StatCard label="Expires" value={fmtDate(a.monthlyExpiresAt)} />
                )}
                {a.mode !== "monthly" && a.retentionExpiresAt && (
                    <StatCard label="Data erased" value={fmtDate(a.retentionExpiresAt)} />
                )}
                {a.mode === "monthly" && a.status === "expired" && a.purgeAt && (
                    <StatCard label="Data erased" value={fmtDate(a.purgeAt)} />
                )}
            </div>

            {/* ── Quests ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", margin: 0 }}>Quests</h2>
                    <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                        {quests.length > 0 ? `${doneCount}/${quests.length} completed` : "none"}
                    </span>
                </div>

                {quests.length === 0 ? (
                    <EmptyState icon="hourglass" title="No quests running yet" description="The account may still be enrolling." />
                ) : (
                    <div style={gridStyle}>
                        {quests.map(([qid, q]) => (
                            <QuestCard key={qid} q={{ ...q, id: qid }} progress={q} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
