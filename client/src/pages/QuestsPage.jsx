import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import api from "../api/client";
import useQuestStream from "../hooks/useQuestStream";
import QuestControl from "../components/QuestControl";
import { EmptyState, Icon, PageHeader, StatCard, StatusBadge, Toggle } from "../components/ui";

// ── Shared status metadata (English) ─────────────────────────────────────────
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
        return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    } catch {
        return "—";
    }
};

// Single-quest accounts are erased one week after their run (token, progress, owner
// link — everything). A monthly subscriber lives as long as the plan, then gets the
// same one-week window to renew before it is erased too.
const retentionText = (a) => {
    const until =
        a.mode === "monthly" ? (a.status === "expired" ? a.purgeAt : null) : a.retentionExpiresAt;
    if (!until) return null;
    const left = until - Date.now();
    if (left <= 0) return "erasing…";
    const d = Math.floor(left / 86400000);
    return d >= 1 ? `erased in ${d}d` : `erased in ${Math.max(1, Math.ceil(left / 3600000))}h`;
};

const modeLabel = (a) =>
    a.mode === "monthly"
        ? "Monthly plan"
        : a.mode === "all"
          ? "All quests"
          : `${a.selectedQuestIds?.length || 0} quest(s)`;

// ── Sub-components ────────────────────────────────────────────────────────────
function StatusPill({ status }) {
    const st = STATUS[status] || { label: status, color: "var(--text-dim)" };
    return <StatusBadge color={st.color}>{st.label}</StatusBadge>;
}

/**
 * Egress menu — which IPs auto quest runs through.
 *
 * The panel used to hardcode "every VPS node is a proxy"; these switches replace
 * that. Proxies you supply are managed on /proxies; this menu only decides which
 * sources are in play, so the two pages never disagree about the same setting.
 */
