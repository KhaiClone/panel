import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
//  LiveLog — a Server-Sent Events log tail.
//
//  The stream sends the last N lines, then every new one as it is written. So
//  a reconnect starts from a clean slate rather than appending that history a
//  second time, and a `panel-error` event (the node said no) stops for good
//  where a dropped connection is retried.
//
//  Lines are rendered once per animation frame: the history arrives as a burst
//  of hundreds of messages, and a render per message would stall the page.
//  The view follows new lines only while it is scrolled to the bottom —
//  scrolling up to read something must not be yanked away by the next line.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_LINES = 2000;
const RETRY_MS = [2000, 5000, 10000];

const lineColor = (text) => {
    if (/\b(ERROR|FATAL|SEVERE)\b|exception|failed/i.test(text)) return "var(--danger)";
    if (/\bWARN(ING)?\b/i.test(text)) return "var(--warning)";
    if (/\b(DEBUG|TRACE)\b/.test(text)) return "var(--text-dim)";
    return "var(--text)";
};

const STATE_LABEL = {
    connecting: { text: "Connecting…", color: "var(--text-muted)" },
    live: { text: "LIVE", color: "var(--success)" },
    retrying: { text: "Disconnected — retrying…", color: "var(--warning)" },
    error: { text: "Error", color: "var(--danger)" },
};

export default function LiveLog({ src, height = 360, toolbarStart = null, emptyText = "No log lines yet." }) {
    const [lines, setLines] = useState([]); // [{ id, text }]
    const [state, setState] = useState("connecting");
    const [error, setError] = useState("");
    const [paused, setPaused] = useState(false);
    const [pending, setPending] = useState(0);
    const [filter, setFilter] = useState("");
    const [atBottom, setAtBottom] = useState(true);

    const boxRef = useRef(null);
    const queueRef = useRef([]); // arrived but not rendered yet
    const frameRef = useRef(0);
    const idRef = useRef(0);
    const pausedRef = useRef(false);
    const stickRef = useRef(true);
    pausedRef.current = paused;

    const flush = useCallback(() => {
        frameRef.current = 0;
        if (pausedRef.current) {
            setPending(queueRef.current.length);
            return;
        }
        const batch = queueRef.current;
        if (!batch.length) return;
        queueRef.current = [];
        setLines((prev) => {
            const next = prev.concat(batch);
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        });
        setPending(0);
    }, []);

    const schedule = useCallback(() => {
        if (!frameRef.current) frameRef.current = requestAnimationFrame(flush);
    }, [flush]);

    useEffect(() => {
        let es = null;
        let retryTimer = null;
        let attempt = 0;
        let stopped = false;
        let token = "";
        try {
            token = localStorage.getItem("token") || "";
        } catch { /* no storage: the server answers with an auth error */ }

        const connect = () => {
            queueRef.current = [];
            setLines([]);
            setPending(0);
            setError("");
            setState(attempt ? "retrying" : "connecting");

            es = new EventSource(`${src}${src.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
            es.onopen = () => setState("live");
            es.onmessage = (e) => {
                attempt = 0;
                queueRef.current.push({ id: ++idRef.current, text: e.data });
                schedule();
            };
            es.addEventListener("panel-error", (e) => {
                stopped = true;
                es.close();
                setState("error");
                setError(e.data || "Could not read the log");
            });
            es.onerror = () => {
                if (stopped) return;
                es.close();
                const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
                attempt++;
                setState("retrying");
                retryTimer = setTimeout(connect, wait);
            };
        };

        connect();
        return () => {
            stopped = true;
            clearTimeout(retryTimer);
            es?.close();
            cancelAnimationFrame(frameRef.current);
            frameRef.current = 0;
        };
    }, [src, schedule]);

    // Resuming shows whatever piled up while paused.
    useEffect(() => {
        if (!paused && queueRef.current.length) schedule();
    }, [paused, schedule]);

    useLayoutEffect(() => {
        const box = boxRef.current;
        if (box && stickRef.current) box.scrollTop = box.scrollHeight;
    }, [lines, filter]);

    const onScroll = () => {
        const box = boxRef.current;
        if (!box) return;
        const near = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        stickRef.current = near;
        setAtBottom(near);
    };

    const toBottom = () => {
        const box = boxRef.current;
        if (!box) return;
        stickRef.current = true;
        setAtBottom(true);
        box.scrollTop = box.scrollHeight;
    };

    const needle = filter.trim().toLowerCase();
    const shown = needle ? lines.filter((l) => l.text.toLowerCase().includes(needle)) : lines;
    const badge = paused ? { text: "Paused", color: "var(--warning)" } : STATE_LABEL[state];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {toolbarStart}
                <span
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        color: badge.color,
                    }}
                >
                    <span
                        className={state === "live" && !paused ? "status-dot" : undefined}
                        style={{ width: 7, height: 7, borderRadius: "50%", background: badge.color }}
                    />
                    {badge.text}
                </span>
                <span style={{ flex: 1 }} />
                <input
                    className="input"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter…"
                    style={{ width: 160, padding: "5px 10px", fontSize: 12 }}
                />
                <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "5px 11px", fontSize: 12 }}
                    disabled={state === "error"}
                    onClick={() => setPaused((p) => !p)}
                >
                    {paused ? `Resume${pending ? ` (+${pending})` : ""}` : "Pause"}
                </button>
                <button
                    type="button"
                    className="btn-ghost"
                    style={{ padding: "5px 11px", fontSize: 12 }}
                    onClick={() => setLines([])}
                    title="Clears the screen only — the log file on the node is kept"
                >
                    Clear screen
                </button>
            </div>

            <div style={{ position: "relative" }}>
                <div
                    ref={boxRef}
                    onScroll={onScroll}
                    className="mono"
                    style={{
                        height,
                        overflowY: "auto",
                        background: "var(--bg-base)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "10px 14px",
                        fontSize: 12,
                        lineHeight: 1.55,
                    }}
                >
                    {state === "error" ? (
                        <p style={{ margin: 0, color: "var(--danger)" }}>{error}</p>
                    ) : shown.length === 0 ? (
                        <p style={{ margin: 0, color: "var(--text-dim)", fontStyle: "italic" }}>
                            {state === "connecting" ? "Loading log…" : needle ? "No matching lines." : emptyText}
                        </p>
                    ) : (
                        shown.map((l) => (
                            <div key={l.id} style={{ color: lineColor(l.text), whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                {l.text}
                            </div>
                        ))
                    )}
                </div>
                {!atBottom && (
                    <button
                        type="button"
                        className="btn-primary"
                        onClick={toBottom}
                        style={{ position: "absolute", right: 14, bottom: 12, padding: "5px 12px", fontSize: 12 }}
                    >
                        ↓ Latest
                    </button>
                )}
            </div>
        </div>
    );
}
