import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useNode } from "../context/NodeContext";

// Interactive shell for the selected node (header switcher). Connects a
// browser xterm.js session to the panel's /api/term WebSocket, which either
// spawns a local PTY or pipes through to the node's agent.

const TERM_THEME = {
    background: "#0b0e14",
    foreground: "#d7dce5",
    cursor: "#7c93f4",
    selectionBackground: "#2a3350",
    black: "#1c2130", red: "#ef4444", green: "#22c55e", yellow: "#f59e0b",
    blue: "#60a5fa", magenta: "#a78bfa", cyan: "#06b6d4", white: "#d7dce5",
    brightBlack: "#4b5468", brightRed: "#f87171", brightGreen: "#4ade80",
    brightYellow: "#fbbf24", brightBlue: "#93c5fd", brightMagenta: "#c4b5fd",
    brightCyan: "#67e8f9", brightWhite: "#ffffff",
};

export default function TerminalPage() {
    const { nodeId, selectedNode, isRemote } = useNode();
    const containerRef = useRef(null);
    const termRef = useRef(null);
    const fitRef = useRef(null);
    const wsRef = useRef(null);
    const [status, setStatus] = useState("connecting"); // connecting | connected | closed
    const [reconnectKey, setReconnectKey] = useState(0);

    // Build the xterm instance once
    useEffect(() => {
        const term = new Terminal({
            fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
            fontSize: 13,
            cursorBlink: true,
            theme: TERM_THEME,
            scrollback: 5000,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        fit.fit();
        termRef.current = term;
        fitRef.current = fit;

        const onResize = () => {
            try {
                fit.fit();
                wsRef.current?.readyState === WebSocket.OPEN &&
                    wsRef.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            } catch { /* not ready */ }
        };
        const ro = new ResizeObserver(onResize);
        ro.observe(containerRef.current);
        window.addEventListener("resize", onResize);

        return () => {
            ro.disconnect();
            window.removeEventListener("resize", onResize);
            term.dispose();
        };
    }, []);

    // (Re)connect whenever the node or reconnect trigger changes
    useEffect(() => {
        const term = termRef.current;
        const fit = fitRef.current;
        if (!term) return;

        setStatus("connecting");
        term.reset();
        term.writeln(`\x1b[90mConnecting to ${isRemote ? selectedNode?.name || nodeId : "panel VPS (local)"}…\x1b[0m`);

        const token = localStorage.getItem("token");
        const proto = window.location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(
            `${proto}://${window.location.host}/api/term?token=${encodeURIComponent(token)}&node=${encodeURIComponent(nodeId)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
            setStatus("connected");
            try { fit.fit(); } catch { /* ignore */ }
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        };
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === "data") term.write(msg.data);
            else if (msg.type === "exit") {
                term.writeln(`\r\n\x1b[90m[session ended, code ${msg.code}]\x1b[0m`);
            }
        };
        ws.onclose = () => setStatus("closed");
        ws.onerror = () => setStatus("closed");

        const disposable = term.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
        });
        term.focus();

        return () => {
            disposable.dispose();
            try { ws.close(); } catch { /* already closing */ }
        };
    }, [nodeId, reconnectKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const dot = status === "connected" ? "var(--success)" : status === "connecting" ? "var(--warning)" : "var(--danger)";

    return (
        <div className="page fade-in" style={{ display: "flex", flexDirection: "column", height: "100%", maxWidth: 1400 }}>
            {/* Toolbar */}
            <div className="mobile-wrap" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <div>
                    <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--text)", margin: "0 0 4px" }}>Terminal</h1>
                    <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                        Shell on <strong style={{ color: "var(--text)" }}>{isRemote ? selectedNode?.name || nodeId : "panel VPS (local)"}</strong>
                        {isRemote && selectedNode?.host ? ` — ${selectedNode.host}` : ""}
                    </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
                        {status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected"}
                    </span>
                    {status === "closed" && (
                        <button className="btn-primary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => setReconnectKey((k) => k + 1)}>
                            Reconnect
                        </button>
                    )}
                </div>
            </div>

            {/* Terminal surface */}
            <div style={{ flex: 1, minHeight: 400, borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: TERM_THEME.background, padding: 8 }}>
                <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
            </div>

            <p style={{ fontSize: 11, color: "var(--text-dim)", margin: "10px 2px 0" }}>
                Switch the node from the ⬡ selector in the header to open a shell on a different machine. Sessions idle-timeout after 30 minutes.
            </p>
        </div>
    );
}
