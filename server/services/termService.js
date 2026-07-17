const url = require("url");
const os = require("os");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Interactive terminal (WebSocket) for the panel.
//
//  Browser xterm.js  ⇄  ws://panel/api/term?token=<jwt>&node=<nodeId>
//    node=local (or absent) → spawn a PTY on the panel VPS (panel's own user)
//    node=<id>              → open a WS to that node's agent /term and pipe
//
//  Same JSON frame protocol both ways as the agent:
//    client → server : { type:"input", data } | { type:"resize", cols, rows }
//    server → client : { type:"data", data }  | { type:"exit", code }
//
//  Admin-only: the JWT is verified in the upgrade handshake (browsers can't
//  send auth headers on a WebSocket), matching the ?token= pattern the panel
//  already uses for log streaming and downloads.
// ─────────────────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const attachTermServer = (httpServer) => {
    const wss = new WebSocket.Server({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);
        if (pathname !== "/api/term") return; // not ours — leave it alone

        let user;
        try {
            user = jwt.verify(query.token || "", process.env.JWT_SECRET);
        } catch {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }
        if (user.role !== "admin") {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, query.node || "local");
        });
    });

    wss.on("connection", (ws, nodeId) => {
        if (!nodeId || nodeId === nodeService.LOCAL_NODE_ID) {
            handleLocal(ws);
        } else {
            handleRemote(ws, nodeId);
        }
    });

    // Keep-alive for the browser-facing sockets
    const pinger = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            try { ws.ping(); } catch { /* closing */ }
        });
    }, PING_INTERVAL_MS);
    wss.on("close", () => clearInterval(pinger));

    console.log("[Server] Terminal WebSocket ready on /api/term");
    return wss;
};

// ── Local PTY (panel VPS) ────────────────────────────────────────────────────
const handleLocal = (ws) => {
    let pty;
    try {
        pty = require("node-pty");
    } catch {
        safeSend(ws, { type: "data", data: "\r\n[panel] node-pty is not installed on the panel VPS.\r\n" });
        return ws.close();
    }

    const term = pty.spawn(process.env.SHELL || "bash", [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: process.env,
    });

    let idleTimer;
    const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { try { term.kill(); } catch { /* gone */ } }, IDLE_TIMEOUT_MS);
    };
    resetIdle();

    term.onData((data) => safeSend(ws, { type: "data", data }));
    term.onExit(({ exitCode }) => {
        safeSend(ws, { type: "exit", code: exitCode });
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === "input") { resetIdle(); term.write(msg.data); }
        else if (msg.type === "resize" && msg.cols && msg.rows) {
            try { term.resize(msg.cols, msg.rows); } catch { /* bad size */ }
        }
    });
    ws.on("close", () => { clearTimeout(idleTimer); try { term.kill(); } catch { /* gone */ } });
};

// ── Remote PTY (agent) — pipe frames straight through ────────────────────────
const handleRemote = async (ws, nodeId) => {
    let node;
    try {
        node = await nodeService.getNode(nodeId);
    } catch (err) {
        safeSend(ws, { type: "data", data: `\r\n[panel] ${err.message}\r\n` });
        return ws.close();
    }

    const agentUrl = `ws://${node.host}:${node.port}/term`;
    const upstream = new WebSocket(agentUrl, { headers: { "x-agent-key": node.apiKey } });

    upstream.on("open", () => {
        // Flush anything the browser typed before the agent link was ready
        ws.isAlive = true;
    });
    upstream.on("message", (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data.toString()); });
    upstream.on("close", () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
    upstream.on("error", (err) => {
        safeSend(ws, { type: "data", data: `\r\n[panel] Cannot reach node "${node.name}": ${err.message}\r\n` });
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(raw.toString());
    });
    ws.on("close", () => { try { upstream.close(); } catch { /* already closing */ } });
};

const safeSend = (ws, obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

module.exports = { attachTermServer };
