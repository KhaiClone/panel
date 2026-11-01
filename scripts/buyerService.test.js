#!/usr/bin/env node
/**
 * Checks for the Buyers page (server/services/buyerService.js + GET /api/buyers):
 * every buyer from the shop's orders on the panel, totals like /me (spent = completed
 * orders), a period cut in Vietnam time — a month, a year, all time or a range of
 * days, both ends included — counting the orders placed in it; ranked by spend, or by
 * completed orders without money, which then sends no amount anywhere; a buyer's
 * profile with their all-time rank and every order newest first; bad periods / ids
 * are 400 in English; staff without the revenue grant get no money from the route.
 * Run:  node scripts/buyerService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "buyers-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
// Stand-in for server/db (discordBus loads it; nothing here reads bots).
stub("db", { get: async () => null, find: async () => [], findOne: async () => null });
const RESELLER = "700000000000000003";
stub("services/resellerService", { isReseller: (id) => id === RESELLER });
// The route only asks whether the caller may see revenue.
stub("middleware/auth", { hasGrant: (auth, grant) => auth?.kind === "owner" || !!auth?.grants?.includes(grant) });

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const buyerService = require("../server/services/buyerService");

discordBus.userTag = async (id) => `user${id.slice(-3)}`;

const SHOP = "1378037598953672746";
const ARNTO = "427399742906040333";
const KHAIDEV = "871329074046435338";
const A = "700000000000000001";
const B = "700000000000000002";
const C = RESELLER;

// A Vietnam wall-clock time as a timestamp: vn(2026, 10, 1, 0, 30) = 00:30 on 1 Oct 2026 in Vietnam.
const vn = (y, m, d, h = 12, min = 0) => Date.UTC(y, m - 1, d, h - 7, min);
let n = 0;
const order = (buyerId, orderDate, status, price, sellerId = ARNTO) => ({ orderId: `arnto_${++n}`, sellerId, buyerId, name: `Product ${n}`, price, orderDate, status });

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
const row = (list, id) => list.buyers.find((b) => b.buyerId === id);

(async () => {
    sharedStore.declare("orders", "collection", SHOP);
    sharedStore.adopt("orders", SHOP, [
        // A: two completed in October (one at 00:30 on 1 Oct, Vietnam), one pending, one in September
        order(A, vn(2025, 10, 1, 0, 30), "completed", 100_000),
        order(A, vn(2025, 10, 20), "completed", 50_000, KHAIDEV),
        order(A, vn(2025, 10, 21), "pending", 999_000),
        order(A, vn(2025, 9, 30, 23, 30), "completed", 10_000),
        // B: fewer orders but the biggest spend in October
        order(B, vn(2025, 10, 5), "completed", 500_000, KHAIDEV),
        order(B, vn(2025, 10, 6), "cancelled", 70_000),
        // C (a reseller): many small completed orders in November
        order(C, vn(2025, 11, 1), "completed", 1_000),
        order(C, vn(2025, 11, 2), "completed", 1_000),
        order(C, vn(2025, 11, 3), "completed", 1_000),
        order(C, vn(2025, 11, 4), "completed", 1_000),
    ]);

    console.log("buyers by period");

    await test("all time: totals like /me, spent = completed, ranked by spend", async () => {
        const all = await buyerService.list({ period: "all", money: true });
        assert.strictEqual(all.period, "all");
        assert.deepStrictEqual(all.buyers.map((b) => b.buyerId), [B, A, C]);
        assert.deepStrictEqual(all.buyers.map((b) => b.rank), [1, 2, 3]);
        const a = row(all, A);
        assert.deepStrictEqual(
            { total: a.total, pending: a.pending, completed: a.completed, cancelled: a.cancelled, spent: a.spent },
            { total: 4, pending: 1, completed: 3, cancelled: 0, spent: 160_000 },
        );
        assert.deepStrictEqual(
            [a.bySeller[ARNTO].spent, a.bySeller[KHAIDEV].spent, a.bySeller[KHAIDEV].name],
            [110_000, 50_000, "KhaiDev"],
        );
        assert.strictEqual(a.firstOrder, vn(2025, 9, 30, 23, 30));
        assert.strictEqual(a.lastOrder, vn(2025, 10, 21));
        assert.strictEqual(row(all, C).reseller, true);
        assert.strictEqual(row(all, A).reseller, false);
        assert.deepStrictEqual(all.totals, { buyers: 3, orders: 10, pending: 1, completed: 8, cancelled: 1, revenue: 664_000 });
        assert.ok(all.months.includes("2025-10"));
    });

    await test("a month counts the orders placed in it, Vietnam time; a buyer with none is not listed", async () => {
        const oct = await buyerService.list({ period: "2025-10", money: true });
        assert.deepStrictEqual(oct.buyers.map((b) => b.buyerId), [B, A]);
        assert.strictEqual(row(oct, A).spent, 150_000); // 00:30 on 1 Oct counts, 23:30 on 30 Sep does not
        const sep = await buyerService.list({ period: "2025-09", money: true });
        assert.deepStrictEqual(sep.buyers.map((b) => [b.buyerId, b.spent]), [[A, 10_000]]);
        const year = await buyerService.list({ period: "2025", money: true });
        assert.strictEqual(year.totals.orders, 10);
    });

    await test("a range of days, both ends included, Vietnam time", async () => {
        const r = await buyerService.list({ period: "2025-10-01_2025-10-05", money: true });
        assert.strictEqual(r.period, "2025-10-01_2025-10-05");
        assert.deepStrictEqual(r.buyers.map((b) => [b.buyerId, b.spent]), [[B, 500_000], [A, 100_000]]);
        const one = await buyerService.list({ period: "2025-09-30_2025-09-30", money: true });
        assert.deepStrictEqual(one.buyers.map((b) => b.buyerId), [A]);
    });

    await test("bad periods are 400 in English", async () => {
        for (const p of ["2025-13", "last week", "2025-10-05_2025-10-01", "2025-02-30_2025-03-01"]) {
            await assert.rejects(buyerService.list({ period: p }), (e) => e.status === 400 && /^[\x20-\x7e—]+$/.test(e.message));
        }
    });

    await test("without money: ranked by completed orders, no amount anywhere", async () => {
        const all = await buyerService.list({ period: "all" });
        assert.deepStrictEqual(all.buyers.map((b) => b.buyerId), [C, A, B]);
        assert.strictEqual(all.money, false);
        const text = JSON.stringify(all);
        assert.ok(!text.includes("spent") && !text.includes("revenue"), text);
    });

    console.log("one buyer");

    await test("profile: all-time numbers, rank and every order newest first", async () => {
        const p = await buyerService.profile(A, { money: true });
        assert.deepStrictEqual([p.total, p.completed, p.pending, p.spent, p.rank], [4, 3, 1, 160_000, 2]);
        assert.deepStrictEqual(p.history.map((o) => o.orderId), ["arnto_3", "arnto_2", "arnto_1", "arnto_4"]);
        assert.deepStrictEqual(
            { price: p.history[1].price, seller: p.history[1].sellerName, status: p.history[1].status },
            { price: 50_000, seller: "KhaiDev", status: "completed" },
        );
        const bare = await buyerService.profile(A);
        assert.strictEqual(bare.rank, 2);
        assert.ok(!JSON.stringify(bare).includes("price") && !JSON.stringify(bare).includes("spent"));
        await assert.rejects(buyerService.profile("123"), (e) => e.status === 400);
        await assert.rejects(buyerService.profile("700000000000000009"), (e) => e.status === 404);
    });

    console.log("route");

    await test("GET /api/buyers: the owner sees money, staff without the grant do not", async () => {
        let auth = null;
        const app = express();
        app.use("/api/buyers", (req, _res, next) => ((req.auth = auth), next()), require("../server/routes/buyers"));
        app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
        const server = app.listen(0, "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        const get = (p) =>
            new Promise((resolve, reject) => {
                const req = http.request({ host: "127.0.0.1", port: server.address().port, path: p, agent: false }, (res) => {
                    let out = "";
                    res.on("data", (c) => (out += c));
                    res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
                });
                req.on("error", reject);
                req.end();
            });
        try {
            auth = { kind: "owner" };
            const mine = await get("/api/buyers?period=2025-10");
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.body.totals.revenue, 650_000);
            assert.strictEqual((await get(`/api/buyers/${B}`)).body.spent, 500_000);

            auth = { kind: "staff", grants: [] };
            const staff = await get("/api/buyers?period=all");
            assert.strictEqual(staff.status, 200);
            assert.ok(!JSON.stringify(staff.body).includes("revenue") && !JSON.stringify(staff.body).includes("spent"));
            const one = await get(`/api/buyers/${B}`);
            assert.ok(!JSON.stringify(one.body).includes("price"));

            auth = { kind: "staff", grants: ["orders.revenue"] };
            assert.strictEqual((await get("/api/buyers?period=all")).body.totals.revenue, 664_000);
            assert.strictEqual((await get("/api/buyers?period=nope")).status, 400);
        } finally {
            server.close();
        }
    });

    console.log(failures ? `\n${failures} failing` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
