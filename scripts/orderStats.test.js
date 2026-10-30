#!/usr/bin/env node
/**
 * Checks for the Orders page statistics by period (server/services/orderService.js
 * getStats + GET /api/shop/orders/stats?period=): a month, a year or all time,
 * cut in Vietnam time (UTC+7) whatever the node's clock; an order counts in the
 * period it was placed in, revenue is its completed orders; a year breaks down
 * by month and all time by year, from the first order to today; staff without
 * the revenue grant get no revenue anywhere, breakdown rows included; a bad
 * period is a 400 in English.
 * Run:  node scripts/orderStats.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "order-stats-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };
// The route file also mounts the Deco Gift orders; not under test here.
const giftPath = require.resolve(path.join(__dirname, "..", "server", "services", "decorGiftService"));
require.cache[giftPath] = { id: giftPath, filename: giftPath, loaded: true, exports: {} };
// The route only asks whether the caller may see revenue.
const authPath = require.resolve(path.join(__dirname, "..", "server", "middleware", "auth"));
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { hasGrant: (auth, grant) => auth?.kind === "owner" || !!auth?.grants?.includes(grant) } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const orderService = require("../server/services/orderService");

discordBus.userTag = async (id) => `user${id.slice(-3)}`;

const SHOP = "1378037598953672746";
const ARNTO = "427399742906040333";
const KHAIDEV = "871329074046435338";

// A Vietnam wall-clock time as a timestamp: vn(2026, 10, 1, 0, 30) = 00:30 on 1 Oct 2026 in Vietnam.
const vn = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h - 7, min);
let n = 0;
const order = (orderDate, status, price, extra = {}) => ({
    orderId: `arnto_${++n}`,
    sellerId: ARNTO,
    buyerId: `70000000000000000${n % 3}`,
    name: `Product ${n}`,
    price,
    orderDate,
    status,
    ...extra,
});

// "Today" for the test: the real clock, so the newest month is whatever this month is.
const nowMonth = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
const [NY, NM] = nowMonth.split("-").map(Number);

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
    sharedStore.declare("orders", "collection", SHOP);
    sharedStore.adopt("orders", SHOP, [
        // 23:30 on 30 Sep in Vietnam is 16:30 UTC: September.
        order(vn(2025, 9, 30, 23, 30), "completed", 100_000),
        // 00:30 on 1 Oct in Vietnam is still 30 Sep in UTC: October all the same.
        order(vn(2025, 10, 1, 0, 30), "completed", 200_000),
        order(vn(2025, 10, 15), "cancelled", 999_000),
        order(vn(2025, 10, 20), "pending", 50_000, { sellerId: KHAIDEV }),
        order(vn(2025, 12, 31, 23, 59), "completed", 300_000, { sellerId: KHAIDEV }),
        // Year turn: 1 Jan 2026 00:10 in Vietnam.
        order(vn(2026, 1, 1, 0, 10), "completed", 400_000),
        order(vn(NY, NM, 1, 9), "completed", 1_000_000),
        // An old order without a date: all time only.
        order(undefined, "completed", 5_000),
    ]);

    console.log("service");

    await test("a month counts the orders placed in it, Vietnam time", async () => {
        const sep = await orderService.getStats({ period: "2025-09" });
        assert.strictEqual(sep.total, 1);
        assert.strictEqual(sep.revenue, 100_000);
        const oct = await orderService.getStats({ period: "2025-10" });
        assert.strictEqual(oct.period, "2025-10");
        assert.deepStrictEqual(
            { total: oct.total, pending: oct.pending, completed: oct.completed, cancelled: oct.cancelled, buyers: oct.buyers, revenue: oct.revenue },
            { total: 3, pending: 1, completed: 1, cancelled: 1, buyers: 3, revenue: 200_000 },
        );
        assert.deepStrictEqual(oct.breakdown, []);
    });

    await test("per seller follows the period", async () => {
        const oct = await orderService.getStats({ period: "2025-10" });
        assert.strictEqual(oct.bySeller[ARNTO].total, 2);
        assert.strictEqual(oct.bySeller[ARNTO].revenue, 200_000);
        assert.strictEqual(oct.bySeller[KHAIDEV].total, 1);
        assert.strictEqual(oct.bySeller[KHAIDEV].pending, 1);
        assert.strictEqual(oct.bySeller[KHAIDEV].revenue, 0);
    });

    await test("a year sums its months and breaks down by month from the first order", async () => {
        const y = await orderService.getStats({ period: "2025" });
        assert.strictEqual(y.total, 5);
        assert.strictEqual(y.revenue, 600_000);
        assert.deepStrictEqual(y.breakdown.map((r) => r.key), ["2025-09", "2025-10", "2025-11", "2025-12"]);
        assert.deepStrictEqual(y.breakdown.map((r) => r.total), [1, 3, 0, 1]);
        assert.deepStrictEqual(y.breakdown.map((r) => r.revenue), [100_000, 200_000, 0, 300_000]);
    });

    await test("the 1 January order belongs to the new year", async () => {
        const jan = await orderService.getStats({ period: "2026-01" });
        assert.strictEqual(jan.total, 1);
        assert.strictEqual(jan.revenue, 400_000);
    });

    await test("this year's months stop at this month", async () => {
        const y = await orderService.getStats({ period: String(NY) });
        assert.strictEqual(y.breakdown.at(-1).key, nowMonth);
        assert.ok(y.breakdown.every((r) => r.key <= nowMonth));
    });

    await test("all time has every order and breaks down by year", async () => {
        for (const period of [undefined, "", "all"]) {
            const all = await orderService.getStats({ period });
            assert.strictEqual(all.period, null);
            assert.strictEqual(all.total, 8);
            assert.strictEqual(all.revenue, 2_005_000);
            const years = [...new Set(["2025", "2026", String(NY)])];
            assert.deepStrictEqual(all.breakdown.map((r) => r.key), years);
            // The dateless order is in the total but in no year.
            assert.strictEqual(all.breakdown.reduce((s, r) => s + r.total, 0), 7);
        }
    });

    await test("months run from the first order's to this one, newest first", async () => {
        const { months } = await orderService.getStats({ period: "all" });
        assert.strictEqual(months[0], nowMonth);
        assert.strictEqual(months.at(-1), "2025-09");
        assert.ok(months.includes("2025-11"), "a month without orders is still pickable");
        for (let i = 1; i < months.length; i++) assert.ok(months[i] < months[i - 1]);
    });

    await test("a bad period is a 400 in English", async () => {
        for (const period of ["2025-13", "25", "2025-1", "October"]) {
            await assert.rejects(orderService.getStats({ period }), (err) => err.status === 400 && /period must be/.test(err.message));
        }
    });

    await test("withoutRevenue strips the breakdown rows too", async () => {
        const stripped = orderService.withoutRevenue(await orderService.getStats({ period: "2025" }));
        assert.ok(!JSON.stringify(stripped).includes("revenue"), JSON.stringify(stripped));
        assert.strictEqual(stripped.breakdown[1].total, 3);
        // A stats object without a breakdown (older shape) stays without one.
        assert.ok(!("breakdown" in orderService.withoutRevenue({ total: 1, revenue: 5, bySeller: {} })));
    });

    console.log("route");

    await test("GET /api/shop/orders/stats?period= passes the period and hides revenue without the grant", async () => {
        let auth = null;
        const app = express();
        app.use("/api/shop", (req, _res, next) => ((req.auth = auth), next()), require("../server/routes/shopOrders"));
        app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
        const server = app.listen(0, "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        const get = (query) =>
            new Promise((resolve, reject) => {
                const req = http.request({ host: "127.0.0.1", port: server.address().port, path: `/api/shop/orders/stats${query}`, agent: false }, (res) => {
                    let out = "";
                    res.on("data", (c) => (out += c));
                    res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
                });
                req.on("error", reject);
                req.end();
            });
        try {
            auth = { kind: "owner" };
            const mine = await get("?period=2025");
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.body.period, "2025");
            assert.strictEqual(mine.body.revenue, 600_000);
            assert.strictEqual(mine.body.breakdown.length, 4);

            auth = { kind: "staff", grants: [] };
            const staff = await get("?period=2025-10");
            assert.strictEqual(staff.status, 200);
            assert.strictEqual(staff.body.total, 3);
            assert.ok(!JSON.stringify(staff.body).includes("revenue"));

            const bad = await get("?period=2025-13");
            assert.strictEqual(bad.status, 400);
            assert.ok(!/[à-ỹđ]/i.test(bad.body.error));
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
