const os = require("os");
const url = require("url");
const WebSocket = require("ws");
const pty = require("node-pty");
const { isValidAgentKey } = require("../middleware/auth");

// ─────────────────────────────────────────────────────────────────────────────
//  Interactive terminal over WebSocket.
//
//  The panel connects to ws://<host>:<port>/term with the shared x-agent-key
//  header and pipes a browser xterm.js session straight through to a real PTY
//  running the node's login shell. Protocol (JSON frames both ways):
//    client → agent : { type:"input", data } | { type:"resize", cols, rows }
//    agent  → client : { type:"data", data }  | { type:"exit", code }
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // kill a session with no input for 30m
const PING_INTERVAL_MS = 30 * 1000;

const createTermSocket = (server) => {
    const wss = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const { pathname } = url.parse(req.url);
        if (pathname !== "/term") return; // leave other upgrades alone

        if (!isValidAgentKey(req.headers["x-agent-key"])) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    wss.on("connection", (ws) => {
        const shell = process.env.SHELL || "bash";
        const term = pty.spawn(shell, [], {
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

        const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

        term.onData((data) => send({ type: "data", data }));
        term.onExit(({ exitCode }) => {
            send({ type: "exit", code: exitCode });
            if (ws.readyState === WebSocket.OPEN) ws.close();
        });

        ws.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (msg.type === "input") {
                resetIdle();
                term.write(msg.data);
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
                try { term.resize(msg.cols, msg.rows); } catch { /* ignore bad sizes */ }
            }
        });

        // Keep-alive: drop the PTY if the socket goes silently dead
        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });

        ws.on("close", () => {
            clearTimeout(idleTimer);
            try { term.kill(); } catch { /* already gone */ }
        });
    });

    // Ping every connection; terminate the ones that stop answering
    const pinger = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            try { ws.ping(); } catch { /* closing */ }
        });
    }, PING_INTERVAL_MS);
    wss.on("close", () => clearInterval(pinger));

    console.log("[Agent] Terminal WebSocket ready on /term");
    return wss;
};

module.exports = { createTermSocket };
