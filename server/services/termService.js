const url = require("url");
const os = require("os");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Interactive terminal (WebSocket) for the panel.
//
//  Browser xterm.js  ⇄  ws://panel/api/term?token=<jwt>&node=<nodeId>
//  Every session opens a WS to that node's agent /term and pipes frames both
//  ways. The panel spawns no shell of its own — the machine it runs on is
//  reached through its own agent like every other node.
//
//  Same JSON frame protocol both ways as the agent:
//    client → server : { type:"input", data } | { type:"resize", cols, rows }
//    server → client : { type:"data", data }  | { type:"exit", code }
//
//  The JWT is verified in the upgrade handshake (browsers can't send auth
//  headers on a WebSocket), matching the ?token= pattern the panel already uses
//  for log streaming and downloads.
// ─────────────────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const attachTermServer = (httpServer) => {
    const wss = new WebSocket.Server({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);
        if (pathname !== "/api/term") return; // not ours — leave it alone

        // A valid token is the only gate — the panel has a single account.
        try {
            jwt.verify(query.token || "", process.env.JWT_SECRET);
        } catch {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, query.node || null);
        });
    });

    wss.on("connection", (ws, nodeId) => {
        if (!nodeId) {
            safeSend(ws, { type: "data", data: "\r\n[panel] No node selected — pick one in the switcher.\r\n" });
            return ws.close();
        }
        handleNode(ws, nodeId);
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

// ── PTY on the node's agent — pipe frames straight through ───────────────────
const handleNode = async (ws, nodeId) => {
    let node;
    try {
        node = await nodeService.getNode(nodeId);
    } catch (err) {
        safeSend(ws, { type: "data", data: `\r\n[panel] ${err.message}\r\n` });
        return ws.close();
    }

    // controlHost keeps this on the loopback for the node the panel shares a machine with
    const agentUrl = `ws://${node.controlHost || node.host}:${node.port}/term`;
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

    ws.isAlive = true;
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
