// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Overview: the panel process at a glance, one line per part
//  that can quietly break (each leading to the tab that fixes it), and its logs.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import api from "../../api/client";
import Section from "./Section";
import { fmtBytes, fmtUptime } from "./format";

// Icon beside the label rather than the value, so four fit a row — and two on a phone.
function StatCard({ icon, label, value, sub, accent = "var(--text)" }) {
    return (
        <div className="card" style={{ padding: "12px 14px", minWidth: 0 }}>
            <p style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px 0", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 13 }}>{icon}</span>{label}
            </p>
            <p style={{ fontSize: 18, fontWeight: 700, color: accent, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</p>
            {sub && <p style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</p>}
        </div>
    );
}

// ── Health checklist ─────────────────────────────────────────────────────────
// Reads the same endpoints the other tabs do; each check turns a response into
// { level, text }. Nothing here changes anything.

const LEVEL_ICON = { ok: "✅", warn: "⚠️", error: "❌", off: "⏸️", loading: "⏳" };
const LEVEL_COLOR = { ok: "var(--text-muted)", warn: "var(--warning)", error: "var(--danger)", off: "var(--text-dim)", loading: "var(--text-dim)" };

/** "5m", "2h 10m" — time since `at`, without the seconds. */
const ago = (at) => fmtUptime(at).replace(/m \d+s$/, "m");

/** Hours between scheduled backups, from backupService's "every hour" / "every N hours" text. */
const backupHours = (schedule) => Number(/every (\d+) hours/.exec(schedule || "")?.[1] || 1);

const backupCheck = (d) => {
    if (!d.configured) return { level: "warn", text: "Off — set DISCORD_BACKUP_WEBHOOK in .env" };
    if (d.last && !d.last.ok) return { level: "error", text: `The last backup failed: ${d.last.message}` };
    if (d.pending?.length) return { level: "warn", text: `restore/ holds ${d.pending.length} file(s) — they replace the data at the next restart` };
    const newest = d.entries?.[0];
    if (!newest) return { level: "warn", text: `No backup yet — the next one runs ${d.schedule}` };
    const at = new Date(newest.at).getTime();
    const late = Date.now() - at > (backupHours(d.schedule) * 2 + 1) * 3_600_000;
    return { level: late ? "warn" : "ok", text: `Last backup ${ago(at)} ago · runs ${d.schedule}` };
};

const gatewayCheck = ({ nodes }) => {
    const bad = nodes.filter((g) => g.error || !g.listening || !g.panelUrl || !g.reach?.ok);
    if (!bad.length) return { level: "ok", text: `${nodes.length}/${nodes.length} nodes forward to the panel` };
    return { level: "warn", text: `${nodes.length - bad.length}/${nodes.length} nodes forward to the panel — not ready: ${bad.map((g) => g.name).join(", ")}` };
};

const busCheck = ({ bus }) => {
    if (!bus.configured) return { level: "off", text: "Off — set PANEL_DISCORD_TOKEN and PANEL_BUS_CHANNEL_ID in .env" };
    if (!bus.ready) return { level: "warn", text: `Not connected${bus.error ? ` — ${bus.error}` : ""}` };
    const queued = bus.counts?.queued || 0;
    return { level: "ok", text: `${bus.botTag} connected${queued ? ` · ${queued} queued` : ""}` };
};

const domainsCheck = ({ domains }) => {
    if (!domains.length) return { level: "warn", text: "No domain — the panel is only reachable by IP" };
    const noSsl = domains.filter((d) => !d.sslEnabled);
    if (noSsl.length) return { level: "warn", text: `Without SSL: ${noSsl.map((d) => d.domain).join(", ")}` };
    return { level: "ok", text: `${domains.length} domain(s), all with SSL` };
};

// Every enabled node (GET /nodes/logrotate). Only "off" is a failure: an offline
// or silent node is "unknown" — nothing is known about its logs either way.
const logrotateCheck = ({ nodes }) => {
    if (!nodes.length) return { level: "off", text: "No enabled nodes" };
    const on = nodes.filter((n) => n.state === "on");
    const off = nodes.filter((n) => n.state === "off");
    const unknown = nodes.filter((n) => n.state === "unknown");
    const notes = [];
    if (off.length) notes.push(`not on: ${off.map((n) => n.name).join(", ")}`);
    if (unknown.length) notes.push(`unknown: ${unknown.map((n) => `${n.name} (${n.reason})`).join(", ")}`);
    const text = `${on.length}/${nodes.length} nodes rotate PM2 logs${notes.length ? ` — ${notes.join(" · ")}` : ""}`;
    return { level: off.length ? "warn" : "ok", text };
};

const CHECKS = [
    { id: "backups", label: "Backups", tab: "recovery", run: () => api.get("/panel/backups").then((r) => backupCheck(r.data)) },
    { id: "gateway", label: "Panel gateway", tab: "integrations", run: () => api.get("/panel/gateway", { timeout: 60_000 }).then((r) => gatewayCheck(r.data)) },
    { id: "bus", label: "Discord bus", tab: "integrations", run: () => api.get("/panel/shared").then((r) => busCheck(r.data)) },
    { id: "domains", label: "Panel domains", tab: "config", run: () => api.get("/panel/domains").then((r) => domainsCheck(r.data)) },
    // Per node now — fixed on a node's Manage tab, reached from the Systems list.
    { id: "logrotate", label: "Log rotation", to: "/systems", run: () => api.get("/nodes/logrotate", { timeout: 60_000 }).then((r) => logrotateCheck(r.data)) },
];

function HealthChecklist() {
    const [results, setResults] = useState({});

    // Every check on its own: a slow one (the gateway asks every node) does not hold up the rest.
    const runAll = useCallback(() => {
        setResults({});
        for (const c of CHECKS) {
            c.run()
                .then((res) => setResults((r) => ({ ...r, [c.id]: res })))
                .catch((err) => setResults((r) => ({ ...r, [c.id]: { level: "error", text: err.response?.data?.error || err.message || "Failed to load" } })));
        }
    }, []);
    useEffect(runAll, [runAll]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {CHECKS.map((c, i) => {
                    const res = results[c.id] || { level: "loading", text: "Checking…" };
                    return (
                        <div key={c.id} style={{ display: "flex", gap: 10, padding: "9px 12px", fontSize: 13, alignItems: "baseline", flexWrap: "wrap", borderBottom: i < CHECKS.length - 1 ? "1px solid var(--border-light)" : "none" }}>
                            <span style={{ flexShrink: 0 }}>{LEVEL_ICON[res.level]}</span>
                            <strong style={{ color: "var(--text)", minWidth: 110 }}>{c.label}</strong>
                            <span style={{ flex: "1 1 240px", minWidth: 0, fontSize: 12, color: LEVEL_COLOR[res.level], overflowWrap: "anywhere" }}>{res.text}</span>
                            <Link to={c.to || `/panel-manage/${c.tab}`} className="btn-ghost" style={{ padding: "2px 8px", fontSize: 11, textDecoration: "none", flexShrink: 0 }}>Open →</Link>
                        </div>
                    );
                })}
            </div>
            <div><button className="btn-ghost" onClick={runAll} style={{ padding: "4px 10px", fontSize: 12 }}>Check again</button></div>
        </div>
    );
}

// ── Panel logs ───────────────────────────────────────────────────────────────

function PanelLogs() {
    const [logs, setLogs] = useState("");
    const [logsLoading, setLogsLoading] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const logsEndRef = useRef(null);

    const fetchLogs = async () => {
        setLogsLoading(true);
        try { const r = await api.get("/panel/logs?lines=200"); setLogs(r.data.logs || "No logs available"); }
        catch { setLogs("Failed to fetch logs"); }
        finally { setLogsLoading(false); }
    };
    useEffect(() => { if (showLogs) fetchLogs(); }, [showLogs]);
    useEffect(() => { if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: "smooth" }); }, [logs]);

    return (
        <div className="card" style={{ display: "flex", flexDirection: "column", minHeight: showLogs ? 400 : 0, maxHeight: 600, padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: showLogs ? "1px solid var(--border)" : "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 16 }}>📋</span>
                    <h2 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Panel Logs</h2>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    {showLogs && <button onClick={fetchLogs} disabled={logsLoading} className="btn-ghost" style={{ padding: "4px 8px", fontSize: 11 }}>{logsLoading ? "⏳" : "🔄 Refresh"}</button>}
                    <button onClick={() => setShowLogs(!showLogs)} className="btn-primary" style={{ padding: "4px 8px", fontSize: 11 }}>{showLogs ? "Hide Logs" : "Load Logs"}</button>
                </div>
            </div>
            {showLogs && (
                <div className="mono" style={{ flex: 1, padding: 16, background: "var(--bg-base)", overflowY: "auto", fontSize: 11, color: "var(--text-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {logs}
                    <div ref={logsEndRef} />
                </div>
            )}
        </div>
    );
}

export default function OverviewTab({ status }) {
    const { env, git, pm2 } = status;
    return (
        <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 120px), 1fr))", gap: 12 }}>
                <StatCard icon="⚡" label="Version" value={`v${env?.version || "?"}`} sub={git?.commitHash ? `Commit: ${git.commitHash.substring(0, 7)}` : ""} />
                <StatCard icon="⏱️" label="Uptime" value={fmtUptime(pm2?.pm_uptime)} sub={`${pm2?.restarts ?? 0} restart(s)`} />
                <StatCard icon="💾" label="Memory" value={fmtBytes(pm2?.monit?.memory)} sub="Panel RAM usage" />
                <StatCard icon="🖥️" label="CPU" value={`${pm2?.monit?.cpu || 0}%`} sub="Panel CPU usage" />
            </div>
            <Section icon="🩺" title="Health" hint="Each line opens the tab that fixes it">
                <HealthChecklist />
            </Section>
            <PanelLogs />
        </>
    );
}
