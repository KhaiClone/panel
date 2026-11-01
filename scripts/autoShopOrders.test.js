#!/usr/bin/env node
/**
 * Checks Auto Quest / Auto Badge orders in ArnTo-Shop's books (server/services/
 * autoShopOrders.js): the one-time backfill (badge orders at their price — by hand =
 * the tier's regular price, buyer = the account; monthly plans estimated from
 * addedAt..end), the outbox that waits for the shop's "order.record", records live
 * orders pending and past ones final, completes / cancels when the panel's record
 * finishes, tolerates "already completed" and a deleted order. And the hooks: a
 * paid single-quest order opens at once and completes when the run is done; one
 * added by hand opens at run_start at quests × the per-quest price; a fresh token
 * goes on with the open order; removing the account cancels it; a monthly purchase
 * is complete when paid, a plan handed over (expiresAt) is not a purchase; badge
 * states map sent/forfeited → completed, refund_due/cancelled → cancelled.
 * The shop, Discord, the proxy pool and the callbacks are stubbed.
 * Run:  node scripts/autoShopOrders.test.js
 */

const path = require("path");
const assert = require("assert");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
let ids = 0;
const db = {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    create: async (m, d) => {
        d._id = `id${++ids}`;
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
    findOneAndDelete: async (m, q) => {
        const arr = store.get(m) || [];
        const i = arr.findIndex((e) => match(e, q));
        if (i === -1) return null;
        const [gone] = arr.splice(i, 1);
        return clone(gone);
    },
};
stub("db", db);

// The shop on the other end of the bus: idempotent on externalId, like ArnTo-Shop.
const SHOP = "shopbot";
const caps = new Set();
const shop = new Map(); // externalId → order
const sent = []; // every bus command
let nextId = 0;
const busError = (m) => new Error(m);
stub("services/discordBus", {
    canHandle: (botId, cmd) => botId === SHOP && caps.has(cmd),
    handlerOf: () => null,
    request: async (botId, cmd, body) => {
        sent.push({ cmd, body: clone(body) });
        if (cmd === "order.record") {
            if (!shop.has(body.externalId)) shop.set(body.externalId, { orderId: `arnto_${++nextId}`, ...clone(body) });
            return clone(shop.get(body.externalId));
        }
        const order = [...shop.values()].find((o) => o.orderId === body.orderId);
        if (!order) throw busError("Order not found");
        if (order.status !== "pending") throw busError(`Order is already ${order.status}`);
        order.status = cmd === "order.complete" ? "completed" : "cancelled";
        return clone(order);
    },
});
stub("services/sharedStore", { nameRow: (name) => (name === "orders" ? { state: "active", owner: SHOP } : null) });
const logs = [];
stub("services/panelLog", { add: (kind, text) => logs.push({ kind, text }) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });

// Quest runner stubs (as in questFeedEvents.test.js): each token = an account with 3 quests.
const quests = new Map();
const questsFor = (token) => {
    if (!quests.has(token)) quests.set(token, [1, 2, 3].map((n) => ({ id: `${token}-${n}`, name: `Quest ${n}`, taskType: "WATCH_VIDEO", done: false })));
    return quests.get(token);
};
class QuestAutocompleter {
    constructor(api) {
        this.api = api;
        this.completedIds = new Set();
    }
    async fetchQuests() {
        return questsFor(this.api.token).filter((q) => !q.done);
    }
    async autoAccept(q) {
        return q;
    }
    async enrollSelected() {}
    async processQuest(q) {
        if (this.api.token.startsWith("dying")) throw Object.assign(new Error("HTTP 401"), { invalidToken: true });
        q.done = true;
        this.completedIds.add(q.id);
        return {};
    }
}
stub("services/questEngine", {
    QuestAutocompleter,
    resolveDiscordAccount: async (token) => ({ ok: true, api: { token }, accountId: token.replace(/^\D+/, ""), username: token }),
    isInvalidTokenError: (e) => !!e?.invalidToken,
    summarizeQuest: (q) => ({ id: q.id, name: q.name, taskType: q.taskType, needed: 1, media: null }),
    warmBuildNumber: () => {},
    _fields: { isEnrolled: () => true, isCompleted: (q) => q.done, isCompletable: () => true, getQuestName: (q) => q.name, getTaskType: (q) => q.taskType },
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }), agentForKey: async () => null });
stub("services/callbackService", { send: () => {} });
// Auto Badge: only its state changes are exercised here.
stub("services/badgeReader", {});
stub("services/badgeEngine", { BadgeSender: class {}, planOrder: () => null, setHypeSquad: async () => {} });
stub("services/resellerService", { isReseller: () => false });

