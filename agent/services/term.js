const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");
const WebSocket = require("ws");
const { isValidAgentKey } = require("../middleware/auth");
const { resolveTarget } = require("../utils/paths");
const { PM2_ENV_LEAKS } = require("./pm2");
const nodeVersions = require("./nodeVersions");

// node-pty is the agent's only native dependency and the only one the agent can
// live without. A missing or ABI-mismatched build must cost us the terminal
// feature alone — never the whole agent: an agent that crash-loops on startup is
// an agent the panel can no longer reach to repair itself.
let pty = null;
let ptyLoadError = null;
try {
    pty = require("node-pty");
} catch (err) {
    ptyLoadError = err.message;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Interactive terminal over WebSocket.
//
//  The panel connects to ws://<host>:<port>/term with the shared x-agent-key
//  header and pipes a browser xterm.js session straight through to a real PTY
//  running the node's login shell. Protocol (JSON frames both ways):
//    client → agent : { type:"input", data } | { type:"resize", cols, rows }
//    agent  → client : { type:"data", data }  | { type:"exit", code }
//
//  /term?root&dir | ?absPath opens the shell in that project's folder instead
//  of the home directory (the panel's per-project terminal); &nodeVersion puts
//  the project's pinned Node first on PATH.
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // kill a session with no input for 30m
const PING_INTERVAL_MS = 30 * 1000;

/**
 * Where a session starts. A project target goes through the same root jail as
 * every fs/git call, but the jail only picks the STARTING directory here — the
 * shell can cd anywhere, exactly as the node terminal always could. A target
 * that does not resolve still opens a shell, in home, and says why.
 */
const startDir = (query) => {
    if (!query.dir && !query.absPath) return { cwd: os.homedir() };
    try {
        const dir = resolveTarget(query);
        if (!fs.existsSync(dir)) return { cwd: os.homedir(), notice: `project folder ${dir} does not exist` };
        return { cwd: dir };
    } catch (err) {
        return { cwd: os.homedir(), notice: err.message };
    }
};

/**
 * The agent's environment minus the pm2_env keys pm2 leaks into it. A project
 * terminal is exactly where someone types `pm2 restart <bot>`, and that pm2
 * CLI would read the agent's own max_memory_restart as configuration — see
 * PM2_ENV_LEAKS in ./pm2.
 *
 * ?nodeVersion puts the project's pinned Node first on PATH, so `npm install`
 * typed here builds for the same Node the project runs on. Only when it is
 * already unpacked: opening a shell must not wait on a download, and the next
 * install or start fetches it anyway.
 */
const shellEnv = (query) => {
    const env = { ...process.env };
    for (const key of PM2_ENV_LEAKS) delete env[key];

    const version = typeof query.nodeVersion === "string" ? query.nodeVersion : "";
    try { nodeVersions.assertVersion(version); } catch { return { env }; }
    if (!nodeVersions.isInstalled(version)) {
        return { env, notice: `Node v${version} is not on this node yet — this shell uses the system node until the next install or start downloads it` };
    }
    env.PATH = `${nodeVersions.binDir(version)}${path.delimiter}${env.PATH || ""}`;
    return { env };
};

const createTermSocket = (server) => {
    if (!pty) {
        console.error(`[Agent] node-pty unavailable — /term disabled: ${ptyLoadError}`);
        console.error("[Agent] Fix with: cd <repo>/agent && npm install --omit=dev && pm2 restart panel-agent");
        // Still answer the upgrade, so the panel shows why the terminal is dead
        // instead of hanging on a socket nobody is listening to.
        server.on("upgrade", (req, socket) => {
            if (url.parse(req.url).pathname !== "/term") return;
            socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
            socket.destroy();
        });
        return null;
    }

    const wss = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);
        if (pathname !== "/term") return; // leave other upgrades alone

        if (!isValidAgentKey(req.headers["x-agent-key"])) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, query));
    });

    wss.on("connection", (ws, query) => {
        const shell = process.env.SHELL || "bash";
        const { cwd, notice } = startDir(query);
        const { env, notice: nodeNotice } = shellEnv(query);
        const term = pty.spawn(shell, [], {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd,
            env,
        });

        let idleTimer;
        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { try { term.kill(); } catch { /* gone */ } }, IDLE_TIMEOUT_MS);
        };
        resetIdle();

        const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

        if (notice) send({ type: "data", data: `\x1b[33m[agent] ${notice} — opened in ${cwd}\x1b[0m\r\n` });
        if (nodeNotice) send({ type: "data", data: `\x1b[33m[agent] ${nodeNotice}\x1b[0m\r\n` });
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
