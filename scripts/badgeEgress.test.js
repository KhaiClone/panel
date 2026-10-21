#!/usr/bin/env node
/**
 * Checks how an Auto Badge order picks its egress — no test framework needed.
 * Run:  node scripts/badgeEgress.test.js
 *
 * The incident: the sticky egress of an account (a node's CONNECT proxy or a bought
 * proxy) stopped answering, BadgeSender.init() died with "timeout of 15000ms
 * exceeded", and the paid order landed in "error" with no Retry button.
 *
 * The real panel DB is never opened (in-memory stand-in), Discord is stubbed, and
 * the egress pool is two fake nodes. Covered:
 *   - the sticky egress is dead → the order moves to the other one and is sent there
 *   - every egress dead → manual_review naming each one (English on the record,
 *     Vietnamese in the event for ArnTo-Auto), nothing sent, no direct connection
 *   - Retry from manual_review once an egress is back
 *   - an "error" order that sent nothing can be retried; one that sent some cannot
 *   - a dead token → token_dead after one try, no failover
 *   - no egress configured → direct connection, as before
 */

const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

const SERVER = path.join(__dirname, "..", "server");
const stubAbs = (p, exports) => {
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ── In-memory stand-in for server/db ─────────────────────────────────────────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => e[k] === q[k]);
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0] ?? null; },
    async create(model, data) {
        const arr = (await this.get(model)) || [];
        arr.push(data);
        await this.set(model, arr);
        return data;
    },
    async findOneAndUpdate(model, q, data) {
        const arr = (await this.get(model)) || [];
        const i = arr.findIndex((e) => matches(e, q));
        if (i < 0) return null;
        arr[i] = { ...arr[i], ...data };
        await this.set(model, arr);
        return arr[i];
    },
};
stubAbs(require.resolve(path.join(SERVER, "db")), fakeDb);
process.env.QUEST_ENC_SECRET = "badge-egress-test";

// ── Discord, stubbed per egress ──────────────────────────────────────────────
// Which egress a request went through: the node host the CONNECT agent points at.
const via = (cfg = {}) => cfg.httpsAgent?.proxy?.hostname ?? "direct";
let deadHosts = new Set();
let meStatus = 200;
const calls = [];
const GAMES = Array.from({ length: 30 }, (_, i) => ({
    id: String(1000 + i),
    name: `Game ${i}`,
    executables: [{ os: "win32", name: `game${i}.exe` }],
}));
const fakeAxios = {
    async get(url, cfg = {}) {
        if (url.includes("discord.com/app")) return { status: 200, data: "" }; // build number → fallback
        if (url.includes("/applications/detectable")) return { status: 200, data: GAMES };
        const host = via(cfg);
        calls.push({ method: "get", host });
        if (deadHosts.has(host)) {
            const e = new Error("timeout of 15000ms exceeded");
            e.code = "ECONNABORTED";
            throw e;
        }
        return { status: meStatus, data: { id: "42", username: "buyer", analytics_token: "at", locale: "vi" } };
    },
    async post(url, body, cfg = {}) {
        calls.push({ method: "post", host: via(cfg) });
        return { status: 204 };
    },
};
stubAbs(require.resolve("axios", { paths: [path.join(SERVER, "services")] }), fakeAxios);

// ── Egress pool: two nodes, no bought proxies ────────────────────────────────
const NODES = [
    { _id: "node-a", name: "node A", host: "10.0.0.1", port: 4200, apiKey: "k", enabled: true },
    { _id: "node-b", name: "node B", host: "10.0.0.2", port: 4200, apiKey: "k", enabled: true },
];
let nodes = NODES;
const nodeService = require("../server/services/nodeService");
nodeService.getNodes = async () => nodes;
nodeService.isNodeOffline = () => false;
const proxyStore = require("../server/services/proxyStore");
proxyStore.usable = async () => [];

// Progress is read with the buyer's own token: account at 0 games.
const badgeReader = require("../server/services/badgeReader");
badgeReader.checkNitro = async () => ({ userId: "42", username: "buyer", premiumType: 0, hasNitro: false, locale: "vi" });
badgeReader.readSelf = async (token, userId) => ({
    userId,
    source: "self",
    badges: { game_variety: { key: "game_variety", value: 0, currentTier: null, owned: false } },
});

const proxyPool = require("../server/services/proxyPool");
const badgeService = require("../server/services/badgeService");

const events = [];
badgeService.bus.on("event", (e) => events.push(e));

