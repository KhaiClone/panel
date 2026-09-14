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
    const needsJava = nodes.filter((n) => n.state === "java-missing" || n.state === "java-too-old");

    return (
        <div className="fade-in page-compact">
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Lavalink</h1>
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
                        Một Lavalink trên mỗi node, dùng chung một cấu hình. Bot nối vào{" "}
                        <code>127.0.0.1:{eff.port}</code> ngay trên node của nó.
                    </p>
                </div>
                <button className="btn-ghost" disabled={!!busy} onClick={previewYaml}>
                    Xem application.yml
                </button>
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
                    Đồng bộ tất cả node
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

            {/* ── Release ─────────────────────────────────────────────────── */}
            <div className="card" style={{ padding: "16px 20px", marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
                    <div>
                        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>Bản mới nhất trên GitHub</p>
                        <p style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700 }}>
                            {release?.version || release?.error || "—"}
                        </p>
                    </div>
                    <div>
                        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>Fleet đang ở</p>
                        <p style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700 }}>
                            {settings?.installedVersion || "—"}
                        </p>
                    </div>
                    <div>
                        <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>Lần quét gần nhất</p>
                        <p style={{ margin: "2px 0 0", fontSize: 13 }}>{fmtTime(settings?.lastCheckAt)}</p>
                    </div>
                    <div style={{ flex: 1 }} />
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <input type="checkbox" checked={!!form.autoUpdate} onChange={set("autoUpdate")} />
                        Tự cập nhật 02:00 ({form.timezone})
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <input type="checkbox" checked={!!form.autoInstallOnNewNode} onChange={set("autoInstallOnNewNode")} />
                        Tự cài khi thêm node
                    </label>
                </div>
                {settings?.lastError && (
                    <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger)" }}>{settings.lastError}</p>
                )}
            </div>

            {needsJava.length > 0 && (
                <div
                    className="card"
                    style={{ padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "var(--warning)" }}
                >
                    {needsJava.map((n) => n.nodeName).join(", ")} chưa có Java 17+. Panel không tự cài gói hệ thống —
                    chạy tay trên node đó:{" "}
                    <code style={{ color: "var(--text)" }}>sudo apt-get install -y openjdk-17-jre-headless</code>
                </div>
            )}

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
                    <button className="btn-ghost" disabled={!!busy} onClick={() => save(false)}>
                        Lưu
                    </button>
                    <button className="btn-primary" disabled={!!busy} onClick={() => save(true)}>
                        Lưu và đồng bộ tất cả
                    </button>
                </div>
            </div>

            {/* ── Nodes ───────────────────────────────────────────────────── */}
            <div className="card" style={{ padding: "18px 20px" }}>
                <h2 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700 }}>Node</h2>
                {nodes.length === 0 && (
                    <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Chưa có node nào được bật.</p>
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {nodes.map((n) => (
                        <div
                            key={n.nodeId}
                            style={{
                                display: "flex",
                                gap: 12,
                                alignItems: "center",
                                flexWrap: "wrap",
                                padding: "12px 0",
                                borderTop: "1px solid var(--border-light)",
                            }}
                        >
                            <div style={{ minWidth: 160 }}>
                                <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{n.nodeName}</p>
                                <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-dim)" }}>{n.host}</p>
                            </div>
                            <Pill state={n.state} />
                            <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 70 }}>
                                {n.version || "—"}
                            </span>
                            <span style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 110 }}>
                                {n.java?.present ? `java ${n.java.major ?? "?"}` : "no java"} · {fmtGB(n.freeBytes)} free
                            </span>
                            {n.error && (
                                <span style={{ fontSize: 11, color: "var(--danger)", flex: 1, minWidth: 200 }}>
                                    {n.error}
                                </span>
                            )}
                            <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                                {n.state === "not-installed" || n.state === "java-missing" || n.state === "java-too-old" ? (
                                    <button
                                        className="btn-ghost"
                                        style={{ padding: "6px 12px", fontSize: 12 }}
                                        disabled={!!busy || !n.online}
                                        onClick={() => nodeAction(n, "install", "Cài đặt")}
                                    >
                                        Cài đặt
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            className="btn-ghost"
                                            style={{ padding: "6px 12px", fontSize: 12 }}
                                            disabled={!!busy || !n.online}
                                            onClick={() => nodeAction(n, "update", "Cập nhật")}
                                        >
                                            Cập nhật
                                        </button>
                                        <button
                                            className="btn-ghost"
                                            style={{ padding: "6px 12px", fontSize: 12 }}
                                            disabled={!!busy || !n.online}
                                            onClick={() => nodeAction(n, "sync", "Đồng bộ config")}
                                        >
                                            Đồng bộ
                                        </button>
                                        <button
                                            className="btn-ghost"
                                            style={{ padding: "6px 12px", fontSize: 12 }}
                                            disabled={!!busy || !n.online}
                                            onClick={() => nodeAction(n, n.live?.status === "online" ? "restart" : "start", "Restart")}
                                        >
                                            {n.live?.status === "online" ? "Restart" : "Start"}
                                        </button>
                                    </>
                                )}
                                <button
                                    className="btn-ghost"
                                    style={{ padding: "6px 12px", fontSize: 12 }}
                                    disabled={!n.online}
                                    onClick={() => openLogs(n)}
                                >
                                    Logs
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

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
