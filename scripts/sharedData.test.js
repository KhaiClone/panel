#!/usr/bin/env node
/**
 * Checks for shared data (server/services/sharedStore.js + routes/dataExternal.js)
 * and the bot library that talks to it (bot-lib/QuickDB.js, bot-lib/PanelBus.js).
 * Run:  node scripts/sharedData.test.js
 *
 * The real route runs in-process on a throwaway shared.sqlite; the bot library
 * talks to it over HTTP exactly as a bot does through its gateway. The core
 * guarantee: the same sequence of calls gives the same results whether a name
 * is local to the bot or shared on the panel.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "shared-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (only bots are read here).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
const fakeDb = {
    store: new Map([["bots", [{ _id: "shop", name: "Shop", botID: "1378037598953672746" }, { _id: "auto", name: "Auto", botID: "1480411893448573009" }]]]),
    async get(k) { return JSON.parse(JSON.stringify(this.store.get(k) ?? null)); },
    async set(k, v) { this.store.set(k, v); },
    async find(m, q = {}) { return ((await this.get(m)) || []).filter((e) => Object.keys(q).every((k) => e[k] === q[k])); },
    async findOne(m, q) { return (await this.find(m, q))[0]; },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const PanelBus = require("../bot-lib/PanelBus");

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

// The data route, with a fake key check: x-api-key "key-<botId>" = that project.
const app = express();
app.use("/api/external/data", (req, res, next) => {
    const k = String(req.headers["x-api-key"] || "");
    if (k.startsWith("key-")) req.apiCaller = { botId: k.slice(4), keyId: "k" };
    next();
}, require("../server/routes/dataExternal"));
const server = http.createServer(app);

/** A bot-lib QuickDB with its own json.sqlite, as project `botId`. */
const botDb = (botId, shared, ttl = "0") => {
    process.env.PANEL_API_KEY = `key-${botId}`;
    process.env.PANEL_SHARED = shared;
    process.env.PANEL_SHARED_TTL_MS = ttl;
    delete require.cache[require.resolve("../bot-lib/QuickDB")];
    const QuickDBExtension = require("../bot-lib/QuickDB");
    return new QuickDBExtension({ filePath: path.join(TMP, `${botId}-${shared.replace(/\W/g, "_") || "local"}.sqlite`) });
};

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === "_id" ? "<id>" : x)));

