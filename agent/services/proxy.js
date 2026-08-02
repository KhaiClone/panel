const net = require("net");

/**
 * proxy.js
 * Turns the agent into a general-purpose authenticated HTTPS forward proxy via the
 * HTTP CONNECT method, sharing the agent's existing port. Any HTTPS host is allowed,
 * but only callers presenting the agent key are served — it is a PRIVATE proxy, not
 * an open relay.
 *
 * Because CONNECT tunnels raw TLS bytes straight to the target, the agent never sees
 * request headers or bodies (e.g. Discord tokens stay encrypted end-to-end). This is
 * intentionally generic so other features can reuse the agent as an egress IP.
 *
 * Auth: `Proxy-Authorization: Basic base64("<anything>:<AGENT_API_KEY>")`.
 *       (the panel embeds it as http://proxy:<key>@host:port)
 */
function createProxy(server) {
    server.on("connect", (req, clientSocket, head) => {
        const key = process.env.AGENT_API_KEY;
        if (!key || !_authOk(req, key)) {
            clientSocket.write(
                "HTTP/1.1 407 Proxy Authentication Required\r\n" +
                    'Proxy-Authenticate: Basic realm="agent"\r\n' +
                    "Connection: close\r\n\r\n",
            );
            clientSocket.destroy();
            return;
        }

        // req.url is "host:port" for CONNECT.
        const [host, portRaw] = String(req.url || "").split(":");
        const port = parseInt(portRaw, 10) || 443;
        if (!host) {
            clientSocket.destroy();
            return;
        }

        const upstream = net.connect(port, host, () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head && head.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });

        const kill = () => {
            upstream.destroy();
            clientSocket.destroy();
        };
        upstream.on("error", kill);
        clientSocket.on("error", kill);
    });

    console.log("[Agent] HTTPS forward proxy (CONNECT) enabled on the agent port");
}

function _authOk(req, key) {
    const h = req.headers["proxy-authorization"];
    const m = /^Basic\s+(.+)$/i.exec(h || "");
    if (!m) return false;
    let decoded;
    try {
        decoded = Buffer.from(m[1], "base64").toString("utf8");
    } catch {
        return false;
    }
    const idx = decoded.indexOf(":");
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return pass === key;
}

module.exports = { createProxy };
