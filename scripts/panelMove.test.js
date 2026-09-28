#!/usr/bin/env node
/**
 * Checks for the panel-move plumbing — no test framework needed.
 * Run:  node scripts/panelMove.test.js
 *
 * The real panel DB is never opened: server/db is replaced by an in-memory
 * stand-in before anything requires it. Covered, in the order a move uses them:
 *   - lifecycle: background jobs only run while active; maintenance and
 *     fencing stop them; a fenced panel can never activate again
 *   - lifecycleGate: which requests pass in each state
 *   - panelLease + nodeService.agentRequest: the epoch header goes out on every
 *     agent call, and an agent's 409 PANEL_SUPERSEDED fences the panel
 *   - integrationService: the address the panel uses for a linked project,
 *     from this node and from a move's target node
 *   - panelMigration.setEnvKey: rewriting PANEL_NODE_ID in the copied .env
 *   - apiKeyService + middleware/apiKey: per-project keys next to the shared one
 *   - callbackService: a callback follows the project that registered it and
 *     is signed with its key; only orphans are rewritten by a move
 */

const http = require("http");
const path = require("path");
const assert = require("assert");

// ── In-memory stand-in for server/db (QuickDB) ───────────────────────────────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => e[k] === q[k]);
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async push(k, ...items) { store.set(k, [...(store.get(k) || []), ...clone(items)]); },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0]; },
    async findOneAndUpdate(model, q, data) {
        const arr = (await this.get(model)) || [];
        const i = arr.findIndex((e) => matches(e, q));
        if (i < 0) return null;
        arr[i] = { ...arr[i], ...data };
        await this.set(model, arr);
        return arr[i];
    },
    async findOneAndDelete(model, q) {
        const arr = (await this.get(model)) || [];
        await this.set(model, arr.filter((e) => !matches(e, q)));
    },
};
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

process.env.PANEL_NODE_ID = "node-panel";
delete process.env.ARNTO_DM_URL;
delete process.env.ARNTO_QUEST_WEBHOOK_URL;
process.env.SHOP_API_URL = "http://127.0.0.1:45299";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.PANEL_API_KEY = "shared-secret";
process.env.PORT = "1975";

const lifecycle = require("../server/services/lifecycle");
const lifecycleGate = require("../server/middleware/lifecycleGate");
const panelLease = require("../server/services/panelLease");
const nodeService = require("../server/services/nodeService");
const integrations = require("../server/services/integrationService");
const { setEnvKey } = require("../server/services/panelMigration");
const { envValue } = require("../server/utils/envText");
const apiKeys = require("../server/services/apiKeyService");
const { apiKeyMiddleware } = require("../server/middleware/apiKey");
const callbacks = require("../server/services/callbackService");
const panelDomains = require("../server/services/panelDomains");

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

/** Run the gate against a fake request; returns { passed, status, code }. */
const gate = (method, p) => {
    const out = { passed: false, status: null, code: null };
    const res = {
        status(c) { out.status = c; return this; },
        json(b) { out.code = b.code; return this; },
    };
    lifecycleGate({ method, path: p }, res, () => { out.passed = true; });
    return out;
};

