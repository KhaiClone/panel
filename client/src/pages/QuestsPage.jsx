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

export default function QuestsPage() {
    const [accounts, setAccounts] = useState([]);
    const [live, setLive] = useState({}); // accountId -> { [questId]: {name,taskType,needed,done,percent,state} }

    // Add-token form
    const [token, setToken] = useState("");
    const [preview, setPreview] = useState(null); // { accountId, username, quests }
    const [selected, setSelected] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null); // { ok, text }
    const esRef = useRef(null);

    const load = useCallback(async () => {
        try {
            const { data } = await api.get("/quests");
            setAccounts(data);
        } catch {}
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Realtime stream
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
                return;
            }
            const aid = evt.accountId;
            if (evt.type === "status") {
                setAccounts((prev) =>
                    prev.map((a) =>
                        a.accountId === aid
                            ? {
                                  ...a,
                                  status: evt.status,
                                  error: evt.error ?? a.error,
                                  running: evt.status === "running",
                              }
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
                    q.name = evt.name ?? q.name;
                    q.taskType = evt.taskType ?? q.taskType;
                    if (evt.needed != null) q.needed = evt.needed;
                    if (evt.done != null) q.done = evt.done;
                    if (evt.percent != null) q.percent = evt.percent;
                    if (evt.type === "quest_done") {
                        q.state = "done";
                        q.percent = 100;
                    } else {
                        q.state = "running";
                    }
                    acc[evt.questId] = q;
                    return { ...prev, [aid]: acc };
                });
            }
        };
        es.onerror = () => {}; // browser auto-reconnects
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
            if (!data.quests.length)
                setMsg({ ok: true, text: "Account này hiện không có quest khả dụng." });
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

    const stopAcc = async (aid) => {
        try {
            await api.post(`/quests/${aid}/stop`);
        } catch {}
    };
    const removeAcc = async (aid) => {
        try {
            await api.delete(`/quests/${aid}`);
            setAccounts((prev) => prev.filter((a) => a.accountId !== aid));
        } catch {}
    };

    const toggle = (id) =>
        setSelected((prev) => {
            const n = new Set(prev);
            n.has(id) ? n.delete(id) : n.add(id);
            return n;
        });

    return (
        <div style={{ padding: 20, maxWidth: 1000, margin: "0 auto" }}>
            <h1 style={{ fontSize: 22, marginBottom: 4 }}>Auto Quest</h1>
            <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 20 }}>
                Nhập token Discord để bot tự làm quest (chọn quest hoặc chạy tất cả). Chạy nền,
                khôi phục sau khi restart.
            </p>

            {/* Add token */}
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
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                            <b>{preview.username}</b> — chọn quest muốn chạy ({preview.quests.length} quest)
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            {preview.quests.map((q) => (
                                <label
                                    key={q.id}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 10,
                                        padding: "8px 10px",
                                        border: "1px solid var(--border)",
                                        borderRadius: 8,
                                        cursor: "pointer",
                                        fontSize: 13,
                                    }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selected.has(q.id)}
                                        onChange={() => toggle(q.id)}
                                    />
                                    <span style={{ flex: 1 }}>{q.name}</span>
                                    <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                                        {q.taskType} · {q.needed}s
                                    </span>
                                </label>
                            ))}
                        </div>
                        <button
                            style={{ ...btn("#5865f2"), marginTop: 12 }}
                            disabled={busy || selected.size === 0}
                            onClick={() => start("select")}
                        >
                            Chạy {selected.size} quest đã chọn
                        </button>
                    </div>
                )}
            </div>

            {/* Accounts */}
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>Account đang chạy ({accounts.length})</h2>
            {accounts.length === 0 && (
                <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Chưa có account nào.</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {accounts.map((a) => {
                    const st = STATUS[a.status] || { label: a.status, color: "#9ca3af" };
                    const quests = Object.entries(live[a.accountId] || {});
                    return (
                        <div
                            key={a.accountId}
                            style={{
                                border: "1px solid var(--border)",
                                borderRadius: 12,
                                padding: 14,
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
                                    {a.mode === "all" ? "Tất cả" : `${a.selectedQuestIds.length} quest`} · đã
                                    xong {a.completedCount}
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
                                <p style={{ fontSize: 12, color: "#f59e0b", marginTop: 6 }}>{a.error}</p>
                            )}
                            {quests.length > 0 && (
                                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                                    {quests.map(([qid, q]) => (
                                        <div key={qid} style={{ fontSize: 12 }}>
                                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                                                <span>
                                                    {q.state === "done" ? "✅ " : "▶ "}
                                                    {q.name}
                                                </span>
                                                <span style={{ color: "var(--text-dim)" }}>
                                                    {q.percent ?? 0}%
                                                </span>
                                            </div>
                                            <div
                                                style={{
                                                    height: 5,
                                                    borderRadius: 4,
                                                    background: "var(--border)",
                                                    marginTop: 3,
                                                    overflow: "hidden",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        height: "100%",
                                                        width: `${q.percent ?? 0}%`,
                                                        background: q.state === "done" ? "#22c55e" : "#3b82f6",
                                                        transition: "width .3s",
                                                    }}
                                                />
                                            </div>
                                        </div>
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
