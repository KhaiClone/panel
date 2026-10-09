// ─────────────────────────────────────────────────────────────────────────────
//  Panel Settings → Recovery: rolling back to a backup and moving the panel to
//  another node. Rare, and both replace what runs now — hence a tab of their own.
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from "react";
import api from "../../api/client";
import ConfirmModal from "../../components/ConfirmModal";
import Section from "./Section";

// ── Backups on Discord and rolling back to one ──────────────────────────────

const fmtKB = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const PART_LABEL = { panel: "panel.sqlite", shared: "shared.sqlite", env: ".env" };

function BackupDiff({ rows }) {
    const changed = rows.filter((r) => r.changed).length;
    const cell = (r, v) => (v === undefined ? "—" : r.kind === "value" ? "set" : r.kind === "map" ? `${v} keys` : v);
    return (
        <details>
            <summary style={{ fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
                {changed ? `${changed} of ${rows.length} entries differ from now` : `Same as now (${rows.length} entries)`}
            </summary>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", gap: "2px 16px", fontSize: 11, marginTop: 6 }}>
                <span style={{ color: "var(--text-dim)" }}>entry</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>now</span>
                <span style={{ color: "var(--text-dim)", textAlign: "right" }}>backup</span>
                {rows.map((r) => [
                    <span key={`${r.key}:k`} className="mono" style={{ color: r.changed ? "#f59e0b" : "var(--text-muted)", overflowWrap: "anywhere" }}>{r.key}</span>,
                    <span key={`${r.key}:n`} style={{ textAlign: "right", color: "var(--text-muted)" }}>{cell(r, r.now)}</span>,
                    <span key={`${r.key}:b`} style={{ textAlign: "right", color: r.changed ? "var(--text)" : "var(--text-muted)" }}>{cell(r, r.backup)}</span>,
                ])}
            </div>
        </details>
    );
}

function BackupSection({ onRestart, onRestarting }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(null); // "run" | "inspect" | "restore" | "clear"
    const [source, setSource] = useState("");
    const [preview, setPreview] = useState(null);
    const [parts, setParts] = useState({ panel: true, shared: true, env: false });
    const [confirming, setConfirming] = useState(false);
    const [showAll, setShowAll] = useState(false);

    const load = useCallback(() => {
        api.get("/panel/backups").then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || "Failed to load"));
    }, []);
    useEffect(load, [load]);

    const errText = (err) => err.response?.data?.error || err.message;

    const runNow = async () => {
        setBusy("run"); setError(""); setNote("");
        try {
            const { data: r } = await api.post("/panel/backups/run", {}, { timeout: 330_000 });
            setNote(`Backup ${r.entry.ts} sent — ${r.entry.files.length} file(s)`);
        } catch (err) { setError(errText(err)); }
        finally { setBusy(null); load(); }
    };

    const inspect = async (src) => {
        const s = String(src ?? source).trim();
        if (!s) return;
        setBusy("inspect"); setError(""); setNote(""); setPreview(null);
        try {
            const { data: r } = await api.post("/panel/backups/inspect", { source: s }, { timeout: 300_000 });
            setPreview({ ...r, source: s });
            // .env only on request: a rollback is usually about data, and an old
            // .env would bring back old passwords and tokens.
            setParts({ panel: !!r.parts.panel, shared: !!r.parts.shared, env: false });
        } catch (err) { setError(errText(err)); }
        finally { setBusy(null); }
    };

    const restore = async () => {
        setConfirming(false); setBusy("restore"); setError(""); setNote("");
        try {
            const { data: r } = await api.post("/panel/backups/restore", { source: preview.source, parts }, { timeout: 300_000 });
            if (r.restarted) { onRestarting(); return; }
            setError(`${r.staged.length} file(s) staged in restore/, but the restart failed (${r.restartError}) — restart the panel to apply them.`);
            setPreview(null);
            load();
        } catch (err) { setError(errText(err)); }
        finally { setBusy(null); }
    };

    const clear = async () => {
        setBusy("clear"); setError(""); setNote("");
        try {
            const { data: r } = await api.delete("/panel/backups/pending");
            setNote(`Removed ${r.removed.length} file(s) from restore/`);
        } catch (err) { setError(errText(err)); }
        finally { setBusy(null); load(); }
    };

    if (!data) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>{error || "Loading…"}</p>;

    const { entries, pending, lastRestore, last } = data;
    const chosen = Object.entries(parts).filter(([k, on]) => on && preview?.parts[k]).map(([k]) => PART_LABEL[k]);
    const chosenDb = (parts.panel && preview?.parts.panel) || (parts.shared && preview?.parts.shared);
    const shown = showAll ? entries : entries.slice(0, 8);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {confirming && (
                <ConfirmModal
                    title={`Roll back to ${preview.takenAt}`}
                    message={`The panel restarts and replaces ${chosen.join(", ")} with this backup. Everything written since then is lost — the current files are kept next to them as *.bak-<time>.\n\nContinue?`}
                    confirmText="Roll back & restart"
                    onConfirm={restore}
                    onCancel={() => setConfirming(false)}
                />
            )}

            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                {data.schedule[0].toUpperCase() + data.schedule.slice(1)} the panel sends ONE message to <span className="mono">DISCORD_BACKUP_WEBHOOK</span>:{" "}
                <span className="mono">panel.sqlite</span> and <span className="mono">shared.sqlite</span> (snapshot, gzip, 9 MB pieces, SHA-256 in the names)
                plus <span className="mono">.env</span>. To roll back, paste that message's link below — or put its files in <span className="mono">restore/</span> on
                the server and restart the panel.
            </p>
            {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171", overflowWrap: "anywhere" }}>{error}</p>}
            {note && <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{note}</p>}

            <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong style={{ color: "var(--text)" }}>Webhook</strong>
                {data.configured ? (
                    <span style={{ color: "var(--text-muted)" }}>
                        {last ? `last backup ${last.ok ? "✅" : "❌"} ${new Date(last.at).toLocaleString()} — ${last.message}` : "no backup sent since the panel started"}
                    </span>
                ) : (
                    <span style={{ color: "#f59e0b" }}>⚠️ off — set DISCORD_BACKUP_WEBHOOK in .env</span>
                )}
                {data.configured && (
                    <button className="btn-ghost" disabled={!!busy || data.running} onClick={runNow} style={{ padding: "2px 8px", fontSize: 11, marginLeft: "auto" }}>
                        {busy === "run" || data.running ? "Sending…" : "Backup now"}
                    </button>
                )}
            </div>

            {pending.length > 0 && (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, border: "1px solid rgba(245,158,11,0.3)", background: "rgba(245,158,11,0.05)" }}>
                    <p style={{ margin: 0, fontSize: 12, color: "#f59e0b", fontWeight: 600 }}>
                        restore/ holds {pending.length} backup file(s) — they replace the current data at the next restart.
                    </p>
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{pending.join("  ")}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn-primary" disabled={!!busy} onClick={onRestart} style={{ padding: "4px 10px", fontSize: 12 }}>Restart now</button>
                        <button className="btn-ghost" disabled={!!busy} onClick={clear} style={{ padding: "4px 10px", fontSize: 12 }}>{busy === "clear" ? "Removing…" : "Discard"}</button>
                    </div>
                </div>
            )}

            {lastRestore && (
                <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ color: lastRestore.ok ? "#4ade80" : "#f87171" }}>
                        {lastRestore.ok
                            ? `✅ Restored backup ${lastRestore.backup} at ${new Date(lastRestore.at).toLocaleString()}: ${lastRestore.restored.join(", ")}`
                            : `❌ Restore skipped at ${new Date(lastRestore.at).toLocaleString()}: ${lastRestore.error}`}
                    </span>
                    {lastRestore.kept?.length > 0 && (
                        <span style={{ color: "var(--text-dim)" }}>Previous files kept in data/: <span className="mono">{lastRestore.kept.join(", ")}</span></span>
                    )}
                    {(lastRestore.notes || []).map((n, i) => <span key={i} style={{ color: "var(--text-dim)" }}>ℹ️ {n}</span>)}
                </div>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                    className="input mono"
                    placeholder="https://discord.com/channels/…/…/…  (Copy Message Link)"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && inspect()}
                    style={{ flex: "1 1 280px", minWidth: 0 }}
                />
                <button className="btn-primary" disabled={!source.trim() || !!busy} onClick={() => inspect()} style={{ padding: "6px 12px", fontSize: 12 }}>
                    {busy === "inspect" ? "Checking…" : "Check backup"}
                </button>
            </div>

            {preview && (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.04)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 13, color: "var(--text)" }}>Backup {preview.takenAt}</strong>
                        <span style={{ fontSize: 11, color: "#4ade80" }}>✅ every piece present, checksums match</span>
                    </div>
                    {preview.notes.map((n, i) => <span key={i} style={{ fontSize: 12, color: "var(--text-muted)" }}>ℹ️ {n}</span>)}

                    {["panel", "shared"].filter((k) => preview.parts[k]).map((k) => (
                        <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                                <input type="checkbox" checked={parts[k]} onChange={(e) => setParts({ ...parts, [k]: e.target.checked })} />
                                <strong className="mono" style={{ color: "var(--text)" }}>{PART_LABEL[k]}</strong>
                                <span style={{ color: "var(--text-dim)" }}>{fmtKB(preview.parts[k].size)} · {preview.parts[k].hash8}</span>
                            </label>
                            <div style={{ paddingLeft: 24 }}><BackupDiff rows={preview.parts[k].rows} /></div>
                        </div>
                    ))}

                    {preview.parts.env && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                                <input type="checkbox" checked={parts.env} onChange={(e) => setParts({ ...parts, env: e.target.checked })} />
                                <strong className="mono" style={{ color: "var(--text)" }}>.env</strong>
                                <span style={{ color: "var(--text-dim)" }}>only when this machine's .env is broken or lost — PANEL_NODE_ID always stays</span>
                            </label>
                            <div style={{ paddingLeft: 24, fontSize: 11, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 2 }}>
                                {preview.parts.env.changed.length + preview.parts.env.onlyInBackup.length + preview.parts.env.onlyNow.length === 0 && <span>Same keys and values as now</span>}
                                {preview.parts.env.changed.length > 0 && <span>different: <span className="mono">{preview.parts.env.changed.join(", ")}</span></span>}
                                {preview.parts.env.onlyInBackup.length > 0 && <span>only in the backup: <span className="mono">{preview.parts.env.onlyInBackup.join(", ")}</span></span>}
                                {preview.parts.env.onlyNow.length > 0 && <span>would be removed: <span className="mono">{preview.parts.env.onlyNow.join(", ")}</span></span>}
                            </div>
                        </div>
                    )}

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn-primary" disabled={!chosenDb || !!busy} onClick={() => setConfirming(true)} style={{ padding: "6px 14px", fontSize: 12, background: "var(--danger)" }}>
                            {busy === "restore" ? "Staging…" : "Roll back & restart"}
                        </button>
                        <button className="btn-ghost" disabled={busy === "restore"} onClick={() => setPreview(null)} style={{ padding: "6px 12px", fontSize: 12 }}>Cancel</button>
                    </div>
                </div>
            )}

            {entries.length > 0 && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    {shown.map((e, i) => (
                        <div key={e.messageId} style={{ display: "flex", gap: 10, padding: "6px 12px", fontSize: 12, alignItems: "baseline", flexWrap: "wrap", borderBottom: i < shown.length - 1 ? "1px solid var(--border-light)" : "none" }}>
                            <span style={{ color: "var(--text)" }}>{new Date(e.at).toLocaleString()}</span>
                            <span style={{ color: "var(--text-dim)" }}>
                                {Object.entries(e.dbs).map(([k, d]) => `${k} ${fmtKB(d.gz)}`).join(" · ")}{e.env ? " · .env" : ""}
                            </span>
                            {e.reason === "manual" && <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>manual</span>}
                            <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                                {e.link && <a href={e.link} target="_blank" rel="noreferrer" className="btn-ghost" style={{ padding: "2px 8px", fontSize: 11 }}>Discord ↗</a>}
                                <button className="btn-ghost" disabled={!!busy} onClick={() => { setSource(e.source); inspect(e.source); }} style={{ padding: "2px 8px", fontSize: 11 }}>Check</button>
                            </span>
                        </div>
                    ))}
                </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
                {entries.length > 8 && <button className="btn-ghost" onClick={() => setShowAll(!showAll)} style={{ padding: "4px 10px", fontSize: 12 }}>{showAll ? "Show fewer" : `Show all ${entries.length}`}</button>}
                <button className="btn-ghost" onClick={load} style={{ padding: "4px 10px", fontSize: 12 }}>Refresh</button>
            </div>
        </div>
    );
}

