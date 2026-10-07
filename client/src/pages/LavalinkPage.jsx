import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api/client";
import LiveLog from "../components/LiveLog";

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink — one audio server per node, one config for all of them.
//
//  Config is deliberately NOT per-node: you edit it here once and every node
//  gets the same application.yml. A node whose file differs shows as drift.
//
//  Bots connect to 127.0.0.1:<port> on their own node, so the password below is
//  what they authenticate with.
//
//  Two tabs: Node — a table, one row per node, that opens into its controls and
//  a live log — and Cấu hình, the shared config. Status refreshes itself every
//  30s while the page is visible; logs stream as they are written.
// ─────────────────────────────────────────────────────────────────────────────

// Downloading a ~100MB jar, restarting the JVM and waiting for its health check
// takes far longer than the client's 30s default.
const LONG = { timeout: 600_000 };

// Each refresh asks every agent for pm2 state and Lavalink's /v4/stats, so it
// is not free — often enough to notice a node falling over, no more.
const POLL_MS = 30_000;

const SOURCES = ["youtube", "bandcamp", "soundcloud", "twitch", "vimeo", "nico", "http", "local"];

const STATE_META = {
    running: { label: "running", color: "var(--success)" },
    "config-drift": { label: "config drift", color: "var(--warning)" },
    stopped: { label: "stopped", color: "var(--text-dim)" },
    "not-installed": { label: "not installed", color: "var(--text-dim)" },
    errored: { label: "errored", color: "var(--danger)" },
    "java-missing": { label: "java missing", color: "var(--danger)" },
    "java-too-old": { label: "java too old", color: "var(--danger)" },
    "agent-outdated": { label: "agent outdated", color: "var(--warning)" },
    "node-offline": { label: "node offline", color: "var(--danger)" },
};

const NOT_INSTALLED = ["not-installed", "java-missing", "java-too-old"];

const fmtTime = (ts) => {
    if (!ts) return "—";
    try {
        return new Date(ts).toLocaleString("en-GB", {
            day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
        });
    } catch {
        return "—";
    }
};

const fmtClock = (ts) => (ts ? new Date(ts).toLocaleTimeString("en-GB") : "—");

const fmtGB = (bytes) => (bytes == null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

const fmtMB = (bytes) => (bytes == null ? "—" : `${Math.round(bytes / 1024 ** 2)} MB`);

/** How long ago a pm2 start timestamp was, in the largest unit that fits. */
const fmtSince = (ts) => {
    if (!ts) return "—";
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 90) return `${secs}s`;
    if (secs < 5400) return `${Math.round(secs / 60)} min`;
    if (secs < 172800) return `${(secs / 3600).toFixed(1)} h`;
    return `${Math.round(secs / 86400)} days`;
};