const DAY = 86_400_000;
const NOW = Date.now();
const BUYER = "200000000000000001";
const ACC = (n) => `10000000000000000${n}`;
store.set("pricing_settings", {
    autoQuest: { pricePerItem: 5000, monthlyPrice: 50000 },
    autoBadge: { enabled: true, badges: { game_time: { eternal: { price: 100000, enabled: true } }, hypesquad: { bravery: { price: 30000, enabled: true } } } },
});
const badge = (orderId, status, extra = {}) => ({
    orderId, status, ref: BUYER, accountId: ACC(1), badgeKey: "game_time", tierKey: "eternal", tierName: "Eternal",
    price: 90000, reseller: false, createdAt: NOW - 10 * DAY, paidAt: NOW - 10 * DAY, ...extra,
});
store.set("badge_orders", [
    badge("b-sent", "sent", { reseller: true }),
    badge("b-forfeit", "forfeited"),
    badge("b-refund", "refund_due"),
    badge("b-dead", "token_dead"),
    badge("b-manual", "sent", { source: "manual", ref: null, accountId: ACC(2), price: 0 }),
    badge("b-unpriced", "sent", { source: "manual", ref: null, badgeKey: "game_variety", tierKey: "ranger", tierName: "Ranger", price: 0 }),
]);
store.set("quest_monthly", [
    { accountId: ACC(3), ref: BUYER, addedAt: NOW - 95 * DAY, monthlyExpiresAt: new Date(NOW + 270 * DAY).toISOString() },
    { accountId: ACC(4), ref: null, addedAt: NOW - 2 * DAY, monthlyExpiresAt: new Date(NOW + 19 * DAY).toISOString() },
]);

const shopOrders = require("../server/services/autoShopOrders");
const questService = require("../server/services/questService");
const questMonthly = require("../server/services/questMonthly");
const questSettings = require("../server/services/questSettings");