// ── Moving the panel to another node ────────────────────────────────────────

const CHECK_ICON = { ok: "✅", info: "ℹ️", warn: "⚠️", error: "❌" };
const STEP_ICON = { running: "⏳", ok: "✅", warn: "⚠️", error: "❌" };

function MoveResult({ result }) {
    if (!result?.target) return null;
    const { target, url, port } = result;
    const href = url || `http://${target.host}:${port}`;
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--text-muted)" }}>
            <p style={{ margin: 0, color: "#4ade80", fontWeight: 700 }}>The panel now runs on {target.name}. This copy is being stopped.</p>
            <p style={{ margin: 0 }}>
                It answers at <span className="mono">{href}</span>. This node's domains will redirect there once the new panel has flipped them.
            </p>
            <div><a className="btn-primary" href={href} style={{ padding: "6px 12px", fontSize: 12, display: "inline-block" }}>Open the new panel</a></div>
        </div>
    );
}

function MoveJob({ job, lost }) {
    const title = job.kind === "move" ? `Moving the panel to ${job.targetName}` : `Preparing ${job.targetName}`;
    const statusColor = job.status === "done" ? "#4ade80" : job.status === "failed" ? "#f87171" : "var(--accent)";
    return (
        <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13, color: "var(--text)" }}>{title}</strong>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: statusColor }}>{job.status}</span>
            </div>
            {job.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                    <span>{STEP_ICON[s.status] || "•"}</span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: "var(--text)" }}>{s.label}</div>
                        {s.detail && (
                            <pre className="mono" style={{ margin: "2px 0 0", fontSize: 11, color: s.status === "error" ? "#f87171" : "var(--text-dim)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto" }}>{s.detail}</pre>
                        )}
                    </div>
                </div>
            ))}
            {job.error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{job.error}</p>}
            {job.kind === "move" && job.status === "done" && <MoveResult result={job.result} />}
            {lost && job.kind === "move" && job.status !== "failed" && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>This copy of the panel has stopped answering — the new one retired it, as expected.</p>
            )}
        </div>
    );
}

