#!/usr/bin/env node
/**
 * Checks for Auto Badge orders added by hand on /badges (server/services/badgeService.js
 * createManualOrder + routes/badges.js): owner only, free, any catalog tier; an account
 * Discord will not read can be sent to with an entered value; owned tiers are refused,
 * and a manual order is never forfeited — only retried or cancelled. Paid orders keep
 * forfeiting. Discord, the sender, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/badgeManual.test.js
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
const db = {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    create: async (m, d) => {
        store.set(m, [...(store.get(m) || []), clone(d)]);
        return d;
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
};
stub("db", db);

// Discord accounts by token. values = null → Discord will not show the progress.
const accounts = {
    nonitro: { userId: "1", username: "free", hasNitro: false, values: null, house: null },
    nitro: { userId: "2", username: "rich", hasNitro: true, values: { game_time: 10, game_variety: 3 }, house: 1 },
    closed: { userId: "3", username: "closed", hasNitro: true, values: null, house: null },
};
const invalid = () => Object.assign(new Error("Token không hợp lệ hoặc đã chết"), { status: 400, invalidToken: true });
stub("services/badgeReader", {
    checkNitro: async (token) => {
        const a = accounts[token];
        if (!a) throw invalid();
        return { userId: a.userId, username: a.username, hasNitro: a.hasNitro, premiumType: a.hasNitro ? 2 : 0, locale: "vi" };
    },
    readSelf: async (token, userId) => {
        const a = accounts[token];
        if (!a.values) throw Object.assign(new Error("HTTP 404"), { status: 400, directoryClosed: true });
        const badges = {};
        for (const k of ["game_time", "game_variety", "streaming"]) {
            badges[k] = { key: k, value: a.values[k] ?? 0, currentTier: null, owned: (a.values[k] ?? 0) > 0 };
        }
        return { userId, source: "self", badges };
    },
    readHypeSquadHouse: async (token) => accounts[token].house,
    readPlayedApplicationIds: async () => [],
});

const plans = [];
const sender = { abort: false };
stub("services/badgeEngine", {
    planOrder: async (args) => {
        plans.push(args);
        const need = Math.ceil(Math.max(0, args.threshold - args.current) * args.overshoot);
        return { games: [{ id: "g1" }], sessions: Array.from({ length: need }, () => ({ game: { id: "g1" }, hours: 1 })), hoursPerSession: 1, need };
    },
    BadgeSender: class {
        async init() {}
        async run(plan) {
            const total = plan.sessions.length;
            return sender.abort ? { sent: 0, total, aborted: true, status: 429 } : { sent: total, total, aborted: false };
        }
    },
    setHypeSquad: async (token, houseId) => {
        accounts[token].house = houseId;
    },
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }) });
const webhooks = [];
stub("services/callbackService", { send: (url, botId, event) => webhooks.push(event) });

const badgeService = require("../server/services/badgeService");
const pricingStore = require("../server/services/pricingStore");
const router = require("../server/routes/badges");

// ── Helpers ──────────────────────────────────────────────────────────────────
let server;
let as = { kind: "owner", username: "admin" };
const call = (method, p, body) =>
    new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
            { port: server.address().port, path: p, method, agent: false, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
            (res) => {
                let out = "";
                res.on("data", (c) => (out += c));
                res.on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
            },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });

const SETTLED = new Set(["sent", "manual_review", "cancelled", "forfeited", "refund_due", "token_dead", "error"]);
const settle = async (orderId) => {
    for (let i = 0; i < 100; i++) {
        const o = await badgeService.getOrder(orderId);
        if (SETTLED.has(o.status)) return o;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`order ${orderId} never settled`);
};

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
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.auth = as;
        next();
    });
    app.use(router);
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));

    console.log("badgeService — accounts added by hand");

    await test("staff cannot check or create (owner only)", async () => {
        as = { kind: "staff", staff: { userId: "9", perms: { badges: "edit" } } };
        assert.strictEqual((await call("POST", "/manual/check", { token: "nitro" })).status, 403);
        assert.strictEqual((await call("POST", "/manual", { token: "nitro", badgeKey: "game_time", tierKey: "serious" })).status, 403);
        as = { kind: "owner", username: "admin" };
    });

    await test("check: catalog without unsupported badges, overshoot, and why progress is unreadable", async () => {
        const { status, body } = await call("POST", "/manual/check", { token: "nonitro" });
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.catalog.map((b) => b.key), ["game_time", "game_variety", "hypesquad"]);
        assert.strictEqual(body.overshoot, 1.1);
        assert.strictEqual(body.tieredAvailable, false);
        assert.strictEqual(body.tieredCode, "needsNitro");
        const closed = await call("POST", "/manual/check", { token: "closed" });
        assert.strictEqual(closed.body.tieredCode, "unreadable");
        const ok = await call("POST", "/manual/check", { token: "nitro" });
        assert.strictEqual(ok.body.values.game_time.value, 10);
        assert.strictEqual(ok.body.tieredCode, null);
    });

    await test("a dead token says so in English", async () => {
        const { status, body } = await call("POST", "/manual/check", { token: "nope" });
        assert.strictEqual(status, 400);
        assert.strictEqual(body.error, "The token is invalid or dead");
    });

    await test("works while Auto Badge is off and the tier has no price", async () => {
        const pricing = await pricingStore.getPricing();
        assert.strictEqual(pricing.autoBadge.enabled, false);
        const { status, body } = await call("POST", "/manual", { token: "nitro", badgeKey: "game_time", tierKey: "serious", note: "  my alt  " });
        assert.strictEqual(status, 201);
        assert.strictEqual(body.source, "manual");
        assert.strictEqual(body.price, 0);
        assert.strictEqual(body.createdBy, "admin");
        assert.strictEqual(body.note, "my alt");
        assert.strictEqual(body.tokenEncrypted, undefined);
        const done = await settle(body.orderId);
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(done.measuredValue, 10);
        assert.strictEqual(done.measuredSource, "self");
        assert.strictEqual(done.sent, Math.ceil((150 - 10) * 1.1));
        assert.strictEqual(webhooks.length, 0, "a manual order calls no one");
    });

    await test("an owned tier is refused at creation", async () => {
        const { status, body } = await call("POST", "/manual", { token: "nitro", badgeKey: "game_time", tierKey: "recreational" });
        assert.strictEqual(status, 409);
        assert.match(body.error, /already has Recreational/);
    });

    await test("unreadable account: asks for the current value, then sends from it", async () => {
        const ask = await call("POST", "/manual", { token: "nonitro", badgeKey: "game_variety", tierKey: "enthusiast" });
        assert.strictEqual(ask.status, 400);
        assert.strictEqual(ask.body.needsValue, true);
        const bad = await call("POST", "/manual", { token: "nonitro", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: -1 });
        assert.strictEqual(bad.body.needsValue, true);
        const owned = await call("POST", "/manual", { token: "nonitro", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: 10 });
        assert.strictEqual(owned.status, 409);

        const { status, body } = await call("POST", "/manual", { token: "nonitro", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: 4 });
        assert.strictEqual(status, 201);
        assert.strictEqual(body.enteredValue, 4);
        const done = await settle(body.orderId);
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(done.measuredValue, 4);
        assert.strictEqual(done.measuredSource, "entered");
        assert.strictEqual(plans.at(-1).current, 4);
    });

    await test("a readable account ignores an entered value", async () => {
        const { body } = await call("POST", "/manual", { token: "nitro", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: 0 });
        assert.strictEqual(body.enteredValue, null);
        const done = await settle(body.orderId);
        assert.strictEqual(done.measuredValue, 3);
        assert.strictEqual(done.measuredSource, "self");
    });

    await test("game_time from an entered value keeps the Game Variety guard", async () => {
        const { body } = await call("POST", "/manual", { token: "closed", badgeKey: "game_time", tierKey: "dedicated", currentValue: 2 });
        await settle(body.orderId);
        assert.strictEqual(plans.at(-1).current, 2);
        assert.strictEqual(plans.at(-1).varietyHeadroom, 1, "variety unknown → treated as 0, not unlimited");
    });

    await test("cancelled when the read at run time finds the tier owned", async () => {
        const order = await badgeService.createManualOrder({ token: "nitro", badgeKey: "game_time", tierKey: "devoted" }, "admin");
        await settle(order.orderId);
        // Force a second run against an owned tier.
        await db.findOneAndUpdate("badge_orders", { orderId: order.orderId }, { status: "manual_review" });
        accounts.nitro.values.game_time = 400;
        const { body } = await call("POST", `/${order.orderId}/resolve`, { action: "retry" });
        assert.strictEqual(body.status, "cancelled");
        assert.match(body.error, /already has Devoted/);
        accounts.nitro.values.game_time = 10;
    });

    await test("manual review of a manual order: no forfeit, cancel → cancelled", async () => {
        sender.abort = true;
        const order = await badgeService.createManualOrder({ token: "nitro", badgeKey: "game_time", tierKey: "seasoned" }, "admin");
        const held = await settle(order.orderId);
        sender.abort = false;
        assert.strictEqual(held.status, "manual_review");
        const forfeit = await call("POST", `/${order.orderId}/resolve`, { action: "forfeit" });
        assert.strictEqual(forfeit.status, 400);
        const cancel = await call("POST", `/${order.orderId}/resolve`, { action: "cancel" });
        assert.strictEqual(cancel.body.status, "cancelled");
    });

    await test("HypeSquad: current house refused, another one switches", async () => {
        const same = await call("POST", "/manual", { token: "nitro", badgeKey: "hypesquad", tierKey: "bravery" });
        assert.strictEqual(same.status, 409);
        const { body } = await call("POST", "/manual", { token: "nitro", badgeKey: "hypesquad", tierKey: "balance" });
        const done = await settle(body.orderId);
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(accounts.nitro.house, 3);
    });

    await test("unsupported badge and unknown tier are refused", async () => {
        assert.strictEqual((await call("POST", "/manual", { token: "nitro", badgeKey: "streaming", tierKey: "newcomer" })).status, 400);
        assert.strictEqual((await call("POST", "/manual", { token: "nitro", badgeKey: "game_time", tierKey: "nope" })).status, 400);
    });

    await test("paid orders still forfeit an owned tier", async () => {
        await pricingStore.setTier("game_time", "casual", { price: 1000, enabled: true });
        await pricingStore.updateFeature("autoBadge", { enabled: true });
        const order = await badgeService.createOrder({ token: "nitro", badgeKey: "game_time", tierKey: "casual", ref: "buyer" });
        const done = await settle(order.orderId);
        assert.strictEqual(done.status, "forfeited");
        assert.strictEqual(done.source, undefined);
    });

    await test("list filters by source", async () => {
        const manual = await call("GET", "/?source=manual");
        assert.ok(manual.body.length > 0 && manual.body.every((o) => o.source === "manual"));
        const auto = await call("GET", "/?source=auto");
        assert.ok(auto.body.length === 1 && auto.body[0].ref === "buyer");
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