const rows = () => store.get("auto_shop_orders") || [];
const row = (id) => rows().find((r) => r.externalId === id);
const settled = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    await shopOrders.sync();
};
const until = async (cond) => {
    for (let i = 0; i < 500; i++) {
        if (await cond()) return;
        await new Promise((r) => setImmediate(r));
    }
    throw new Error("condition never met");
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
    await questSettings.update({ accountDelaySec: 0 });

    console.log("backfill — once, before anything else");

    await test("badge orders at their price (by hand: tier price, buyer = account), finished ones as history", async () => {
        await shopOrders.ready();
        const sentRow = row("badge:b-sent");
        assert.deepStrictEqual(
            { price: sentRow.price, buyer: sentRow.buyerId, want: sentRow.want, history: sentRow.history, reseller: sentRow.reseller, source: sentRow.source, name: sentRow.name, date: sentRow.orderDate },
            { price: 90000, buyer: BUYER, want: "completed", history: true, reseller: true, source: "autoBadge", name: "Auto Badge: Game Time — Eternal", date: NOW - 10 * DAY },
        );
        assert.strictEqual(row("badge:b-forfeit").want, "completed");
        assert.strictEqual(row("badge:b-refund").want, "cancelled");
        assert.deepStrictEqual([row("badge:b-dead").want, row("badge:b-dead").history], ["pending", false]);
        assert.deepStrictEqual([row("badge:b-manual").price, row("badge:b-manual").buyerId], [100000, ACC(2)]);
        assert.ok(!row("badge:b-unpriced"), "a tier with no price is left out");
    });

    await test("monthly plans: months from addedAt to the end × the monthly price, buyer = ref or the account", async () => {
        const long = row(`questMonthly:history:${ACC(3)}`);
        assert.deepStrictEqual([long.name, long.price, long.buyerId, long.want, long.history], ["Auto Quest Monthly: 12 months", 600000, BUYER, "completed", true]);
        const short = row(`questMonthly:history:${ACC(4)}`);
        assert.deepStrictEqual([short.name, short.price, short.buyerId], ["Auto Quest Monthly: 1 month", 50000, ACC(4)]);
        assert.strictEqual(rows().length, 7);
        assert.ok(logs.some((l) => l.kind === "system" && /queued 7 past orders/.test(l.text) && /1,110,000 VND/.test(l.text)));
    });

    await test("a restart does not backfill again", async () => {
        const p = require.resolve("../server/services/autoShopOrders");
        delete require.cache[p];
        await require(p).ready();
        assert.strictEqual(rows().length, 7);
    });

    console.log("outbox — the shop's books");

    await test("nothing is sent before the shop announces order.record", async () => {
        await shopOrders.sync();
        assert.strictEqual(sent.length, 0);
        caps.add("order.record").add("order.complete").add("order.cancel");
    });

    await test("history goes in final, a live order pending; all as KhaiDev, quietly", async () => {
        await shopOrders.sync();
        const rec = (id) => sent.find((s) => s.cmd === "order.record" && s.body.externalId === id).body;
        assert.deepStrictEqual(
            { status: rec("badge:b-sent").status, seller: rec("badge:b-sent").sellerId, date: rec("badge:b-sent").orderDate, reseller: rec("badge:b-sent").reseller },
            { status: "completed", seller: "871329074046435338", date: NOW - 10 * DAY, reseller: true },
        );
        assert.strictEqual(rec("badge:b-refund").status, "cancelled");
        assert.strictEqual(rec("badge:b-dead").status, "pending");
        assert.ok(!sent.some((s) => s.cmd === "order.complete"), "history is never completed afterwards");
        assert.ok(rows().every((r) => r.shopOrderId && r.have === r.want));
    });

    console.log("badge orders");

    await test("the pending one completes when the panel's order is sent", async () => {
        await shopOrders.settle("badge:b-dead", "completed");
        await settled();
        assert.strictEqual(shop.get("badge:b-dead").status, "completed");
        assert.strictEqual(row("badge:b-dead").have, "completed");
    });

    await test("a finished order never changes its mind", async () => {
        await shopOrders.settle("badge:b-dead", "cancelled");
        assert.strictEqual(row("badge:b-dead").want, "completed");
    });

    await test("open twice = one order; no price or no buyer = not recorded", async () => {
        const e = { externalId: "badge:x1", source: "autoBadge", buyerId: BUYER, name: "Auto Badge: x", price: 1000 };
        await shopOrders.open(e);
        await shopOrders.open({ ...e, price: 9999 });
        assert.strictEqual(rows().filter((r) => r.externalId === "badge:x1").length, 1);
        assert.strictEqual(row("badge:x1").price, 1000);
        assert.strictEqual(await shopOrders.open({ ...e, externalId: "badge:x2", price: 0 }), null);
        assert.strictEqual(await shopOrders.open({ ...e, externalId: "badge:x3", buyerId: "nobody" }), null);
    });

    await test("'already completed' from the shop counts as done; a deleted order is left as is", async () => {
        await settled();
        shop.get("badge:x1").status = "completed"; // completed on the shop's side meanwhile
        await shopOrders.settle("badge:x1", "completed");
        await settled();
        assert.strictEqual(row("badge:x1").have, "completed");
        await shopOrders.open({ externalId: "badge:x4", source: "autoBadge", buyerId: BUYER, name: "Auto Badge: y", price: 1000 });
        await settled();
        shop.delete("badge:x4");
        await shopOrders.settle("badge:x4", "cancelled");
        await settled();
        assert.strictEqual(row("badge:x4").have, "cancelled");
        assert.ok(logs.some((l) => l.kind === "warn" && /gone from the shop/.test(l.text)));
    });

    console.log("single quests");

    await test("a paid order opens at its price and completes when the run is done", async () => {
        const token = `paid${ACC(5)}`;
        await questService.startAccount({ token, mode: "select", selectedQuestIds: [`${token}-1`, `${token}-2`], ref: BUYER, order: { id: "QP1", price: 8000, reseller: true } });
        const r = row("quest:QP1");
        assert.deepStrictEqual([r.name, r.price, r.buyerId, r.reseller, r.source], ["Auto Quest: 2 quests", 8000, BUYER, true, "autoQuest"]);
        await until(async () => (await questService.getAccount(ACC(5)))?.status === "done");
        await settled();
        assert.strictEqual(shop.get("quest:QP1").status, "completed");
        assert.deepStrictEqual((await db.findOne("quest_accounts", { accountId: ACC(5) })).openOrders, []);
    });

    await test("added by hand: opened at run_start, quests × the per-quest price, buyer = the account", async () => {
        const token = `hand${ACC(6)}`;
        await questService.startAccount({ token, mode: "all", manual: true });
        await until(async () => (await questService.getAccount(ACC(6)))?.status === "done");
        await settled();
        const r = rows().find((x) => x.externalId.startsWith(`quest:manual:${ACC(6)}:`));
        assert.deepStrictEqual([r.name, r.price, r.buyerId, r.have], ["Auto Quest: 3 quests", 15000, ACC(6), "completed"]);
    });

    await test("a resume is never a new order", async () => {
        const before = rows().length;
        for (const q of questsFor(`hand${ACC(6)}`)) q.done = false;
        await questService.resumeAccount(ACC(6));
        await until(async () => (await questService.getAccount(ACC(6)))?.status === "done");
        assert.strictEqual(rows().length, before);
    });

    await test("a dead token keeps the order open; the fresh token goes on with it; removing cancels", async () => {
        await questService.startAccount({ token: `dying${ACC(7)}`, mode: "all", ref: BUYER, order: { id: "QP2", price: 15000 } });
        await until(async () => (await questService.getAccount(ACC(7)))?.status === "token_dead");
        await settled();
        assert.strictEqual(shop.get("quest:QP2").status, "pending");
        const before = rows().length;
        await questService.startAccount({ token: `again${ACC(7)}`, mode: "all", ref: BUYER }); // no payment: same order
        await until(async () => (await questService.getAccount(ACC(7)))?.status === "done");
        await settled();
        assert.strictEqual(rows().length, before);
        assert.strictEqual(shop.get("quest:QP2").status, "completed");

        await questService.startAccount({ token: `dying${ACC(8)}`, mode: "all", ref: BUYER, order: { id: "QP3", price: 15000 } });
        await until(async () => (await questService.getAccount(ACC(8)))?.status === "token_dead");
        await questService.removeAccount(ACC(8));
        await settled();
        assert.strictEqual(shop.get("quest:QP3").status, "cancelled");
    });

    console.log("monthly plans");

    await test("a paid plan is complete at once, at what was paid", async () => {
        await questMonthly.activate({ token: `m${ACC(9)}`, months: 2, ref: BUYER, order: { id: "QM1", price: 90000 } });
        await settled();
        const r = row("questMonthly:QM1");
        assert.deepStrictEqual([r.name, r.price, r.want], ["Auto Quest Monthly: 2 months", 90000, "completed"]);
        assert.strictEqual(shop.get("questMonthly:QM1").status, "completed");
        // Recorded pending, then completed — so the shop grants its buyer role as for any order.
        assert.strictEqual(sent.find((s) => s.body.externalId === "questMonthly:QM1").body.status, "pending");
    });

    await test("by hand: months × the monthly price; a plan handed over with expiresAt is no purchase", async () => {
        await questMonthly.activate({ token: `h${ACC(10)}`, months: 3, manual: true });
        const r = rows().find((x) => x.externalId.startsWith(`questMonthly:manual:${ACC(10)}:`));
        assert.deepStrictEqual([r.name, r.price, r.buyerId], ["Auto Quest Monthly: 3 months", 150000, ACC(10)]);
        const before = rows().length;
        await questMonthly.activate({ token: `x${ACC(9)}`, ref: BUYER, expiresAt: new Date(NOW + 10 * DAY).toISOString() });
        assert.strictEqual(rows().length, before);
    });

    console.log("badge states (badgeService._patch)");

    await test("forfeited → completed, refund_due → cancelled, an order by hand cancelled → cancelled", async () => {
        const badgeService = require("../server/services/badgeService");
        const list = store.get("badge_orders");
        for (const [id, extra] of [["r-forfeit", {}], ["r-refund", {}], ["r-hand", { source: "manual" }]]) {
            list.push(badge(id, "manual_review", extra));
            await shopOrders.open({ externalId: `badge:${id}`, source: "autoBadge", buyerId: BUYER, name: "Auto Badge: z", price: 1000 });
        }
        await badgeService.resolveManual("r-forfeit", "forfeit");
        await badgeService.resolveManual("r-refund", "cancel");
        await badgeService.resolveManual("r-hand", "cancel");
        await settled();
        assert.deepStrictEqual(
            ["r-forfeit", "r-refund", "r-hand"].map((id) => shop.get(`badge:${id}`).status),
            ["completed", "cancelled", "cancelled"],
        );
    });

    console.log("arguments from ArnTo-Auto");

    await test("order: { id, price > 0, reseller? } — missing is null, anything else is a 400", async () => {
        assert.strictEqual(shopOrders.orderArg(undefined), null);
        assert.deepStrictEqual(shopOrders.orderArg({ id: " P1 ", price: "5000" }), { id: "P1", price: 5000, reseller: false });
        for (const bad of [{ price: 1 }, { id: "x", price: 0 }, { id: "x".repeat(65), price: 1 }, { id: "x", price: 1, reseller: "yes" }]) {
            assert.throws(() => shopOrders.orderArg(bad), (e) => e.status === 400);
        }
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
