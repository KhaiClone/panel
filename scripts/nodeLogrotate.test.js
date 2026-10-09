#!/usr/bin/env node
/**
 * Checks for pm2-logrotate per node — no test framework needed.
 * Run:  node scripts/nodeLogrotate.test.js
 *
 * The real panel DB is never opened: server/db is replaced by an in-memory
 * stand-in before anything requires it, and every agent call is stubbed.
 * Covered:
 *   - nodeLogrotate.status / install / set: the node's own agent, the right
 *     endpoint, body and timeout (install waits minutes)
 *   - panelService.logrotate*: the same calls, aimed at the panel's node
 *   - overview: "on" / "off" / "unknown" per enabled node; an offline node is
 *     unknown and never asked, a silent agent or PM2 is unknown, not "off"
 *   - the routes: /api/nodes/logrotate, /api/nodes/:id/logrotate(+/install),
 *     404 for a node that does not exist, an agent's 400 stays a 400
 */

const path = require("path");
const assert = require("assert");

// ── In-memory stand-in for server/db (QuickDB) ───────────────────────────────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => e[k] === q[k]);
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0]; },
};
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub("server/db", fakeDb);
// The routes file reads history for other endpoints; its SQLite store stays closed.
stub("server/services/historyService", {});

process.env.PANEL_NODE_ID = "node-panel";

const nodeService = require("../server/services/nodeService");
const nodeLogrotate = require("../server/services/nodeLogrotate");
const panelService = require("../server/services/panelService");

const PANEL_NODE = { _id: "node-panel", name: "sangs", host: "160.191.87.150", port: 4200, apiKey: "k-panel", enabled: true };
const DIO = { _id: "node-dio", name: "dio", host: "160.191.87.61", port: 4200, apiKey: "k-dio", enabled: true };
const OLD = { _id: "node-old", name: "dio 2", host: "163.227.230.36", port: 4200, apiKey: "k-old", enabled: true };
const OFF = { _id: "node-off", name: "spare", host: "10.0.0.9", port: 4200, apiKey: "k-off", enabled: false };

const ON = { installed: true, status: "online", config: { max_size: "50M", retain: "7", compress: "true" } };

// Agent calls, recorded; `agentReplies[nodeName]` decides that node's answer.
const calls = [];
let agentReplies = {};
nodeService.agentRequest = async (node, method, urlPath, opts = {}) => {
    calls.push({ node: node.name, method, urlPath, data: opts.data, timeout: opts.timeout });
    const reply = agentReplies[node.name];
    if (typeof reply === "function") return reply(method, urlPath, opts);
    if (reply instanceof Error) throw reply;
    return reply ?? ON;
};
const offline = new Set();
nodeService.isNodeOffline = (id) => offline.has(id);

/** An agent that answered with { error } — agentRequest's shape for it. */
const agentError = (node, status, message) => Object.assign(new Error(`[Node ${node}] ${message}`), { status });

const reset = async () => {
    store.clear();
    calls.length = 0;
    agentReplies = {};
    offline.clear();
    await fakeDb.set("nodes", [PANEL_NODE, DIO, OLD, OFF]);
};

