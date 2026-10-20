#!/usr/bin/env node
/**
 * Checks for Auto Badge orders added by hand on /badges (server/services/badgeService.js
 * createManualOrder + routes/badges.js): owner only, free, any catalog tier; an account
 * Discord will not read can be sent to with an entered value; owned tiers are refused,
 * and a manual order is never forfeited — only retried or cancelled. Paid orders keep
 * forfeiting. Game badges are sold to non-Nitro accounts too, and an account with no
 * badges yet buys from 0. Errors are English on the panel (orders, /api/badges) and keep their
 * Vietnamese text towards ArnTo-Auto (badge.event, /api/external/badges), which shows
 * it to buyers. Discord, the sender, the proxy pool and the callbacks are stubbed.
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

// Discord accounts by token. values = null → Discord fails to answer with the progress;
// fresh = no badges yet (the real readSelf answers zeros with source "empty").
const accounts = {
    nonitro: { userId: "1", username: "free", hasNitro: false, values: { game_time: 3, game_variety: 1 }, house: null },
    nitro: { userId: "2", username: "rich", hasNitro: true, values: { game_time: 10, game_variety: 3 }, house: 1 },
    closed: { userId: "3", username: "closed", hasNitro: true, values: null, house: null },
    fresh: { userId: "4", username: "new", hasNitro: false, values: {}, empty: true, house: null },
};
// Same shape as badgeReader's errors: English message, Vietnamese `vi` for ArnTo-Auto.
const invalid = () =>
    Object.assign(new Error("The token is invalid or dead"), { status: 400, invalidToken: true, vi: "Token không hợp lệ hoặc đã chết" });
const down = () => Object.assign(new Error("Discord returned HTTP 500"), { status: 502, vi: "Discord trả HTTP 500" });
stub("services/badgeReader", {
    checkNitro: async (token) => {
        if (token === "down") throw down();
        const a = accounts[token];
        if (!a) throw invalid();
        return { userId: a.userId, username: a.username, hasNitro: a.hasNitro, premiumType: a.hasNitro ? 2 : 0, locale: "vi" };
    },
    readSelf: async (token, userId) => {
        const a = accounts[token];
        if (!a.values) throw Object.assign(new Error("Reading the badges failed (HTTP 500)"), { status: 502, vi: "Đọc badge thất bại (HTTP 500)" });
        const badges = {};
        for (const k of ["game_time", "game_variety", "streaming"]) {
            badges[k] = { key: k, value: a.values[k] ?? 0, currentTier: null, owned: (a.values[k] ?? 0) > 0 };
        }
        return { userId, source: a.empty ? "empty" : "self", badges };
    },
    readHypeSquadHouse: async (token) => accounts[token].house,
    readPlayedApplicationIds: async () => [],
});

const plans = [];
const sender = { abort: false, initError: null };
stub("services/badgeEngine", {
    planOrder: async (args) => {
        plans.push(args);
        const need = Math.ceil(Math.max(0, args.threshold - args.current) * args.overshoot);
        return { games: [{ id: "g1" }], sessions: Array.from({ length: need }, () => ({ game: { id: "g1" }, hours: 1 })), hoursPerSession: 1, need };
    },
    BadgeSender: class {
        async init() {
            if (sender.initError) throw sender.initError;
        }
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
const external = require("../server/routes/badgesExternal");

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
        req.apiCaller = { botId: "auto" };
        next();
    });
    // /external = what ArnTo-Auto calls (/api/external/badges); the rest is the panel's /api/badges.
    app.use("/external", external);
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

    await test("check: catalog without unsupported badges, overshoot, no Nitro needed, why progress is unreadable", async () => {
        const { status, body } = await call("POST", "/manual/check", { token: "nonitro" });
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.catalog.map((b) => b.key), ["game_time", "game_variety", "hypesquad"]);
        assert.strictEqual(body.overshoot, 1.1);
        assert.strictEqual(body.hasNitro, false);
        assert.strictEqual(body.tieredAvailable, true);
        assert.strictEqual(body.tieredCode, null);
        assert.strictEqual(body.values.game_time.value, 3);
        const closed = await call("POST", "/manual/check", { token: "closed" });
        assert.strictEqual(closed.body.tieredAvailable, false);
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
        const ask = await call("POST", "/manual", { token: "closed", badgeKey: "game_variety", tierKey: "enthusiast" });
        assert.strictEqual(ask.status, 400);
        assert.strictEqual(ask.body.needsValue, true);
        const bad = await call("POST", "/manual", { token: "closed", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: -1 });
        assert.strictEqual(bad.body.needsValue, true);
        const owned = await call("POST", "/manual", { token: "closed", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: 10 });
        assert.strictEqual(owned.status, 409);

        const { status, body } = await call("POST", "/manual", { token: "closed", badgeKey: "game_variety", tierKey: "enthusiast", currentValue: 4 });
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

    // ── Game badges for every account, Nitro or not (2026-10-21) ────────────────
    await test("a non-Nitro account buys a game badge like any other", async () => {
        await pricingStore.setTier("game_time", "dedicated", { price: 1000, enabled: true });
        const check = await call("POST", "/external/check", { token: "nonitro" });
        assert.strictEqual(check.body.tieredAvailable, true);
        assert.strictEqual(check.body.tieredReason, null);
        assert.strictEqual(check.body.values.game_time.value, 3);
        const quote = await call("POST", "/external/quote", { token: "nonitro", badgeKey: "game_time", tierKey: "dedicated" });
        assert.strictEqual(quote.status, 200);
        assert.strictEqual(quote.body.hasNitro, false);
        assert.strictEqual(quote.body.currentValue, 3);
        assert.strictEqual(quote.body.alreadyOwned, false);
        // An owned tier is still caught before the QR.
        const owned = await call("POST", "/external/quote", { token: "nonitro", badgeKey: "game_time", tierKey: "casual" });
        assert.strictEqual(owned.body.alreadyOwned, true);

        const order = await badgeService.createOrder({ token: "nonitro", badgeKey: "game_time", tierKey: "dedicated", ref: "buyer3" });
        const done = await settle(order.orderId);
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(done.measuredValue, 3);
        assert.strictEqual(done.measuredSource, "self");
        assert.strictEqual(plans.at(-1).current, 3);
    });

    await test("an account with no badges yet buys from 0", async () => {
        const check = await call("POST", "/external/check", { token: "fresh" });
        assert.strictEqual(check.body.tieredAvailable, true);
        assert.strictEqual(check.body.values.game_variety.value, 0);
        const order = await badgeService.createOrder({ token: "fresh", badgeKey: "game_time", tierKey: "dedicated", ref: "buyer3" });
        const done = await settle(order.orderId);
        assert.strictEqual(done.status, "sent");
        assert.strictEqual(done.measuredValue, 0);
        assert.strictEqual(done.measuredSource, "empty");
        assert.strictEqual(done.sent, Math.ceil(20 * 1.1));
        assert.strictEqual(plans.at(-1).varietyHeadroom, 1, "Game Variety at 0 → next tier (2) is 1 away");
    });

    // ── Panel = English, ArnTo-Auto = the Vietnamese its buyers already get ──────
    const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
    const paid = async (token, tierKey) => {
        const order = await badgeService.createOrder({ token, badgeKey: "game_time", tierKey, ref: "buyer2", webhookBotId: "auto" });
        const done = await settle(order.orderId);
        return { done, events: webhooks.filter((w) => w.orderId === order.orderId) };
    };

    await test("external quote/check answer ArnTo-Auto in Vietnamese", async () => {
        const unread = await call("POST", "/external/quote", { token: "closed", badgeKey: "game_time", tierKey: "casual" });
        assert.strictEqual(unread.status, 400);
        assert.match(unread.body.error, /^Discord không cho đọc tiến độ badge/);
        const closed = await call("POST", "/external/check", { token: "closed" });
        assert.strictEqual(closed.body.tieredCode, "unreadable");
        assert.match(closed.body.tieredReason, /^Discord không cho đọc tiến độ badge/);
        // Auto reads a 400 that says "token" as a dead token — this reason must not.
        assert.doesNotMatch(closed.body.tieredReason, /token/i);
        const dead = await call("POST", "/external/quote", { token: "nope", badgeKey: "game_time", tierKey: "casual" });
        assert.strictEqual(dead.status, 400);
        assert.strictEqual(dead.body.error, "Token không hợp lệ hoặc đã chết");
        const broken = await call("POST", "/external/check", { token: "down" });
        assert.strictEqual(broken.status, 502);
        assert.strictEqual(broken.body.error, "Discord trả HTTP 500");
    });

    await test("the same failures read English on the panel", async () => {
        const broken = await call("POST", "/manual/check", { token: "down" });
        assert.strictEqual(broken.status, 502);
        assert.strictEqual(broken.body.error, "Discord returned HTTP 500");
    });

    await test("a forfeited order: English on the order, Vietnamese in the event", async () => {
        const { done, events } = await paid("nitro", "casual");
        assert.strictEqual(done.status, "forfeited");
        assert.strictEqual(done.error, "Account already has Casual (10 hours)");
        const ev = events.find((e) => e.type === "forfeited");
        assert.strictEqual(ev.error, "Tài khoản đã đạt mốc Casual (10 hours)");
    });

    await test("unreadable at run time: held for review in English, event in Vietnamese", async () => {
        await pricingStore.setTier("game_time", "serious", { price: 1000, enabled: true });
        const { done, events } = await paid("closed", "serious");
        assert.strictEqual(done.status, "manual_review");
        assert.match(done.error, /^Discord does not show this account's badge progress/);
        const ev = events.find((e) => e.type === "manual_review");
        assert.match(ev.error, /^Discord không cho đọc tiến độ badge/);
    });

    await test("a token that dies while sending: English on the order, Vietnamese to the buyer", async () => {
        sender.initError = invalid();
        const { done, events } = await paid("nitro", "serious");
        sender.initError = null;
        assert.strictEqual(done.status, "token_dead");
        assert.strictEqual(done.error, "The token is invalid or dead");
        // Auto puts this text in the buyer's "Đơn thất bại" DM.
        const ev = events.find((e) => e.type === "failed");
        assert.strictEqual(ev.error, "Token không hợp lệ hoặc đã chết");
    });

    await test("review outcomes and a send refused mid-way are English", async () => {
        sender.abort = true;
        const { done } = await paid("nitro", "serious");
        sender.abort = false;
        assert.match(done.error, /^Discord refused with HTTP 429 after 0\/\d+ games$/);
        const refund = await call("POST", `/${done.orderId}/resolve`, { action: "cancel" });
        assert.strictEqual(refund.body.error, "Cancelled on review — refund due");
        sender.abort = true;
        const again = await paid("nitro", "serious");
        sender.abort = false;
        const forfeit = await call("POST", `/${again.done.orderId}/resolve`, { action: "forfeit" });
        assert.strictEqual(forfeit.body.error, "Forfeited on review");
    });

    await test("no order the panel lists carries Vietnamese", async () => {
        const { body } = await call("GET", "/");
        for (const o of body) assert.doesNotMatch(String(o.error ?? ""), VI, `${o.orderId}: ${o.error}`);
    });

    server.close();
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
