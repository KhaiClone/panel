#!/usr/bin/env node
/**
 * Checks for the decor sale switches (services/decorService.js) — no framework.
 * Run:  node scripts/decorService.test.js
 *
 * Uses a throwaway shared.sqlite under the OS temp dir, never data/.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "decor-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
const sharedStore = require("../server/services/sharedStore");
const decorService = require("../server/services/decorService");

let passed = 0;
const pending = [];
const ok = (label, fn) => pending.push([label, fn]);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRICES = [
    { type: "login", original: 100, price: 10 },
    { type: "login", original: 80, price: 8 },
    { type: "gift", original: 100, price: 20 },
    { type: "login", original: 200, price: 30 },
    { type: "login", original: 150, price: 25 },
    { type: "gift", original: 200, price: 40 },
    { type: "gift-bundle", original: 60, price: 50 },
];
const decor = (sku, withNitro, withoutNitro, extra = {}) => ({ sku_id: sku, name: `d${sku}`, type: 0, prices: { withNitro, withoutNitro }, ...extra });
const LOADED = [decor("1", 100, 80), decor("2", 200, 150, { noLoginWithNitro: true }), { sku_id: "9", name: "bundle", type: 1000, items: ["1", "2"], prices: { withNitro: 250, withoutNitro: 200 } }];
const IMPORTED = [decor("5", 100, 80, { noGift: true })];

const byId = (list) => Object.fromEntries(list.map((d) => [d.sku_id, d]));

// ── Pure: prices honour the switches ─────────────────────────────────────────

ok("selling prices: a switched-off way sells for 0, the others are untouched", () => {
    const list = byId(decorService.buildDecorList(LOADED, IMPORTED, PRICES));
    assert.deepStrictEqual(list["1"].sellingPrices, { loginWithNitro: 10, loginWithoutNitro: 8, gift: 20 });
    assert.deepStrictEqual(list["2"].sellingPrices, { loginWithNitro: 0, loginWithoutNitro: 25, gift: 40 });
    assert.deepStrictEqual(list["5"].sellingPrices, { loginWithNitro: 10, loginWithoutNitro: 8, gift: 0 });
    assert.strictEqual(list["1"].tierPrices, undefined, "the public shape carries no tier prices");
});

ok("tier prices (Decors page): what each way costs, whatever the switches", () => {
    const list = byId(decorService.buildDecorList(LOADED, IMPORTED, PRICES, { tierPrices: true }));
    assert.deepStrictEqual(list["2"].tierPrices, { loginWithNitro: 30, loginWithoutNitro: 25, gift: 40 });
    assert.deepStrictEqual(list["5"].tierPrices.gift, 20);
});

ok("a bundle has its own switches; its prices still sum its members", () => {
    const off = LOADED.map((d) => (d.sku_id === "9" ? { ...d, noLoginWithoutNitro: true } : d));
    const b = byId(decorService.buildDecorList(off, IMPORTED, PRICES, { tierPrices: true }))["9"];
    // Member 2 does not sell login-with-Nitro itself, but the bundle still does.
    assert.deepStrictEqual(b.sellingPrices, { loginWithNitro: 40, loginWithoutNitro: 0, giftBundle: 50 });
    assert.deepStrictEqual(b.tierPrices, { loginWithNitro: 40, loginWithoutNitro: 33, giftBundle: 50 });
});

// ── Pure: the price report only asks for prices that are sold ────────────────

ok("price report: a tier is needed only by the ways that are sold", () => {
    const solo = [decor("2", 200, 150, { noLoginWithNitro: true, noGift: true })];
    const r = decorService.buildPriceReport(solo, [], PRICES);
    const t200 = r.decorTiers.find((t) => t.original === 200);
    const t150 = r.decorTiers.find((t) => t.original === 150);
    assert.strictEqual(t200.loginCount, 0);
    assert.strictEqual(t200.giftCount, 0);
    assert.strictEqual(t200.decorCount, 0, "200 has a price row but nothing needs it");
    assert.strictEqual(t150.loginCount, 1);
    assert.strictEqual(t150.decorCount, 1);
    assert.ok(!("users" in t150), "no internal bookkeeping leaks out");
});

ok("price report: a bundle that sells a way needs its members' tiers for it", () => {
    const r = decorService.buildPriceReport(LOADED, [], PRICES);
    const t200 = r.decorTiers.find((t) => t.original === 200);
    // Decor 2 switched its own login-with-Nitro off, bundle 9 still sells it.
    assert.strictEqual(t200.loginCount, 1);
    assert.deepStrictEqual(t200.decors.map((d) => d.sku_id), ["2"], "listed once");
});

ok("price report: a bundle without gift needs no gift-bundle tier", () => {
    const noGift = LOADED.map((d) => (d.sku_id === "9" ? { ...d, noGift: true } : d));
    const before = decorService.buildPriceReport(LOADED, [], PRICES).bundleTiers.find((t) => t.total === 60);
    const after = decorService.buildPriceReport(noGift, [], PRICES).bundleTiers.find((t) => t.total === 60);
    assert.strictEqual(before.bundleCount, 1);
    assert.strictEqual(after.bundleCount, 0, "only the price row remains");
});

// ── Store: one decor, many decors ────────────────────────────────────────────

const seed = () => {
    for (const [name, kind, value] of [
        ["decors", "collection", LOADED],
        ["importedDecors", "collection", IMPORTED],
        ["prices", "collection", PRICES],
        ["decorCategories", "collection", [{ sku_id: "c1", name: "Theme" }]],
    ]) {
        sharedStore.declare(name, kind, "assistant");
        sharedStore.adopt(name, "assistant", value);
    }
};
const get = (name, sku) => sharedStore.run(name, "findOne", { query: { sku_id: sku } });

ok("PATCH one: a LOADED decor can switch ways off now (it is written to decors)", async () => {
    seed();
    const r = await decorService.updateDecor("1", { noGift: true, noLoginWithoutNitro: 1 });
    assert.strictEqual(r.decor.noGift, true);
    assert.strictEqual(get("decors", "1").noLoginWithoutNitro, true);
    assert.strictEqual(get("decors", "1").name, "d1", "the rest of the record is kept");
});

ok("PATCH one: an imported decor keeps its theme editing; a loaded one refuses it", async () => {
    await decorService.updateDecor("5", { category_sku_id: "c1", noGift: false });
    assert.strictEqual(get("importedDecors", "5").category_sku_id, "c1");
    assert.strictEqual(get("importedDecors", "5").noGift, false);
    await assert.rejects(decorService.updateDecor("1", { category_sku_id: "c1" }), /chỉ đổi được theme/);
    await assert.rejects(decorService.updateDecor("404", { noGift: true }), (e) => e.status === 404);
    await assert.rejects(decorService.updateDecor("1", { name: "x" }), (e) => e.status === 400, "unknown fields are not written");
    assert.strictEqual(get("decors", "1").name, "d1");
});

ok("PATCH many: switches go to whichever collection holds each sku", async () => {
    const r = await decorService.updateDecors(["1", "5", "9", "1", "nope"], { noLoginWithNitro: true });
    assert.strictEqual(r.count, 3, "duplicates and unknown skus do not count");
    assert.strictEqual(get("decors", "1").noLoginWithNitro, true);
    assert.strictEqual(get("decors", "9").noLoginWithNitro, true);
    assert.strictEqual(get("importedDecors", "5").noLoginWithNitro, true);
    assert.strictEqual(get("decors", "2").noLoginWithNitro, true, "untouched (was already off)");
    await assert.rejects(decorService.updateDecors([], { noGift: true }), (e) => e.status === 400);
    await assert.rejects(decorService.updateDecors(["1"], { category_sku_id: "c1" }), (e) => e.status === 400);
});

ok("listDecors reads the switches straight back", async () => {
    const list = byId(await decorService.listDecors({ tierPrices: true }));
    assert.strictEqual(list["1"].sellingPrices.loginWithNitro, 0);
    assert.strictEqual(list["1"].tierPrices.loginWithNitro, 10);
    assert.strictEqual(list["5"].decorFrom, "importedDecors");
});

(async () => {
    console.log("decorService");
    for (const [label, fn] of pending) {
        try {
            await fn();
            passed++;
            console.log(`  ok   ${label}`);
        } catch (err) {
            console.error(`  FAIL ${label}\n       ${err.stack.split("\n").slice(0, 3).join("\n       ")}`);
            process.exitCode = 1;
        }
    }
    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
    process.exit();
})();