(async () => {
    console.log("lifecycle + gate");

    await test("starts in 'starting': scheduled jobs are skipped, writes wait", () => {
        let ran = 0;
        lifecycle.guard(() => ran++)();
        assert.strictEqual(ran, 0);
        assert.strictEqual(gate("POST", "/bots").code, "PANEL_STARTING");
        assert.ok(gate("GET", "/bots").passed);
        assert.ok(gate("POST", "/auth/login").passed);
    });

    await test("activate(): jobs run, everything passes the gate", () => {
        assert.strictEqual(lifecycle.activate(), true);
        let ran = 0;
        lifecycle.guard(() => ran++)();
        assert.strictEqual(ran, 1);
        assert.ok(gate("POST", "/bots").passed);
    });

    await test("maintenance: jobs stop, reads pass, writes get PANEL_MAINTENANCE", async () => {
        const r = await lifecycle.enterMaintenance({ to: "VPS pokeclaw" });
        assert.strictEqual(r.questsSuspended, 0);
        let ran = 0;
        lifecycle.guard(() => ran++)();
        assert.strictEqual(ran, 0);
        const w = gate("POST", "/external/quests/start");
        assert.strictEqual(w.status, 503);
        assert.strictEqual(w.code, "PANEL_MAINTENANCE");
        assert.ok(gate("GET", "/external/bots").passed);
        assert.ok(gate("GET", "/panel/migration").passed);
    });

    await test("a second maintenance is refused while one is running", async () => {
        await assert.rejects(() => lifecycle.enterMaintenance(), /maintenance, not active/);
    });

    await test("exitMaintenance(): back to active (an aborted move)", async () => {
        await lifecycle.exitMaintenance();
        assert.strictEqual(lifecycle.get().state, "active");
        assert.ok(gate("POST", "/bots").passed);
    });

    console.log("panelLease + agentRequest");

    await test("a panel with no stored epoch starts at 1 and records it", async () => {
        assert.strictEqual(await panelLease.load(), 1);
        assert.strictEqual((await fakeDb.get("panel_lease")).epoch, 1);
        assert.deepStrictEqual(panelLease.headers(), { "x-panel-epoch": "1" });
    });

    // A stand-in agent: follows epoch 5, refuses anything older like the real one.
    const seen = [];
    const agent = http.createServer((req, res) => {
        seen.push({ path: req.url, epoch: req.headers["x-panel-epoch"], key: req.headers["x-agent-key"] });
        const epoch = req.headers["x-panel-epoch"];
        res.setHeader("content-type", "application/json");
        if (epoch !== undefined && Number(epoch) < 5) {
            res.statusCode = 409;
            return res.end(JSON.stringify({ error: "superseded", code: "PANEL_SUPERSEDED", lease: { epoch: 5, panelNodeId: "node-new" } }));
        }
        res.end(JSON.stringify({ epoch: 5 }));
    });
    await new Promise((r) => agent.listen(0, "127.0.0.1", r));
    const node = { _id: "node-x", name: "VPS x", host: "127.0.0.1", port: agent.address().port, apiKey: "k" };

    await test("noEpoch requests leave the header off and are answered", async () => {
        const r = await nodeService.agentRequest(node, "get", "/lease", { noEpoch: true });
        assert.strictEqual(r.epoch, 5);
        assert.strictEqual(seen.at(-1).epoch, undefined);
        assert.strictEqual(seen.at(-1).key, "k");
    });

    await test("an older panel's request gets 409, and the panel fences itself", async () => {
        assert.strictEqual(lifecycle.get().state, "active");
        await assert.rejects(() => nodeService.agentRequest(node, "get", "/pm2/list"), (err) => err.code === "PANEL_SUPERSEDED" && err.status === 409);
        assert.strictEqual(seen.at(-1).epoch, "1");
        assert.strictEqual(lifecycle.get().state, "fenced");
        assert.strictEqual(lifecycle.get().info.byNodeId, "node-new");
    });

    await test("fenced: jobs never run, the gate refuses all but health/auth/move status, activate() is refused", () => {
        let ran = 0;
        lifecycle.guard(() => ran++)();
        assert.strictEqual(ran, 0);
        assert.strictEqual(gate("GET", "/bots").code, "PANEL_SUPERSEDED");
        assert.strictEqual(gate("POST", "/panel/migration/start").code, "PANEL_SUPERSEDED");
        assert.ok(gate("GET", "/health").passed);
        assert.ok(gate("GET", "/panel/migration").passed);
        assert.strictEqual(lifecycle.activate(), false);
    });

    agent.close();

    console.log("integrations");

    await fakeDb.set("nodes", [
        { _id: "node-panel", name: "sangs", host: "160.191.87.150", port: 4200, wgOverlayIp: "10.88.0.4" },
        { _id: "node-dio", name: "dio", host: "160.191.87.61", port: 4200, wgOverlayIp: "10.88.0.3" },
        { _id: "node-poke", name: "pokeclaw", host: "14.225.211.157", port: 4200 },
    ]);
    await fakeDb.set("bots", [
        { _id: "bot-shop", name: "arnto-shop", nodeId: "node-panel" },
        { _id: "bot-auto", name: "arnto-auto", nodeId: "node-dio" },
    ]);

    await test("unlinked: the .env URL is used as-is, and a loopback one is recognised", async () => {
        const r = await integrations.resolve("shop");
        assert.strictEqual(r.source, "env");
        assert.strictEqual(r.url, "http://127.0.0.1:45299");
        assert.ok(integrations.isLoopbackUrl(r.url));
        assert.ok(integrations.isLoopbackUrl("http://localhost:1942"));
        assert.ok(!integrations.isLoopbackUrl("https://panel.thunderbolt.io.vn"));
        assert.strictEqual((await integrations.resolve("dm")).source, "none");
    });

    await test("linked project on the panel's node → 127.0.0.1", async () => {
        await integrations.setLink("shop", { botId: "bot-shop", port: 45299 });
        const r = await integrations.resolve("shop");
        assert.strictEqual(r.source, "project");
        assert.strictEqual(r.url, "http://127.0.0.1:45299");
    });

    await test("the same link seen from a move's target → the project's node over WireGuard", async () => {
        const r = await integrations.resolve("shop", { fromNodeId: "node-poke" });
        assert.strictEqual(r.url, "http://10.88.0.4:45299");
        assert.strictEqual(r.local, false);
    });

    await test("a project on another node → its WireGuard IP; no overlay → its public host", async () => {
        await integrations.setLink("dm", { botId: "bot-auto", port: 1942 });
        assert.strictEqual(await integrations.baseUrl("dm"), "http://10.88.0.3:1942");
        await fakeDb.findOneAndUpdate("bots", { _id: "bot-auto" }, { nodeId: "node-poke" });
        assert.strictEqual(await integrations.baseUrl("dm"), "http://14.225.211.157:1942");
    });

    await test("a link to a deleted project fails loudly instead of calling the wrong host", async () => {
        await fakeDb.findOneAndDelete("bots", { _id: "bot-auto" });
        await assert.rejects(() => integrations.resolve("dm"), /no longer exists/);
    });

    await test("unlinking falls back to the .env URL; bad input is refused", async () => {
        await integrations.setLink("shop", null);
        assert.strictEqual((await integrations.resolve("shop")).source, "env");
        await assert.rejects(() => integrations.setLink("shop", { botId: "bot-shop", port: 0 }), /valid port/);
        await assert.rejects(() => integrations.setLink("shop", { botId: "nope", port: 1 }), /not found/);
        await assert.rejects(() => integrations.setLink("mail", null), /Unknown integration/);
    });

    console.log("setEnvKey");

    await test("PANEL_NODE_ID is rewritten in place, everything else byte-identical", () => {
        const env = "# panel\nPORT=1975\nJWT_SECRET=abc=def\n\n# node\nPANEL_NODE_ID=OfZUe9L9B1NqCcUqfRkwl6HJ\nX=1\n";
        const out = setEnvKey(env, "PANEL_NODE_ID", "HRJAlEc08chkJ9k7ZGVt9YxB");
        assert.strictEqual(out, env.replace("OfZUe9L9B1NqCcUqfRkwl6HJ", "HRJAlEc08chkJ9k7ZGVt9YxB"));
    });

    await test("a .env without PANEL_NODE_ID gets it appended", () => {
        assert.strictEqual(setEnvKey("PORT=1\n", "PANEL_NODE_ID", "n"), "PORT=1\nPANEL_NODE_ID=n\n");
    });

    console.log("callback URLs");

    await test("envValue: plain, quoted, commented-out and missing keys", () => {
        const env = "# ARNTO_QUEST_WEBHOOK_URL=http://old\nARNTO_QUEST_WEBHOOK_URL=\"http://localhost:1942/api/quest-event\"\r\nEMPTY=\nX=a=b\n";
        assert.strictEqual(envValue(env, "ARNTO_QUEST_WEBHOOK_URL"), "http://localhost:1942/api/quest-event");
        assert.strictEqual(envValue(env, "X"), "a=b");
        assert.strictEqual(envValue(env, "EMPTY"), null);
        assert.strictEqual(envValue(env, "NOPE"), null);
    });

    await test("relocateUrl: only the loopback host changes, the rest is byte-identical", () => {
        const { relocateUrl } = callbacks;
        assert.strictEqual(relocateUrl("http://localhost:1942/api/quest-event", "10.88.0.4"), "http://10.88.0.4:1942/api/quest-event");
        assert.strictEqual(relocateUrl("http://127.0.0.1:1942/api/badge-event?x=1", "10.88.0.4"), "http://10.88.0.4:1942/api/badge-event?x=1");
        assert.strictEqual(relocateUrl("https://LOCALHOST/hook", "10.88.0.4"), "https://10.88.0.4/hook");
        assert.strictEqual(relocateUrl("http://[::1]:80", "10.88.0.4"), "http://10.88.0.4:80");
        assert.strictEqual(relocateUrl("http://localhost.example.com/x", "10.88.0.4"), null);
        assert.strictEqual(relocateUrl("https://panel.thunderbolt.io.vn/api", "10.88.0.4"), null);
        assert.strictEqual(relocateUrl("http://localhost:1942", null), null);
        assert.strictEqual(relocateUrl(null, "10.88.0.4"), null);
    });

    console.log("API keys");

    // sangs = the panel's node, dio has an overlay IP, pokeclaw none (set above).
    await fakeDb.set("bots", [
        { _id: "bot-shop", name: "arnto-shop", nodeId: "node-panel" },
        { _id: "bot-auto", name: "arnto-auto", nodeId: "node-panel" },
        { _id: "bot-dio", name: "dio-bot", nodeId: "node-dio" },
    ]);
    await fakeDb.set("integrations", {});
    let autoKey = null;

    await test("create: a pk_ key shown once; stored only as hash + encrypted copy", async () => {
        const { key, record } = await apiKeys.create({ botId: "bot-auto", label: "" });
        autoKey = key;
        assert.match(key, /^pk_[A-Za-z0-9_-]{32}$/);
        assert.strictEqual(record.botName, "arnto-auto");
        assert.strictEqual(record.label, "arnto-auto");
        const raw = JSON.stringify(await fakeDb.get("api_keys"));
        assert.ok(!raw.includes(key), "plaintext key must not be stored");
        const listed = await apiKeys.list();
        assert.deepStrictEqual(Object.keys(listed[0]).sort(), ["_id", "botId", "botName", "createdAt", "label", "lastUsedAt", "prefix", "revokedAt"]);
        await assert.rejects(() => apiKeys.create({ botId: "nope" }), /Project not found/);
    });

    await test("verify / keyFor: the key maps back to its project; unknown keys map to nothing", async () => {
        assert.strictEqual((await apiKeys.verify(autoKey)).botId, "bot-auto");
        assert.strictEqual(await apiKeys.verify("pk_not-a-real-key"), null);
        assert.strictEqual(await apiKeys.verify("shared-secret"), null);
        assert.strictEqual(await apiKeys.keyFor("bot-auto"), autoKey);
        assert.strictEqual(await apiKeys.keyFor("bot-shop"), null);
    });

    /** Run the middleware; resolves { passed, status, caller }. */
    const auth = (key) =>
        new Promise((resolve) => {
            const req = { headers: key === undefined ? {} : { "x-api-key": key } };
            const res = { status(c) { resolve({ passed: false, status: c }); return this; }, json() { return this; } };
            apiKeyMiddleware(req, res, () => resolve({ passed: true, caller: req.apiCaller }));
        });

    await test("middleware: shared key → caller unknown, project key → its project, anything else → 401", async () => {
        assert.deepStrictEqual((await auth("shared-secret")).caller, { shared: true });
        const p = await auth(autoKey);
        assert.ok(p.passed);
        assert.strictEqual(p.caller.botId, "bot-auto");
        assert.strictEqual((await auth("pk_wrong")).status, 401);
        assert.strictEqual((await auth("shared-secreT")).status, 401);
        assert.strictEqual((await auth(undefined)).status, 401);
    });

    console.log("callbacks");

    await test("owned localhost callback → the owner's node as seen from the panel, signed with its key", async () => {
        const hook = "http://localhost:1942/api/quest-event";
        let r = await callbacks.resolve(hook, "bot-auto");
        assert.strictEqual(r.url, "http://127.0.0.1:1942/api/quest-event");
        assert.strictEqual(r.key, autoKey);
        // The panel moved to pokeclaw, the project stayed on sangs:
        r = await callbacks.resolve(hook, "bot-auto", { fromNodeId: "node-poke" });
        assert.strictEqual(r.url, "http://10.88.0.4:1942/api/quest-event");
        // The project was migrated to dio:
        await fakeDb.findOneAndUpdate("bots", { _id: "bot-auto" }, { nodeId: "node-dio" });
        r = await callbacks.resolve(hook, "bot-auto");
        assert.strictEqual(r.url, "http://10.88.0.3:1942/api/quest-event");
        await fakeDb.findOneAndUpdate("bots", { _id: "bot-auto" }, { nodeId: "node-panel" });
    });

    await test("shared-key callback: owner = the project linked under Integrations on that port, else sent as-is", async () => {
        const hook = "http://localhost:1942/api/quest-event";
        let r = await callbacks.resolve(hook, null, { fromNodeId: "node-poke" });
        assert.strictEqual(r.owner, null);
        assert.strictEqual(r.url, hook);
        assert.strictEqual(r.key, "shared-secret");
        await integrations.setLink("dm", { botId: "bot-auto", port: 1942 });
        r = await callbacks.resolve(hook, null, { fromNodeId: "node-poke" });
        assert.strictEqual(r.owner._id, "bot-auto");
        assert.strictEqual(r.url, "http://10.88.0.4:1942/api/quest-event");
        assert.strictEqual(r.key, autoKey);
    });

    await test("a key never goes to an outside host just because the port matches a link", async () => {
        const r = await callbacks.resolve("https://hooks.example.com:1942/x", null);
        assert.strictEqual(r.owner, null);
        assert.strictEqual(r.key, "shared-secret");
        const owned = await callbacks.resolve("http://10.88.0.4:1942/x", "bot-auto");
        assert.strictEqual(owned.url, "http://10.88.0.4:1942/x");
        assert.strictEqual(owned.key, autoKey);
    });

    await test("send(): the request reaches the resolved address with the owner's key", async () => {
        let got;
        const received = new Promise((resolve) => {
            got = http.createServer((req, res) => {
                let body = "";
                req.on("data", (c) => (body += c));
                req.on("end", () => {
                    res.end("{}");
                    resolve({ path: req.url, key: req.headers["x-api-key"], body: JSON.parse(body) });
                });
            });
        });
        await new Promise((r) => got.listen(0, "127.0.0.1", r));
        callbacks.send(`http://localhost:${got.address().port}/api/quest-event`, "bot-auto", { type: "quest_done" });
        const hit = await received;
        got.close();
        assert.strictEqual(hit.path, "/api/quest-event");
        assert.strictEqual(hit.key, autoKey);
        assert.deepStrictEqual(hit.body, { type: "quest_done" });
    });

    await test("revoke: the key stops working and callbacks fall back to the shared key", async () => {
        const [rec] = await apiKeys.list();
        await apiKeys.revoke(rec._id);
        assert.strictEqual(await apiKeys.verify(autoKey), null);
        assert.strictEqual(await apiKeys.keyFor("bot-auto"), null);
        assert.strictEqual((await callbacks.resolve("http://localhost:1942/x", "bot-auto")).key, "shared-secret");
        assert.strictEqual((await apiKeys.list())[0].revokedAt !== null, true);
    });

    await test("audit + relocateOrphans: owned callbacks follow their project, only orphans are pinned by a move", async () => {
        await fakeDb.set("quest_monthly", [
            { _id: "m1", webhookUrl: "http://localhost:1942/api/quest-event", webhookBotId: "bot-auto" },
            { _id: "m2", webhookUrl: "http://localhost:1942/api/quest-event" }, // shared key, owned via the dm link
            { _id: "m3", webhookUrl: "http://localhost:5555/hook" }, // nobody on 5555 → orphan
            { _id: "m4", webhookUrl: "https://hooks.example.com/q" },
            { _id: "m5", webhookUrl: null },
            { _id: "m6" },
        ]);
        await fakeDb.set("badge_orders", [{ _id: "b1", webhookUrl: "http://127.0.0.1:5555/hook", status: "done" }]);

        const groups = await callbacks.audit();
        const owned = groups.find((g) => g.url.includes(":1942"));
        assert.strictEqual(owned.ownerBotId, "bot-auto");
        assert.deepStrictEqual(owned.sources, ["2 in quest_monthly"]);
        assert.deepStrictEqual(groups.filter((g) => !g.ownerBotId).map((g) => g.url).sort(), ["http://127.0.0.1:5555/hook", "http://localhost:5555/hook"]);

        assert.strictEqual(await callbacks.relocateOrphans("10.88.0.4"), 2);
        const monthly = await fakeDb.get("quest_monthly");
        assert.strictEqual(monthly[0].webhookUrl, "http://localhost:1942/api/quest-event");
        assert.strictEqual(monthly[1].webhookUrl, "http://localhost:1942/api/quest-event");
        assert.strictEqual(monthly[2].webhookUrl, "http://10.88.0.4:5555/hook");
        assert.strictEqual(monthly[3].webhookUrl, "https://hooks.example.com/q");
        assert.strictEqual(monthly[4].webhookUrl, null);
        assert.ok(!("webhookUrl" in monthly[5]));
        assert.deepStrictEqual((await fakeDb.get("badge_orders"))[0], { _id: "b1", webhookUrl: "http://10.88.0.4:5555/hook", status: "done" });
        assert.strictEqual(await callbacks.relocateOrphans("10.88.0.4"), 0);
    });

    console.log("panel gateway address");

    const sangs = { _id: "node-panel", name: "sangs", host: "160.191.87.150", wgOverlayIp: "10.88.0.4" };
    await test("each agent learns the panel's address as seen from its own node", () => {
        assert.strictEqual(panelLease.panelUrlFor(sangs, sangs), "http://127.0.0.1:1975");
        assert.strictEqual(panelLease.panelUrlFor({ _id: "node-dio" }, sangs), "http://10.88.0.4:1975");
        assert.strictEqual(panelLease.panelUrlFor({ _id: "node-dio" }, { _id: "p", host: "14.225.211.157" }), "http://14.225.211.157:1975");
        assert.strictEqual(panelLease.panelUrlFor({ _id: "node-dio" }, { _id: "p", host: "2001:db8::1" }), "http://[2001:db8::1]:1975");
        assert.strictEqual(panelLease.panelUrlFor({ _id: "node-dio" }, null), null);
    });

    await test("claimAll sends every agent its own panelUrl", async () => {
        const claims = [];
        const fakeAgent = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                claims.push({ port: req.socket.localPort, body: JSON.parse(body || "{}") });
                res.setHeader("content-type", "application/json");
                res.end("{}");
            });
        });
        const a = http.createServer(fakeAgent.listeners("request")[0]);
        const portA = await new Promise((r) => fakeAgent.listen(0, "127.0.0.1", () => r(fakeAgent.address().port)));
        const portB = await new Promise((r) => a.listen(0, "127.0.0.1", () => r(a.address().port)));
        await fakeDb.set("nodes", [
            { _id: "node-panel", name: "sangs", host: "127.0.0.1", port: portA, apiKey: "k", wgOverlayIp: "10.88.0.4" },
            { _id: "node-dio", name: "dio", host: "127.0.0.1", port: portB, apiKey: "k" },
        ]);
        await panelLease.claimAll();
        fakeAgent.close();
        a.close();
        const byPort = Object.fromEntries(claims.map((c) => [c.port, c.body]));
        assert.strictEqual(byPort[portA].panelUrl, "http://127.0.0.1:1975");
        assert.strictEqual(byPort[portB].panelUrl, "http://10.88.0.4:1975");
        assert.strictEqual(byPort[portB].panelNodeId, "node-panel");
    });

    console.log("panel domains (one or more per node)");

    const rows = [
        { domain: "panel.example.com", nodeId: "node-panel", sslEnabled: true, addedAt: 1 },
        { domain: "old.example.com", nodeId: "node-panel", sslEnabled: false, addedAt: 0 },
        { domain: "panel-poke.example.com", nodeId: "node-poke", sslEnabled: true, addedAt: 2 },
    ];

    await test("the panel's address is the first domain of its node, https once it has a certificate", () => {
        assert.strictEqual(panelDomains.publicUrl(rows, sangs), "http://old.example.com");
        assert.strictEqual(panelDomains.publicUrl(rows.slice(0, 1).concat(rows[2]), sangs), "https://panel.example.com");
        assert.strictEqual(panelDomains.publicUrl([], sangs), "http://160.191.87.150:1975");
    });

    await test("the panel's node proxies its domains, every other node redirects to the panel", () => {
        const plan = panelDomains.planSites(rows, sangs);
        assert.deepStrictEqual(plan.get("node-panel"), [
            { domain: "panel.example.com", mode: "proxy", port: 1975 },
            { domain: "old.example.com", mode: "proxy", port: 1975 },
        ]);
        assert.deepStrictEqual(plan.get("node-poke"), [{ domain: "panel-poke.example.com", mode: "redirect", to: "http://old.example.com" }]);
    });

    await test("after a move the same domains flip — no DNS change anywhere", () => {
        const poke = { _id: "node-poke", name: "pokeclaw", host: "14.225.211.157" };
        const plan = panelDomains.planSites(rows, poke);
        assert.deepStrictEqual(plan.get("node-poke"), [{ domain: "panel-poke.example.com", mode: "proxy", port: 1975 }]);
        assert.ok(plan.get("node-panel").every((s) => s.mode === "redirect" && s.to === "https://panel-poke.example.com"));
    });

    await test("normalize: domains from before per-node domains get the given node, once", async () => {
        await fakeDb.set("panel_domains", [{ domain: "a.example.com", sslEnabled: true }, { domain: "b.example.com", nodeId: "node-poke" }]);
        assert.strictEqual(await panelDomains.normalize("node-panel"), 1);
        assert.deepStrictEqual((await fakeDb.get("panel_domains")).map((d) => d.nodeId), ["node-panel", "node-poke"]);
        assert.strictEqual(await panelDomains.normalize("node-dio"), 0);
        assert.strictEqual((await fakeDb.get("panel_domains"))[0].nodeId, "node-panel");
    });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    // restore() fires a background request to Discord; do not wait for it.
    process.exit(0);
})();
