import { useCallback, useEffect, useState } from "react";
import api from "../api/client";

// ─────────────────────────────────────────────────────────────────────────────
//  Lavalink — one audio server per node, one config for all of them.
//
//  Config is deliberately NOT per-node: you edit it here once and every node
//  gets the same application.yml. A node whose file differs shows as drift.
//
//  Bots connect to 127.0.0.1:<port> on their own node, so the password below is
//  what they authenticate with.
// ─────────────────────────────────────────────────────────────────────────────

// Downloading a ~100MB jar, restarting the JVM and waiting for its health check
// takes far longer than the client's 30s default.
const LONG = { timeout: 600_000 };

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

const fmtGB = (bytes) => (bytes == null ? "—" : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

const fmtMB = (bytes) => (bytes == null ? "—" : `${Math.round(bytes / 1024 ** 2)} MB`);

/** How long ago a pm2 start timestamp was, in the largest unit that fits. */
const fmtSince = (ts) => {
    if (!ts) return "—";
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 90) return `${secs} giây`;
    if (secs < 5400) return `${Math.round(secs / 60)} phút`;
    if (secs < 172800) return `${(secs / 3600).toFixed(1)} giờ`;
    return `${Math.round(secs / 86400)} ngày`;
};

function Pill({ state }) {
    const meta = STATE_META[state] || { label: state || "unknown", color: "var(--text-dim)" };
    return (
        <span
            className="badge"
            style={{ background: `${meta.color}22`, color: meta.color, border: `1px solid ${meta.color}33` }}
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

// ── Trạng thái ───────────────────────────────────────────────────────────────

const TONE = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--danger)" };

function Summary({ label, value, sub, tone }) {
    return (
        <div style={{ minWidth: 96 }}>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{label}</p>
            <p style={{ margin: "2px 0 0", fontSize: 18, fontWeight: 700, color: tone ? TONE[tone] : "var(--text)" }}>
                {value}
            </p>
            {sub ? <p style={{ margin: "1px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{sub}</p> : null}
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

/**
 * One node, one card.
 *
 * The numbers are chosen for the question this page exists to answer — "is my
 * music working?". `players` comes from Lavalink's own /v4/stats, so it says
 * whether bots are actually connected; pm2 can only say a JVM is alive.
 * `restarts` is on the card because a climbing count is the signature of the
 * crash loop that took an afternoon to find once.
 */
function NodeCard({ n, busy, onAction, onLogs }) {
    const meta = STATE_META[n.state] || { label: n.state || "unknown", color: "var(--text-dim)" };
    const live = n.live || {};
    const notInstalled = ["not-installed", "java-missing", "java-too-old"].includes(n.state);
    const running = live.status === "online";

    return (
        <div className="card" style={{ padding: "14px 16px", borderLeft: `3px solid ${meta.color}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 14, fontWeight: 700, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {n.nodeName}
                </span>
                <Pill state={n.state} />
            </div>
            <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--text-dim)" }}>
                {n.host}
                {n.version ? ` · Lavalink ${n.version}` : ""}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 12 }}>
                <Metric label="Uptime" value={running ? fmtSince(live.uptime) : "—"} dim={!running} />
                <Metric label="RAM" value={running ? fmtMB(live.memory) : "—"} dim={!running} />
                <Metric
                    label="Player"
                    value={n.stats ? `${n.stats.players ?? 0}` : running ? "?" : "—"}
                    dim={!n.stats?.players}
                />
                <Metric
                    label="Restart"
                    value={running ? String(live.restarts ?? 0) : "—"}
                    dim={!live.restarts}
                />
            </div>

            {n.stats?.playingPlayers > 0 && (
                <p style={{ margin: "-6px 0 10px", fontSize: 11, color: "var(--success)" }}>
                    {n.stats.playingPlayers} player đang phát nhạc
                </p>
            )}

            {n.state === "config-drift" && (
                <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--warning)" }}>
                    File trên node khác cấu hình của panel — bấm Đồng bộ để ghi đè và restart.
                </p>
            )}
            {n.error && (
                <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--danger)", wordBreak: "break-word" }}>
                    {n.error}
                </p>
            )}

            <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--text-dim)" }}>
                {n.java?.present ? `Java ${n.java.major ?? "?"}` : "chưa có Java"} · {fmtGB(n.freeBytes)} trống
                {n.hasRollback ? " · có bản jar cũ để rollback" : ""}
            </p>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {notInstalled ? (
                    <button
                        className="btn-ghost"
                        style={{ padding: "5px 11px", fontSize: 12 }}
                        disabled={!!busy || !n.online}
                        onClick={() => onAction("install", "Cài đặt")}
                    >
                        Cài đặt
                    </button>
                ) : (
                    <>
                        <button
                            className="btn-ghost"
                            style={{ padding: "5px 11px", fontSize: 12 }}
                            disabled={!!busy || !n.online}
                            onClick={() => onAction(running ? "restart" : "start", running ? "Restart" : "Start")}
                        >
                            {running ? "Restart" : "Start"}
                        </button>
                        {running && (
                            <button
                                className="btn-ghost"
                                style={{ padding: "5px 11px", fontSize: 12 }}
                                disabled={!!busy}
                                onClick={() => onAction("stop", "Dừng")}
                            >
                                Dừng
                            </button>
                        )}
                        <button
                            className="btn-ghost"
                            style={{ padding: "5px 11px", fontSize: 12 }}
                            disabled={!!busy || !n.online}
                            onClick={() => onAction("sync", "Đồng bộ config")}
                        >
                            Đồng bộ
                        </button>
                        <button
                            className="btn-ghost"
                            style={{ padding: "5px 11px", fontSize: 12 }}
                            disabled={!!busy || !n.online}
                            onClick={() => onAction("update", "Cập nhật")}
                        >
                            Cập nhật
                        </button>
                    </>
                )}
                <button
                    className="btn-ghost"
                    style={{ padding: "5px 11px", fontSize: 12 }}
                    disabled={!n.online}
                    onClick={onLogs}
                >
                    Logs
                </button>
            </div>
        </div>
    );
}

export default function LavalinkPage() {
    const [settings, setSettings] = useState(null);
    const [effective, setEffective] = useState(null);
    const [form, setForm] = useState(null);
    const [release, setRelease] = useState(null);
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null); // free-text description of what is running
    const [err, setErr] = useState("");
    const [msg, setMsg] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showYaml, setShowYaml] = useState(false);
    const [yaml, setYaml] = useState("");
    const [logs, setLogs] = useState(null); // { nodeName, text }
    const [switchPrompt, setSwitchPrompt] = useState(null); // { dropped: [] }
    const [configOpen, setConfigOpen] = useState(false);

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

    const loadStatus = useCallback(async () => {
        const { data } = await api.get("/lavalink/status", { timeout: 120_000 });
        setStatus(data);
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
        run(sync ? "Đang lưu và đồng bộ…" : "Đang lưu…", async () => {
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
                    `Lưu ý: ${data.edit.inserted.join(", ")} chưa có trong file nên phải thêm mới — file đã bị định dạng lại.`,
                );
            }
            if (!data.sync) return "Đã lưu cấu hình. Bấm “Đồng bộ tất cả node” để đẩy xuống các node.";
            const failed = data.sync.results.filter((r) => !r.ok);
            return failed.length
                ? `Đã lưu. Đồng bộ lỗi ở ${failed.length} node: ${failed.map((f) => f.nodeName).join(", ")}`
                : `Đã lưu và đồng bộ ${data.sync.results.length} node.`;
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
            return run("Đang chuyển sang chỉnh file…", async () => {
                const { data } = await api.post("/lavalink/mode/file", {}, LONG);
                applyServerState(data);
                return "Giờ bạn sửa trực tiếp application.yml. Chưa có gì thay đổi trên node.";
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
        run("Đang chuyển về form…", async () => {
            const { data } = await api.post("/lavalink/mode/form", { confirm: true }, LONG);
            applyServerState(data);
            setSwitchPrompt(null);
            return data.dropped?.length
                ? `Đã chuyển về form. Đã bỏ: ${data.dropped.join(", ")}. Bấm Đồng bộ để đẩy xuống node.`
                : "Đã chuyển về form.";
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
        run("Đang kiểm tra GitHub…", async () => {
            const { data } = await api.post("/lavalink/check-update", {}, LONG);
            await loadSettings();
            if (data.skipped) return data.skipped;
            if (data.upToDate) return `Mọi node đều đã ở bản ${data.release.version}.`;
            if (data.autoUpdate === false) return `Có bản ${data.release.version} — tự động cập nhật đang tắt.`;
            const ok = (data.results || []).filter((r) => r.ok).length;
            return `${ok}/${(data.results || []).length} node đã lên ${data.release?.version}.`;
        });

    const nodeAction = (node, action, label) =>
        run(`${label} — ${node.nodeName}…`, async () => {
            const { data } = await api.post(`/lavalink/nodes/${node.nodeId}/${action}`, {}, LONG);
            if (data.ok === false) throw new Error(data.error || "Thất bại");
            if (data.health && data.health.ok === false) return `${node.nodeName}: chưa trả lời /version (${data.health.error})`;
            return `${node.nodeName}: ${label.toLowerCase()} xong.`;
        });

    const openLogs = async (node) => {
        setErr("");
        try {
            const { data } = await api.get(`/lavalink/nodes/${node.nodeId}/logs`, { params: { lines: 200 } });
            setLogs({ nodeName: node.nodeName, text: data.logs || "(trống)" });
        } catch (e) {
            setErr(e.response?.data?.error || e.message);
        }
    };

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
    const fleetVersion = versions.length === 1 ? versions[0] : versions.length ? "không đồng nhất" : null;
    const needsJava = nodes.filter((n) => n.state === "java-missing" || n.state === "java-too-old");

    return (
        <div className="fade-in page-compact">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Lavalink</h1>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                        Mỗi node một Lavalink, dùng chung một cấu hình. Bot nối vào{" "}
                        <code>127.0.0.1:{eff.port}</code> ngay trên node của nó.
                    </p>
                </div>
                <button className="btn-ghost" disabled={!!busy} onClick={() => loadStatus()}>
                    Làm mới
                </button>
                <button className="btn-primary" disabled={!!busy} onClick={checkUpdate}>
                    Kiểm tra bản mới
                </button>
            </div>

            {busy && (
                <div className="card" style={{ padding: "10px 16px", marginBottom: 12, fontSize: 13, color: "var(--text-muted)" }}>
                    {busy}
                </div>
            )}
            {err && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 12, color: "var(--danger)", fontSize: 13 }}>
                    {err}
                </div>
            )}
            {msg && (
                <div className="card" style={{ padding: "12px 16px", marginBottom: 12, color: "var(--success)", fontSize: 13 }}>
                    {msg}
                </div>
            )}

            {/* ── Tổng quan ───────────────────────────────────────────────── */}
            <div className="card" style={{ padding: "16px 20px", marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <Summary
                        label="Node đang chạy"
                        value={`${runningCount}/${nodes.length}`}
                        tone={nodes.length && runningCount === nodes.length ? "ok" : runningCount ? "warn" : "bad"}
                    />
                    <Summary
                        label="Player"
                        value={totalPlayers === null ? "—" : `${totalPlayers}`}
                        sub={totalPlayers === null ? "không đọc được" : `${playingPlayers} đang phát`}
                    />
                    <Summary
                        label="Phiên bản"
                        value={fleetVersion || "—"}
                        sub={
                            release?.version && fleetVersion && release.version !== fleetVersion
                                ? `có bản ${release.version}`
                                : release?.version
                                  ? "mới nhất"
                                  : release?.error || ""
                        }
                        tone={release?.version && fleetVersion && release.version !== fleetVersion ? "warn" : "ok"}
                    />
                    <Summary label="Quét GitHub" value={fmtTime(settings?.lastCheckAt)} sub={`tự động 02:00 ${form.timezone}`} />
                    <div style={{ flex: 1 }} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                            <input type="checkbox" checked={!!form.autoUpdate} onChange={set("autoUpdate")} />
                            Tự cập nhật 02:00
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                            <input
                                type="checkbox"
                                checked={!!form.autoInstallOnNewNode}
                                onChange={set("autoInstallOnNewNode")}
                            />
                            Tự cài khi thêm node
                        </label>
                    </div>
                </div>
                {settings?.lastError && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger)" }}>{settings.lastError}</p>
                )}
            </div>

            {/* ── Node ────────────────────────────────────────────────────── */}
            {nodes.length === 0 ? (
                <div className="card" style={{ padding: 30, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
                    Chưa có node nào được bật.
                </div>
            ) : (
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))",
                        gap: 12,
                        marginBottom: 16,
                    }}
                >
                    {nodes.map((n) => (
                        <NodeCard
                            key={n.nodeId}
                            n={n}
                            busy={busy}
                            onAction={(action, label) => nodeAction(n, action, label)}
                            onLogs={() => openLogs(n)}
                        />
                    ))}
                </div>
            )}

            {needsJava.length > 0 && (
                <div
                    className="card"
                    style={{ padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "var(--warning)" }}
                >
                    {needsJava.map((n) => n.nodeName).join(", ")} chưa có Java 17+. Panel không tự cài gói hệ thống —
                    chạy tay trên node đó:{" "}
                    <code style={{ color: "var(--text)" }}>sudo apt-get install -y openjdk-21-jre-headless</code>
                </div>
            )}

            {driftCount > 0 && (
                <div
                    className="card"
                    style={{
                        padding: "12px 16px",
                        marginBottom: 16,
                        fontSize: 13,
                        color: "var(--warning)",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        flexWrap: "wrap",
                    }}
                >
                    <span style={{ flex: 1 }}>
                        {driftCount} node đang chạy file khác với cấu hình của panel. Đồng bộ sẽ ghi lại file và
                        restart node đó (đứt nhạc vài giây).
                    </span>
                    <button
                        className="btn-ghost"
                        disabled={!!busy}
                        onClick={() =>
                            run("Đang đồng bộ…", async () => {
                                const { data } = await api.post("/lavalink/sync", { restart: true }, LONG);
                                const failed = data.results.filter((r) => !r.ok);
                                return failed.length
                                    ? `Lỗi ở ${failed.length} node: ${failed.map((f) => f.nodeName).join(", ")}`
                                    : `Đã đồng bộ ${data.results.length} node.`;
                            })
                        }
                    >
                        Đồng bộ ngay
                    </button>
                </div>
            )}

            {/* ── Cấu hình (gấp lại — status mới là thứ xem hằng ngày) ────── */}
            <details open={configOpen} onToggle={(e) => setConfigOpen(e.target.open)} style={{ marginBottom: 16 }}>
                <summary
                    style={{
                        cursor: "pointer",
                        padding: "12px 20px",
                        borderRadius: 10,
                        border: "1px solid var(--border)",
                        background: "var(--bg-card)",
                        fontSize: 14,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                    }}
                >
                    Cấu hình dùng chung
                    <span
                        className="badge"
                        style={{
                            background: "var(--bg-input)",
                            color: "var(--text-muted)",
                            border: "1px solid var(--border)",
                            fontWeight: 400,
                        }}
                    >
                        {eff.custom ? "file application.yml" : "form của panel"}
                    </span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontWeight: 400 }}>
                        port {eff.port} · {(eff.plugins || []).length} plugin
                    </span>
                </summary>
                <div style={{ marginTop: 12 }}>
            {/* ── Shared config ───────────────────────────────────────────── */}
            <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                    <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, flex: 1 }}>Cấu hình dùng chung</h2>
                    <div style={{ display: "flex", gap: 6 }}>
                        <ModePill active={!eff.custom} disabled={!!busy} onClick={() => switchMode("form")}>
                            Form của panel
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
                            File bên dưới là cấu hình thật, panel đẩy nguyên văn xuống mọi node. Các ô nhập{" "}
                            <strong>sửa thẳng vào file</strong> — chỉ thay đúng giá trị đó, giữ nguyên comment, thụt
                            lề và mọi khối khác (plugin settings, proxy, key Spotify…).
                        </>
                    ) : (
                        <>
                            Panel tự sinh application.yml từ các ô bên dưới. Cần khai báo gì form không có thì chuyển
                            sang <strong>File application.yml</strong> để viết tay.
                        </>
                    )}
                    {eff.parseError && (
                        <span style={{ display: "block", marginTop: 6, color: "var(--danger)" }}>
                            File đang lỗi cú pháp: {eff.parseError} — sửa trong ô yaml rồi lưu lại.
                        </span>
                    )}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                    <Field label="Port" hint={eff.custom ? "ghi vào server.port" : undefined}>
                        <input className="input" value={form.port ?? ""} onChange={set("port")} />
                    </Field>
                    <Field
                        label="Bind address"
                        hint={eff.custom ? "ghi vào server.address" : "0.0.0.0 để node khác gọi được; 127.0.0.1 để đóng lại"}
                    >
                        <input className="input" value={form.address ?? ""} onChange={set("address")} />
                    </Field>
                    <Field label="Heap (-Xmx)" hint="Cờ JVM, không nằm trong yaml">
                        <input className="input" value={form.heap ?? ""} onChange={set("heap")} />
                    </Field>
                    <Field
                        label="Password"
                        hint={eff.custom ? "ghi vào lavalink.server.password" : "Bot dùng đúng chuỗi này để xác thực"}
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
                                {showPassword ? "Ẩn" : "Hiện"}
                            </button>
                        </div>
                    </Field>
                </div>

                <p style={{ margin: "18px 0 8px", fontSize: 12, color: "var(--text-muted)" }}>Nguồn nhạc</p>
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
                        Khi có plugin youtube, nguồn youtube gốc tự động bị tắt — Lavalink không chạy được nếu bật cả hai.
                    </p>
                )}

                <p style={{ margin: "18px 0 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    Plugin{eff.custom ? " — lavalink.plugins trong file" : ""}
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
                            title="Bản snapshot — lấy từ repo snapshot thay vì release"
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
                            Xoá
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
                    + Thêm plugin
                </button>

                {eff.custom && (
                    <div style={{ marginTop: 18 }}>
                        <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--text-muted)" }}>
                            application.yml — sửa trực tiếp
                        </p>
                        <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--text-dim)" }}>
                            Sửa cả file ở đây, hoặc dùng các ô phía trên cho những trường quen thuộc. Lưu một lần là
                            áp dụng cả hai: file được ghi trước, rồi các ô mới ghi đè đúng giá trị của chúng.
                        </p>
                        <textarea
                            className="input"
                            spellCheck={false}
                            style={{ minHeight: 340, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5 }}
                            value={form.yamlOverride || ""}
                            onChange={(e) => setForm((f) => ({ ...f, yamlOverride: e.target.value }))}
                        />
                    </div>
                )}

                <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                    {!eff.custom && (
                        <button className="btn-ghost" disabled={!!busy} onClick={previewYaml}>
                            Xem application.yml sẽ sinh ra
                        </button>
                    )}
                    <button className="btn-ghost" disabled={!!busy} onClick={() => save(false)}>
                        Lưu
                    </button>
                    <button className="btn-primary" disabled={!!busy} onClick={() => save(true)}>
                        Lưu và đồng bộ tất cả
                    </button>
                </div>
            </div>
                </div>
            </details>

            {/* ── Modals ──────────────────────────────────────────────────── */}
            {switchPrompt && (
                <Modal title="Chuyển về form của panel?" onClose={() => setSwitchPrompt(null)}>
                    <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-muted)" }}>
                        Form chỉ sinh ra những gì nó mô tả được. Những phần sau đang có trong file sẽ{" "}
                        <strong style={{ color: "var(--danger)" }}>biến mất</strong> ở lần đồng bộ kế tiếp:
                    </p>
                    {switchPrompt.dropped.length === 0 ? (
                        <p style={{ fontSize: 13, color: "var(--success)" }}>Không mất gì cả.</p>
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
                        Port, password, nguồn và danh sách plugin được giữ lại. Node vẫn chạy file cũ cho đến khi
                        bạn bấm Đồng bộ.
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button className="btn-ghost" style={{ flex: 1 }} onClick={() => setSwitchPrompt(null)}>
                            Giữ nguyên file
                        </button>
                        <button className="btn-danger" style={{ flex: 1 }} disabled={!!busy} onClick={confirmSwitchToForm}>
                            Vẫn chuyển
                        </button>
                    </div>
                </Modal>
            )}
            {showYaml && (
                <Modal title="application.yml" onClose={() => setShowYaml(false)}>
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{yaml}</pre>
                </Modal>
            )}
            {logs && (
                <Modal title={`Lavalink logs — ${logs.nodeName}`} onClose={() => setLogs(null)}>
                    <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {logs.text}
                    </pre>
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
                        Đóng
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}
