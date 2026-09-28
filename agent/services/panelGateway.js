const http = require("http");
const https = require("https");
const net = require("net");
const lease = require("./panelLease");

// ─────────────────────────────────────────────────────────────────────────────
//  Panel gateway — the panel's API at a fixed local address on every node.
//
//  Projects that call the panel (arnto-auto → /api/external/*) must not carry
//  the panel's whereabouts in their .env: the panel can move, and so can the
//  project. Every agent therefore listens on 127.0.0.1:PANEL_GATEWAY_PORT
//  (default 4201) and forwards each request, unchanged, to the panel that
//  currently holds this node's lease — lease.panelUrl, sent by that panel with
//  its claim (127.0.0.1 on its own node, its WireGuard IP elsewhere). After a
//  move the new panel claims every agent and the gateways follow at once.
//
//  Loopback only: it is a door for the projects on THIS machine, it needs no
//  firewall rule, and it grants nothing — the panel still checks every key.
//  No WebSocket upgrades: the API callers here are plain HTTP (SSE streams
//  are fine — responses are piped, not buffered).
// ─────────────────────────────────────────────────────────────────────────────

const HOST = "127.0.0.1";
const CONNECT_TIMEOUT_MS = 5000;
// Hop-by-hop headers belong to one connection, never forwarded.
const HOP = new Set([
    "connection", "keep-alive", "proxy-connection", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
]);

/** 0 / "off" disables the gateway. */
const configuredPort = () => {
    const raw = String(process.env.PANEL_GATEWAY_PORT ?? "4201").trim().toLowerCase();
    if (raw === "off") return 0;
    const p = parseInt(raw, 10);
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
};

const copyHeaders = (src) => {
    const out = {};
    for (const [k, v] of Object.entries(src)) if (!HOP.has(k.toLowerCase())) out[k] = v;
    return out;
};

const reply = (res, status, body) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
};

/** Forward one request to the current panel. */
const handle = (req, res) => {
    const target = lease.read().panelUrl;
    if (!target) {
        return reply(res, 503, {
            error: "This node does not know where the panel is yet — it learns it when the panel claims the node",
            code: "PANEL_UNKNOWN",
        });
    }
    const u = new URL(target);
    const headers = copyHeaders(req.headers);
    headers.host = u.host;
    headers["x-forwarded-for"] = req.socket.remoteAddress;
    headers["x-panel-gateway"] = "1";

    const upstream = (u.protocol === "https:" ? https : http).request({
        host: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
    });

    // Only the CONNECT is timed: once connected, a slow answer or a long SSE
    // stream is the panel's business.
    const connectTimer = setTimeout(() => upstream.destroy(new Error("timeout")), CONNECT_TIMEOUT_MS);
    upstream.on("socket", (s) => {
        if (s.connecting) s.once("connect", () => clearTimeout(connectTimer));
        else clearTimeout(connectTimer);
    });

    upstream.on("response", (up) => {
        clearTimeout(connectTimer);
        res.writeHead(up.statusCode, copyHeaders(up.headers));
        up.pipe(res);
    });
    upstream.on("error", (err) => {
        clearTimeout(connectTimer);
        reply(res, 502, {
            error: `The panel at ${target} did not answer (${err.code || err.message})`,
            code: "PANEL_UNREACHABLE",
        });
    });
    // The caller gave up: drop the upstream request too.
    res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
};

let server = null;
let listening = false;
let lastError = null;

/** Start the gateway (no-op when disabled). A taken port is logged, never fatal. */
const start = () => {
    const port = configuredPort();
    if (!port) {
        console.log("[Agent] Panel gateway disabled (PANEL_GATEWAY_PORT=off)");
        return null;
    }
    server = http.createServer(handle);
    server.on("error", (err) => {
        listening = false;
        lastError = err.code || err.message;
        console.error(`[Agent] Panel gateway could not listen on ${HOST}:${port}: ${lastError}`);
    });
    server.listen(port, HOST, () => {
        listening = true;
        lastError = null;
        console.log(`[Agent] Panel gateway on http://${HOST}:${port} → the panel holding this node's lease`);
    });
    return server;
};

/** TCP check from this machine to the panel the gateway forwards to. */
const canReach = (url, timeout = 3000) =>
    new Promise((resolve) => {
        let u;
        try {
            u = new URL(url);
        } catch {
            return resolve({ ok: false, error: "bad url" });
        }
        const sock = net.connect({ host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80) });
        const done = (ok, error = null) => {
            sock.destroy();
            resolve({ ok, error });
        };
        sock.setTimeout(timeout, () => done(false, "timeout"));
        sock.once("connect", () => done(true));
        sock.once("error", (e) => done(false, e.code || e.message));
    });

/** What GET /lease/gateway reports. */
const status = async () => {
    const { panelUrl, epoch } = lease.read();
    return {
        port: configuredPort() || null,
        listening,
        error: lastError,
        localUrl: listening ? `http://${HOST}:${configuredPort()}` : null,
        panelUrl,
        epoch,
        reach: panelUrl ? await canReach(panelUrl) : null,
    };
};

module.exports = { start, status, configuredPort, _handle: handle };
