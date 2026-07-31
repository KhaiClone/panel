import { useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../api/client";
import useQuestStream from "../hooks/useQuestStream";

// ── Shared status metadata (English) ─────────────────────────────────────────
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
        return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } catch {
        return "—";
    }
};

const modeLabel = (a) =>
    a.mode === "monthly"
        ? "♾️ Monthly plan"
        : a.mode === "all"
          ? "All quests"
          : `${a.selectedQuestIds?.length || 0} quest(s)`;

// ── Sub-components ────────────────────────────────────────────────────────────
function StatusPill({ status }) {
    const st = STATUS[status] || { label: status, color: "var(--text-dim)" };
    return (
        <span
            className="status-pill"
            style={{ background: st.color + "22", color: st.color, border: `1px solid ${st.color}33` }}
        >
            <span className="status-dot" style={{ background: st.color }} />
            {st.label}
        </span>
    );
}

function StatCard({ icon, label, value, sub, color = "var(--accent)" }) {
    return (
        <div
            className="card"
            style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 10, position: "relative", overflow: "hidden" }}
        >
            <div style={{ position: "absolute", top: -20, right: -10, width: 80, height: 80, background: color, opacity: 0.07, filter: "blur(20px)", borderRadius: "50%", pointerEvents: "none" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
                <span style={{ fontSize: 18, color }}>{icon}</span>
            </div>
            <p style={{ fontSize: 28, fontWeight: 800, color: "#fff", margin: 0, lineHeight: 1 }}>{value}</p>
            {sub && <p style={{ fontSize: 12, color: "var(--text-dim)", margin: 0 }}>{sub}</p>}
        </div>
    );
}

function AccountRow({ a, live, onOpen }) {
    const qs = live[a.accountId] || {};
    const total = Object.keys(qs).length;
    const done = Object.values(qs).filter((q) => q.state === "done").length;
    const pct = total > 0 ? Math.round((done / total) * 100) : null;

    const progressText =
        a.mode === "monthly"
            ? `Expires ${fmtDate(a.monthlyExpiresAt)}`
            : total > 0
              ? `${done}/${total} quests`
              : `${a.completedCount || 0} completed`;

    return (
        <div
            className="card card-hover"
            onClick={onOpen}
            style={{ padding: "14px 16px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 10 }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                    <span
                        style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg-input)", border: "1px solid var(--border)", display: "grid", placeItems: "center", fontSize: 15, flexShrink: 0 }}
                    >
                        🎮
                    </span>
                    <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.username}
                        </p>
                        <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-dim)" }}>{modeLabel(a)}</p>
                    </div>
                </div>
                <StatusPill status={a.status} />
                <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{progressText}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 18 }}>›</span>
            </div>

            {pct !== null && (
                <div style={{ height: 5, borderRadius: 4, background: "var(--bg-input)", overflow: "hidden" }}>
                    <div
                        style={{
                            height: "100%",
                            width: `${pct}%`,
                            background: pct === 100 ? "var(--success)" : "var(--accent)",
                            transition: "width .3s",
                        }}
                    />
                </div>
            )}
        </div>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function QuestsPage() {
    const { accounts, live, reload } = useQuestStream();
    const navigate = useNavigate();

    // Temporary manual add-token (admin). Collapsed by default — the panel's main
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
            setMsg({ ok: true, text: "Started." });
            reload();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || "Failed." });
        } finally {
            setBusy(false);
        }
    };

    const runningCount = accounts.filter((a) => a.status === "running").length;
    const monthlyCount = accounts.filter((a) => a.mode === "monthly").length;
    const doneCount = accounts.filter((a) => a.status === "done").length;

    return (
        <div className="page fade-in" style={{ maxWidth: 1100 }}>
            {/* ── Page title ── */}
            <div style={{ marginBottom: 24 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", margin: "0 0 4px", letterSpacing: "-0.02em" }}>
                    Auto Quest
                </h1>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                    Monitor every account running quests. Click an account to inspect its quests.
                </p>
            </div>

            {/* ── Stat row ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14, marginBottom: 24 }}>
                <StatCard icon="📦" label="Accounts" value={accounts.length} color="var(--accent)" sub="total tracked" />
                <StatCard icon="▶️" label="Running" value={runningCount} color="var(--success)" sub="active now" />
                <StatCard icon="♾️" label="Monthly" value={monthlyCount} color="#a78bfa" sub="subscriptions" />
                <StatCard icon="✅" label="Completed" value={doneCount} color="#22c55e" sub="finished runs" />
            </div>

            {/* ── Account list ── */}
            {accounts.length === 0 ? (
                <div className="card" style={{ padding: "40px 20px", textAlign: "center" }}>
                    <p style={{ fontSize: 26, margin: "0 0 8px" }}>🕹️</p>
                    <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0, fontWeight: 600 }}>No accounts yet</p>
                    <p style={{ color: "var(--text-dim)", fontSize: 12.5, margin: "4px 0 0" }}>
                        Accounts appear here once a user starts a quest run.
                    </p>
                </div>
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {accounts.map((a) => (
                        <AccountRow key={a.accountId} a={a} live={live} onOpen={() => navigate(`/quests/${a.accountId}`)} />
                    ))}
                </div>
            )}

            {/* ── Temporary manual add ── */}
            <div style={{ marginTop: 28 }}>
                <button
                    onClick={() => setShowAdd((s) => !s)}
                    style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 12, cursor: "pointer", padding: 0 }}
                >
                    {showAdd ? "▾" : "▸"} Add account manually (temporary)
                </button>
                {showAdd && (
                    <div className="card" style={{ marginTop: 10, padding: 16 }}>
                        <div className="mobile-stack" style={{ display: "flex", gap: 8 }}>
                            <input
                                className="input"
                                style={{ flex: 1 }}
                                type="password"
                                placeholder="Discord token"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                            />
                            <button className="btn-primary btn-full-mobile" disabled={busy || !token.trim()} onClick={runAll}>
                                {busy ? "Starting…" : "Run all"}
                            </button>
                        </div>
                        {msg && (
                            <p style={{ marginTop: 8, fontSize: 12, color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</p>
                        )}
                        <p style={{ marginTop: 8, fontSize: 11, color: "var(--text-dim)" }}>
                            In production, the token and quest run are triggered by arnto-auto via the panel API after payment.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
