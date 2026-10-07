#!/usr/bin/env node
/**
 * Checks for the stock (server/services/stockService.js): product types, pasted
 * items, delivering one through the (stubbed) Discord bus, settling lost
 * answers, and the expiry reminders.
 * Run:  node scripts/stockService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "stock-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-secret";

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const discordService = require("../server/services/discordService");
const stock = require("../server/services/stockService");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const bus = { handler: "assistant", ready: true, calls: [], answer: null, rows: new Map() };
discordBus.handlerOf = (cmd) => (cmd === "stock.deliver" ? bus.handler : null);
discordBus.status = () => ({ ready: bus.ready });
discordBus.userTag = async (id) => `user${id.slice(-3)}`;
discordBus.get = (id) => bus.rows.get(id) || null;
discordBus.request = async (target, cmd, payload, opts) => {
    const busId = `bus-${bus.calls.length + 1}`;
    bus.calls.push({ target, cmd, payload, opts, busId });
    opts.onQueued?.(busId);
    return typeof bus.answer === "function" ? bus.answer(payload) : bus.answer;
};

const sent = [];
discordService.sendStockExpiryWarning = async (a) => sent.push({ kind: "warn", ...a });
discordService.sendStockExpired = async (a) => sent.push({ kind: "expired", ...a });

const raw = () => sharedStore.raw();
const BUYER = "871329074046435338";

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

(async () => {
    console.log("stockService");
    let nitro;
    let acc;

    await test("product types: create, unique code, validation", async () => {
        nitro = stock.createProduct({ name: "Nitro 1 tháng", code: "Nitro-1m", fields: "Gmail | Password | Hash", reminders: { enabled: true, days: 30 } });
        assert.strictEqual(nitro.code, "nitro-1m");
        assert.deepStrictEqual(nitro.fields, ["Gmail", "Password", "Hash"]);
        assert.strictEqual(nitro.separator, ":");
        assert.deepStrictEqual(nitro.counts, { available: 0, reserved: 0, delivered: 0 });
        await rejects(() => stock.createProduct({ name: "Khác", code: "nitro-1m" }), 409);
        await rejects(() => stock.createProduct({ name: "Khác", code: "có dấu" }), 400);
        await rejects(() => stock.createProduct({ name: "", code: "x" }), 400);
        acc = stock.createProduct({ name: "Tài khoản", code: "acc", multiline: true });
        assert.strictEqual(acc.reminders.enabled, false);
        const edited = stock.updateProduct(acc.id, { title: "Tài khoản của bạn", reminders: { days: 7 } });
        assert.strictEqual(edited.title, "Tài khoản của bạn");
        assert.strictEqual(edited.multiline, true, "untouched settings stay");
        assert.strictEqual(edited.reminders.days, 7);
        assert.strictEqual(edited.reminders.enabled, false);
    });

    await test("items: one per line, pasted twice skipped, encrypted at rest", async () => {
        const r = stock.addItems(nitro.id, { text: "a@x.com:p1:h1\r\n\n b@x.com:p2:h2 \na@x.com:p1:h1\n" });
        assert.deepStrictEqual([r.added, r.duplicates], [2, 1]);
        const again = stock.addItems("nitro-1m", { text: "b@x.com:p2:h2\nc@x.com:p3:h3" });
        assert.deepStrictEqual([again.added, again.duplicates], [1, 1]);
        const dup = stock.addItems(nitro.id, { text: "c@x.com:p3:h3", allowDuplicates: true });
        assert.strictEqual(dup.added, 1);
        assert.strictEqual(stock.listItems(nitro.id).length, 4);
        const stored = raw().prepare("SELECT content FROM stock_items").pluck().all().join("\n");
        assert.ok(!stored.includes("a@x.com"), "item text must not be stored in clear");
        await rejects(() => stock.addItems(nitro.id, { text: "  \n " }), 400);
        await rejects(() => stock.addItems(nitro.id, { text: "x".repeat(1001) }), 400);
    });

    await test("items: multi-line products split on blank lines", async () => {
        assert.deepStrictEqual(stock.splitItems("user1\npass1  \n\n\nuser2\npass2\n \nuser3", true), ["user1\npass1", "user2\npass2", "user3"]);
        const r = stock.addItems(acc.id, { text: "user1\npass1\n\nuser2\npass2" });
        assert.strictEqual(r.added, 2);
    });

    await test("formatItem: labelled fields, the last one takes the rest", async () => {
        const f = { fields: ["Gmail", "Password", "Hash"], separator: ":" };
        assert.deepStrictEqual(stock.formatItem("m:p:h:extra", f).fields.map((x) => x.value), ["m", "p", "h:extra"]);
        assert.deepStrictEqual(stock.formatItem("m:p", f).fields.map((x) => x.name), ["Gmail", "Password"]);
        assert.deepStrictEqual(stock.formatItem("m\np:q\nh", f).fields.map((x) => x.value), ["m", "p:q", "h"]);
        assert.deepStrictEqual(stock.formatItem("plain text", { fields: [] }), { text: "plain text" });
    });

    await test("deliver: a random item, sealed, then history with an expiry", async () => {
        bus.answer = () => ({ delivered: true, messageId: "m1" });
        const before = stock.getProduct(nitro.id).counts.available;
        const r = await stock.deliver({ product: "nitro-1m", buyerId: BUYER, staffId: "427399742906040333", staffTag: "arnto", via: "discord" });
        assert.strictEqual(r.delivered, true);
        assert.strictEqual(r.remaining, before - 1);
        const call = bus.calls.at(-1);
        assert.strictEqual(call.target, "assistant");
        assert.strictEqual(call.cmd, "stock.deliver");
        assert.strictEqual(call.opts.sealed, true);
        assert.ok(call.payload.deadline > Date.now());
        assert.deepStrictEqual(call.payload.item.fields.map((x) => x.name), ["Gmail", "Password", "Hash"]);
        assert.strictEqual(call.payload.product.message, stock.DEFAULT_MESSAGE);
        const [h] = stock.listDeliveries({ productId: nitro.id });
        assert.strictEqual(h.id, r.deliveryId);
        assert.strictEqual(h.status, "delivered");
        assert.strictEqual(h.buyerTag, "user338", "looked up by the panel's bot");
        assert.strictEqual(h.staffTag, "arnto");
        assert.ok(h.content.includes("@x.com"));
        assert.ok(Math.abs(h.expiresAt - (Date.now() + 30 * 86_400_000)) < 5000);
        assert.strictEqual(stock.getProduct(nitro.id).counts.delivered, 1);
    });

    await test("deliver: DM blocked → back to stock, no history", async () => {
        bus.answer = () => ({ delivered: false, reason: "dm_blocked" });
        const before = stock.getProduct(nitro.id).counts;
        const r = await stock.deliver({ product: nitro.id, buyerId: BUYER });
        assert.deepStrictEqual([r.delivered, r.reason], [false, "dm_blocked"]);
        assert.deepStrictEqual(stock.getProduct(nitro.id).counts, before);
        assert.strictEqual(stock.listDeliveries({ productId: nitro.id }).length, 1);
    });

    await test("deliver: the assistant's error → back to stock", async () => {
        bus.answer = () => {
            throw Object.assign(new Error("boom"), { status: 502 });
        };
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 502);
        assert.strictEqual(stock.getProduct(nitro.id).counts.reserved, 0);
    });

    await test("deliver: refused when it cannot happen", async () => {
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: "123" }), 400);
        await rejects(() => stock.deliver({ product: "nope", buyerId: BUYER }), 404);
        bus.handler = null;
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 503);
        bus.handler = "assistant";
        bus.ready = false;
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 503);
        bus.ready = true;
        stock.updateProduct(acc.id, { enabled: false });
        await rejects(() => stock.deliver({ product: acc.id, buyerId: BUYER }), 409);
        stock.updateProduct(acc.id, { enabled: true });
        const empty = stock.createProduct({ name: "Trống", code: "empty" });
        await rejects(() => stock.deliver({ product: empty.id, buyerId: BUYER }), 409);
        const cat = Object.fromEntries(stock.catalog().map((p) => [p.code, p.available]));
        assert.deepStrictEqual(Object.keys(cat).sort(), ["acc", "empty", "nitro-1m"]);
        assert.strictEqual(cat.empty, 0);
        stock.updateProduct(empty.id, { enabled: false });
        assert.ok(!stock.catalog().some((p) => p.code === "empty"), "a disabled type is not offered in /giao");
    });

    await test("settle: a lost answer is read back from the outbox", async () => {
        const timeout = () => {
            throw Object.assign(new Error("no answer"), { status: 504 });
        };
        bus.answer = timeout;
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 504);
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 504);
        await rejects(() => stock.deliver({ product: nitro.id, buyerId: BUYER }), 504);
        const pending = raw().prepare("SELECT id, bus_id FROM stock_deliveries WHERE status = 'pending' ORDER BY created_at").all();
        assert.strictEqual(pending.length, 3);
        assert.strictEqual(stock.getProduct(nitro.id).counts.reserved, 3);
        assert.ok(pending.every((p) => p.bus_id), "the outbox id is kept as soon as it is queued");

        bus.rows.set(pending[0].bus_id, { status: "done", result: { delivered: true, messageId: "late" } });
        bus.rows.set(pending[1].bus_id, { status: "failed" });
        stock.settle();
        const left = raw().prepare("SELECT id FROM stock_deliveries WHERE status = 'pending'").pluck().all();
        assert.deepStrictEqual(left, [pending[2].id], "still within its deadline");
        assert.strictEqual(raw().prepare("SELECT status FROM stock_deliveries WHERE id = ?").pluck().get(pending[0].id), "delivered");

        // Past the deadline but posted: the assistant may have DM'd it — wait for its answer.
        raw().prepare("UPDATE stock_deliveries SET deadline = ? WHERE id = ?").run(Date.now() - 11 * 60_000, pending[2].id);
        bus.rows.set(pending[2].bus_id, { status: "sent" });
        stock.settle();
        assert.strictEqual(stock.getProduct(nitro.id).counts.reserved, 1);

        // Never posted (still queued, or no outbox row at all): released once the deadline is long gone.
        bus.rows.set(pending[2].bus_id, { status: "queued" });
        stock.settle();
        assert.strictEqual(raw().prepare("SELECT COUNT(*) FROM stock_deliveries WHERE status = 'pending'").pluck().get(), 0);
        assert.strictEqual(stock.getProduct(nitro.id).counts.reserved, 0);
    });

    await test("reminders: each milestone once, then expired once", async () => {
        const [d] = stock.listDeliveries({ productId: nitro.id }).filter((x) => x.status === "delivered");
        const at = (ms) => raw().prepare("UPDATE stock_deliveries SET expires_at = ?, warned = '[]', expired_sent = 0 WHERE id = ?").run(Date.now() + ms, d.id);
        raw().prepare("UPDATE stock_deliveries SET expires_at = NULL WHERE id != ?").run(d.id);

        sent.length = 0;
        await stock.checkExpiry();
        assert.strictEqual(sent.length, 0, "30 days left: nothing yet");

        at(30 * 3_600_000);
        await stock.checkExpiry();
        await stock.checkExpiry();
        assert.deepStrictEqual(sent.map((s) => s.kind), ["warn"]);
        assert.strictEqual(sent[0].hoursLeft, 30);
        assert.strictEqual(sent[0].delivery.buyerId, BUYER);
        assert.strictEqual(sent[0].delivery.content, null, "never the item in a reminder");

        raw().prepare("UPDATE stock_deliveries SET expires_at = ? WHERE id = ?").run(Date.now() + 10 * 3_600_000, d.id);
        await stock.checkExpiry();
        assert.deepStrictEqual(sent.map((s) => s.kind), ["warn", "warn"]);

        raw().prepare("UPDATE stock_deliveries SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, d.id);
        await stock.checkExpiry();
        await stock.checkExpiry();
        assert.deepStrictEqual(sent.map((s) => s.kind), ["warn", "warn", "expired"]);

        // Renewed: a fresh expiry, reminders start over.
        const ext = stock.extendDelivery(d.id, 1);
        assert.ok(ext.expiresAt > Date.now() + 23 * 3_600_000);
        sent.length = 0;
        await stock.checkExpiry();
        assert.strictEqual(sent.length, 0, "1 day after renewal: the 72/47/24 h milestones are already behind");

        stock.setDeliveryReminders(d.id, false);
        raw().prepare("UPDATE stock_deliveries SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, d.id);
        await stock.checkExpiry();
        assert.strictEqual(sent.length, 0, "switched off for this delivery");
        stock.setDeliveryReminders(d.id, true);
        stock.updateProduct(nitro.id, { reminders: { enabled: false } });
        await stock.checkExpiry();
        assert.strictEqual(sent.length, 0, "switched off for the product type");
    });

    await test("a short product does not warn right after delivery", async () => {
        const day = stock.createProduct({ name: "1 ngày", code: "day", reminders: { enabled: true, days: 1 } });
        stock.addItems(day.id, { text: "k1" });
        bus.answer = () => ({ delivered: true });
        await stock.deliver({ product: day.id, buyerId: BUYER });
        sent.length = 0;
        await stock.checkExpiry();
        assert.strictEqual(sent.length, 0);
    });

    await test("items: delete one, empty the stock; delivered stay as history", async () => {
        const items = stock.listItems(nitro.id);
        stock.deleteItem(nitro.id, items[0].id);
        await rejects(() => stock.deleteItem(nitro.id, items[0].id), 404);
        const r = stock.clearItems(nitro.id);
        assert.strictEqual(r.counts.available, 0);
        assert.ok(r.counts.delivered >= 1);
    });

    await test("delete a product type with its stock and history", async () => {
        stock.deleteProduct(nitro.id);
        await rejects(() => stock.getProduct(nitro.id), 404);
        assert.strictEqual(raw().prepare("SELECT COUNT(*) FROM stock_items WHERE product_id = ?").pluck().get(nitro.id), 0);
        assert.strictEqual(raw().prepare("SELECT COUNT(*) FROM stock_deliveries WHERE product_id = ?").pluck().get(nitro.id), 0);
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