function EgressMenu() {
    const [pool, setPool] = useState(null);
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/proxies/settings/quest");
            setPool(data);
        } catch (e) {
            setErr(e.response?.data?.error || "Could not load egress settings.");
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const save = async (patch) => {
        setSaving(true);
        setErr(null);
        try {
            const { data } = await api.patch("/proxies/settings/quest", patch);
            setPool(data);
        } catch (e) {
            setErr(e.response?.data?.error || "Could not save.");
        } finally {
            setSaving(false);
        }
    };

    const summary = !pool
        ? "…"
        : pool.activeSource === "proxy"
          ? `${pool.activeCount} custom proxy(ies)`
          : pool.activeSource === "node"
            ? `${pool.activeCount} VPS node(s)`
            : "panel IP (no proxy)";

    const Switch = ({ label, hint, field, count }) => (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--border-light)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                    {label} <span style={{ color: "var(--text-dim)", fontWeight: 500 }}>({count})</span>
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--text-muted)" }}>{hint}</p>
            </div>
            <Toggle
                checked={!!pool.settings[field]}
                disabled={saving}
                onChange={(on) => save({ [field]: on })}
                title={label}
            />
        </div>
    );

    return (
        <div style={{ marginBottom: 20 }}>
            <button
                onClick={() => setOpen((o) => !o)}
                className="btn-ghost"
                aria-expanded={open}
            >
                <Icon name="globe" /> Egress: {summary}
                <Icon name={open ? "chevronDown" : "chevronRight"} size={14} style={{ color: "var(--text-dim)" }} />
            </button>

            {open && pool && (
                <div className="card" style={{ marginTop: 10, padding: 18, maxWidth: 560 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
                        Which IPs quest traffic leaves from. With both on, one source is used and the
                        other is the fallback — unless you pick “Mix”.
                    </p>

                    <Switch
                        label="My proxies"
                        hint="Proxies registered on the Proxy Pool page."
                        field="useCustomProxies"
                        count={pool.customProxies.length}
                    />
                    <Switch
                        label="VPS nodes as proxy"
                        hint="Every enabled agent node doubles as an egress IP."
                        field="useNodes"
                        count={pool.nodes.length}
                    />

                    <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 12, borderTop: "1px solid var(--border-light)" }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>
                            Order
                        </span>
                        <select
                            className="input"
                            style={{ width: 180 }}
                            value={pool.settings.priority}
                            disabled={saving}
                            onChange={(e) => save({ priority: e.target.value })}
                        >
                            <option value="custom">My proxies first</option>
                            <option value="nodes">VPS nodes first</option>
                            <option value="mixed">Mix both</option>
                        </select>
                    </div>

                    {err && <p style={{ fontSize: 12, color: "var(--danger)", margin: "10px 0 0" }}>{err}</p>}

                    <p style={{ margin: "14px 0 0", fontSize: 12 }}>
                        <Link to="/proxies" style={{ color: "var(--accent-hover)", display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
                            Manage proxies <Icon name="arrowRight" size={14} />
                        </Link>
                    </p>
                </div>
            )}
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
                        style={{ width: 34, height: 34, borderRadius: 8, background: "var(--bg-input)", border: "1px solid var(--border)", color: "var(--text-muted)", display: "grid", placeItems: "center", flexShrink: 0 }}
                    >
                        <Icon name="gamepad" />
                    </span>
                    <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {a.username}
                        </p>
                        <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6 }}>
                            {a.mode === "monthly" && <Icon name="infinity" size={12} />}
                            {modeLabel(a)}
                            {a.ref && (
                                <span title="Owner linked" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    · <Icon name="user" size={12} />
                                </span>
                            )}
                            {retentionText(a) && (
                                <span title="Data is kept for 1 week, then deleted (a monthly plan's week starts when it expires)" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                                    · <Icon name="clock" size={12} /> {retentionText(a)}
                                </span>
                            )}
                        </p>
                    </div>
                </div>
                <StatusPill status={a.status} />
                <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{progressText}</span>
                <Icon name="chevronRight" style={{ color: "var(--text-dim)" }} />
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

    // Admin manual add — paste a token and assign its owner, bypassing arnto-auto.
    const [showAdd, setShowAdd] = useState(false);
    const [ownerId, setOwnerId] = useState("");
    const [token, setToken] = useState("");
    const [mode, setMode] = useState("all"); // "all" | "monthly"
    const [months, setMonths] = useState(1);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    const submitAdd = async () => {
        const owner = ownerId.trim();
        if (!/^\d{17,20}$/.test(owner)) {
            setMsg({ ok: false, text: "Owner ID must be a Discord user ID (17–20 digits)." });
            return;
        }
        if (!token.trim()) {
            setMsg({ ok: false, text: "Token is required." });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            await api.post("/quests/start", {
                token: token.trim(),
                ref: owner,
                mode,
                ...(mode === "monthly" ? { months: Number(months) || 1 } : {}),
            });
            setToken("");
            setOwnerId("");
            setMsg({
                ok: true,
                text: mode === "monthly" ? "Monthly plan activated." : "Started running quests.",
            });
            reload();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || "Failed." });
        } finally {
            setBusy(false);
        }
    };

    const runningCount = accounts.filter((a) => a.status === "running").length;
    const waitingCount = accounts.filter((a) => a.status === "paused").length;
    const monthlyCount = accounts.filter((a) => a.mode === "monthly").length;
    const doneCount = accounts.filter((a) => a.status === "done").length;

    return (
        <div className="page fade-in" style={{ maxWidth: 1100 }}>
            {/* ── Page title ── */}
            <div style={{ marginBottom: 24 }}>
                <PageHeader
                    title="Auto Quest"
                    description="Monitor every account running quests. Click an account to inspect its quests. Single-quest accounts are erased 1 week after their run — token, progress and owner link included."
                />
            </div>

            {/* ── Scheduler: pause, run now, schedule ── */}
            <QuestControl
                runningCount={accounts.filter((a) => a.status === "running" && a.mode !== "monthly").length}
                waitingCount={waitingCount}
                onChanged={reload}
            />

            {/* ── Egress (which IPs quest traffic uses) ── */}
            <EgressMenu />

            {/* ── Stat row ── */}
            <div className="stat-grid" style={{ marginBottom: 24 }}>
                <StatCard label="Accounts" value={accounts.length} hint="total tracked" />
                <StatCard label="Running" value={runningCount} tone="accent" hint="active now" />
                <StatCard label="Monthly" value={monthlyCount} tone="var(--violet)" hint="subscriptions" />
                <StatCard label="Completed" value={doneCount} tone="success" hint="finished runs" />
            </div>

            {/* ── Account list ── */}
            {accounts.length === 0 ? (
                <EmptyState icon="quests" title="No accounts yet" description="Accounts appear here once a user starts a quest run." />
            ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {accounts.map((a) => (
                        <AccountRow key={a.accountId} a={a} live={live} onOpen={() => navigate(`/quests/${a.accountId}`)} />
                    ))}
                </div>
            )}

            {/* ── Manual add (admin) ── */}
            <div style={{ marginTop: 28 }}>
                <button
                    onClick={() => setShowAdd((s) => !s)}
                    aria-expanded={showAdd}
                    style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 12, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                    <Icon name={showAdd ? "chevronDown" : "chevronRight"} size={14} /> Add account manually
                </button>
                {showAdd && (
                    <div className="card" style={{ marginTop: 10, padding: 18, display: "flex", flexDirection: "column", gap: 14, maxWidth: 480 }}>
                        <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
                            Paste a Discord token and assign its owner, bypassing the bot. The owner ID is
                            stored so the bot can identify whose token this is (and DM them) — it is never
                            shown in the account list.
                        </p>

                        <div className="form-group">
                            <label className="label">Owner Discord user ID</label>
                            <input
                                className="input"
                                inputMode="numeric"
                                placeholder="e.g. 123456789012345678"
                                value={ownerId}
                                onChange={(e) => setOwnerId(e.target.value)}
                            />
                        </div>

                        <div className="form-group">
                            <label className="label">Discord token</label>
                            <input
                                className="input"
                                type="password"
                                placeholder="Token"
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                            />
                        </div>

                        <div className="form-group">
                            <label className="label">Mode</label>
                            <div className="tab-bar" style={{ display: "inline-flex", alignSelf: "flex-start" }}>
                                <button type="button" className={`tab-item${mode === "all" ? " active" : ""}`} onClick={() => setMode("all")}>
                                    Run all now
                                </button>
                                <button type="button" className={`tab-item${mode === "monthly" ? " active" : ""}`} onClick={() => setMode("monthly")}>
                                    Monthly plan
                                </button>
                            </div>
                        </div>

                        {mode === "monthly" && (
                            <div className="form-group" style={{ maxWidth: 140 }}>
                                <label className="label">Months</label>
                                <input
                                    className="input"
                                    type="number"
                                    min={1}
                                    value={months}
                                    onChange={(e) => setMonths(e.target.value)}
                                />
                            </div>
                        )}

                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <button type="button" className="btn-primary" disabled={busy} onClick={submitAdd}>
                                {busy ? "Working…" : mode === "monthly" ? "Activate monthly" : "Add & run"}
                            </button>
                            {msg && (
                                <span style={{ fontSize: 12.5, color: msg.ok ? "var(--success)" : "var(--danger)" }}>{msg.text}</span>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
