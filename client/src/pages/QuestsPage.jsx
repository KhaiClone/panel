import { useState, useEffect, useCallback, useRef } from "react";
import api from "../api/client";

const STATUS = {
    running: { label: "Đang chạy", color: "#3b82f6" },
    done: { label: "Đã xong", color: "#22c55e" },
    stopped: { label: "Đã dừng", color: "#9ca3af" },
    token_dead: { label: "Token lỗi", color: "#f59e0b" },
    error: { label: "Lỗi", color: "#ef4444" },
};

const btn = (bg, extra = {}) => ({
    padding: "7px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: bg,
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
    ...extra,
});

const fmtDate = (iso) => {
    try {
        return new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
    } catch {
        return null;
    }
};
const hexColor = (c) => (typeof c === "string" && c.startsWith("#") ? c : null);

// ── Discord-style quest card ──────────────────────────────────────────────────────
function QuestCard({ q, selectable, selected, onToggle, progress }) {
    const m = q.media || {};
    const accent = hexColor(m.colors?.primary) || "#5865f2";
    const orbs = m.reward?.orbs;
    return (
        <div
            style={{
                borderRadius: 14,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--bg-card, #16171a)",
            }}
        >
            {/* Hero banner */}
            <div
                style={{
                    position: "relative",
                    aspectRatio: "16 / 6",
                    background: m.heroImage
                        ? `center/cover no-repeat url(${m.heroImage})`
                        : `linear-gradient(135deg, ${accent}, #111)`,
                }}
            >
                {m.heroVideo && (
                    <video
                        src={m.heroVideo}
                        autoPlay
                        muted
                        loop
                        playsInline
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                        }}
                    />
                )}
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        background: "linear-gradient(to top, rgba(0,0,0,.75), rgba(0,0,0,0) 55%)",
                    }}
                />
                {m.logotype && (
                    <img
                        src={m.logotype}
                        alt=""
                        style={{
                            position: "absolute",
                            left: 14,
                            bottom: 12,
                            height: 32,
                            maxWidth: "60%",
                            objectFit: "contain",
                            filter: "drop-shadow(0 2px 5px rgba(0,0,0,.6))",
                        }}
                    />
                )}
            </div>

            {/* Meta */}
            <div style={{ padding: 14 }}>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        marginBottom: 12,
                    }}
                >
                    <span>
                        Quảng bá bởi{" "}
                        <b style={{ color: "var(--text)" }}>
                            {m.gamePublisher || m.gameTitle || "—"}
                        </b>
                    </span>
                    {m.expiresAt && <span>Kết thúc {fmtDate(m.expiresAt)}</span>}
                </div>

                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    {m.gameTile && (
                        <img
                            src={m.gameTile}
                            alt=""
                            style={{ width: 52, height: 52, borderRadius: 14, objectFit: "cover", flexShrink: 0 }}
                        />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-dim)", letterSpacing: 0.5 }}>
                            NHIỆM VỤ {(m.gameTitle || q.name || "").toUpperCase()}
                        </div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>
                            {orbs ? `◈ Nhận ${orbs} Orbs` : q.name}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {q.taskType || "—"}
                            {q.needed ? ` · ${q.needed}s` : ""}
                        </div>
                    </div>
                    {selectable && (
                        <input
                            type="checkbox"
                            checked={selected}
                            onChange={onToggle}
                            style={{ width: 20, height: 20, flexShrink: 0, cursor: "pointer" }}
                        />
                    )}
                </div>

                {progress && (
                    <div style={{ marginTop: 12 }}>
                        <div
                            style={{
                                height: 6,
                                borderRadius: 4,
                                background: "var(--border)",
                                overflow: "hidden",
                            }}
                        >
                            <div
                                style={{
                                    height: "100%",
                                    width: `${progress.percent || 0}%`,
                                    background: progress.state === "done" ? "#22c55e" : accent,
                                    transition: "width .3s",
                                }}
                            />
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
                            {progress.state === "done" ? "✅ Hoàn thành" : `${progress.percent || 0}%`}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
    gap: 14,
};

export default function QuestsPage() {
    const [accounts, setAccounts] = useState([]);
    const [live, setLive] = useState({}); // accountId -> { [questId]: {...,media} }
    const [token, setToken] = useState("");
    const [preview, setPreview] = useState(null);
    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);
    const esRef = useRef(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/quests");
            setAccounts(data);
            setLive((prev) => {
                const n = { ...prev };
                for (const a of data) n[a.accountId] = { ...(n[a.accountId] || {}), ...(a.quests || {}) };
                return n;
            });
        } catch {}
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        const tok = localStorage.getItem("token");
        if (!tok) return;
        const es = new EventSource(`/api/quests/stream?token=${encodeURIComponent(tok)}`);
        esRef.current = es;
        es.onmessage = (e) => {
            let evt;
            try {
                evt = JSON.parse(e.data);
            } catch {
                return;
            }
            if (evt.type === "snapshot") {
                setAccounts(evt.accounts || []);
                setLive((prev) => {
                    const n = { ...prev };
                    for (const a of evt.accounts || [])
                        n[a.accountId] = { ...(n[a.accountId] || {}), ...(a.quests || {}) };
                    return n;
                });
                return;
            }
            const aid = evt.accountId;
            if (evt.type === "status") {
                setAccounts((prev) =>
                    prev.map((a) =>
                        a.accountId === aid
                            ? { ...a, status: evt.status, error: evt.error ?? a.error, running: evt.status === "running" }
                            : a,
                    ),
                );
            } else if (evt.type === "removed") {
                setAccounts((prev) => prev.filter((a) => a.accountId !== aid));
                setLive((prev) => {
                    const n = { ...prev };
                    delete n[aid];
                    return n;
                });
            } else if (["quest_start", "quest_progress", "quest_done"].includes(evt.type)) {
                setLive((prev) => {
                    const acc = { ...(prev[aid] || {}) };
                    const q = { ...(acc[evt.questId] || {}) };
                    if (evt.name) q.name = evt.name;
                    if (evt.taskType) q.taskType = evt.taskType;
                    if (evt.needed != null) q.needed = evt.needed;
                    if (evt.done != null) q.done = evt.done;
                    if (evt.percent != null) q.percent = evt.percent;
                    if (evt.media) q.media = evt.media;
                    q.state = evt.type === "quest_done" ? "done" : "running";
                    if (evt.type === "quest_done") q.percent = 100;
                    acc[evt.questId] = q;
                    return { ...prev, [aid]: acc };
                });
            }
        };
        es.onerror = () => {};
        return () => es.close();
    }, []);

    const doPreview = async () => {
        if (!token.trim()) return;
        setBusy(true);
        setMsg(null);
        setPreview(null);
        setSelected(new Set());
        try {
            const { data } = await api.post("/quests/preview", { token: token.trim() });
            setPreview(data);
            if (!data.quests.length) setMsg({ ok: true, text: "Account này hiện không có quest khả dụng." });
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || "Không lấy được quest." });
        } finally {
            setBusy(false);
        }
    };

    const start = async (mode) => {
        setBusy(true);
        setMsg(null);
        try {
            await api.post("/quests/start", {
                token: token.trim(),
                mode,
                selectedQuestIds: mode === "select" ? [...selected] : [],
            });
            setToken("");
            setPreview(null);
            setSelected(new Set());
            setMsg({ ok: true, text: "Đã bắt đầu chạy quest." });
            load();
        } catch (err) {
            setMsg({ ok: false, text: err.response?.data?.error || "Không bắt đầu được." });
        } finally {
            setBusy(false);
        }
    };

    const stopAcc = (aid) => api.post(`/quests/${aid}/stop`).catch(() => {});
    const removeAcc = (aid) =>
        api
            .delete(`/quests/${aid}`)
            .then(() => setAccounts((prev) => prev.filter((a) => a.accountId !== aid)))
            .catch(() => {});
    const toggle = (id) =>
        setSelected((prev) => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });

    return (
        <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>Auto Quest</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
                Nhập token Discord để bot tự làm quest (chọn quest hoặc chạy tất cả). Chạy nền, khôi
                phục sau restart.
            </p>

            <div
                style={{
                    background: "var(--bg-card, var(--bg))",
                    border: "1px solid var(--border)",
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 24,
                }}
            >
                <label className="label">Token Discord</label>
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <input
                        className="input"
                        style={{ flex: 1 }}
                        type="password"
                        placeholder="Dán token vào đây"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                    />
                    <button style={btn("#5865f2")} disabled={busy || !token.trim()} onClick={doPreview}>
                        Xem quest
                    </button>
                    <button
                        style={btn("#22c55e")}
                        disabled={busy || !token.trim()}
                        onClick={() => start("all")}
                        title="Chạy toàn bộ quest khả dụng"
                    >
                        Chạy tất cả
                    </button>
                </div>

                {msg && (
                    <p style={{ marginTop: 10, fontSize: 13, color: msg.ok ? "#22c55e" : "#ef4444" }}>
                        {msg.text}
                    </p>
                )}

                {preview && preview.quests.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 10 }}>
                            <b>{preview.username}</b> — chọn quest muốn chạy ({preview.quests.length})
                        </div>
                        <div style={gridStyle}>
                            {preview.quests.map((q) => (
                                <QuestCard
                                    key={q.id}
                                    q={q}
                                    selectable
                                    selected={selected.has(q.id)}
                                    onToggle={() => toggle(q.id)}
                                />
                            ))}
                        </div>
                        <button
                            style={{ ...btn("#5865f2"), marginTop: 14 }}
                            disabled={busy || selected.size === 0}
                            onClick={() => start("select")}
                        >
                            Chạy {selected.size} quest đã chọn
                        </button>
                    </div>
                )}
            </div>

            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Account ({accounts.length})</h2>
            {accounts.length === 0 && (
                <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Chưa có account nào.</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {accounts.map((a) => {
                    const st = STATUS[a.status] || { label: a.status, color: "#9ca3af" };
                    const quests = Object.entries(live[a.accountId] || {});
                    return (
                        <div key={a.accountId}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                <span style={{ fontWeight: 600 }}>{a.username}</span>
                                <span
                                    style={{
                                        fontSize: 11,
                                        padding: "2px 8px",
                                        borderRadius: 20,
                                        background: st.color + "22",
                                        color: st.color,
                                    }}
                                >
                                    {st.label}
                                </span>
                                <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                                    {a.mode === "all" ? "Tất cả" : `${a.selectedQuestIds.length} quest`} · đã xong{" "}
                                    {a.completedCount}
                                </span>
                                <span style={{ flex: 1 }} />
                                {a.status === "running" && (
                                    <button style={btn("#6b7280")} onClick={() => stopAcc(a.accountId)}>
                                        Dừng
                                    </button>
                                )}
                                <button style={btn("#ef4444")} onClick={() => removeAcc(a.accountId)}>
                                    Xoá
                                </button>
                            </div>
                            {a.error && (
                                <p style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8 }}>{a.error}</p>
                            )}
                            {quests.length > 0 && (
                                <div style={gridStyle}>
                                    {quests.map(([qid, q]) => (
                                        <QuestCard key={qid} q={{ ...q, id: qid }} progress={q} />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