// ── Helpers ──────────────────────────────────────────────────────────────────
function encrypt(token) {
    const key = crypto.createHash("sha256").update(process.env.QUEST_ENC_SECRET).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update(token, "utf8"), c.final()]);
    return { tokenEncrypted: enc.toString("base64"), tokenIv: iv.toString("base64"), tokenTag: c.getAuthTag().toString("base64") };
}

async function addOrder(orderId, extra = {}) {
    await fakeDb.create("badge_orders", {
        orderId,
        accountId: "42",
        username: "buyer",
        hasNitro: false,
        ...encrypt("tok"),
        badgeKey: "game_variety",
        tierKey: "sampler",
        tierName: "Sampler",
        kind: "tiered",
        threshold: 5,
        unit: "games",
        overshoot: 1,
        forfeitOnWrongTier: true,
        status: "paid",
        error: null,
        sent: 0,
        total: 0,
        ...extra,
    });
}

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};

(async () => {
    console.log("badge orders — egress failover");

    // The node the sticky hash gives account 42 is the one that goes dead.
    const probe = await proxyPool.acquire("42", { feature: "badge" });
    probe.release();
    const sticky = NODES.find((n) => n._id === probe.source.id);
    const other = NODES.find((n) => n !== sticky);

    await test("proxyPool.acquire: exclude skips an entry, excluding all leaves no egress", async () => {
        const next = await proxyPool.acquire("42", { feature: "badge", exclude: [sticky._id] });
        next.release();
        assert.strictEqual(next.source.id, other._id);
        const none = await proxyPool.acquire("42", { feature: "badge", exclude: NODES.map((n) => n._id) });
        assert.strictEqual(none.source, null);
    });

    await test("the sticky egress is dead → sent through the other one", async () => {
        deadHosts = new Set([sticky.host]);
        calls.length = 0;
        await addOrder("o1");
        const o = await badgeService.processOrder("o1");
        assert.strictEqual(o.status, "sent", JSON.stringify(o));
        assert.strictEqual(o.sent, 5);
        const posts = calls.filter((c) => c.method === "post");
        assert.ok(posts.length > 0);
        assert.ok(posts.every((c) => c.host === other.host), "every /science batch goes through the working egress");
    });

    await test("every egress dead → manual_review naming each one, nothing sent", async () => {
        deadHosts = new Set(NODES.map((n) => n.host));
        calls.length = 0;
        events.length = 0;
        await addOrder("o2");
        const o = await badgeService.processOrder("o2");
        assert.strictEqual(o.status, "manual_review");
        assert.strictEqual(o.sent, 0);
        assert.match(o.error, /^Could not reach Discord through any egress \(/);
        assert.match(o.error, new RegExp(`${sticky.name}: timeout of 15000ms exceeded`));
        assert.match(o.error, new RegExp(`${other.name}: timeout of 15000ms exceeded`));
        assert.ok(!calls.some((c) => c.host === "direct"), "never falls back to the panel's own IP");
        assert.ok(!calls.some((c) => c.method === "post"));
        // ArnTo-Auto gets the Vietnamese text in the event.
        const review = events.find((e) => e.orderId === "o2" && e.type === "manual_review");
        assert.match(review.error, /^Không kết nối được Discord qua egress nào \(/);
        // It never reached "sending": a panel restart now re-runs it instead of parking it.
        assert.ok(!events.some((e) => e.orderId === "o2" && e.status === "sending"));
    });

    await test("Retry once an egress is back", async () => {
        deadHosts = new Set();
        const o = await badgeService.resolveManual("o2", "retry");
        assert.strictEqual(o.status, "sent");
    });

    await test("an \"error\" order that sent nothing can be retried, a partial one cannot", async () => {
        await addOrder("o3", { status: "error", error: "timeout of 15000ms exceeded" });
        const o = await badgeService.resolveManual("o3", "retry");
        assert.strictEqual(o.status, "sent");
        await addOrder("o4", { status: "error", sent: 3, total: 5 });
        await assert.rejects(badgeService.resolveManual("o4", "retry"), /not waiting for review/);
    });

    await test("a dead token → token_dead after one try, no failover", async () => {
        meStatus = 401;
        calls.length = 0;
        await addOrder("o5");
        const o = await badgeService.processOrder("o5");
        meStatus = 200;
        assert.strictEqual(o.status, "token_dead");
        assert.strictEqual(calls.filter((c) => c.method === "get").length, 1);
    });

    await test("no egress configured → direct connection, as before", async () => {
        nodes = [];
        calls.length = 0;
        await addOrder("o6");
        const o = await badgeService.processOrder("o6");
        nodes = NODES;
        assert.strictEqual(o.status, "sent");
        assert.ok(calls.length > 0 && calls.every((c) => c.host === "direct"));
    });

    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