function Pill({ state }) {
    const meta = STATE_META[state] || { label: state || "unknown", color: "var(--text-dim)" };
    return (
        <span
            className="badge"
            style={{ background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}33`, whiteSpace: "nowrap" }}
        >
            {meta.label}
        </span>
    );
}

function Field({ label, hint, children }) {
    return (
        <label style={{ display: "block" }}>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
                {label}
            </span>
            {children}
            {hint && (
                <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{hint}</span>
            )}
        </label>
    );
}

// ── Tổng quan ────────────────────────────────────────────────────────────────

const TONE = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--danger)" };

function StatTile({ label, value, sub, tone }) {
    return (
        <div className="card" style={{ padding: "14px 16px" }}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                {label}
            </p>
            <p style={{ margin: "4px 0 0", fontSize: 20, fontWeight: 700, color: tone ? TONE[tone] : "var(--text)" }}>
                {value}
            </p>
            {sub ? <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{sub}</p> : null}
        </div>
    );
}

function Metric({ label, value, dim }) {
    return (
        <div>
            <p style={{ margin: 0, fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>
                {label}
            </p>
            <p style={{ margin: "1px 0 0", fontSize: 13, fontWeight: 600, color: dim ? "var(--text-muted)" : "var(--text)" }}>
                {value}
            </p>
        </div>
    );
}

/** A warning strip above the table, with an optional button on its right. */
function Alert({ children, action }) {
    return (
        <div
            className="card"
            style={{
                padding: "12px 16px",
                marginBottom: 12,
                fontSize: 13,
                color: "var(--warning)",
                border: "1px solid var(--warning-border)",
                background: "var(--warning-bg)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
            }}
        >
            <div style={{ flex: 1, minWidth: 220 }}>{children}</div>
            {action}
        </div>
    );
}

/** A shell command with a copy button — these get pasted into a node's terminal. */
function CopyCode({ text }) {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked: the text is still selectable */ }
    };
    return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 6 }}>
            <code style={{ flex: 1, color: "var(--text)", wordBreak: "break-all", fontSize: 12 }}>{text}</code>
            <button type="button" className="btn-ghost" style={{ padding: "2px 10px", fontSize: 11 }} onClick={copy}>
                {copied ? "Copied" : "Copy"}
            </button>
        </div>
    );
}

// ── spotify-tokener ──────────────────────────────────────────────────────────

// Chrome is a system package, so — like Java — the page shows the command and
// the agent never runs it. Google publishes no Linux arm64 build.
const CHROME_INSTALL = {
    x64: "wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y /tmp/chrome.deb",
    arm64: "sudo snap install chromium",
};

/**
 * What the tokener on one node is doing: a short word for the table and a
 * sentence for the open row. A tokener the panel did not start (already
 * answering on the port, or a pm2 process by the same name) is shown and never
 * touched, whichever way the node's switch is set.
 */
const tokenerView = (t, enabled, lavalinkRunning) => {
    if (!t) return { short: "old agent", text: "old agent — update the agent", color: "var(--warning)" };
    if (t.external) {
        return {
            short: "pre-existing",
            text: `already on the node (not managed by the panel) · 127.0.0.1:${t.port} — the panel leaves it alone`,
            color: "var(--text-muted)",
        };
    }
    if (t.foreignPm2) return { short: "foreign pm2", text: `pm2 "${t.pm2Name}" was not created by the panel — the panel leaves it alone`, color: "var(--warning)" };
    if (!enabled) return { short: "off", text: "turned off on this node", color: "var(--text-dim)" };
    if (!t.chrome?.present) return { short: "no Chrome", text: "Chrome is not installed", color: "var(--danger)" };
    if (t.live?.status === "online") {
        if (t.health?.lastError) return { short: "error", text: `error: ${t.health.lastError}`, color: "var(--danger)" };
        const ago = t.health?.lastTokenAt ? ` · token ${fmtSince(t.health.lastTokenAt)} ago` : "";
        return { short: "running", text: `running · 127.0.0.1:${t.port}${ago}`, color: "var(--success)" };
    }
    if (lavalinkRunning) return { short: "not running", text: "not running — press Sync or Restart", color: "var(--warning)" };
    return { short: "stopped", text: "stopped along with Lavalink", color: "var(--text-dim)" };
};

/** One line on what an action did to the tokener, or "" when there is nothing to say. */
const tokenerNote = (t) => {
    if (!t?.wanted) return "";
    if (t.external) {
        const base = " Spotify tokener: the node already has a tokener the panel does not manage — the panel leaves it alone";
        return t.health && !t.health.ok ? `${base}, but it cannot get a token: ${t.health.error}` : `${base}.`;
    }
    if (t.error) return ` Spotify tokener: ${t.error}`;
    if (t.health && !t.health.ok) return ` Spotify tokener cannot get a token: ${t.health.error}`;
    return "";
};

// ── Node table ───────────────────────────────────────────────────────────────

/**
 * The open row: controls, the tokener, and the live log.
 *
 * The log streams for as long as the row is open — closing it closes the
 * EventSource, which stops `pm2 logs` on the node. `key={src}` gives each
 * source (Lavalink / tokener) a fresh view: filter and pause belong to the
 * log being read, not the one before it.
 */
function NodeDetail({ n, busy, wantsTokener, onAction, onTokener }) {
    const [which, setWhich] = useState("lavalink");
    const live = n.live || {};
    const running = live.status === "online";
    const notInstalled = NOT_INSTALLED.includes(n.state);
    const enabled = n.tokenerEnabled !== false;
    const tv = wantsTokener ? tokenerView(n.tokener, enabled, running) : null;
    const tokenerHasLog = wantsTokener && Boolean(n.tokener?.managed || n.tokener?.foreignPm2);
    const source = tokenerHasLog ? which : "lavalink";
    const src = `/api/lavalink/nodes/${n.nodeId}/logs/stream?which=${source}&lines=200`;
    const canLog = n.online && n.state !== "agent-outdated" && !notInstalled;
    const btn = { padding: "6px 12px", fontSize: 12 };

    return (
        <div style={{ padding: "16px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {notInstalled ? (
                    <button className="btn-primary" style={btn} disabled={!!busy || !n.online} onClick={() => onAction("install", "Install")}>
                        Install Lavalink
                    </button>
                ) : (
                    <>
                        <button
                            className="btn-ghost"
                            style={btn}
                            disabled={!!busy || !n.online}
                            onClick={() => onAction(running ? "restart" : "start", running ? "Restart" : "Start")}
                        >
                            {running ? "Restart" : "Start"}
                        </button>
                        {running && (
                            <button className="btn-ghost" style={btn} disabled={!!busy} onClick={() => onAction("stop", "Stop")}>
                                Stop
                            </button>
                        )}
                        <button className="btn-ghost" style={btn} disabled={!!busy || !n.online} onClick={() => onAction("sync", "Sync config")}>
                            Sync
                        </button>
                        <button className="btn-ghost" style={btn} disabled={!!busy || !n.online} onClick={() => onAction("update", "Update")}>
                            Update
                        </button>
                    </>
                )}
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    {n.java?.present ? `Java ${n.java.major ?? "?"}` : "no Java"} · {fmtGB(n.freeBytes)} free
                    {n.hasRollback ? " · previous jar kept for rollback" : ""}
                </span>
            </div>

            {n.state === "config-drift" && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--warning)" }}>
                    The file on the node differs from the panel's config — press Sync to overwrite it and restart.
                </p>
            )}
            {n.error && (
                <p style={{ margin: 0, fontSize: 12, color: "var(--danger)", wordBreak: "break-word" }}>{n.error}</p>
            )}

            {/* The table hides these columns on a phone; the open row shows them instead. */}
            <div className="hide-desktop" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
                <Metric label="Version" value={n.version || "—"} dim={!n.version} />
                <Metric label="Uptime" value={running ? fmtSince(live.uptime) : "—"} dim={!running} />
                <Metric label="RAM" value={running ? fmtMB(live.memory) : "—"} dim={!running} />
                <Metric label="Restart" value={running ? String(live.restarts ?? 0) : "—"} dim={!live.restarts} />
            </div>

            {tv && n.online && n.state !== "agent-outdated" && (
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                        background: "var(--bg-input)",
                    }}
                >
                    <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>Spotify tokener</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: tv.color, wordBreak: "break-word" }}>{tv.text}</span>
                    {n.tokener && (
                        <label
                            title="Turn the panel-managed spotify-tokener on this node on or off"
                            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}
                        >
                            <input type="checkbox" checked={enabled} disabled={!!busy} onChange={(e) => onTokener(e.target.checked)} />
                            On
                        </label>
                    )}
                </div>
            )}

            {canLog ? (
                <LiveLog
                    key={src}
                    src={src}
                    height={340}
                    toolbarStart={
                        tokenerHasLog ? (
                            <div style={{ display: "flex", gap: 4 }}>
                                <ModePill active={source === "lavalink"} onClick={() => setWhich("lavalink")}>
                                    Lavalink
                                </ModePill>
                                <ModePill active={source === "tokener"} onClick={() => setWhich("tokener")}>
                                    Spotify tokener
                                </ModePill>
                            </div>
                        ) : (
                            <span style={{ fontSize: 12, fontWeight: 600 }}>Log Lavalink</span>
                        )
                    }
                />
            ) : (
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-dim)" }}>
                    {!n.online
                        ? "Cannot reach this node."
                        : n.state === "agent-outdated"
                          ? "This node's agent is too old — update the agent to see the log."
                          : "Lavalink is not installed on this node."}
                </p>
            )}
        </div>
    );
}

function NodeRows({ n, open, onToggle, cols, wantsTokener, ...detail }) {
    const live = n.live || {};
    const running = live.status === "online";
    const tv = wantsTokener ? tokenerView(n.tokener, n.tokenerEnabled !== false, running) : null;
    const onKeyDown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
        }
    };

    return (
        <>
            <tr
                className={`row-click${open ? " row-open" : ""}`}
                tabIndex={0}
                aria-expanded={open}
                onClick={onToggle}
                onKeyDown={onKeyDown}
            >
                <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <span
                            style={{
                                fontSize: 10,
                                color: "var(--text-dim)",
                                transition: "transform 0.15s ease",
                                transform: open ? "rotate(90deg)" : "none",
                            }}
                        >
                            ▶
                        </span>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {n.nodeName}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{n.host}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <Pill state={n.state} />
                </td>
                <td>
                    {n.stats ? (
                        <>
                            <span style={{ fontWeight: 600 }}>{n.stats.players ?? 0}</span>
                            {n.stats.playingPlayers > 0 && (
                                <span style={{ fontSize: 11, color: "var(--success)" }}> · {n.stats.playingPlayers} playing</span>
                            )}
                        </>
                    ) : (
                        <span style={{ color: "var(--text-dim)" }}>{running ? "?" : "—"}</span>
                    )}
                </td>
                <td className="hide-mobile" style={{ color: n.version ? "var(--text)" : "var(--text-dim)" }}>{n.version || "—"}</td>
                <td className="hide-mobile" style={{ color: running ? "var(--text)" : "var(--text-dim)" }}>
                    {running ? fmtMB(live.memory) : "—"}
                </td>
                <td className="hide-mobile" style={{ color: running ? "var(--text)" : "var(--text-dim)" }}>
                    {running ? fmtSince(live.uptime) : "—"}
                </td>
                <td className="hide-mobile" style={{ color: live.restarts ? "var(--warning)" : "var(--text-dim)" }}>
                    {running ? live.restarts ?? 0 : "—"}
                </td>
                {wantsTokener && (
                    <td className="hide-mobile" style={{ color: tv.color, whiteSpace: "nowrap", fontSize: 12 }}>
                        {n.online && n.state !== "agent-outdated" ? tv.short : "—"}
                    </td>
                )}
            </tr>
            {open && (
                <tr className="row-detail">
                    <td colSpan={cols}>
                        <NodeDetail n={n} wantsTokener={wantsTokener} {...detail} />
                    </td>
                </tr>
            )}
        </>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function LavalinkPage() {
    const [settings, setSettings] = useState(null);
    const [effective, setEffective] = useState(null);
    const [form, setForm] = useState(null);
    const [release, setRelease] = useState(null);
    const [status, setStatus] = useState(null);
    const [statusAt, setStatusAt] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null); // free-text description of what is running
    const [err, setErr] = useState("");
    const [msg, setMsg] = useState("");
    const [tab, setTab] = useState("nodes");
    const [openId, setOpenId] = useState(null);
    const [showPassword, setShowPassword] = useState(false);
    const [showYaml, setShowYaml] = useState(false);
    const [yaml, setYaml] = useState("");
    const [switchPrompt, setSwitchPrompt] = useState(null); // { dropped: [] }

    const busyRef = useRef(null);
    busyRef.current = busy;
    const statusSeq = useRef(0);
    const autoOpened = useRef(false);

    // With a hand-written application.yml the stored form fields describe
    // nothing, so the inputs are seeded from what the FILE says — that is what
    // makes editing it through them meaningful.
    const applyServerState = useCallback((data) => {
        setSettings(data.settings);
        setEffective(data.effective);
        setForm(
            data.effective?.custom
                ? {
                      ...data.settings,
                      port: data.effective.port,
                      address: data.effective.address,
                      password: data.effective.password,
                      sources: data.effective.sources || {},
                      plugins: data.effective.plugins || [],
                  }
                : data.settings,
        );
    }, []);

    const loadSettings = useCallback(async () => {
        const { data } = await api.get("/lavalink");
        applyServerState(data);
        setRelease(data.release);
    }, [applyServerState]);

    // A background refresh and the one after an action can overlap; only the
    // newest request may write, so a slow poll never paints over fresh state.
    const loadStatus = useCallback(async () => {
        const seq = ++statusSeq.current;
        const { data } = await api.get("/lavalink/status", { timeout: 120_000 });
        if (seq !== statusSeq.current) return;
        setStatus(data);
        setStatusAt(Date.now());
    }, []);

    useEffect(() => {
        (async () => {
            try {
                await loadSettings();
                await loadStatus();
            } catch (e) {
                setErr(e.response?.data?.error || e.message);
            } finally {
                setLoading(false);
            }
        })();
    }, [loadSettings, loadStatus]);

    // Quiet background refresh — skipped while an action runs (it refreshes on
    // its own when done) and while the tab is hidden.
    useEffect(() => {
        const timer = setInterval(() => {
            if (document.hidden || busyRef.current) return;
            loadStatus().catch(() => {});
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [loadStatus]);

    // With a single node there is nothing to choose: open it, once.
    useEffect(() => {
        if (autoOpened.current || !status?.nodes) return;
        autoOpened.current = true;
        if (status.nodes.length === 1) setOpenId(status.nodes[0].nodeId);
    }, [status]);

    const run = async (label, fn) => {
        setBusy(label);
        setErr("");
        setMsg("");
        try {
            const result = await fn();
            if (result) setMsg(result);
            await loadStatus();
        } catch (e) {
            setErr(e.response?.data?.error || e.message);
        } finally {
            setBusy(null);
        }
    };

    const set = (key) => (e) => {
        const value = e?.target?.type === "checkbox" ? e.target.checked : e?.target?.value ?? e;
        setForm((f) => ({ ...f, [key]: value }));
    };

    const setSource = (key) => (e) =>
        setForm((f) => ({ ...f, sources: { ...f.sources, [key]: e.target.checked } }));

    const setPlugin = (i, key) => (e) =>
        setForm((f) => {
            const plugins = f.plugins.map((p, idx) => (idx === i ? { ...p, [key]: e.target.value } : p));
            return { ...f, plugins };
        });

    const save = (sync) =>
        run(sync ? "Saving and syncing…" : "Saving…", async () => {
            // File mode: send the document AND the field edits. The server
            // writes the document first, then splices each field over the exact
            // bytes it replaces — so both ways of editing land in one save.
            const body = eff.custom
                ? {
                      heap: form.heap,
                      autoUpdate: form.autoUpdate,
                      autoInstallOnNewNode: form.autoInstallOnNewNode,
                      yamlOverride: form.yamlOverride,
                      configEdits: {
                          port: form.port,
                          address: form.address,
                          password: form.password,
                          sources: form.sources,
                          plugins: form.plugins,
                      },
                      sync,
                  }
                : { ...form, sync };

            const { data } = await api.put("/lavalink/settings", body, LONG);
            applyServerState(data);
            if (data.edit?.reformatted) {
                setMsg(
                    `Note: ${data.edit.inserted.join(", ")} was not in the file and had to be added — the file was reformatted.`,
                );
            }
            if (!data.sync) return "Config saved. Press “Save and sync all” to push it to the nodes.";
            const failed = data.sync.results.filter((r) => !r.ok);
            return failed.length
                ? `Saved. Sync failed on ${failed.length} node(s): ${failed.map((f) => f.nodeName).join(", ")}`
                : `Saved and synced ${data.sync.results.length} node(s).`;
        });

    /**
     * Switch which of the two editors owns the config.
     *
     * Form → file is free: the editor is seeded with the file the nodes already
     * run. File → form is not, because the form can only render what it models
     * — so the server reports what would be dropped and nothing happens until
     * that list has been shown and accepted.
     */
    const switchMode = async (target) => {
        if ((target === "file") === Boolean(eff.custom)) return;
        if (target === "file") {
            return run("Switching to file editing…", async () => {
                const { data } = await api.post("/lavalink/mode/file", {}, LONG);
                applyServerState(data);
                return "You now edit application.yml directly. Nothing has changed on the nodes yet.";
            });
        }
        setErr("");
        try {
            const { data } = await api.post("/lavalink/mode/form", {}, LONG);
            if (data.switched) return applyServerState(data);
            setSwitchPrompt({ dropped: data.dropped || [] });
        } catch (e) {
            setErr(e.response?.data?.error || e.message);
        }
    };

    const confirmSwitchToForm = () =>
        run("Switching back to the form…", async () => {
            const { data } = await api.post("/lavalink/mode/form", { confirm: true }, LONG);
            applyServerState(data);
            setSwitchPrompt(null);
            return data.dropped?.length
                ? `Switched back to the form. Dropped: ${data.dropped.join(", ")}. Press Sync to push it to the nodes.`
                : "Switched back to the form.";
        });

    const previewYaml = async () => {
        setErr("");
        try {
            const { data } = await api.get("/lavalink/yaml");
            setYaml(data.yaml);
            setShowYaml(true);
        } catch (e) {
            setErr(e.response?.data?.error || e.message);
        }
    };

    const checkUpdate = () =>
        run("Checking GitHub…", async () => {
            const { data } = await api.post("/lavalink/check-update", {}, LONG);
            await loadSettings();
            if (data.skipped) return data.skipped;
            if (data.upToDate) return `Every node is already on ${data.release.version}.`;
            if (data.autoUpdate === false) return `${data.release.version} is out — auto-update is off.`;
            const ok = (data.results || []).filter((r) => r.ok).length;
            return `${ok}/${(data.results || []).length} node(s) now on ${data.release?.version}.`;
        });

    const syncAll = () =>
        run("Syncing…", async () => {
            const { data } = await api.post("/lavalink/sync", { restart: true }, LONG);
            const failed = data.results.filter((r) => !r.ok);
            return failed.length
                ? `Failed on ${failed.length} node(s): ${failed.map((f) => f.nodeName).join(", ")}`
                : `Synced ${data.results.length} node(s).`;
        });

    const nodeAction = (node, action, label) =>
        run(`${label} — ${node.nodeName}…`, async () => {
            const { data } = await api.post(`/lavalink/nodes/${node.nodeId}/${action}`, {}, LONG);
            if (data.ok === false) throw new Error(data.error || "Failed");
            if (data.health && data.health.ok === false) return `${node.nodeName}: not answering /version yet (${data.health.error})`;
            return `${node.nodeName}: ${label} done.${tokenerNote(data.tokener)}`;
        });

    const toggleTokener = (node, enabled) =>
        run(`Turning Spotify tokener ${enabled ? "on" : "off"} — ${node.nodeName}…`, async () => {
            const { data } = await api.post(`/lavalink/nodes/${node.nodeId}/tokener`, { enabled }, LONG);
            if (data.ok === false) throw new Error(data.error || "Failed");
            const t = data.tokener;
            if (!enabled) return `${node.nodeName}: Spotify tokener turned off.`;
            const note = tokenerNote(t);
            if (note) return `${node.nodeName}: turned on.${note}`;
            if (t && !t.running) return `${node.nodeName}: turned on — Lavalink is stopped, the tokener will start along with it.`;
            return `${node.nodeName}: Spotify tokener turned on${t?.health?.ok ? " — it got a token" : ""}.`;
        });

    if (loading) return <p style={{ color: "var(--text-muted)" }}>Loading…</p>;
    if (!form) return <p style={{ color: "var(--danger)" }}>{err || "Could not load Lavalink settings."}</p>;

    // What the nodes actually run. With a hand-written application.yml this is
    // read back out of that file, so the page can never show a plugin list or a
    // port that nothing is using.
    const eff = effective || { custom: false, parseError: null, port: form.port, address: form.address, password: form.password, plugins: form.plugins || [], sources: form.sources || {} };
    // In file mode the checkboxes have to cover whatever the file declares —
    // production enables `spotify`, which the panel's own list has no box for.
    const sourceKeys = eff.custom
        ? [...new Set([...Object.keys(eff.sources || {}), ...SOURCES])]
        : SOURCES;
    const nodes = status?.nodes || [];
    const wantsTokener = Boolean(eff.tokenerPort);
    const runningCount = nodes.filter((n) => n.live?.status === "online").length;
    const driftCount = nodes.filter((n) => n.state === "config-drift").length;
    // A node that answers /v4/stats contributes a number; one that does not
    // contributes nothing, and the total says "not readable" rather than a
    // confident 0 that would hide a broken node.
    const withStats = nodes.filter((n) => n.stats);
    const totalPlayers = withStats.length ? withStats.reduce((a, n) => a + (n.stats.players ?? 0), 0) : null;
    const playingPlayers = withStats.reduce((a, n) => a + (n.stats.playingPlayers ?? 0), 0);
    // The fleet version is only meaningful when every running node agrees.
    const versions = [...new Set(nodes.filter((n) => n.version).map((n) => n.version))];
    const fleetVersion = versions.length === 1 ? versions[0] : versions.length ? "mixed" : null;
    const newerRelease = release?.version && fleetVersion && release.version !== fleetVersion;
    const needsJava = nodes.filter((n) => n.state === "java-missing" || n.state === "java-too-old");
    // Only when the config actually sends LavaSrc to a tokener on the node.
    const needsChrome = wantsTokener
        ? nodes.filter(
              (n) =>
                  n.online &&
                  n.tokenerEnabled !== false &&
                  n.tokener &&
                  !n.tokener.external &&
                  !n.tokener.foreignPm2 &&
                  !n.tokener.chrome?.present,
          )
        : [];
    const chromeArches = [...new Set(needsChrome.map((n) => (n.tokener.arch === "arm64" ? "arm64" : "x64")))];
    const cols = wantsTokener ? 8 : 7;

    return (
        <div className="fade-in page-compact">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Lavalink</h1>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                        One Lavalink per node, all sharing one config. Bots connect to{" "}
                        <code>127.0.0.1:{eff.port}</code> on their own node.
                    </p>
                </div>
                <span className="hide-mobile" style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    updated {fmtClock(statusAt)} · refreshes every 30s
                </span>
                <button className="btn-ghost" disabled={!!busy} onClick={() => run("Refreshing…", async () => null)}>
                    Refresh
                </button>
                <button className="btn-primary" disabled={!!busy} onClick={checkUpdate}>
                    Check for updates
                </button>
            </div>

            {busy && (
                <div
                    className="card"
                    style={{ padding: "10px 16px", marginBottom: 12, fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 10 }}
                >
                    <span
                        style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }}
                    />
                    {busy}
                </div>
            )}
            {err && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 12, color: "var(--danger)", fontSize: 13, border: "1px solid var(--danger-border)" }}>
                    {err}
                </div>
            )}
            {msg && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 12, color: "var(--success)", fontSize: 13, border: "1px solid var(--success-border)" }}>
                    {msg}
                </div>
            )}

            {/* ── Overview ────────────────────────────────────────────────── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
                <StatTile
                    label="Nodes running"
                    value={`${runningCount}/${nodes.length}`}
                    tone={nodes.length && runningCount === nodes.length ? "ok" : runningCount ? "warn" : "bad"}
                />
                <StatTile
                    label="Player"
                    value={totalPlayers === null ? "—" : `${totalPlayers}`}
                    sub={totalPlayers === null ? "unreadable" : `${playingPlayers} playing`}
                />
                <StatTile
                    label="Version"
                    value={fleetVersion || "—"}
                    sub={newerRelease ? `${release.version} available` : release?.version ? "latest" : release?.error || ""}
                    tone={newerRelease ? "warn" : undefined}
                />
                <StatTile
                    label="GitHub check"
                    value={fmtTime(settings?.lastCheckAt)}
                    sub={settings?.autoUpdate ? `auto-update 02:00 ${form.timezone}` : "auto-update is off"}
                />
            </div>
            {settings?.lastError && (
                <p style={{ margin: "-6px 0 14px", fontSize: 12, color: "var(--danger)" }}>{settings.lastError}</p>
            )}

            <div className="tab-bar" style={{ marginBottom: 16, display: "inline-flex" }}>
                <button className={`tab-item ${tab === "nodes" ? "active" : ""}`} onClick={() => setTab("nodes")}>
                    Node ({nodes.length})
                </button>
                <button className={`tab-item ${tab === "config" ? "active" : ""}`} onClick={() => setTab("config")}>
                    Config
                </button>
            </div>

            {/* ── Node ────────────────────────────────────────────────────── */}
            {tab === "nodes" && (
                <div className="slide-up">
                    {driftCount > 0 && (
                        <Alert
                            action={
                                <button className="btn-ghost" disabled={!!busy} onClick={syncAll}>
                                    Sync now
                                </button>
                            }
                        >
                            {driftCount} node(s) are running a file that differs from the panel's config. Sync rewrites the
                            file and restarts the node (music cuts out for a few seconds).
                        </Alert>
                    )}
                    {needsJava.length > 0 && (
                        <Alert>
                            {needsJava.map((n) => n.nodeName).join(", ")} has no Java 17+. The panel does not install system
                            packages — run this on that node:
                            <CopyCode text="sudo apt-get install -y openjdk-21-jre-headless" />
                        </Alert>
                    )}
                    {needsChrome.length > 0 && (
                        <Alert>
                            {needsChrome.map((n) => n.nodeName).join(", ")} has no Chrome, so spotify-tokener cannot
                            run and Spotify links fail on that node. Run this on the node, then press Sync:
                            {chromeArches.map((arch) => (
                                <div key={arch}>
                                    {chromeArches.length > 1 && (
                                        <span style={{ fontSize: 11 }}>{arch === "arm64" ? "ARM64" : "x86_64"}</span>
                                    )}
                                    <CopyCode text={CHROME_INSTALL[arch]} />
                                </div>
                            ))}
                        </Alert>
                    )}

                    {nodes.length === 0 ? (
                        <div className="card" style={{ padding: 30, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
                            No node is enabled yet.
                        </div>
                    ) : (
                        <div className="card scroll-x" style={{ padding: 0 }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Node</th>
                                        <th>Status</th>
                                        <th>Player</th>
                                        <th className="hide-mobile">Version</th>
                                        <th className="hide-mobile">RAM</th>
                                        <th className="hide-mobile">Uptime</th>
                                        <th className="hide-mobile">Restart</th>
                                        {wantsTokener && <th className="hide-mobile">Tokener</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {nodes.map((n) => (
                                        <NodeRows
                                            key={n.nodeId}
                                            n={n}
                                            cols={cols}
                                            open={openId === n.nodeId}
                                            onToggle={() => setOpenId((cur) => (cur === n.nodeId ? null : n.nodeId))}
                                            wantsTokener={wantsTokener}
                                            busy={busy}
                                            onAction={(action, label) => nodeAction(n, action, label)}
                                            onTokener={(enabled) => toggleTokener(n, enabled)}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--text-dim)" }}>
                        Click a node to open its controls and live log.
                    </p>
                </div>
            )}

            {/* ── Config ──────────────────────────────────────────────────── */}
            {tab === "config" && (
                <div className="slide-up" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div className="card" style={{ padding: "18px 20px" }}>
                        <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700 }}>Operation</h2>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, alignItems: "end" }}>
                            <Field label="Heap (-Xmx)" hint="JVM flag for running Lavalink, not part of the yaml">
                                <input className="input" value={form.heap ?? ""} onChange={set("heap")} />
                            </Field>
                            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, paddingBottom: 22 }}>
                                <input type="checkbox" checked={!!form.autoUpdate} onChange={set("autoUpdate")} />
                                Auto-update at 02:00 ({form.timezone})
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, paddingBottom: 22 }}>
                                <input type="checkbox" checked={!!form.autoInstallOnNewNode} onChange={set("autoInstallOnNewNode")} />
                                Install on newly added nodes
                            </label>
                        </div>
                    </div>

                    <div className="card" style={{ padding: "18px 20px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Shared config</h2>
                            <div style={{ display: "flex", gap: 6 }}>
                                <ModePill active={!eff.custom} disabled={!!busy} onClick={() => switchMode("form")}>
                                    Panel form
                                </ModePill>
                                <ModePill active={eff.custom} disabled={!!busy} onClick={() => switchMode("file")}>
                                    File application.yml
                                </ModePill>
                            </div>
                        </div>

                        <div
                            style={{
                                padding: "10px 14px",
                                marginBottom: 16,
                                borderRadius: 8,
                                border: "1px solid var(--border)",
                                background: "var(--bg-input)",
                                fontSize: 12,
                                color: "var(--text-muted)",
                            }}
                        >
                            {eff.custom ? (
                                <>
                                    The file below is the real config; the panel pushes it as-is to every node. The fields{" "}
                                    <strong>edit the file directly</strong> — only that value changes; comments,
                                    indentation and every other block (plugin settings, proxy, Spotify keys…) stay as they are.
                                </>
                            ) : (
                                <>
                                    The panel generates application.yml from the fields below. For anything the form does not cover,
                                    switch to <strong>File application.yml</strong> and write it by hand.
                                </>
                            )}
                            {eff.parseError && (
                                <span style={{ display: "block", marginTop: 6, color: "var(--danger)" }}>
                                    The file has a syntax error: {eff.parseError} — fix it in the yaml box and save again.
                                </span>
                            )}
                        </div>

                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                            <Field label="Port" hint={eff.custom ? "writes server.port" : undefined}>
                                <input className="input" value={form.port ?? ""} onChange={set("port")} />
                            </Field>
                            <Field
                                label="Bind address"
                                hint={eff.custom ? "writes server.address" : "0.0.0.0 so other nodes can reach it; 127.0.0.1 to close it"}
                            >
                                <input className="input" value={form.address ?? ""} onChange={set("address")} />
                            </Field>
                            <Field
                                label="Password"
                                hint={eff.custom ? "writes lavalink.server.password" : "Bots authenticate with exactly this string"}
                            >
                                <div style={{ display: "flex", gap: 6 }}>
                                    <input
                                        className="input"
                                        type={showPassword ? "text" : "password"}
                                        value={form.password ?? ""}
                                        onChange={set("password")}
                                    />
                                    <button
                                        type="button"
                                        className="btn-ghost"
                                        style={{ padding: "0 10px" }}
                                        onClick={() => setShowPassword((v) => !v)}
                                    >
                                        {showPassword ? "Hide" : "Show"}
                                    </button>
                                </div>
                            </Field>
                        </div>

                        <p style={{ margin: "18px 0 8px", fontSize: 12, color: "var(--text-muted)" }}>Sources</p>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                            {sourceKeys.map((key) => (
                                <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                                    <input type="checkbox" checked={form.sources?.[key] === true} onChange={setSource(key)} />
                                    {key}
                                </label>
                            ))}
                        </div>
                        {!eff.custom && (
                            <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--text-dim)" }}>
                                With the youtube plugin, the built-in youtube source is turned off automatically — Lavalink
                                does not start with both on.
                            </p>
                        )}

                        <p style={{ margin: "18px 0 8px", fontSize: 12, color: "var(--text-muted)" }}>
                            Plugins{eff.custom ? " — lavalink.plugins in the file" : ""}
                        </p>
                        {(form.plugins || []).map((p, i) => (
                            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                                <input
                                    className="input"
                                    style={{ flex: 2, minWidth: 240 }}
                                    value={p.dependency}
                                    placeholder="group:artifact:version"
                                    onChange={setPlugin(i, "dependency")}
                                />
                                <input
                                    className="input"
                                    style={{ flex: 2, minWidth: 200 }}
                                    value={p.repository || ""}
                                    placeholder="https://maven.lavalink.dev/releases"
                                    onChange={setPlugin(i, "repository")}
                                />
                                <label
                                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)" }}
                                    title="Snapshot build — from the snapshot repo instead of releases"
                                >
                                    <input
                                        type="checkbox"
                                        checked={p.snapshot === true}
                                        onChange={(e) =>
                                            setForm((f) => ({
                                                ...f,
                                                plugins: f.plugins.map((x, idx) =>
                                                    idx === i ? { ...x, snapshot: e.target.checked } : x,
                                                ),
                                            }))
                                        }
                                    />
                                    snapshot
                                </label>
                                <button
                                    type="button"
                                    className="btn-danger"
                                    style={{ padding: "0 12px" }}
                                    onClick={() => setForm((f) => ({ ...f, plugins: f.plugins.filter((_, idx) => idx !== i) }))}
                                >
                                    Remove
                                </button>
                            </div>
                        ))}
                        <button
                            type="button"
                            className="btn-ghost"
                            style={{ padding: "6px 12px", fontSize: 12 }}
                            onClick={() =>
                                setForm((f) => ({
                                    ...f,
                                    plugins: [
                                        ...(f.plugins || []),
                                        { dependency: "", repository: "https://maven.lavalink.dev/releases", snapshot: false },
                                    ],
                                }))
                            }
                        >
                            + Add plugin
                        </button>

                        {eff.custom && (
                            <div style={{ marginTop: 18 }}>
                                <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--text-muted)" }}>
                                    application.yml — edit directly
                                </p>
                                <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--text-dim)" }}>
                                    Edit the whole file here, or use the fields above for the familiar settings. One save
                                    applies both: the file is written first, then the fields overwrite just their own
                                    values.
                                </p>
                                <textarea
                                    className="input"
                                    spellCheck={false}
                                    style={{ minHeight: 420, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                                    value={form.yamlOverride || ""}
                                    onChange={(e) => setForm((f) => ({ ...f, yamlOverride: e.target.value }))}
                                />
                            </div>
                        )}
                    </div>

                    {/* Always within reach, however long the yaml above gets. */}
                    <div
                        className="card"
                        style={{
                            position: "sticky",
                            bottom: 12,
                            zIndex: 5,
                            padding: "12px 16px",
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                            alignItems: "center",
                            boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
                        }}
                    >
                        <span style={{ flex: 1, minWidth: 180, fontSize: 12, color: "var(--text-dim)" }}>
                            Save only writes to the panel. Nodes change only when synced.
                        </span>
                        {!eff.custom && (
                            <button className="btn-ghost" disabled={!!busy} onClick={previewYaml}>
                                View application.yml
                            </button>
                        )}
                        <button className="btn-ghost" disabled={!!busy} onClick={() => save(false)}>
                            Save
                        </button>
                        <button className="btn-primary" disabled={!!busy} onClick={() => save(true)}>
                            Save and sync all
                        </button>
                    </div>
                </div>
            )}

            {/* ── Modals ──────────────────────────────────────────────────── */}
            {switchPrompt && (
                <Modal title="Switch back to the panel form?" onClose={() => setSwitchPrompt(null)}>
                    <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-muted)" }}>
                        The form only generates what it can describe. These parts of the file will{" "}
                        <strong style={{ color: "var(--danger)" }}>disappear</strong> on the next sync:
                    </p>
                    {switchPrompt.dropped.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--success)" }}>Nothing is lost.</p>
                    ) : (
                        <ul style={{ margin: "0 0 14px", paddingLeft: 20, fontSize: 13 }}>
                            {switchPrompt.dropped.map((d) => (
                                <li key={d} style={{ marginBottom: 4 }}>
                                    <code>{d}</code>
                                </li>
                            ))}
                        </ul>
                    )}
                    <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-dim)" }}>
                        Port, password, sources and the plugin list are kept. Nodes keep running the old file until
                        you press Sync.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setSwitchPrompt(null)}>
                            Keep the file
                        </button>
                        <button className="btn-danger" style={{ flex: 1 }} disabled={!!busy} onClick={confirmSwitchToForm}>
                            Switch anyway
                        </button>
                    </div>
                </Modal>
            )}
            {showYaml && (
                <Modal title="application.yml" onClose={() => setShowYaml(false)}>
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{yaml}</pre>
                </Modal>
            )}
        </div>
    );
}

function ModePill({ active, disabled, onClick, children }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            style={{
                background: active ? "var(--accent-dim)" : "var(--bg-input)",
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                color: active ? "var(--accent-hover)" : "var(--text-muted)",
                borderRadius: 999,
                padding: "5px 14px",
                fontSize: 12,
                fontWeight: active ? 600 : 400,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.6 : 1,
            }}
        >
            {children}
        </button>
    );
}

function Modal({ title, onClose, children }) {
    return (
        <div
            onClick={onClose}
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.6)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 100,
                padding: 20,
            }}
        >
            <div
                className="card"
                onClick={(e) => e.stopPropagation()}
                style={{ padding: 20, maxWidth: 900, width: "100%", maxHeight: "80vh", overflow: "auto" }}
            >
                <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, flex: 1 }}>{title}</h3>
                    <button className="btn-ghost" style={{ padding: "4px 10px" }} onClick={onClose}>
                        Close
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
