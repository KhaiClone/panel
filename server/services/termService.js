const url = require("url");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const db = require("../db");
const nodeService = require("./nodeService");
const executor = require("./executor");

// ─────────────────────────────────────────────────────────────────────────────
//  Interactive terminal (WebSocket) for the panel.
//
//  Browser xterm.js  ⇄  ws://panel/api/term?token=<jwt>&node=<nodeId>
//                    |  ws://panel/api/term?token=<jwt>&bot=<botId>
//  Every session opens a WS to that node's agent /term and pipes frames both
//  ways. The panel spawns no shell of its own — the machine it runs on is
//  reached through its own agent like every other node.
//
//  ?bot= opens the shell in that project's folder on the project's node. The
//  folder comes from the bot record (executor.target), never from the browser.
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
// Frames the browser sends before the agent link is open (its first resize,
// early keystrokes). Bounded so a dead agent cannot grow it forever.
const MAX_PENDING_FRAMES = 200;

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
            wss.emit("connection", ws, query);
        });
    });

    wss.on("connection", (ws, query) => {
        // Listeners go on before any await: the browser sends its size the
        // moment the socket opens, and a frame that arrives with no listener
        // is gone — the PTY would stay 80x24 until the window next resized.
        const pending = [];
        let upstream = null;

        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });
        ws.on("message", (raw) => {
            const frame = raw.toString();
            if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
            else if (pending.length < MAX_PENDING_FRAMES) pending.push(frame);
        });
        ws.on("close", () => { try { upstream?.close(); } catch { /* already closing */ } });

        resolveSession(query)
            .then(({ node, target, banner }) => {
                if (ws.readyState !== WebSocket.OPEN) return; // browser left while we looked it up
                if (banner) safeSend(ws, { type: "data", data: `\x1b[90m${banner}\x1b[0m\r\n` });
                upstream = connectAgent(ws, node, target, pending);
            })
            .catch((err) => {
                safeSend(ws, { type: "data", data: `\r\n[panel] ${err.message}\r\n` });
                ws.close();
            });
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

/** Which node to open a shell on, where to start it, and what to print first. */
const resolveSession = async (query) => {
    if (query.bot) {
        const bot = await db.findOne("bots", { _id: query.bot });
        if (!bot) throw new Error("Project not found.");
        const node = await nodeService.getNode(bot.nodeId);
        // A static site with a domain is served by nginx and has no pm2 process.
        const nginxOnly = bot.projectType === "website" && bot.websiteConfig?.mode === "static" && bot.websiteConfig?.domain;
        return {
            node,
            // nodeVersion puts the project's pinned Node first on the shell's PATH.
            target: { ...executor.target(bot), ...(bot.nodeVersion ? { nodeVersion: bot.nodeVersion } : {}) },
            banner: `[panel] ${bot.name} on ${node.name}${nginxOnly ? " · served by nginx" : ` · pm2: ${bot.pm2Name}`}` +
                (bot.nodeVersion ? ` · node v${bot.nodeVersion}` : ""),
        };
    }
    if (!query.node) throw new Error("No node selected — pick one in the switcher.");
    return { node: await nodeService.getNode(query.node), target: null, banner: null };
};

// ── PTY on the node's agent — pipe frames straight through ───────────────────
const connectAgent = (ws, node, target, pending) => {
    // controlHost keeps this on the loopback for the node the panel shares a machine with
    const agentUrl = new URL(`ws://${node.controlHost || node.host}:${node.port}/term`);
    for (const [key, value] of Object.entries(target || {})) agentUrl.searchParams.set(key, value);

    const upstream = new WebSocket(agentUrl.toString(), { headers: { "x-agent-key": node.apiKey } });

    upstream.on("open", () => {
        for (const frame of pending.splice(0)) upstream.send(frame);
    });
    upstream.on("message", (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data.toString()); });
    upstream.on("close", () => { if (ws.readyState === WebSocket.OPEN) ws.close(); });
    upstream.on("error", (err) => {
        safeSend(ws, { type: "data", data: `\r\n[panel] Cannot reach node "${node.name}": ${err.message}\r\n` });
        if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    return upstream;
};

const safeSend = (ws, obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

module.exports = { attachTermServer };