(async () => {
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    process.env.PANEL_API_URL = `http://127.0.0.1:${server.address().port}`;

    console.log("adoption");

    const shop = botDb("shop", "orders,nextOrderId");
    // The shop's local data before the move — written to its json.sqlite through
    // the base class, as the bot's old code did.
    const setLocal = (k, v) => require("quick.db").QuickDB.prototype.set.call(shop, k, v);
    await setLocal("orders", [
        { _id: "o1", orderId: "arnto_1", status: "pending", price: 100, buyerId: "u1" },
        { _id: "o2", orderId: "arnto_2", status: "completed", price: 250, buyerId: "u2" },
    ]);
    await setLocal("nextOrderId", 2);

    await test("an undeclared name cannot be adopted; reads say so", async () => {
        await assert.rejects(() => shop.find("orders"), /not shared data/);
    });

    await test("declared names are adopted once, with the bot's local copy", async () => {
        sharedStore.declare("orders", "collection", "shop");
        sharedStore.declare("nextOrderId", "value", "shop");
        // Reads before the bot adopts are refused, never answered from an empty copy.
        await assert.rejects(() => shop.find("orders"), /not been adopted/);
    });

    // The bot library's first start.
    await test("adoptShared uploads orders + the counter; a second start does nothing", async () => {
        await shop.adoptShared();
        assert.strictEqual(sharedStore.nameRow("orders").state, "active");
        assert.strictEqual(sharedStore.run("orders", "get").length, 2);
        assert.strictEqual(sharedStore.run("nextOrderId", "get"), 2);
        await shop.adoptShared();
        assert.strictEqual(sharedStore.run("orders", "get").length, 2);
    });

    console.log("same results, local or shared");

    const local = botDb("shop", ""); // nothing shared: pure quick.db
    await local.set("orders", [
        { _id: "o1", orderId: "arnto_1", status: "pending", price: 100, buyerId: "u1" },
        { _id: "o2", orderId: "arnto_2", status: "completed", price: 250, buyerId: "u2" },
    ]);
    await local.set("nextOrderId", 2);

    const script = async (d) => {
        const out = [];
        out.push(await d.add("nextOrderId", 1));
        const created = await d.create("orders", { orderId: "arnto_3", status: "pending", price: 70, buyerId: "u1" });
        out.push(typeof created._id === "string" && created._id.length === 24);
        out.push(await d.findOne("orders", { orderId: "arnto_3" }));
        out.push(await d.findOne("orders", { orderId: "nope" }));
        out.push(await d.find("orders", { buyerId: "u1" }));
        out.push(await d.findOneAndUpdate("orders", { orderId: "arnto_1" }, { status: "completed" }));
        out.push(await d.findOneAndUpdate("orders", { orderId: "nope" }, { status: "x" }));
        out.push(await d.createMany("orders", [{ orderId: "a" }, { orderId: "b" }]));
        out.push(await d.findOneAndDelete("orders", { orderId: "a" }));
        out.push(await d.deleteMany("orders", { orderId: "b" }));
        out.push(await d.get("orders"));
        out.push(await d.get("nextOrderId"));
        await assert.rejects(() => d.findOneAndUpdate("orders", { orderId: "arnto_1" }, { _id: "x" }), /can't change _id/);
        return strip(out);
    };

    await test("the same calls give the same answers on quick.db and on the panel", async () => {
        const a = await script(local);
        const b = await script(shop);
        assert.deepStrictEqual(b, a);
    });

    await test("a findOne miss is undefined on both, not null", async () => {
        assert.strictEqual(await local.findOne("orders", { orderId: "nope" }), undefined);
        assert.strictEqual(await shop.findOne("orders", { orderId: "nope" }), undefined);
    });

    await test("create() still gives the caller's own object its _id", async () => {
        const o = { orderId: "arnto_9" };
        const r = await shop.create("orders", o);
        assert.strictEqual(r, o);
        assert.match(o._id, /^[\w-]{24}$/);
    });

    await test("names that are not shared stay in the bot's own json.sqlite", async () => {
        await shop.set("tickets", [{ id: 1 }]);
        assert.deepStrictEqual(await shop.get("tickets"), [{ id: 1 }]);
        assert.strictEqual(sharedStore.nameRow("tickets"), null);
    });

    console.log("ownership and outages");

    await test("another project cannot read or write the shop's names", async () => {
        const auto = botDb("auto", "orders");
        await assert.rejects(() => auto.find("orders"), /belongs to another project/);
        await assert.rejects(() => auto.create("orders", { x: 1 }), /belongs to another project/);
    });

    await test("the shared key (no project) is refused outright", async () => {
        const res = await fetch(`${process.env.PANEL_API_URL}/api/external/data/orders?op=get`, { headers: { "x-api-key": "shared" } });
        assert.strictEqual(res.status, 403);
    });

    await test("panel unreachable: reads answer the last value, writes fail", async () => {
        const seen = await shop.find("orders", { buyerId: "u2" });
        const port = server.address().port;
        await new Promise((r) => server.close(r));
        const warn = console.warn;
        console.warn = () => {};
        try {
            assert.deepStrictEqual(await shop.find("orders", { buyerId: "u2" }), seen);
            await assert.rejects(() => shop.create("orders", { x: 1 }), /unreachable/);
            await assert.rejects(() => shop.find("orders", { buyerId: "never-read" }), /unreachable/);
        } finally {
            console.warn = warn;
        }
        await new Promise((r) => server.listen(port, "127.0.0.1", r));
    });

    await test("a TTL cache serves repeated reads without a call, and a write clears it", async () => {
        const cached = botDb("shop", "orders", "60000");
        const before = (await cached.get("orders")).length;
        sharedStore.run("orders", "create", { data: { orderId: "from-panel" } }); // panel-side change
        assert.strictEqual((await cached.get("orders")).length, before); // still cached
        await cached.create("orders", { orderId: "from-bot" });
        assert.strictEqual((await cached.get("orders")).length, before + 2);
    });

    console.log("bus signatures");

    await test("a command signed by the panel verifies in the bot library, and the reply back", () => {
        const key = "pk_test_key";
        process.env.PANEL_API_KEY = key;
        const bus = new PanelBus({ user: null, db: null });
        const cmd = { v: 1, id: "abc", ts: 1, kind: "cmd", cmd: "order.complete", body: { orderId: "arnto_1" } };
        cmd.sig = discordBus.sign(key, cmd);
        assert.ok(bus.verify(cmd));
        assert.ok(!bus.verify({ ...cmd, body: { orderId: "arnto_2" } }));
        const reply = { v: 1, id: "abc", ts: 2, kind: "reply", cmd: "order.complete", body: { ok: true, result: { status: "completed" } } };
        reply.sig = bus.sign(reply);
        assert.ok(discordBus.verify(key, reply));
        assert.ok(!discordBus.verify("another-key", reply));
    });

    await test("a command is for this bot by mention or by its text (posted before the bot joined)", () => {
        const bus = new PanelBus({ user: { id: "B" }, db: null });
        bus.channelId = "CH";
        bus.panelBotId = "P";
        const msg = (over) => ({ channelId: "CH", author: { id: "P" }, content: "", mentions: { users: new Map() }, ...over });
        assert.ok(bus.isForMe(msg({ mentions: { users: new Map([["B", {}]]) } })));
        assert.ok(bus.isForMe(msg({ content: "<@B> `panel-bus` ping" }))); // mention not recorded
        assert.ok(!bus.isForMe(msg({ content: "<@C> `panel-bus` ping" }))); // another bot's command
        assert.ok(!bus.isForMe(msg({ content: "<@B>", author: { id: "X" } }))); // not the panel
        assert.ok(!bus.isForMe(msg({ content: "<@B>", channelId: "OTHER" })));
    });

    server.close();
    sharedStore.close();
    // quick.db keeps its files open; Windows then refuses the delete — harmless.
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir left behind */ }

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
