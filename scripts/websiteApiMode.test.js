#!/usr/bin/env node
/**
 * Checks for the "API only" website mode (server/routes/bots.js): a website that
 * is just a PM2 app, every path proxied to it by nginx, no dist folder.
 *
 * The incident (2026-11-11): pokezone-api has no frontend, so it was created as
 * "Full-stack" and nginx served a dist folder that does not exist — a 500 on
 * every path outside /api. Covered:
 *   - creating an API site: apiPort required, no dist folder stored, the vhost
 *     is written with mode "api"
 *   - unknown modes are refused; full-stack still needs its dist folder
 *   - Edit config switches full-stack ↔ API (vhost rewritten, SSL re-applied),
 *     never static ↔ an app
 * The agent, the node scheduler and history are stubbed; db is in memory.
 * Run:  node scripts/websiteApiMode.test.js
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// In-memory stand-in for server/db (same merge semantics as QuickDB.js).
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
let nextId = 1;
stub("db", {
    create: async (m, d) => {
        const rec = { _id: `id${nextId++}`, ...clone(d) };
        store.set(m, [...(store.get(m) || []), rec]);
        return clone(rec);
    },
    find: async (m, q = {}) => clone((store.get(m) || []).filter((e) => match(e, q))),
    findOne: async (m, q) => clone((store.get(m) || []).find((e) => match(e, q))),
    findOneAndUpdate: async (m, q, d) => {
        const arr = store.get(m) || [];
        const i = arr.findIndex((e) => match(e, q));
        if (i === -1) return null;
        arr[i] = { ...arr[i], ...clone(d) };
        return clone(arr[i]);
    },
});

// Every agent call the route makes, in order. Unlisted calls succeed with nothing.
const calls = [];
const answers = { findFreePortOn: () => 3002 };
const recorder = (log) => new Proxy({}, {
    get: (_, name) => async (...args) => {
        log.push({ name, args: clone(args) });
        return answers[name]?.(...args);
    },
});
stub("services/executor", recorder(calls));
stub("services/historyService", recorder([]));
stub("services/nodeReleases", recorder([]));
stub("services/staleCopies", recorder([]));
stub("services/schedulerService", { pickNode: async () => ({ nodeId: "n1", nodeName: "node-1", reason: "test" }) });
stub("services/nodeService", { panelNodeId: () => "n1" });
stub("routes/notifications", { createNotification: async () => {} });

const router = require("../server/routes/bots");

// ── Harness ──────────────────────────────────────────────────────────────────
let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ✗ ${name}\n      ${err.stack || err.message}`);
    }
};

const app = express();
app.use(express.json());
app.use("/api/bots", router);
app.use((err, req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

let base;
const call = (method, url, body) =>
    new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request(base + url, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
            let s = "";
            res.on("data", (d) => (s += d)).on("end", () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
        });
        req.on("error", reject);
        req.end(data || undefined);
    });

const site = (botID, websiteConfig) => ({
    buyerID: "100", botID, name: botID, repoUrl: "https://github.com/acme/" + botID, branch: "main",
    projectType: "website", startScript: "node server.js", installCommand: "npm install --omit=dev", websiteConfig,
});
const nginxWrites = () => calls.filter((c) => c.name === "nginxWriteConfig").map((c) => c.args[1]);
const record = (id) => store.get("bots").find((b) => b._id === id);

(async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    console.log("Create");

    await test("an API site needs its API port", async () => {
        const r = await call("POST", "/api/bots", site("noport", { mode: "api" }));
        assert.strictEqual(r.status, 400);
        assert.match(r.body.error, /apiPort is required for API websites/);
        assert.ok(!calls.some((c) => c.name === "cloneRepo"), "nothing is cloned for a refused site");
    });

    let apiId;
    await test("an API site is created without a dist folder, its vhost as \"api\"", async () => {
        calls.length = 0;
        const r = await call("POST", "/api/bots", site("pokezoneapi", { mode: "api", apiPort: "7149", distFolder: "dist" }));
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        apiId = r.body._id;
        assert.deepStrictEqual(
            { mode: r.body.websiteConfig.mode, port: r.body.websiteConfig.port, apiPort: r.body.websiteConfig.apiPort, distFolder: r.body.websiteConfig.distFolder },
            { mode: "api", port: 3002, apiPort: 7149, distFolder: null },
        );
        const [w] = nginxWrites();
        assert.deepStrictEqual({ mode: w.mode, port: w.port, apiPort: w.apiPort }, { mode: "api", port: 3002, apiPort: 7149 });
        assert.ok(calls.some((c) => c.name === "installDeps"), "deps are installed like any app");
        assert.ok(calls.some((c) => c.name === "ufwOpenPort" && c.args[1] === 3002));
    });

    await test("an unknown mode is refused", async () => {
        const r = await call("POST", "/api/bots", site("weird", { mode: "proxy", apiPort: 7000 }));
        assert.strictEqual(r.status, 400);
        assert.match(r.body.error, /Unknown website mode "proxy"/);
    });

    await test("full-stack still needs a dist folder and an API port", async () => {
        const a = await call("POST", "/api/bots", site("fs1", { mode: "fullstack", apiPort: 7000 }));
        assert.strictEqual(a.status, 400);
        assert.match(a.body.error, /distFolder is required for full-stack/);
        const b = await call("POST", "/api/bots", site("fs2", { mode: "fullstack", distFolder: "dist" }));
        assert.strictEqual(b.status, 400);
        assert.match(b.body.error, /apiPort is required for full-stack/);
    });

    console.log("Edit config");

    let fsId;
    await test("a full-stack site with a domain switches to API only", async () => {
        const r = await call("POST", "/api/bots", site("fs3", { mode: "fullstack", apiPort: 7150, distFolder: "client/dist" }));
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        fsId = r.body._id;
        // As if "Save & issue SSL" had worked.
        record(fsId).websiteConfig = { ...record(fsId).websiteConfig, domain: "fs3.example.com", sslEnabled: true };
        calls.length = 0;

        const u = await call("PUT", `/api/bots/${fsId}/website-config`, { mode: "api" });
        assert.strictEqual(u.status, 200, JSON.stringify(u.body));
        assert.strictEqual(u.body.bot.websiteConfig.mode, "api");
        assert.strictEqual(u.body.bot.websiteConfig.distFolder, "client/dist", "kept for a switch back");
        const [w] = nginxWrites();
        assert.deepStrictEqual({ mode: w.mode, apiPort: w.apiPort, domain: w.domain }, { mode: "api", apiPort: 7150, domain: "fs3.example.com" });
        assert.ok(calls.some((c) => c.name === "nginxEnableSSL" && c.args[1] === "fs3.example.com"), "SSL put back on the new vhost");
    });

    await test("and back to full-stack, with the folder it had", async () => {
        calls.length = 0;
        const u = await call("PUT", `/api/bots/${fsId}/website-config`, { mode: "fullstack" });
        assert.strictEqual(u.status, 200, JSON.stringify(u.body));
        assert.strictEqual(nginxWrites()[0].mode, "fullstack");
        assert.strictEqual(nginxWrites()[0].distFolder, "client/dist");
    });

    await test("a site created as API becomes full-stack with \"dist\"", async () => {
        calls.length = 0;
        const u = await call("PUT", `/api/bots/${apiId}/website-config`, { mode: "fullstack" });
        assert.strictEqual(u.status, 200, JSON.stringify(u.body));
        assert.strictEqual(u.body.bot.websiteConfig.distFolder, "dist");
        assert.strictEqual(nginxWrites()[0].distFolder, "dist");
    });

    await test("Edit config without a mode keeps the mode", async () => {
        calls.length = 0;
        const u = await call("PUT", `/api/bots/${fsId}/website-config`, { port: "3010" });
        assert.strictEqual(u.status, 200, JSON.stringify(u.body));
        assert.strictEqual(u.body.bot.websiteConfig.mode, "fullstack");
        assert.strictEqual(nginxWrites()[0].port, 3010);
    });

    await test("static never becomes an app (or back)", async () => {
        const s = await call("POST", "/api/bots", site("st1", { mode: "static", distFolder: "." }));
        assert.strictEqual(s.status, 201, JSON.stringify(s.body));
        const u = await call("PUT", `/api/bots/${s.body._id}/website-config`, { mode: "api" });
        assert.strictEqual(u.status, 400);
        assert.match(u.body.error, /Only a full-stack site can switch to API only/);
        const v = await call("PUT", `/api/bots/${fsId}/website-config`, { mode: "static" });
        assert.strictEqual(v.status, 400);
        assert.strictEqual(record(fsId).websiteConfig.mode, "fullstack");
    });

    await test("switching to API with no API port is refused", async () => {
        record(fsId).websiteConfig = { ...record(fsId).websiteConfig, apiPort: null };
        const u = await call("PUT", `/api/bots/${fsId}/website-config`, { mode: "api" });
        assert.strictEqual(u.status, 400);
        assert.match(u.body.error, /valid API port/);
    });

    server.close();
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