let failures = 0;
const test = async (name, fn) => {
    try {
        await reset();
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

(async () => {
    console.log("nodeLogrotate");

    await test("status / install / set go to that node's agent with the panel's timeouts", async () => {
        await nodeLogrotate.status(DIO);
        await nodeLogrotate.install(DIO);
        await nodeLogrotate.set(DIO, { max_size: "100M" });
        assert.deepStrictEqual(calls, [
            { node: "dio", method: "get", urlPath: "/logrotate", data: undefined, timeout: 20_000 },
            { node: "dio", method: "post", urlPath: "/logrotate/install", data: undefined, timeout: 200_000 },
            { node: "dio", method: "put", urlPath: "/logrotate", data: { max_size: "100M" }, timeout: 60_000 },
        ]);
    });

    await test("panelService.logrotate* still aim at the panel's node", async () => {
        assert.deepStrictEqual(await panelService.logrotateStatus(), ON);
        await panelService.logrotateInstall();
        await panelService.logrotateSet({ retain: "3" });
        assert.deepStrictEqual(calls.map((c) => `${c.node} ${c.method} ${c.urlPath} ${c.timeout}`), [
            "sangs get /logrotate 20000",
            "sangs post /logrotate/install 200000",
            "sangs put /logrotate 60000",
        ]);
        assert.deepStrictEqual(calls[2].data, { retain: "3" });
    });

    await test("overview: every enabled node, on when installed and online", async () => {
        const { nodes } = await nodeLogrotate.overview();
        assert.deepStrictEqual(nodes.map((n) => [n.name, n.state]), [["sangs", "on"], ["dio", "on"], ["dio 2", "on"]]);
        assert.ok(!calls.some((c) => c.node === "spare"), "a disabled node is not asked");
        assert.deepStrictEqual(nodes[0], { nodeId: "node-panel", name: "sangs", installed: true, status: "online", config: ON.config, state: "on" });
    });

    await test("overview: not installed, or installed but stopped, is off", async () => {
        agentReplies = {
            dio: { installed: false, status: "not_installed", config: null },
            "dio 2": { installed: true, status: "stopped", config: { max_size: "50M" } },
        };
        const byName = Object.fromEntries((await nodeLogrotate.overview()).nodes.map((n) => [n.name, n]));
        assert.strictEqual(byName.sangs.state, "on");
        assert.strictEqual(byName.dio.state, "off");
        assert.strictEqual(byName.dio.installed, false);
        assert.strictEqual(byName["dio 2"].state, "off");
        assert.strictEqual(byName["dio 2"].status, "stopped");
    });

    await test("overview: offline, silent agent or silent PM2 is unknown — never off", async () => {
        offline.add("node-old");
        agentReplies = {
            dio: agentError("dio", undefined, "ECONNABORTED timeout of 20000ms exceeded"),
            sangs: { installed: true, status: "unknown", config: ON.config },
        };
        const { nodes } = await nodeLogrotate.overview();
        const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
        assert.deepStrictEqual(nodes.map((n) => n.state), ["unknown", "unknown", "unknown"]);
        assert.strictEqual(byName["dio 2"].reason, "offline");
        assert.ok(!calls.some((c) => c.node === "dio 2"), "an offline node is not asked — it would only time out");
        assert.strictEqual(byName.dio.reason, "no answer");
        assert.match(byName.dio.error, /timeout of 20000ms/);
        assert.strictEqual(byName.sangs.reason, "PM2 did not answer");
    });

    console.log("routes");

    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/api/nodes", require("../server/routes/nodes"));
    app.use(require("../server/middleware/errorHandler"));
    const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/nodes`;
    const req = async (method, url, body) => {
        const r = await fetch(`${base}${url}`, {
            method,
            headers: body ? { "content-type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.json() };
    };
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production"; // the error handler logs less
    const prevLog = console.log;

    try {
        await test("GET /api/nodes/logrotate — the overview, not a node called \"logrotate\"", async () => {
            agentReplies = { dio: { installed: false, status: "not_installed", config: null } };
            const r = await req("GET", "/logrotate");
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body.nodes.map((n) => `${n.name}:${n.state}`), ["sangs:on", "dio:off", "dio 2:on"]);
        });

        await test("GET /api/nodes/:id/logrotate — that node's status; 404 for no such node", async () => {
            agentReplies = { "dio 2": { installed: true, status: "errored", config: {} } };
            const r = await req("GET", "/node-old/logrotate");
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(r.body, { installed: true, status: "errored", config: {} });
            assert.deepStrictEqual(calls.map((c) => `${c.node} ${c.method} ${c.urlPath}`), ["dio 2 get /logrotate"]);
            const missing = await req("GET", "/node-nope/logrotate");
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.body.error, "Node not found");
        });

        await test("POST /api/nodes/:id/logrotate/install — installs on that node", async () => {
            console.log = () => {}; // the route's progress lines
            const r = await req("POST", "/node-dio/logrotate/install");
            console.log = prevLog;
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(calls.map((c) => `${c.node} ${c.method} ${c.urlPath} ${c.timeout}`), ["dio post /logrotate/install 200000"]);
        });

        await test("PUT /api/nodes/:id/logrotate — forwards the settings; the agent's 400 stays a 400", async () => {
            const ok = await req("PUT", "/node-dio/logrotate", { max_size: "100M", retain: "3" });
            assert.strictEqual(ok.status, 200);
            assert.deepStrictEqual(calls[0].data, { max_size: "100M", retain: "3" });

            agentReplies = { dio: agentError("dio", 400, 'Invalid value for "max_size": "lots"') };
            const bad = await req("PUT", "/node-dio/logrotate", { max_size: "lots" });
            assert.strictEqual(bad.status, 400);
            assert.strictEqual(bad.body.error, '[Node dio] Invalid value for "max_size": "lots"');
        });
    } finally {
        console.log = prevLog;
        process.env.NODE_ENV = prevEnv;
        server.close();
    }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