function PanelMoveSection() {
    const [ov, setOv] = useState(null);
    const [lost, setLost] = useState(false);
    const [targetId, setTargetId] = useState("");
    const [pf, setPf] = useState(null);
    const [checking, setChecking] = useState(false);
    const [confirmName, setConfirmName] = useState("");
    const [error, setError] = useState("");
    const [starting, setStarting] = useState(null); // "prepare" | "start" while its request is in flight

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/panel/migration");
            setOv(data); setLost(false);
        } catch {
            setLost(true);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const job = ov?.job;
    const running = job?.status === "running";
    // Poll while a job runs; keep polling after a finished move so "stopped
    // answering" shows once the new panel retires this one.
    const followMove = job?.kind === "move" && job?.status === "done";
    useEffect(() => {
        if (!running && !followMove) return;
        const t = setInterval(load, running ? 2000 : 5000);
        return () => clearInterval(t);
    }, [running, followMove, load]);

    // A finished Prepare carries a fresh preflight — show it.
    useEffect(() => {
        if (job?.kind === "prepare" && job.status === "done" && job.result?.preflight) setPf(job.result.preflight);
    }, [job?.kind, job?.status, job?.result]);

    const runCheck = async () => {
        setChecking(true); setError(""); setPf(null);
        try {
            const { data } = await api.post("/panel/migration/preflight", { targetNodeId: targetId }, { timeout: 180_000 });
            setPf(data);
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally { setChecking(false); }
    };

    const start = (kind) => async () => {
        if (starting) return;
        setStarting(kind); setError("");
        try {
            const body = kind === "start" ? { targetNodeId: targetId, confirmName } : { targetNodeId: targetId };
            await api.post(`/panel/migration/${kind}`, body, { timeout: 180_000 });
            setConfirmName("");
            await load();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
        } finally { setStarting(null); }
    };

    if (!ov) return <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>Loading…</p>;

    const state = ov.lifecycle?.state;
    const current = ov.nodes.find((n) => n.isPanelNode);
    const candidates = ov.nodes.filter((n) => !n.isPanelNode && n.enabled);
    const nodeName = (id) => ov.nodes.find((n) => n._id === id)?.name || id;
    const idle = !running && !starting && state === "active";

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
                The panel runs on <strong style={{ color: "var(--text)" }}>{current?.name || ov.panelNodeId || "?"}</strong> (epoch {ov.epoch}).
                Moving it copies its database, .env and history to another node, starts it there and retires this copy.
                Bots keep running throughout; quests and badge orders pause for a few minutes and resume on the new panel.
            </p>

            {state === "fenced" && (
                <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "#f87171" }}>
                    This panel has been replaced{ov.lifecycle.info?.to ? ` — it now runs on ${ov.lifecycle.info.to}` : ""}. Nothing here runs any more.
                    {ov.lifecycle.info?.url && <> Open <a href={ov.lifecycle.info.url} className="mono">{ov.lifecycle.info.url}</a>.</>}
                </p>
            )}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="input" value={targetId} disabled={!idle} onChange={(e) => { setTargetId(e.target.value); setPf(null); setConfirmName(""); }} style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <option value="">— choose the new host —</option>
                    {candidates.map((n) => (
                        <option key={n._id} value={n._id}>{n.name} ({n.host}){n.online ? "" : " — offline"}</option>
                    ))}
                </select>
                <button className="btn-ghost" disabled={!targetId || checking || !idle} onClick={runCheck} style={{ padding: "6px 12px", fontSize: 12 }}>
                    {checking ? "Checking…" : "Check"}
                </button>
                <button className="btn-primary" disabled={!pf?.canPrepare || !idle} onClick={start("prepare")} style={{ padding: "6px 12px", fontSize: 12 }} title="Firewall access, dependencies, client build and HTTPS for its domains on the new host — nothing is paused">
                    {starting === "prepare" ? "Starting…" : "Prepare"}
                </button>
            </div>

            {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

            {pf && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {pf.checks.map((c, i) => (
                        <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, alignItems: "flex-start" }}>
                            <span>{CHECK_ICON[c.level] || "•"}</span>
                            <span style={{ color: c.level === "error" ? "#f87171" : c.level === "warn" ? "#f59e0b" : "var(--text-muted)", overflowWrap: "anywhere" }}>{c.message}</span>
                        </div>
                    ))}
                </div>
            )}

            {pf?.canMove && (idle || starting === "start") && pf.target?._id === targetId && (
                <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.04)" }}>
                    <p style={{ margin: 0, fontSize: 13 }}>Every check passed. Type <strong className="mono">{pf.target.name}</strong> to move the panel there.</p>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={pf.target.name} style={{ flex: "1 1 200px", minWidth: 0 }} />
                        <button className="btn-primary" disabled={confirmName !== pf.target.name || !!starting} onClick={start("start")} style={{ padding: "6px 14px", fontSize: 12, background: "var(--danger)" }}>
                            {starting === "start" ? "Starting…" : "Move panel"}
                        </button>
                    </div>
                </div>
            )}

            {job && <MoveJob job={job} lost={lost} />}

            {ov.history?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
                    <strong style={{ color: "var(--text-muted)" }}>Recent moves</strong>
                    {ov.history.map((h) => (
                        <span key={h.id}>
                            {new Date(h.startedAt).toLocaleString()} · {nodeName(h.fromNodeId)} → {nodeName(h.toNodeId)} · {h.status}{h.error ? ` — ${h.error}` : ""}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function RecoveryTab({ onRestart, onRestarting }) {
    return (
        <>
            <Section icon="💾" title="Backup & Rollback" hint="Hourly to Discord; roll back from a message link" danger>
                <BackupSection onRestart={onRestart} onRestarting={onRestarting} />
            </Section>
            <Section icon="🚚" title="Move Panel" hint="Run the panel on another node" danger>
                <PanelMoveSection />
            </Section>
        </>
    );
}
