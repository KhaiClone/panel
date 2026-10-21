#!/usr/bin/env node
/**
 * Checks for the reseller (CTV) prices of the auto orders: who pays them (an
 * active CTV on the Resellers page), Auto Quest's and each Auto Badge tier's
 * (services/pricingStore.js), the decor gift / gift-bundle tiers'
 * (services/decorService.js), and where they are charged — the badge quote and
 * order (badgeService via /api/external/badges), the Deco Gift catalog and an
 * order made on the panel (decorGiftService), /api/external/pricing/buyer.
 * Empty = the regular price; a tier with no reseller price charges a CTV the
 * regular one. Discord, the bus and the badge sender are stubbed.
 * Run:  node scripts/resellerPricing.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "reseller-pricing-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// In-memory stand-in for server/db (same merge semantics as QuickDB.js).
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
stub("db", {
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
});

const ACCOUNT = { userId: "2", username: "rich", hasNitro: true };
stub("services/badgeReader", {
    checkNitro: async () => ({ ...ACCOUNT, premiumType: 2, locale: "vi" }),
    readSelf: async (token, userId) => ({
        userId,
        source: "self",
        badges: Object.fromEntries(["game_time", "game_variety", "streaming"].map((k) => [k, { key: k, value: 0, currentTier: null, owned: false }])),
    }),
    readHypeSquadHouse: async () => null,
    readPlayedApplicationIds: async () => [],
});
stub("services/badgeEngine", {
    planOrder: async () => ({ games: [], sessions: [], hoursPerSession: 1, need: 0 }),
    BadgeSender: class {
        async init() {}
        async run() {
            return { sent: 0, total: 0, aborted: false };
        }
    },
    setHypeSquad: async () => {},
});
stub("services/proxyPool", { acquire: async () => ({ agent: null, release: () => {} }) });
stub("services/callbackService", { send: () => {} });

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const resellers = require("../server/services/resellerService");
const pricingStore = require("../server/services/pricingStore");
const decorService = require("../server/services/decorService");
const decorGift = require("../server/services/decorGiftService");
const pricingExternal = require("../server/routes/pricingExternal");
const badgesExternal = require("../server/routes/badgesExternal");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const SHOP = "1378037598953672746";
const AUTO = "1378037598953672747";
const bus = { requests: [] };
discordBus.handlerOf = (cmd) => (cmd === resellers.CMD ? SHOP : cmd === "decor.gift.create" ? AUTO : null);
discordBus.canHandle = () => true;
discordBus.status = () => ({ ready: true });
discordBus.userTag = async (id) => `user${id.slice(-3)}`;
discordBus.request = async (target, cmd, payload) => {
    bus.requests.push({ target, cmd, payload });
    if (cmd === resellers.CMD) return { role: "added", dm: "sent" };
    if (cmd === "decor.gift.create") return { id: payload.id, existed: false, status: "open", shopOrderId: "arnto_1" };
    return {};
};

const CTV = "953525563878948914";
const FORMER = "612880338590498816";
const BUYER = "700000000000000001"; // an ordinary buyer

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
const rejects = async (fn, status) => {
    try {
        await fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};

// An express app on port 0 with the router(s) and a project key's caller.
const serve = async (mounts) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.apiCaller = { botId: AUTO };
        next();
    });
    for (const [at, router] of mounts) app.use(at, router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const call = async (method, url, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };
    return { call, close: () => new Promise((r) => server.close(r)) };
};

// ── Decor fixtures (the assistant's shared data) ─────────────────────────────
const PRICES = [
    { type: "login", original: 100, price: 10000 },
    { type: "gift", original: 100, price: 20000, resellerPrice: 15000 },
    { type: "gift", original: 200, price: 40000 }, // no reseller price
    { type: "gift-bundle", original: 60000, price: 50000, resellerPrice: 42000 },
];
const decor = (sku, withNitro, extra = {}) => ({ sku_id: sku, name: `d${sku}`, type: 0, prices: { withNitro, withoutNitro: withNitro }, ...extra });
const LOADED = [decor("1", 100), decor("2", 200), { sku_id: "9", name: "bundle", type: 1000, items: ["1", "2"], prices: {} }, decor("5", 100, { noGift: true })];

(async () => {
    console.log("Reseller prices of the auto orders");

    for (const [name, kind, value] of [
        ["decors", "collection", LOADED],
        ["importedDecors", "collection", []],
        ["prices", "collection", PRICES],
        ["decorCategories", "collection", []],
    ]) {
        sharedStore.declare(name, kind, "assistant");
        sharedStore.adopt(name, "assistant", value);
    }

    await test("isReseller: an active CTV only — not a removed one, a buyer or garbage", async () => {
        await resellers.add({ userId: CTV, shop: "Lan Store" }, { via: "panel" });
        await resellers.add({ userId: FORMER }, { via: "panel" });
        await resellers.remove(FORMER, { via: "panel" });
        assert.strictEqual(resellers.isReseller(CTV), true);
        assert.strictEqual(resellers.isReseller(FORMER), false, "removed");
        assert.strictEqual(resellers.isReseller(BUYER), false);
        for (const v of [null, undefined, "", "12", "<@953525563878948914>"]) assert.strictEqual(resellers.isReseller(v), false, String(v));
    });

    // ── Auto Quest ──
    await test("Auto Quest: reseller prices start empty, are set, cleared, and never 0", async () => {
        let p = await pricingStore.getPricing();
        assert.strictEqual(p.autoQuest.resellerPricePerItem, null);
        assert.strictEqual(p.autoQuest.resellerMonthlyPrice, null);
        p = await pricingStore.updateFeature("autoQuest", { pricePerItem: 2000, monthlyPrice: 50000, resellerPricePerItem: "1500", resellerMonthlyPrice: 40000 });
        assert.strictEqual(p.autoQuest.resellerPricePerItem, 1500);
        assert.strictEqual(p.autoQuest.resellerMonthlyPrice, 40000);
        p = await pricingStore.updateFeature("autoQuest", { pricePerItem: 2500 });
        assert.strictEqual(p.autoQuest.resellerPricePerItem, 1500, "a patch without it keeps it");
        assert.strictEqual(p.autoQuest.pricePerItem, 2500);
        p = await pricingStore.updateFeature("autoQuest", { resellerMonthlyPrice: "" });
        assert.strictEqual(p.autoQuest.resellerMonthlyPrice, null, "empty = the regular price");
        const err = await rejects(() => pricingStore.updateFeature("autoQuest", { resellerPricePerItem: 0 }), 400);
        assert.match(err.message, /reseller price/i);
        await rejects(() => pricingStore.updateFeature("autoQuest", { resellerPricePerItem: "abc" }), 400);
        assert.strictEqual((await pricingStore.getPricing()).autoQuest.resellerPricePerItem, 1500, "a refused patch changes nothing");
    });

    // ── Auto Badge ──
    await test("Auto Badge: a tier's reseller price is set with the tier, cleared with empty, never 0", async () => {
        await pricingStore.updateFeature("autoBadge", { enabled: true });
        let p = await pricingStore.setTier("hypesquad", "bravery", { price: 30000, enabled: true, resellerPrice: 20000 });
        let t = p.autoBadge.badges.hypesquad.tiers.find((x) => x.key === "bravery");
        assert.strictEqual(t.resellerPrice, 20000);
        assert.strictEqual(t.price, 30000);
        p = await pricingStore.setTier("hypesquad", "brilliance", { price: 30000, enabled: true });
        t = p.autoBadge.badges.hypesquad.tiers.find((x) => x.key === "brilliance");
        assert.strictEqual(t.resellerPrice, null);
        await rejects(() => pricingStore.setTier("hypesquad", "brilliance", { resellerPrice: 0 }), 400);
        p = await pricingStore.setTier("hypesquad", "balance", { price: 30000, enabled: true, resellerPrice: 25000 });
        p = await pricingStore.setTier("hypesquad", "balance", { resellerPrice: "" });
        t = p.autoBadge.badges.hypesquad.tiers.find((x) => x.key === "balance");
        assert.strictEqual(t.resellerPrice, null);
        assert.strictEqual(t.enabled, true, "clearing the reseller price leaves the tier on sale");
    });

    await test("Auto Badge: quote charges a CTV the reseller price only where there is one", async () => {
        let q = await pricingStore.quote("hypesquad", "bravery", { reseller: true });
        assert.deepStrictEqual([q.price, q.regularPrice, q.reseller], [20000, 30000, true]);
        q = await pricingStore.quote("hypesquad", "bravery");
        assert.deepStrictEqual([q.price, q.reseller], [30000, false]);
        q = await pricingStore.quote("hypesquad", "brilliance", { reseller: true });
        assert.deepStrictEqual([q.price, q.reseller], [30000, false], "no reseller price → regular");
    });

    await test("Auto Badge: a reseller price does not put a tier on sale", async () => {
        await pricingStore.setTier("game_time", "casual", { resellerPrice: 5000 });
        const t = (await pricingStore.getPricing()).autoBadge.badges.game_time.tiers.find((x) => x.key === "casual");
        assert.strictEqual(t.enabled, false);
        await rejects(() => pricingStore.quote("game_time", "casual", { reseller: true }), 400);
    });

    await test("/api/external/badges: quote + start with buyerId charge and record the CTV price", async () => {
        const srv = await serve([["/badges", badgesExternal]]);
        try {
            let r = await srv.call("POST", "/badges/quote", { token: "t", badgeKey: "hypesquad", tierKey: "bravery", buyerId: CTV });
            assert.strictEqual(r.status, 200, JSON.stringify(r.body));
            assert.deepStrictEqual([r.body.price, r.body.regularPrice, r.body.reseller], [20000, 30000, true]);
            r = await srv.call("POST", "/badges/quote", { token: "t", badgeKey: "hypesquad", tierKey: "bravery", buyerId: BUYER });
            assert.deepStrictEqual([r.body.price, r.body.reseller], [30000, false]);
            r = await srv.call("POST", "/badges/quote", { token: "t", badgeKey: "hypesquad", tierKey: "bravery" });
            assert.deepStrictEqual([r.body.price, r.body.reseller], [30000, false], "an old bot (no buyerId) pays the regular price");
            r = await srv.call("POST", "/badges/start", { token: "t", badgeKey: "hypesquad", tierKey: "bravery", ref: CTV, buyerId: CTV, paymentId: "p1" });
            assert.strictEqual(r.status, 201, JSON.stringify(r.body));
            assert.deepStrictEqual([r.body.price, r.body.reseller], [20000, true]);
            assert.ok(!("tokenEncrypted" in r.body));
            r = await srv.call("POST", "/badges/start", { token: "t", badgeKey: "hypesquad", tierKey: "bravery", ref: BUYER, buyerId: BUYER, paymentId: "p2" });
            assert.deepStrictEqual([r.body.price, r.body.reseller], [30000, false]);
        } finally {
            await srv.close();
        }
    });

    await test("/api/external/pricing: /buyer/:id says who is a CTV; the table carries the reseller prices", async () => {
        const srv = await serve([["/pricing", pricingExternal]]);
        try {
            let r = await srv.call("GET", `/pricing/buyer/${CTV}`);
            assert.deepStrictEqual(r.body, { userId: CTV, reseller: true });
            r = await srv.call("GET", `/pricing/buyer/${FORMER}`);
            assert.strictEqual(r.body.reseller, false);
            r = await srv.call("GET", "/pricing/buyer/abc");
            assert.strictEqual(r.body.reseller, false);
            r = await srv.call("GET", "/pricing/autoQuest");
            assert.strictEqual(r.body.resellerPricePerItem, 1500);
            r = await srv.call("GET", "/pricing");
            assert.strictEqual(r.body.autoBadge.badges.hypesquad.tiers[0].resellerPrice, 20000);
            r = await srv.call("POST", "/pricing/quote", { badgeKey: "hypesquad", tierKey: "bravery", buyerId: CTV });
            assert.deepStrictEqual([r.body.price, r.body.reseller], [20000, true]);
        } finally {
            await srv.close();
        }
    });

    // ── Decor gift tiers ──
    await test("decor list: reseller gift prices only when asked — never in the public shape", () => {
        const pub = decorService.buildDecorList(LOADED, [], PRICES);
        assert.ok(pub.every((d) => !("resellerGift" in d)), "the decor site never sees them");
        const list = Object.fromEntries(decorService.buildDecorList(LOADED, [], PRICES, { reseller: true }).map((d) => [d.sku_id, d]));
        assert.strictEqual(list["1"].resellerGift, 15000);
        assert.strictEqual(list["2"].resellerGift, null, "the 200 tier has none");
        assert.strictEqual(list["9"].resellerGift, 42000, "a bundle: its gift-bundle tier (20,000 + 40,000)");
        assert.strictEqual(list["5"].resellerGift, null, "not sold as a gift");
    });

    await test("price report: the gift and bundle tiers carry their reseller prices", () => {
        const r = decorService.buildPriceReport(LOADED, [], PRICES);
        assert.strictEqual(r.decorTiers.find((t) => t.original === 100).giftReseller, 15000);
        assert.strictEqual(r.decorTiers.find((t) => t.original === 200).giftReseller, null);
        assert.strictEqual(r.bundleTiers.find((t) => t.total === 60000).giftBundleReseller, 42000);
        assert.strictEqual(r.rows.find((x) => x.type === "gift" && x.original === 100).resellerPrice, 15000);
    });

    await test("setResellerPrice: gift / gift-bundle tiers that exist, > 0 or empty; the regular price untouched", async () => {
        await decorService.setResellerPrice({ type: "gift", original: 200, resellerPrice: "33000" });
        let row = sharedStore.run("prices", "findOne", { query: { type: "gift", original: 200 } });
        assert.deepStrictEqual([row.price, row.resellerPrice], [40000, 33000]);
        await decorService.upsertPrice({ type: "gift", original: 200, price: 41000 });
        row = sharedStore.run("prices", "findOne", { query: { type: "gift", original: 200 } });
        assert.deepStrictEqual([row.price, row.resellerPrice], [41000, 33000], "changing the price keeps the reseller price");
        await decorService.setResellerPrice({ type: "gift", original: 200, resellerPrice: null });
        row = sharedStore.run("prices", "findOne", { query: { type: "gift", original: 200 } });
        assert.strictEqual(row.resellerPrice, null);
        await rejects(() => decorService.setResellerPrice({ type: "login", original: 100, resellerPrice: 5000 }), 400);
        await rejects(() => decorService.setResellerPrice({ type: "gift", original: 100, resellerPrice: 0 }), 400);
        await rejects(() => decorService.setResellerPrice({ type: "gift", original: 999, resellerPrice: 5000 }), 404);
        await decorService.upsertPrice({ type: "gift", original: 200, price: 40000 });
    });

    // ── Deco Gift ──
    await test("Deco Gift catalog: each decor's resellerPrice, null when none", async () => {
        const c = await decorGift.catalog();
        const by = Object.fromEntries(c.decors.map((d) => [d.sku_id, d]));
        assert.deepStrictEqual([by["1"].price, by["1"].resellerPrice], [20000, 15000]);
        assert.deepStrictEqual([by["2"].price, by["2"].resellerPrice], [40000, null]);
        assert.deepStrictEqual([by["9"].price, by["9"].resellerPrice], [50000, 42000]);
        assert.ok(!by["5"], "not sold as a gift");
    });

    await test("Deco Gift on the panel: buyer lookup says CTV; a CTV's order is at the reseller prices", async () => {
        assert.strictEqual((await decorGift.buyerInfo(CTV)).reseller, true);
        assert.strictEqual((await decorGift.buyerInfo(BUYER)).reseller, false);

        bus.requests.length = 0;
        await decorGift.createByHand({ ref: "abcdefgh1", buyerId: CTV, skus: ["1", "2", "9"] }, { kind: "owner", username: "admin" });
        let sent = bus.requests.find((r) => r.cmd === "decor.gift.create").payload;
        assert.deepStrictEqual(sent.items.map((i) => i.price), [15000, 40000, 42000], "the 200 tier has no reseller price");
        assert.strictEqual(sent.total, 97000);
        assert.strictEqual(sent.reseller, true);

        bus.requests.length = 0;
        await decorGift.createByHand({ ref: "abcdefgh2", buyerId: BUYER, skus: ["1", "9"] }, { kind: "owner", username: "admin" });
        sent = bus.requests.find((r) => r.cmd === "decor.gift.create").payload;
        assert.deepStrictEqual(sent.items.map((i) => i.price), [20000, 50000]);
        assert.strictEqual(sent.total, 70000);
        assert.strictEqual(sent.reseller, false);

        bus.requests.length = 0;
        await decorGift.createByHand({ ref: "abcdefgh3", buyerId: CTV, skus: ["2"] }, { kind: "owner", username: "admin" });
        sent = bus.requests.find((r) => r.cmd === "decor.gift.create").payload;
        assert.deepStrictEqual([sent.total, sent.reseller], [40000, false], "a CTV with nothing at a reseller price");
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
