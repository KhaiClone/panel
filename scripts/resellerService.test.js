#!/usr/bin/env node
/**
 * Checks for the CTVs (server/services/resellerService.js): the shop's one-time
 * import from the CTV role and ownership, adding / removing (with the shop's part
 * over the stubbed Discord bus), which orders count as a CTV's (the shop's stamp,
 * or the dates for older orders), the month and all-time figures, the role check
 * and the DM texts.
 * Run:  node scripts/resellerService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "reseller-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const resellers = require("../server/services/resellerService");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const SHOP = "1378037598953672746";
const bus = { ready: true, handler: SHOP, requests: [], answer: { role: "added", dm: "sent" }, unknown: new Set() };
discordBus.handlerOf = (cmd) => (cmd === resellers.CMD ? bus.handler : null);
discordBus.canHandle = (botId, cmd) => !!bus.handler && botId === bus.handler && cmd === resellers.CMD;
discordBus.status = () => ({ ready: bus.ready });
discordBus.userTag = async (id) => {
    if (bus.unknown.has(id)) throw Object.assign(new Error("Unknown User"), { code: 10013 });
    return `user${id.slice(-3)}`;
};
discordBus.request = async (target, cmd, payload, opts) => {
    bus.requests.push({ target, cmd, payload, opts });
    if (typeof bus.answer === "function") return bus.answer(payload);
    return bus.answer;
};

const ARNTO = "427399742906040333";
const KHAIDEV = "871329074046435338";
const LAN = "953525563878948914"; // imported from the role
const MINH = "612880338590498816"; // imported, server joined in August
const HOA = "852876827965521952"; // added on the page
const KHACH = "700000000000000001"; // an ordinary buyer

// Vietnam time: 2026-10-01 00:00 +07 = 2026-09-30 17:00 UTC.
const vn = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 7);

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
const discord = { via: "discord", byId: ARNTO, byTag: "arnto" };
const byId = (list, id) => list.resellers.find((r) => r.userId === id);

let seq = 0;
const order = (buyerId, price, at, status = "completed", extra = {}) => ({
    _id: `o${++seq}`,
    orderId: `arnto_${seq}`,
    sellerId: seq % 2 ? ARNTO : KHAIDEV,
    buyerId,
    name: `Item ${seq}`,
    price,
    orderDate: at,
    status,
    ...extra,
});

(async () => {
    console.log("resellerService");

    await test("before the orders are on the panel: list has no figures, orders() is 503", async () => {
        resellers.start();
        const l = resellers.list({ month: "2026-10" });
        assert.strictEqual(l.ordersOnPanel, false);
        assert.strictEqual(l.totals, null);
        await rejects(() => resellers.orders({}), 503);
    });

    await test("month: Vietnam's, and the last 12 newest first", () => {
        assert.strictEqual(resellers.monthOf(vn(2026, 10, 1, 0)), "2026-10");
        assert.strictEqual(resellers.monthOf(vn(2026, 9, 30, 23)), "2026-09");
        const l = resellers.list();
        assert.strictEqual(l.months.length, 12);
        assert.strictEqual(l.months[0], resellers.monthOf(Date.now()));
        assert.strictEqual(l.month, l.months[0]);
        assert.throws(() => resellers.list({ month: "2026-13" }), /month must look like/);
    });

    await test("import: once, from the role holders, the importer owns it, nobody DMed", async () => {
        assert.strictEqual(resellers.canAccess("someone"), true, "nobody owns it before the import");
        const r = resellers.importFrom(SHOP, {
            resellers: [
                { userId: LAN, userTag: "lan", joinedAt: vn(2026, 1, 5) },
                { userId: MINH, userTag: "minh", joinedAt: vn(2026, 8, 20) },
                { userId: "not-an-id" },
                { userId: LAN, userTag: "lan again" },
            ],
        });
        assert.deepStrictEqual(r, { imported: true, resellers: 2 });
        assert.strictEqual(resellers.canAccess(SHOP), true);
        assert.strictEqual(resellers.canAccess("someone"), false);
        const lan = resellers.get(LAN);
        assert.strictEqual(lan.userTag, "lan");
        assert.strictEqual(lan.joinedAt, vn(2026, 1, 5));
        assert.strictEqual(lan.addedBy, "Import");
        assert.strictEqual(bus.requests.length, 0, "an import changes nothing on Discord");
        assert.strictEqual(resellers.importFrom(SHOP, { resellers: [{ userId: HOA }] }).already, true, "a second import does nothing");
        assert.strictEqual(resellers.status().active, 2);
    });

    await test("add from the page: tag looked up, the shop is told (sealed) and answers", async () => {
        const out = await resellers.add({ userId: HOA, shop: "  Hoa Store  ", note: "bạn của Lan" }, { via: "panel" });
        assert.strictEqual(out.reseller.userTag, "user952");
        assert.strictEqual(out.reseller.shop, "Hoa Store");
        assert.strictEqual(out.reseller.addedBy, "Panel");
        assert.deepStrictEqual(out.discord, { sent: true, result: { role: "added", dm: "sent" } });
        assert.strictEqual(out.event, undefined, "the page does not get the raw event");
        const req = bus.requests.pop();
        assert.strictEqual(req.target, SHOP);
        assert.strictEqual(req.cmd, "reseller.event");
        assert.strictEqual(req.opts.sealed, true);
        assert.strictEqual(req.payload.event, "joined");
        assert.match(req.payload.dm, new RegExp(`<@${HOA}> \\(${HOA}\\)`));
        await rejects(() => resellers.add({ userId: HOA }, { via: "panel" }), 409);
        await rejects(() => resellers.add({ userId: "12" }, { via: "panel" }), 400);
        bus.unknown.add("700000000000000009");
        await rejects(() => resellers.add({ userId: "700000000000000009" }, { via: "panel" }), 400);
    });

    await test("add / remove from Discord: the event comes back, the bus is not used", async () => {
        const id = "700000000000000002";
        const out = await resellers.add({ userId: id, userTag: "tam" }, discord);
        assert.strictEqual(out.event.event, "joined");
        assert.strictEqual(out.reseller.addedBy, "arnto");
        const gone = await resellers.remove(id, discord);
        assert.strictEqual(gone.event.event, "left");
        assert.match(gone.event.dm, /không còn là Cộng Tác Viên/);
        assert.strictEqual(gone.reseller.active, false);
        assert.strictEqual(bus.requests.length, 0);
        await rejects(() => resellers.remove(id, discord), 404);
    });

    await test("update: shop, note, “CTV since” (not in the future)", async () => {
        const r = resellers.update(MINH, { shop: "discord.gg/minh", note: "x", joinedAt: vn(2026, 9, 1, 0) });
        assert.strictEqual(r.shop, "discord.gg/minh");
        assert.strictEqual(r.joinedAt, vn(2026, 9, 1, 0));
        await rejects(() => resellers.update(MINH, { joinedAt: Date.now() + 3 * 86_400_000 }), 400);
        await rejects(() => resellers.update(MINH, { joinedAt: "nope" }), 400);
        await rejects(() => resellers.update(KHACH, {}), 404);
    });

    // The shop's orders arrive on the panel.
    const ORDERS = [
        // Lan: CTV since January — old orders count by date, new ones by the stamp.
        order(LAN, 100_000, vn(2025, 12, 20)), // before she was a CTV
        order(LAN, 200_000, vn(2026, 9, 10)), // legacy, in the window
        order(LAN, 300_000, vn(2026, 10, 2), "completed", { reseller: true }),
        order(LAN, 50_000, vn(2026, 10, 3), "pending", { reseller: true }),
        order(LAN, 70_000, vn(2026, 10, 4), "cancelled", { reseller: true }),
        order(LAN, 999_000, vn(2026, 10, 5), "completed", { reseller: false }), // the shop says: not as a CTV
        // Minh: CTV since 2026-09-01 (edited above).
        order(MINH, 40_000, vn(2026, 8, 25)), // before
        order(MINH, 60_000, vn(2026, 9, 15)),
        order(MINH, 500_000, vn(2026, 10, 9), "completed", { reseller: true }),
        // An ordinary buyer, and Hoa (added today) with an old order.
        order(KHACH, 1_000_000, vn(2026, 10, 6)),
        order(HOA, 80_000, vn(2026, 10, 1)),
    ];

    await test("figures: the stamp decides, older orders by date; month vs all time", async () => {
        sharedStore.declare("orders", "collection", SHOP);
        sharedStore.adopt("orders", SHOP, ORDERS);
        const l = resellers.list({ month: "2026-10" });
        assert.strictEqual(l.ordersOnPanel, true);
        const lan = byId(l, LAN).stats;
        assert.deepStrictEqual(lan.month, { orders: 1, revenue: 300_000, pending: 1 });
        assert.deepStrictEqual(lan.total, { orders: 2, revenue: 500_000, pending: 1 });
        assert.strictEqual(lan.lastOrderAt, vn(2026, 10, 4), "the unstamped-false order is not theirs as a CTV");
        const minh = byId(l, MINH).stats;
        assert.deepStrictEqual(minh.month, { orders: 1, revenue: 500_000, pending: 0 });
        assert.deepStrictEqual(minh.total, { orders: 2, revenue: 560_000, pending: 0 });
        assert.deepStrictEqual(byId(l, HOA).stats.total, { orders: 0, revenue: 0, pending: 0 }, "an order before joining does not count");
        // Best month first.
        assert.deepStrictEqual(l.resellers.map((r) => r.userId), [MINH, LAN, HOA]);
        // Shop revenue in October: 300k + 999k + 500k + 1M + 80k.
        assert.deepStrictEqual(l.totals, { orders: 2, revenue: 800_000, pending: 1, shopRevenue: 2_879_000, buyers: 2 });
        const sept = resellers.list({ month: "2026-09" });
        assert.deepStrictEqual(byId(sept, LAN).stats.month, { orders: 1, revenue: 200_000, pending: 0 });
        assert.deepStrictEqual(byId(sept, MINH).stats.month, { orders: 1, revenue: 60_000, pending: 0 });
    });

    await test("orders(): one CTV or all, one month or all time, newest first", async () => {
        const oct = resellers.orders({ month: "2026-10" });
        assert.deepStrictEqual(
            oct.orders.map((o) => [o.buyerId, o.price, o.status]),
            [
                [MINH, 500_000, "completed"],
                [LAN, 70_000, "cancelled"],
                [LAN, 50_000, "pending"],
                [LAN, 300_000, "completed"],
            ],
        );
        assert.strictEqual(oct.orders[0].buyerTag, "minh");
        assert.strictEqual(oct.orders[0].sellerName, oct.orders[0].sellerId === ARNTO ? "ArnTo" : "KhaiDev");
        assert.strictEqual(oct.orders[0].stamped, true);
        const lanAll = resellers.orders({ userId: LAN, month: "all" });
        assert.strictEqual(lanAll.month, null);
        assert.deepStrictEqual(lanAll.orders.map((o) => o.price), [70_000, 50_000, 300_000, 200_000]);
        assert.strictEqual(lanAll.orders[3].stamped, false);
        await rejects(() => resellers.orders({ userId: KHACH }), 404);
    });

    await test("orders(): one page at a time; odd page / size are corrected", async () => {
        const many = Array.from({ length: 60 }, (_, i) => order(MINH, 1_000 + i, vn(2026, 10, 10) + i * 60_000, "completed", { reseller: true }));
        for (const o of many) sharedStore.run("orders", "create", { data: o });
        const first = resellers.orders({ userId: MINH, month: "all" });
        assert.deepStrictEqual([first.total, first.page, first.pageSize, first.pages, first.orders.length], [62, 1, 25, 3, 25]);
        assert.strictEqual(first.orders[0].price, 1_059, "newest first");
        const last = resellers.orders({ userId: MINH, month: "all", page: 3 });
        // Orders 51–62: the ten oldest of the new ones, then Minh's two from before.
        assert.deepStrictEqual(
            last.orders.map((o) => o.price),
            [1_009, 1_008, 1_007, 1_006, 1_005, 1_004, 1_003, 1_002, 1_001, 1_000, 500_000, 60_000],
        );
        assert.strictEqual(resellers.orders({ userId: MINH, month: "all", page: 99 }).page, 3, "past the end → the last page");
        assert.strictEqual(resellers.orders({ userId: MINH, month: "all", page: "x" }).page, 1);
        const big = resellers.orders({ userId: MINH, month: "all", pageSize: 100 });
        assert.deepStrictEqual([big.pageSize, big.pages, big.orders.length], [100, 1, 62]);
        assert.strictEqual(resellers.orders({ pageSize: 5000 }).pageSize, 25, "only 25 | 50 | 100");
        const empty = resellers.orders({ userId: HOA, month: "all" });
        assert.deepStrictEqual([empty.total, empty.page, empty.pages, empty.orders.length], [0, 1, 1, 0]);
        // Back to the orders the next checks expect.
        for (const o of many) sharedStore.run("orders", "findOneAndDelete", { query: { orderId: o.orderId } });
        assert.strictEqual(resellers.orders({ userId: MINH, month: "all" }).total, 2);
    });

    await test("removed and added again: stamped orders stay theirs, old unstamped ones follow the new date", async () => {
        bus.answer = { role: "removed", dm: "sent" };
        const out = await resellers.remove(LAN, { via: "panel" });
        assert.deepStrictEqual(out.discord, { sent: true, result: { role: "removed", dm: "sent" } });
        assert.strictEqual(bus.requests.pop().payload.event, "left");
        assert.strictEqual(resellers.list({ month: "2026-10" }).resellers.some((r) => r.userId === LAN), false, "the default list is the active ones");
        const all = resellers.list({ month: "2026-10", all: true });
        assert.strictEqual(byId(all, LAN).active, false);
        assert.deepStrictEqual(byId(all, LAN).stats.total, { orders: 2, revenue: 500_000, pending: 1 }, "still counted after removal");
        await rejects(() => resellers.update(LAN, { joinedAt: Date.now() }), 400); // after they were removed
        bus.answer = { role: "added", dm: "sent" };
        const back = await resellers.add({ userId: LAN }, { via: "panel" });
        bus.requests.pop();
        assert.strictEqual(back.reseller.userTag, "user914", "the tag is looked up again");
        assert.ok(back.reseller.joinedAt > vn(2026, 10, 9));
        assert.deepStrictEqual(resellers.list({ month: "2026-10" }).resellers.find((r) => r.userId === LAN).stats.total, { orders: 1, revenue: 300_000, pending: 1 });
    });

    await test("the shop not there: saved anyway, the page is told why", async () => {
        bus.ready = false;
        const out = await resellers.add({ userId: "700000000000000003" }, { via: "panel" });
        assert.strictEqual(out.discord.sent, false);
        assert.match(out.discord.error, /bus is not ready/);
        bus.ready = true;
        bus.handler = null;
        const out2 = await resellers.remove("700000000000000003", { via: "panel" });
        assert.strictEqual(out2.discord.sent, false);
        assert.match(out2.discord.error, /reseller\.event/);
        await rejects(() => resellers.syncRoles(), 503);
        bus.handler = SHOP;
        bus.answer = () => {
            throw Object.assign(new Error("timeout"), { status: 504 });
        };
        const out3 = await resellers.add({ userId: "700000000000000004" }, { via: "panel" });
        assert.deepStrictEqual(out3.discord, { sent: true, queued: true });
        await rejects(() => resellers.syncRoles(), 504);
        bus.requests.length = 0;
    });

    await test("check roles: the active CTVs go to the shop, its answer comes back", async () => {
        bus.answer = (p) => ({ given: [], had: p.userIds, missing: [], failed: [], extra: [{ id: KHACH, tag: "khach" }] });
        const r = await resellers.syncRoles();
        const sent = bus.requests.pop().payload;
        assert.strictEqual(sent.event, "sync");
        assert.deepStrictEqual([...sent.userIds].sort(), [LAN, MINH, HOA, "700000000000000004"].sort());
        assert.deepStrictEqual(r.extra, [{ id: KHACH, tag: "khach" }]);
    });

    await test("DM texts: defaults, custom, empty = default again", async () => {
        const d = resellers.getSettings();
        assert.match(d.welcome, /Cộng Tác Viên \(CTV\)/);
        assert.deepStrictEqual(d.vars, ["{user}", "{id}", "{tag}"]);
        resellers.setSettings({ welcome: "Chào {tag} — giá CTV ở <#123>" });
        bus.answer = { role: "added", dm: "sent" };
        await resellers.add({ userId: "700000000000000005", userTag: "binh" }, { via: "panel" });
        assert.strictEqual(bus.requests.pop().payload.dm, "Chào binh — giá CTV ở <#123>");
        resellers.setSettings({ welcome: "" });
        assert.match(resellers.getSettings().welcome, /Chào Mừng Cộng Tác Viên/);
    });

    await test("the shop's list has no figures", () => {
        const plain = resellers.listPlain();
        assert.ok(plain.length >= 4);
        assert.ok(plain.every((r) => r.stats === undefined && r.active));
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
