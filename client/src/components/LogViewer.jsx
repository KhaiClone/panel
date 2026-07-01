import { useState, useEffect, useRef } from "react";
import api from "../api/client";

export default function LogViewer({ botId }) {
    const [lines, setLines] = useState([]);
    const [live, setLive] = useState(false);
    const [loading, setLoading] = useState(true);
    const [clearing, setClearing] = useState(false);
    const bottomRef = useRef(null);
    const esRef = useRef(null); // EventSource ref

    // ── Snapshot load ──────────────────────────────────────────────────────────
    const fetchSnapshot = async () => {
        setLoading(true);
        try {
            const { data } = await api.get(`/logs/${botId}?lines=200`);
            const parsed = data.logs.split("\n").filter(Boolean);
            setLines(parsed);
        } catch {
            setLines(["[Error] Failed to fetch logs."]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSnapshot();
        return () => stopLive(); // cleanup on unmount
    }, [botId]);

    // Auto-scroll to bottom when new lines arrive
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [lines]);

    // ── Live streaming ─────────────────────────────────────────────────────────
    const startLive = () => {
        if (esRef.current) return;

        const token = localStorage.getItem("token");
        const es = new EventSource(`/api/logs/${botId}/stream?token=${token}`);

        es.onmessage = (e) => {
            setLines((prev) => {
                const next = [...prev, e.data];
                // Cap at 500 lines in memory
                return next.length > 500 ? next.slice(-500) : next;
            });
        };

        es.onerror = () => {
            setLines((prev) => [...prev, "[Stream] Connection lost."]);
            stopLive();
        };

        esRef.current = es;
        setLive(true);
    };

    const stopLive = () => {
        if (esRef.current) {
            esRef.current.close();
            esRef.current = null;
        }
        setLive(false);
    };

    const toggleLive = () => (live ? stopLive() : startLive());

    const clearLogs = async () => {
        if (!window.confirm("Xoá toàn bộ lịch sử log của project này?")) return;
        setClearing(true);
        try {
            await api.delete(`/logs/${botId}`);
            setLines([]);
        } catch {
            // silently ignore
        } finally {
            setClearing(false);
        }
    };

    // ── Color coding ──────────────────────────────────────────────────────────
    const colorLine = (line) => {
        if (/error|err|fail|fatal/i.test(line)) return "var(--danger)";
        if (/warn/i.test(line)) return "var(--warning)";
        if (/info|ready|online/i.test(line)) return "var(--success)";
        if (/debug/i.test(line)) return "var(--text-dim)";
        return "var(--text)";
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 20, background: "var(--bg-card)", height: 600 }}>
            {/* Toolbar */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                        Console Output
                    </span>
                    {live && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--success)", textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 8px", background: "var(--success-bg)", borderRadius: 99 }}>
                            <span className="status-dot" style={{ width: 6, height: 6, background: "var(--success)" }} />
                            Live
                        </span>
                    )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button className="btn-ghost" onClick={fetchSnapshot} disabled={loading || live} style={{ padding: "6px 12px" }}>
                        🔄 Refresh
                    </button>
                    <button
                        className="btn-ghost"
                        onClick={clearLogs}
                        disabled={clearing || live}
                        style={{ padding: "6px 12px", color: "var(--danger)", border: "1px solid var(--danger-border)", background: "rgba(239,68,68,0.05)" }}
                    >
                        {clearing ? "Clearing…" : "🗑 Clear Logs"}
                    </button>
                    <button className={live ? "btn-danger" : "btn-success"} onClick={toggleLive} style={{ padding: "6px 14px", fontWeight: 700 }}>
                        {live ? "⏹ Stop Stream" : "▶ Start Live Stream"}
                    </button>
                </div>
            </div>

            {/* Log output */}
            <div className="mono no-scrollbar" style={{ 
                flex: 1, background: "var(--bg-base)", border: "1px solid var(--border)", borderRadius: 10,
                padding: "16px 20px", overflowY: "auto", fontSize: 13, lineHeight: 1.6,
                boxShadow: "inset 0 4px 20px rgba(0,0,0,0.5)"
            }}>
                {loading && !lines.length ? (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
                        <div style={{ width: 30, height: 30, borderRadius: "50%", border: "3px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin 1s linear infinite" }} />
                    </div>
                ) : lines.length === 0 ? (
                    <p style={{ color: "var(--text-dim)", fontStyle: "italic", textAlign: "center", marginTop: 40 }}>No logs available.</p>
                ) : (
                    lines.map((line, i) => (
                        <div key={i} style={{ color: colorLine(line), whiteSpace: "pre-wrap", wordBreak: "break-all", marginBottom: 2 }}>
                            {line}
                        </div>
                    ))
                )}
                <div ref={bottomRef} />
            </div>
        </div>
    );
}
