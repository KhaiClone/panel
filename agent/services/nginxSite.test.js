/**
 * Standalone checks for the website vhosts the agent writes — no test
 * framework, no nginx: the builder is pure, and the route runs against a
 * stubbed services/nginx.
 * Run:  node agent/services/nginxSite.test.js
 *
 * The incident (2026-11-11): pokezone-api, an API with no frontend, could only
 * be created as "Full-stack". nginx then served a dist folder that does not
 * exist, and `try_files … /index.html` looped into a 500 on every path outside
 * /api. Mode "api" proxies every path to the PM2 app.
 * Covered:
 *   - api: every path goes to the app, on the public port and on 80 for the
 *     domain; no root / try_files; custom directives only in the domain block
 *   - api without a domain: only the public-port block
 *   - static and full-stack: unchanged layout
 *   - POST /nginx/config refuses an API site without apiPort, passes mode on
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-nginxsite-"));
process.env.BOTS_ROOT_DIR = path.join(tmp, "bots");
process.env.SITES_ROOT_DIR = path.join(tmp, "sites");

const nginx = require("./nginx");

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

/** The server blocks of a config, as strings. */
const blocks = (conf) => conf.split(/\n(?=server \{)/).map((b) => b.trim()).filter(Boolean);

(async () => {
    console.log("buildConfig");

    await test("api: every path goes to the app, on the public port and on 80 for the domain", () => {
        const conf = nginx.buildConfig({ mode: "api", port: 3002, apiPort: 7149, distFolder: "/x/dist", domain: "api.example.com", extraConfig: "client_max_body_size 5m;" });
        const [ipBlock, domainBlock] = blocks(conf);
        assert.strictEqual(blocks(conf).length, 2);
        assert.match(ipBlock, /listen 3002;\n\s+server_name _;/);
        assert.match(domainBlock, /listen 80;\n\s+server_name api\.example\.com;/);
        for (const b of [ipBlock, domainBlock]) {
            assert.match(b, /location \/ \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:7149;/);
            assert.ok(!/\broot\b|try_files|location \/api/.test(b), b);
            assert.ok(b.includes("proxy_set_header X-Forwarded-Proto $scheme;"));
            assert.ok(b.includes("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"));
        }
        assert.ok(!ipBlock.includes("client_max_body_size"));
        assert.ok(domainBlock.includes("client_max_body_size 5m;"));
        assert.strictEqual(conf.split("{").length, conf.split("}").length);
    });

    await test("api without a domain: only the public-port block", () => {
        const conf = nginx.buildConfig({ mode: "api", port: 3002, apiPort: 7149, domain: null });
        assert.strictEqual(blocks(conf).length, 1);
        assert.ok(!conf.includes("listen 80;"));
    });

    await test("full-stack keeps its dist + /api layout", () => {
        const conf = nginx.buildConfig({ mode: "fullstack", port: 3002, apiPort: 7149, distFolder: "/x/dist", domain: "a.example.com" });
        assert.strictEqual(blocks(conf).length, 2);
        for (const b of blocks(conf)) {
            assert.ok(b.includes("root /x/dist;"));
            assert.match(b, /location \/api \{\n\s+proxy_pass http:\/\/127\.0\.0\.1:7149;/);
            assert.ok(b.includes("try_files $uri $uri/ /index.html;"));
        }
    });

    await test("static (with a domain) is unchanged", () => {
        const conf = nginx.buildConfig({ mode: "static", distFolder: "/x/site", domain: "s.example.com" });
        assert.strictEqual(blocks(conf).length, 1);
        assert.ok(conf.includes("root /x/site;") && !conf.includes("proxy_pass"));
    });

    console.log("POST /nginx/config");

    // The route with writeConfig stubbed: what it would have been given.
    const written = [];
    nginx.writeConfig = async (pm2Name, opts) => { written.push({ pm2Name, opts }); };
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/nginx", require("../routes/nginx"));
    app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const post = (body) => new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/nginx/config", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
            let s = "";
            res.on("data", (d) => (s += d)).on("end", () => resolve({ status: res.statusCode, body: JSON.parse(s || "{}") }));
        });
        req.on("error", reject);
        req.end(data);
    });

    await test("an API site without apiPort is refused", async () => {
        const r = await post({ pm2Name: "1-api", mode: "api", port: 3002, root: "sites", dir: "1/api" });
        assert.strictEqual(r.status, 400);
        assert.match(r.body.error, /apiPort/);
        assert.strictEqual(written.length, 0);
    });

    await test("an API site is written with its mode and ports", async () => {
        const r = await post({ pm2Name: "1-api", mode: "api", port: 3002, apiPort: 7149, root: "sites", dir: "1/api", domain: "api.example.com" });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(
            { mode: written[0].opts.mode, port: written[0].opts.port, apiPort: written[0].opts.apiPort, domain: written[0].opts.domain },
            { mode: "api", port: 3002, apiPort: 7149, domain: "api.example.com" },
        );
    });

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
