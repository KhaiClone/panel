const url = require("url");
const WebSocket = require("ws");
const { ownerOf, tokenOf } = require("../middleware/auth");
const db = require("../db");
const nodeService = require("./nodeService");
const executor = require("./executor");
const panelLog = require("./panelLog");

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
//  for log streaming and downloads. Only the owner's token opens a shell.
//
//  A CLI key (services/cliAccess.js) opens one too — sent as an Authorization
//  header, so the key never sits in a URL (nginx logs those). See "CLI
//  sessions" below for what changes for it.
// ─────────────────────────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 30 * 1000;
// Frames the browser sends before the agent link is open (its first resize,
// early keystrokes). Bounded so a dead agent cannot grow it forever.
const MAX_PENDING_FRAMES = 200;

// ── CLI sessions ─────────────────────────────────────────────────────────────
// scripts/panel-cli.js runs one command per session. It sends
//   { type:"run", command, tag }
// and the panel turns that into ONE line of shell input (runLine) which prints
// "__PCLI_BEGIN_<tag>:" before the command's output and
// "__PCLI_END_<tag>:<exit code>" after it; the script keeps what lies between.
//   - The command travels base64 inside the line: a multi-line script is still
//     one line, so none of it is echoed after the BEGIN marker.
//   - The echoed line holds "__PCLI_BEGIN_<tag>" but never "…<tag>:" — the
//     colon comes from printf's "%s:" — so the echo cannot pass for a marker.
//   - The panel, not the script, builds the line, so the panel log shows each
//     command as it was asked for: whatever a key runs is on the record. Raw
//     keystrokes from a CLI session (Ctrl-C on a timeout) are logged too.
//   - The leading space keeps the line out of bash history where
//     HISTCONTROL ignores such lines (Ubuntu's default).
const RUN_TAG = /^[a-z0-9]{8,32}$/;
const MAX_COMMAND = 16 * 1024;

const runLine = (command, tag) =>
    " stty -echo 2>/dev/null; export TERM=dumb NO_COLOR=1 PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER=cat; " +
    `printf '%s:\\n' __PCLI_BEGIN_${tag}; ` +
    `eval "$(printf %s '${Buffer.from(command, "utf8").toString("base64")}' | base64 -d)"; ` +
    `printf '\\n%s:%s\\n' __PCLI_END_${tag} "$?"\r`;

const inlineCode = (s) => `\`${String(s).replace(/`/g, "ʼ")}\``;

/**
 * One frame from a CLI session → the frame to send the agent (or null to
 * drop it), logging what the key asked the shell to do.
 */
const cliFrame = (raw, log) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return null; }
    if (msg.type === "run") {
        const command = typeof msg.command === "string" ? msg.command : "";
        if (!command.trim() || command.length > MAX_COMMAND || !RUN_TAG.test(String(msg.tag || ""))) return null;
        log(`ran ${inlineCode(command)}`);
        return JSON.stringify({ type: "input", data: runLine(command, msg.tag) });
    }
    if (msg.type === "input" && typeof msg.data === "string") {
        // eslint-disable-next-line no-control-regex
        const shown = msg.data.replace(/\x03/g, "^C").replace(/[\x00-\x1f\x7f]/g, " ").trim();
        if (shown) log(`typed ${inlineCode(shown.slice(0, 300))}`);
    }
    return raw;
};

const attachTermServer = (httpServer) => {
    const wss = new WebSocket.Server({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);
        if (pathname !== "/api/term") return; // not ours — leave it alone

        // A shell on a VPS: the owner's token (or a CLI key) only — never a staff one.
        const who = ownerOf(tokenOf(req) || query.token || "", req);
        if (!who) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, query, who);
        });
    });

    wss.on("connection", (ws, query, who) => {
        // Listeners go on before any await: the browser sends its size the
        // moment the socket opens, and a frame that arrives with no listener
        // is gone — the PTY would stay 80x24 until the window next resized.
        const pending = [];
        let upstream = null;

        // A CLI key's commands go to the panel log, naming where they ran —
        // known once the session is resolved; lines before that wait for it.
        const cli = who?.cli || null;
        let where = null;
        const waiting = [];
        const log = (text) => (where ? panelLog.add("owner", `CLI **${cli.name}** · shell on ${where} · ${text}`) : waiting.push(text));
        const located = (w) => {
            where = w;
            for (const text of waiting.splice(0)) log(text);
        };

        ws.isAlive = true;
        ws.on("pong", () => { ws.isAlive = true; });
        ws.on("message", (raw) => {
            const frame = cli ? cliFrame(raw.toString(), log) : raw.toString();
            if (frame == null) return;
            if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
            else if (pending.length < MAX_PENDING_FRAMES) pending.push(frame);
        });
        ws.on("close", () => { try { upstream?.close(); } catch { /* already closing */ } });

        resolveSession(query)
            .then(({ node, target, banner, label }) => {
                if (cli) located(label);
                if (ws.readyState !== WebSocket.OPEN) return; // browser left while we looked it up
                if (banner) safeSend(ws, { type: "data", data: `\x1b[90m${banner}\x1b[0m\r\n` });
                upstream = connectAgent(ws, node, target, pending);
            })
            .catch((err) => {
                if (cli) located(query.bot ? `project ${query.bot}` : `node ${query.node || "?"}`);
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
            label: `**${bot.name}** on node **${node.name}**`,
        };
    }
    if (!query.node) throw new Error("No node selected — pick one in the switcher.");
    const node = await nodeService.getNode(query.node);
    return { node, target: null, banner: null, label: `node **${node.name}**` };
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

module.exports = { attachTermServer, runLine };
