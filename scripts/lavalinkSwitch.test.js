#!/usr/bin/env node
/**
 * Checks for the per-node Lavalink switch — no test framework needed.
 * Run:  node scripts/lavalinkSwitch.test.js
 *
 * The real panel DB is never opened: server/db is replaced by an in-memory
 * stand-in before anything requires it, and every agent call is stubbed.
 * Covered:
 *   - store: a node is on until switched off; the switch is a per-node choice
 *   - status: a node that is off reads "disabled" (no drift / Java noise), and
 *     says so when it is off but still running
 *   - off: stops Lavalink only when pm2 has something to stop; saved even when
 *     the node cannot be reached
 *   - on: syncs the config, then starts an installed Lavalink; leaves a node
 *     without one alone; does not restart one already running
 *   - while off: Sync all passes it by (skipped, not failed), per-node Sync /
 *     Install / Update / Start / Restart / Rollback refuse, Stop still works
 *   - the 02:00 job never updates a node that is off
 *   - the routes: body validation, 409 for Start on a node that is off
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

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
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const reports = [];
stub("services/discordService", { sendLavalinkReport: async (r) => reports.push(r) });

const nodeService = require("../server/services/nodeService");
const lavalinkStore = require("../server/services/lavalinkStore");
const lavalink = require("../server/services/lavalinkService");
const updater = require("../server/services/lavalinkUpdater");

const A = { _id: "node-a", name: "dio", host: "203.0.113.10", port: 4200, apiKey: "k-a", enabled: true };
const B = { _id: "node-b", name: "pkz", host: "203.0.113.20", port: 4200, apiKey: "k-b", enabled: true };

// What each node's agent reports, and every call it received.
let agents = {};
const calls = [];
const rawStatus = (over = {}) => ({
    installed: true,
    version: "4.2.2",
    configSha: "stale",
    java: { present: true, major: 21 },
    libc: "glibc",
    live: { status: "online", memory: 1, restarts: 0, uptime: Date.now() },
    tokener: null,
    ...over,
});

nodeService.agentRequest = async (node, method, urlPath, opts = {}) => {
    calls.push({ node: node.name, method, urlPath, data: opts.data });
    const a = agents[node._id];
    if (!a || a.offline) {
        const e = new Error("connect ECONNREFUSED");
        throw e;
    }
    if (urlPath === "/lavalink/status") return a.raw;
    if (urlPath === "/lavalink/stats") return { stats: { players: 2, playingPlayers: 1 } };
    if (urlPath === "/lavalink/stop") {
        a.raw.live = { status: "stopped" };
        return { output: "stopped" };
    }
    if (urlPath === "/lavalink/start") {
        a.raw.live = { status: "online" };
        return { output: "started", health: { ok: true }, tokener: null };
    }
    if (urlPath === "/lavalink/config") return { sha: "new", changed: true, restarted: false };
    if (urlPath === "/lavalink/update") return { updated: true, started: true, health: { ok: true } };
    return {};
};
lavalink.latestRelease = async () => ({
    version: "4.3.0",
    url: "https://example.invalid/release",
    assets: { glibc: { url: "https://example.invalid/Lavalink.jar", size: 1 }, musl: null },
});

const reset = async () => {
    store.clear();
    calls.length = 0;
    reports.length = 0;
    await fakeDb.set("nodes", [A, B]);
    agents = { [A._id]: { raw: rawStatus() }, [B._id]: { raw: rawStatus() } };
};

const turnOff = (node) => lavalinkStore.setNodeState(node._id, { enabled: false });
const callsTo = (node, urlPath) => calls.filter((c) => c.node === node.name && c.urlPath === urlPath);

let failures = 0;
const test = async (name, fn) => {
    try {
        await reset();
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ✗ ${name}\n       ${err.stack || err.message}`);
    }
};

(async () => {
    console.log("store");

    await test("a node is on until it is switched off", async () => {
        let s = await lavalinkStore.get();
        assert.strictEqual(lavalinkStore.nodeEnabled(s, A._id), true);
        await turnOff(A);
        s = await lavalinkStore.get();
        assert.strictEqual(lavalinkStore.nodeEnabled(s, A._id), false);
        assert.strictEqual(lavalinkStore.nodeEnabled(s, B._id), true);
        // A switch is a choice, not state: later state writes keep it.
        await lavalinkStore.setNodeState(A._id, { state: "stopped", error: null });
        s = await lavalinkStore.get();
        assert.strictEqual(lavalinkStore.nodeEnabled(s, A._id), false);
        assert.strictEqual(lavalinkStore.nodeEnabled(null, A._id), true);
    });

    console.log("status");

    await test("off and stopped reads as disabled, no error", async () => {
        await turnOff(A);
        agents[A._id].raw = rawStatus({ live: { status: "stopped" }, java: { present: false, major: null } });
        const { nodes } = await lavalink.statusAll();
        const a = nodes.find((n) => n.nodeId === A._id);
        const b = nodes.find((n) => n.nodeId === B._id);
        assert.strictEqual(a.state, "disabled");
        assert.strictEqual(a.enabled, false);
        assert.strictEqual(a.error, null);
        assert.strictEqual(b.enabled, true);
        assert.strictEqual(b.state, "config-drift");
    });

    await test("off but still running says so", async () => {
        await turnOff(A);
        const a = (await lavalink.statusAll()).nodes.find((n) => n.nodeId === A._id);
        assert.strictEqual(a.state, "disabled");
        assert.match(a.error, /still running/);
    });

    console.log("switching off");

    await test("off stops a running Lavalink and saves the switch", async () => {
        const r = await lavalink.setEnabled(A, false);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.stopped, true);
        assert.strictEqual(callsTo(A, "/lavalink/stop").length, 1);
        assert.strictEqual(callsTo(B, "/lavalink/stop").length, 0);
        assert.strictEqual(lavalinkStore.nodeEnabled(await lavalinkStore.get(), A._id), false);
    });

    await test("off on a stopped node asks pm2 for nothing", async () => {
        agents[A._id].raw.live = { status: "stopped" };
        const r = await lavalink.setEnabled(A, false);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.stopped, false);
        assert.strictEqual(callsTo(A, "/lavalink/stop").length, 0);
    });

    await test("off on an unreachable node is saved, and reported", async () => {
        agents[A._id].offline = true;
        const r = await lavalink.setEnabled(A, false);
        assert.strictEqual(r.ok, false);
        assert.match(r.error, /^Saved, but the node could not be reached/);
        assert.strictEqual(lavalinkStore.nodeEnabled(await lavalinkStore.get(), A._id), false);
    });

    console.log("switching on");

    await test("on syncs the config, then starts a stopped Lavalink", async () => {
        await turnOff(A);
        agents[A._id].raw.live = { status: "stopped" };
        const r = await lavalink.setEnabled(A, true);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.started, true);
        const order = calls.filter((c) => c.node === A.name && c.method !== "get").map((c) => c.urlPath);
        assert.deepStrictEqual(order, ["/lavalink/config", "/lavalink/start"]);
        assert.strictEqual(lavalinkStore.nodeEnabled(await lavalinkStore.get(), A._id), true);
    });

    await test("on leaves a node without Lavalink alone", async () => {
        await turnOff(A);
        agents[A._id].raw = rawStatus({ installed: false, live: { status: "stopped" } });
        const r = await lavalink.setEnabled(A, true);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.started, false);
        assert.match(r.note, /not installed/);
        assert.strictEqual(calls.filter((c) => c.method !== "get").length, 0);
    });

    await test("on does not start one already running", async () => {
        await turnOff(A);
        const r = await lavalink.setEnabled(A, true);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.alreadyRunning, true);
        assert.strictEqual(callsTo(A, "/lavalink/start").length, 0);
        assert.strictEqual(callsTo(A, "/lavalink/config").length, 1);
    });

    console.log("while off");

    await test("Sync all passes a node that is off by", async () => {
        await turnOff(A);
        const r = await lavalink.syncAll({ restart: true });
        assert.deepStrictEqual(r.results.map((x) => x.nodeName), [B.name]);
        assert.deepStrictEqual(r.skipped, [{ nodeId: A._id, nodeName: A.name, state: "disabled" }]);
        assert.strictEqual(callsTo(A, "/lavalink/config").length, 0);
    });

    await test("per-node Sync / Install / Update refuse without touching the node", async () => {
        await turnOff(A);
        const release = await lavalink.latestRelease();
        for (const r of [
            await lavalink.syncNode(A),
            await lavalink.installOnNode(A),
            await lavalink.updateNode(A, release),
        ]) {
            assert.strictEqual(r.ok, false);
            assert.match(r.error, /turned off on "dio"/);
        }
        assert.strictEqual(calls.length, 0);
    });

    await test("Start / Restart / Rollback refuse with 409, Stop still works", async () => {
        await turnOff(A);
        for (const action of ["start", "restart", "rollback"]) {
            await assert.rejects(lavalink.control(A, action), (err) => err.status === 409 && /turn it on first/.test(err.message));
        }
        await lavalink.control(A, "stop");
        assert.strictEqual(callsTo(A, "/lavalink/stop").length, 1);
        assert.strictEqual(calls.length, 1);
    });

    await test("the 02:00 job never updates a node that is off", async () => {
        await turnOff(A);
        const r = await updater.run();
        assert.deepStrictEqual(r.results.map((x) => x.nodeName), [B.name]);
        assert.ok(r.skipped.some((s) => s.nodeName === A.name && s.state === "disabled"));
        assert.strictEqual(callsTo(A, "/lavalink/update").length, 0);
        assert.strictEqual(callsTo(B, "/lavalink/update").length, 1);
    });

    console.log("routes");

    await test("POST /nodes/:id/enabled and the 409 on Start", async () => {
        const app = express();
        app.use(express.json());
        app.use("/api/lavalink", require("../server/routes/lavalink"));
        app.use(require("../server/middleware/errorHandler"));
        const server = await new Promise((resolve) => {
            const s = app.listen(0, "127.0.0.1", () => resolve(s));
        });
        const post = (urlPath, body) =>
            new Promise((resolve, reject) => {
                const data = JSON.stringify(body);
                const req = http.request(
                    {
                        host: "127.0.0.1",
                        port: server.address().port,
                        path: urlPath,
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
                    },
                    (res) => {
                        let text = "";
                        res.on("data", (c) => (text += c));
                        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text || "null") }));
                    },
                );
                req.on("error", reject);
                req.end(data);
            });
        try {
            let r = await post(`/api/lavalink/nodes/${A._id}/enabled`, { enabled: "no" });
            assert.strictEqual(r.status, 400);

            r = await post(`/api/lavalink/nodes/nope/enabled`, { enabled: false });
            assert.strictEqual(r.status, 404);

            r = await post(`/api/lavalink/nodes/${A._id}/enabled`, { enabled: false });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.body.enabled, false);
            assert.strictEqual(r.body.stopped, true);

            r = await post(`/api/lavalink/nodes/${A._id}/start`, {});
            assert.strictEqual(r.status, 409);
            assert.match(r.body.error, /turned off on "dio"/);

            r = await post(`/api/lavalink/nodes/${A._id}/enabled`, { enabled: true });
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.body.ok, true);
            assert.strictEqual(r.body.started, true);
        } finally {
            server.close();
        }
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
