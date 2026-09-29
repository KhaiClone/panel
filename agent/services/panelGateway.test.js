/**
 * Standalone checks for the panel gateway, the lease's panelUrl, the panel
 * vhost renderer and certbot's failure message — no test framework needed.
 * Run:  node agent/services/panelGateway.test.js
 *
 * The gateway is how local projects reach the panel wherever it runs, so the
 * guarantees here are: it forwards method, path, headers, body and status
 * unchanged, streams the answer, follows a new panelUrl at once, and says
 * clearly when it does not know the panel or cannot reach it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const LEASE = path.join(os.tmpdir(), `panel-gateway-test-${process.pid}.json`);
process.env.PANEL_LEASE_PATH = LEASE;
fs.rmSync(LEASE, { force: true });

const lease = require("./panelLease");
const gateway = require("./panelGateway");
const nginx = require("./nginx");
const { buildPanelSites } = nginx;

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

/** A request through the gateway → { status, headers, body }. */
const call = (port, { method = "GET", path: p = "/", headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });

(async () => {
    console.log("lease.panelUrl");

    await test("a claim stores panelUrl; a same-epoch claim without one keeps it", () => {
        assert.strictEqual(lease.claim(1, "node-a", "http://127.0.0.1:1975").lease.panelUrl, "http://127.0.0.1:1975");
        assert.strictEqual(lease.claim(1, "node-a").lease.panelUrl, "http://127.0.0.1:1975");
        assert.strictEqual(JSON.parse(fs.readFileSync(LEASE, "utf8")).panelUrl, "http://127.0.0.1:1975");
    });

    await test("an unchanged re-claim writes nothing", () => {
        const before = fs.statSync(LEASE).mtimeMs;
        const at = lease.read().updatedAt;
        assert.ok(lease.claim(1, "node-a", "http://127.0.0.1:1975").ok);
        assert.strictEqual(lease.read().updatedAt, at);
        assert.strictEqual(fs.statSync(LEASE).mtimeMs, before);
    });

    await test("a new epoch without panelUrl forgets the old panel's address", () => {
        assert.strictEqual(lease.claim(2, "node-b").lease.panelUrl, null);
    });

    await test("panelUrl must be a bare origin", () => {
        for (const bad of ["ftp://x:1", "http://x:1/path", "http://u:p@x:1", "http://x:1?q=1", "x:1", 42]) {
            assert.throws(() => lease.claim(2, "node-b", bad), /panelUrl/, String(bad));
        }
        assert.ok(lease.claim(2, "node-b", "http://10.88.0.2:1975").ok);
        assert.ok(lease.claim(2, "node-b", "http://[::1]:1975").ok);
    });

    console.log("gateway");

    const seen = [];
    const panel = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            if (req.url === "/stream") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write("data: 1\n\n");
                setTimeout(() => res.end("data: 2\n\n"), 50);
                return;
            }
            res.writeHead(req.url === "/missing" ? 404 : 201, { "content-type": "application/json", "x-from": "panel" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const panelPort = await listen(panel);
    const gw = http.createServer(gateway._handle);
    const gwPort = await listen(gw);

    await test("no panelUrl yet → 503 PANEL_UNKNOWN", async () => {
        lease.claim(3, "node-c");
        const r = await call(gwPort, { path: "/api/external/quests" });
        assert.strictEqual(r.status, 503);
        assert.strictEqual(JSON.parse(r.body).code, "PANEL_UNKNOWN");
    });

    await test("method, path, query, headers and body reach the panel unchanged; status and headers come back", async () => {
        lease.claim(3, "node-c", `http://127.0.0.1:${panelPort}`);
        const body = JSON.stringify({ token: "t", webhookUrl: "http://localhost:1942/api/quest-event" });
        const r = await call(gwPort, {
            method: "POST",
            path: "/api/external/quests/start?x=1",
            headers: { "x-api-key": "pk_abc", "content-type": "application/json" },
            body,
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.headers["x-from"], "panel");
        const s = seen.at(-1);
        assert.strictEqual(s.method, "POST");
        assert.strictEqual(s.url, "/api/external/quests/start?x=1");
        assert.strictEqual(s.headers["x-api-key"], "pk_abc");
        assert.strictEqual(s.headers["x-panel-gateway"], "1");
        assert.strictEqual(s.body, body);
    });

    await test("panel errors pass through as they are", async () => {
        assert.strictEqual((await call(gwPort, { path: "/missing" })).status, 404);
    });

    await test("a streamed answer arrives whole", async () => {
        const r = await call(gwPort, { path: "/stream" });
        assert.strictEqual(r.body, "data: 1\n\ndata: 2\n\n");
    });

    await test("a new claim re-points the gateway at once; a dead panel → 502 PANEL_UNREACHABLE", async () => {
        const dead = http.createServer();
        const deadPort = await listen(dead);
        await new Promise((r) => dead.close(r));
        lease.claim(4, "node-d", `http://127.0.0.1:${deadPort}`);
        const r = await call(gwPort, { path: "/api/health" });
        assert.strictEqual(r.status, 502);
        assert.strictEqual(JSON.parse(r.body).code, "PANEL_UNREACHABLE");
        lease.claim(4, "node-d", `http://127.0.0.1:${panelPort}`);
        assert.strictEqual((await call(gwPort, { path: "/api/health" })).status, 201);
    });

    await test("an older panel cannot re-point it", () => {
        assert.strictEqual(lease.claim(3, "node-c", "http://10.0.0.9:1975").ok, false);
        assert.strictEqual(lease.read().panelUrl, `http://127.0.0.1:${panelPort}`);
    });

    await test("PANEL_GATEWAY_PORT: default 4201, 'off' disables, garbage disables", () => {
        delete process.env.PANEL_GATEWAY_PORT;
        assert.strictEqual(gateway.configuredPort(), 4201);
        process.env.PANEL_GATEWAY_PORT = "off";
        assert.strictEqual(gateway.configuredPort(), 0);
        process.env.PANEL_GATEWAY_PORT = "99999";
        assert.strictEqual(gateway.configuredPort(), 0);
        process.env.PANEL_GATEWAY_PORT = "4300";
        assert.strictEqual(gateway.configuredPort(), 4300);
    });

    gw.close();
    panel.close();

    console.log("nginx.buildPanelSites");

    const sites = [
        { domain: "panel.example.com", mode: "proxy", port: 1975 },
        { domain: "panel-b.example.com", mode: "redirect", to: "https://panel.example.com" },
    ];

    await test("no certificate → a plain port-80 server per domain", () => {
        const out = buildPanelSites(sites, { certs: new Set(), options: true, dhparam: true });
        assert.strictEqual((out.match(/listen 80;/g) || []).length, 2);
        assert.ok(!out.includes("listen 443"));
        assert.ok(out.includes("proxy_pass http://127.0.0.1:1975;"));
        assert.ok(out.includes("return 302 https://panel.example.com$request_uri;"));
    });

    await test("with a certificate → 80 redirects to https inside a location, 443 serves it", () => {
        const out = buildPanelSites(sites, { certs: new Set(["panel.example.com"]), options: true, dhparam: false });
        assert.strictEqual((out.match(/listen 443 ssl;/g) || []).length, 1);
        assert.ok(out.includes("ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;"));
        assert.ok(out.includes("include /etc/letsencrypt/options-ssl-nginx.conf;"));
        assert.ok(!out.includes("ssl_dhparam"));
        // the 301 sits in `location /`, never at server level (certbot renewals need that)
        assert.ok(/location \/ \{\s+return 301 https:\/\/\$host\$request_uri;\s+\}/.test(out));
        assert.ok(!/server_name panel\.example\.com;\s+return/.test(out));
    });

    console.log("nginx.certbotFailure");

    const CERTBOT_STDERR = "Saving debug log to /var/log/letsencrypt/letsencrypt.log\nSome challenges have failed.\nAsk for help or search for solutions at https://community.letsencrypt.org.";
    const challenge = (type, detail) => ({
        stdout: `Certbot failed to authenticate some domains (authenticator: nginx). The Certificate Authority reported these problems:\n  Domain: p.example.com\n  Type:   ${type}\n  Detail: ${detail}\n\nHint: The Certificate Authority failed to verify the temporary nginx configuration changes made by Certbot.\n`,
        stderr: CERTBOT_STDERR,
        message: `Command failed: sudo certbot certonly --nginx -d p.example.com\n${CERTBOT_STDERR}`,
    });

    await test("a firewalled port 80: the CA's detail from stdout, and the ufw command", () => {
        const e = nginx.certbotFailure("p.example.com", challenge("connection", "203.0.113.10: Fetching http://p.example.com/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)"));
        assert.strictEqual(
            e.message,
            "certbot could not get a certificate for p.example.com (connection): 203.0.113.10: Fetching http://p.example.com/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem). Port 80 of this VPS is not reachable from the internet — on it: sudo ufw allow 80,443/tcp",
        );
    });

    await test("DNS and a wrong server get their own hints", () => {
        assert.match(nginx.certbotFailure("p.example.com", challenge("dns", "DNS problem: NXDOMAIN looking up A for p.example.com")).message, /\(dns\): DNS problem.*does not resolve to this VPS/);
        assert.match(nginx.certbotFailure("p.example.com", challenge("unauthorized", "104.21.0.1: Invalid response from http://p.example.com/.well-known/acme-challenge/x: 404")).message, /Another server answered/);
    });

    await test("not a challenge failure: the raw reason, without the command line", () => {
        const e = nginx.certbotFailure("p.example.com", { stderr: "sudo: certbot: command not found", message: "Command failed: sudo certbot certonly --nginx -d p.example.com\nsudo: certbot: command not found" });
        assert.strictEqual(e.message, "sudo: certbot: command not found");
    });

    fs.rmSync(LEASE, { force: true });
    fs.rmSync(`${LEASE}.tmp`, { force: true });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
