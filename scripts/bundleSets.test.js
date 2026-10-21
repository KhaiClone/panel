#!/usr/bin/env node
/**
 * Checks for bundle gift prices by composition (services/decorService.js): a
 * bundle's gift price is looked up by what is in it — each member's Discord
 * Nitro price × how many ("66000x2", "66000x1+99000x1") — so changing a decor's
 * gift price no longer drops its bundles' prices. The old sum-keyed rows
 * (`gift-bundle`) are moved once, prices kept, and stay until the owner removes
 * them. (A composition always had one old sum — its members' gift prices are
 * looked up by the same Discord prices — so the conflict path is a guard.)
 * Run:  node scripts/bundleSets.test.js
 *
 * Uses a throwaway shared.sqlite under the OS temp dir, never data/.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-sets-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const sharedStore = require("../server/services/sharedStore");
const decorService = require("../server/services/decorService");

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

// Discord Nitro prices (VND): 66,000 and 99,000.
const decor = (sku, withNitro, extra = {}) => ({ sku_id: sku, name: `d${sku}`, type: 0, prices: { withNitro, withoutNitro: withNitro + 10000 }, ...extra });
const bundle = (sku, items, extra = {}) => ({ sku_id: sku, name: `b${sku}`, type: 1000, items, prices: { withNitro: 1, withoutNitro: 1 }, ...extra });
const DECORS = [decor("1", 66000), decor("2", 66000), decor("3", 66000), decor("4", 99000), decor("5", 99000)];
const BUNDLES = [
    bundle("A", ["1", "2"]), // 66000 × 2
    bundle("B", ["2", "3"]), // 66000 × 2 as well
    bundle("C", ["1", "2", "3"]), // 66000 × 3
    bundle("D", ["1", "4"]), // 66000 + 99000
    bundle("E", ["4", "5"]), // 99000 × 2
    bundle("F", ["4", "1"]), // 66000 + 99000, the other order
];
// What is charged today, by the old key: the sum of the members' gift prices.
const GIFT = [
    { type: "gift", original: 66000, price: 70000 },
    { type: "gift", original: 99000, price: 100000 },
];
const LEGACY = [
    { type: "gift-bundle", original: 140000, price: 130000, resellerPrice: 120000 }, // A, B (70k + 70k)
    { type: "gift-bundle", original: 210000, price: 190000 }, // C
    { type: "gift-bundle", original: 170000, price: 160000 }, // D, F (70k + 100k)
    { type: "gift-bundle", original: 200000, price: 180000 }, // E
];

const byId = (list) => Object.fromEntries(list.map((d) => [d.sku_id, d]));
const row = (type, original) => sharedStore.run("prices", "findOne", { query: { type, original } });

(async () => {
    console.log("Bundle gift prices by composition");

    await test("bundleSetKey: Discord Nitro price × count, cheapest first, any member order", () => {
        const k = (skus) => decorService.bundleSetKey(skus.map((s) => DECORS.find((d) => d.sku_id === s)));
        assert.strictEqual(k(["1", "2"]), "66000x2");
        assert.strictEqual(k(["1", "2", "3"]), "66000x3");
        assert.strictEqual(k(["4", "1"]), "66000x1+99000x1");
        assert.strictEqual(k(["1", "4"]), "66000x1+99000x1");
        assert.strictEqual(k(["4", "5", "1"]), "66000x1+99000x2");
        assert.strictEqual(decorService.bundleSetKey([undefined, { type: 0, prices: {} }]), null, "no priced member");
        assert.strictEqual(decorService.bundleSetKey([DECORS[0], undefined]), "66000x1", "a missing member is skipped, as before");
        assert.strictEqual(decorService.canonicalSetKey("99000x1+66000x1"), "66000x1+99000x1");
        assert.strictEqual(decorService.canonicalSetKey("66000x1+66000x1"), "66000x2");
        for (const bad of ["", "66000", "66000x0", "x2", "66000x2+", "66000*2", null]) assert.strictEqual(decorService.canonicalSetKey(bad), null, String(bad));
    });

    await test("the bug: changing a decor's gift price leaves its bundles' price alone", () => {
        const prices = [...GIFT, { type: "gift-bundle-set", original: "66000x2", price: 130000 }];
        const before = byId(decorService.buildDecorList([...DECORS, ...BUNDLES], [], prices)).A;
        const raised = prices.map((p) => (p.type === "gift" && p.original === 66000 ? { ...p, price: 75000 } : p));
        const after = byId(decorService.buildDecorList([...DECORS, ...BUNDLES], [], raised)).A;
        assert.strictEqual(before.sellingPrices.giftBundle, 130000);
        assert.strictEqual(after.sellingPrices.giftBundle, 130000);
        assert.strictEqual(after.sellingPrices.loginWithNitro, 0, "login still adds up the members (no login rows here)");
    });

    await test("price report: one tier per composition, its bundles, members and count; old rows listed apart", () => {
        const prices = [...GIFT, ...LEGACY, { type: "gift-bundle-set", original: "66000x2", price: 130000, resellerPrice: 120000 }];
        const r = decorService.buildPriceReport([...DECORS, ...BUNDLES], [], prices);
        assert.deepStrictEqual(
            r.bundleTiers.map((t) => [t.key, t.memberCount, t.bundleCount, t.giftBundle]),
            [
                ["66000x2", 2, 2, 130000],
                ["66000x1+99000x1", 2, 2, null],
                ["99000x2", 2, 1, null],
                ["66000x3", 3, 1, null],
            ],
        );
        const two = r.bundleTiers[0];
        assert.deepStrictEqual(two.members, [{ original: 66000, count: 2 }]);
        assert.deepStrictEqual(two.bundles.map((b) => b.sku_id), ["A", "B"]);
        assert.strictEqual(two.giftBundleReseller, 120000);
        assert.deepStrictEqual(r.legacyBundleTiers.map((t) => t.total), [140000, 170000, 200000, 210000]);
        assert.ok(!r.decorTiers.some((t) => t.original === 140000), "old bundle rows are not decor tiers");
        // A bundle's gift no longer needs its members' gift prices.
        const t99 = r.decorTiers.find((t) => t.original === 99000);
        assert.strictEqual(t99.giftCount, 2, "decors 4 and 5 themselves, not again through D, E, F");
    });

    // ── The store ──
    for (const [name, value] of [
        ["decors", [...DECORS, ...BUNDLES.slice(0, 5)]],
        ["importedDecors", [BUNDLES[5]]],
        ["prices", [...GIFT, ...LEGACY, { type: "gift-bundle-set", original: "99000x2", price: 175000 }]],
        ["decorCategories", []],
    ]) {
        sharedStore.declare(name, "collection", "assistant");
        sharedStore.adopt(name, "assistant", value);
    }

    await test("migration: each composition gets its bundles' old price; a priced one is left alone", () => {
        const r = decorService.migrateBundleSets();
        assert.strictEqual(r.moved, 3, JSON.stringify(r));
        assert.deepStrictEqual(r.conflicts, []);
        assert.deepStrictEqual([row("gift-bundle-set", "66000x2").price, row("gift-bundle-set", "66000x2").resellerPrice], [130000, 120000], "the reseller price moves too");
        assert.strictEqual(row("gift-bundle-set", "66000x3").price, 190000);
        assert.strictEqual(row("gift-bundle-set", "66000x1+99000x1").price, 160000, "D (loaded) and F (imported) agree");
        assert.strictEqual(row("gift-bundle-set", "99000x2").price, 175000, "already priced: E's old 180,000 does not overwrite it");
        assert.ok(row("gift-bundle", 140000), "the old rows stay");
        const list = byId(decorService.buildDecorList([...DECORS, ...BUNDLES], [], sharedStore.run("prices", "get")));
        assert.deepStrictEqual(["A", "B", "C", "D", "F"].map((s) => list[s].sellingPrices.giftBundle), [130000, 130000, 190000, 160000, 160000], "same prices as before the move");
    });

    await test("migration runs once", () => {
        assert.strictEqual(decorService.migrateBundleSets(), null);
    });

    await test("listPrices: the move's result, and the old rows to remove", async () => {
        const r = await decorService.listPrices();
        assert.strictEqual(r.migration.moved, 3);
        assert.strictEqual(r.legacyBundleTiers.length, 4);
        const out = await decorService.deleteLegacyBundlePrices();
        assert.strictEqual(out.removed, 4);
        assert.strictEqual((await decorService.listPrices()).legacyBundleTiers.length, 0);
        assert.strictEqual(row("gift-bundle-set", "66000x2").price, 130000, "the new rows stay");
    });

    await test("a composition's price is set, re-priced, given a reseller price and removed by its key in any order", async () => {
        await decorService.upsertPrice({ type: "gift-bundle-set", original: "99000x1+66000x1", price: 165000 });
        assert.strictEqual(row("gift-bundle-set", "66000x1+99000x1").price, 165000);
        await decorService.setResellerPrice({ type: "gift-bundle-set", original: "66000x1+99000x1", resellerPrice: 150000 });
        assert.strictEqual(row("gift-bundle-set", "66000x1+99000x1").resellerPrice, 150000);
        await rejects(() => decorService.upsertPrice({ type: "gift-bundle-set", original: "66000", price: 1 }), 400);
        await rejects(() => decorService.upsertPrice({ type: "gift-bundle", original: 140000, price: 1 }), 400);
        await decorService.deletePrice("gift-bundle-set", "66000x1+99000x1");
        assert.strictEqual(row("gift-bundle-set", "66000x1+99000x1"), null);
        await rejects(() => decorService.deletePrice("gift-bundle-set", "66000x1+99000x1"), 404);
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
