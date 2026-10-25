#!/usr/bin/env node
/**
 * Checks for deleting a shop order from the panel (server/services/orderService.js
 * deleteOrder + DELETE /api/shop/orders/:orderId): any status, owner only; the
 * shop does it over the stubbed Discord bus (order.delete) because it holds the
 * monthly statistics, the buyer's history and the waiting-list message; Deco Gift
 * orders, unknown orders and a shop that has not announced the command are
 * refused before anything is sent; one English line in the panel log.
 * Run:  node scripts/orderDelete.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "order-delete-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };
// The route file also mounts the Deco Gift orders; not under test here.
const giftPath = require.resolve(path.join(__dirname, "..", "server", "services", "decorGiftService"));
require.cache[giftPath] = { id: giftPath, filename: giftPath, loaded: true, exports: {} };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const panelLog = require("../server/services/panelLog");
const orderService = require("../server/services/orderService");

// ── Bus stub: the shop deletes the record on its side, like functions/orderActions.js ──
const SHOP = "1378037598953672746";
const bus = { caps: ["order.complete", "order.cancel", "order.delete"], requests: [] };
discordBus.canHandle = (botId, cmd) => botId === SHOP && bus.caps.includes(cmd);
discordBus.userTag = async (id) => `user${id.slice(-3)}`;
discordBus.request = async (target, cmd, payload, opts) => {
    bus.requests.push({ target, cmd, payload, opts });
    const gone = sharedStore.run("orders", "findOneAndDelete", { query: { orderId: payload.orderId } }, SHOP);
    if (!gone) throw Object.assign(new Error("Order not found"), { status: 502 });
    return gone;
};
const logged = [];
panelLog.add = (kind, text) => logged.push({ kind, text });

const ARNTO = "427399742906040333";
const BUYER = "700000000000000001";
const order = (n, status, extra = {}) => ({ orderId: `arnto_${n}`, sellerId: ARNTO, buyerId: BUYER, name: `Product ${n}`, price: 1_000_000, orderDate: 1_790_000_000_000 + n, status, ...extra });

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

const ids = () => sharedStore.run("orders", "get").map((o) => o.orderId);

(async () => {
    sharedStore.declare("orders", "collection", SHOP);
    sharedStore.adopt("orders", SHOP, [
        order(1, "pending"),
        order(2, "completed"),
        order(3, "cancelled"),
        order(4, "completed", { source: "decoGift" }),
        order(5, "pending"),
    ]);

    console.log("service");

    await test("a completed order goes to the shop as order.delete and leaves the list", async () => {
        const out = await orderService.deleteOrder("arnto_2");
        assert.strictEqual(out.message, "Order deleted");
        assert.strictEqual(out.order.orderId, "arnto_2");
        assert.strictEqual(out.order.sellerName, "ArnTo");
        const req = bus.requests.at(-1);
        assert.strictEqual(req.target, SHOP);
        assert.strictEqual(req.cmd, "order.delete");
        assert.deepStrictEqual(req.payload, { orderId: "arnto_2" });
        assert.ok(!ids().includes("arnto_2"));
        assert.strictEqual((await orderService.getStats()).completed, 1);
    });

    await test("pending and cancelled orders can be deleted too", async () => {
        await orderService.deleteOrder("arnto_1");
        await orderService.deleteOrder("arnto_3");
        assert.deepStrictEqual(ids(), ["arnto_4", "arnto_5"]);
    });

    await test("the panel log gets one English line with the money in the page style", async () => {
        const line = logged.find((l) => l.text.includes("arnto_2"));
        assert.strictEqual(line.kind, "owner");
        assert.strictEqual(line.text, "Owner deleted order `arnto_2` — Product 2 · 1,000,000 VND · completed");
        assert.ok(!/[à-ỹđ]/i.test(logged.map((l) => l.text).join("\n")));
    });

    await test("a Deco Gift order is refused before anything is sent", async () => {
        const before = bus.requests.length;
        await assert.rejects(orderService.deleteOrder("arnto_4"), (err) => err.status === 409 && /Deco Gift/.test(err.message));
        assert.strictEqual(bus.requests.length, before);
        assert.ok(ids().includes("arnto_4"));
    });

    await test("an unknown order is a 404 without a bus request", async () => {
        const before = bus.requests.length;
        await assert.rejects(orderService.deleteOrder("arnto_999"), (err) => err.status === 404 && err.message === "Order not found");
        assert.strictEqual(bus.requests.length, before);
    });

    await test("a shop that has not announced order.delete gets a clear 503", async () => {
        bus.caps = ["order.complete", "order.cancel"];
        try {
            await assert.rejects(orderService.deleteOrder("arnto_5"), (err) => err.status === 503 && /order\.delete/.test(err.message) && /restart/.test(err.message));
            assert.ok(ids().includes("arnto_5"));
        } finally {
            bus.caps.push("order.delete");
        }
    });

    console.log("route");

    await test("DELETE /api/shop/orders/:id is the owner's alone", async () => {
        let auth = null;
        const app = express();
        app.use(express.json());
        app.use("/api/shop", (req, _res, next) => ((req.auth = auth), next()), require("../server/routes/shopOrders"));
        app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
        const server = app.listen(0, "127.0.0.1");
        await new Promise((r) => server.once("listening", r));
        const del = (orderId) =>
            new Promise((resolve, reject) => {
                const req = http.request({ host: "127.0.0.1", port: server.address().port, path: `/api/shop/orders/${orderId}`, method: "DELETE", agent: false }, (res) => {
                    let out = "";
                    res.on("data", (c) => (out += c));
                    res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
                });
                req.on("error", reject);
                req.end();
            });
        try {
            const before = bus.requests.length;
            auth = { kind: "staff", staff: { userId: "953525563878948914", perms: { orders: "edit" } } };
            const staff = await del("arnto_5");
            assert.strictEqual(staff.status, 403);
            assert.strictEqual(staff.body.error, "Only the owner can delete orders");
            assert.strictEqual(bus.requests.length, before);
            assert.ok(ids().includes("arnto_5"));

            auth = { kind: "owner", username: "admin" };
            const mine = await del("arnto_5");
            assert.strictEqual(mine.status, 200);
            assert.strictEqual(mine.body.order.orderId, "arnto_5");
            assert.ok(!ids().includes("arnto_5"));

            const gift = await del("arnto_4");
            assert.strictEqual(gift.status, 409);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
