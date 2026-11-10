#!/usr/bin/env node
/**
 * Checks for the delivery types of ArnTo-assistant's /giaotay
 * (server/services/deliveryService.js): who owns them, types with Discord's
 * limits, rules shared between types, the confirmation message that must fit
 * with its rules, telling the bot to re-read, and the routes.
 * Run:  node scripts/deliveryService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (the page's GET looks up the owner's name).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { findOne: async (c, q) => (q._id === "assistant" ? { name: "ArnTo-assistant" } : null), find: async () => [], get: async () => null },
};

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const deliveries = require("../server/services/deliveryService");

const notified = [];
discordBus.canHandle = (botId, cmd) => botId === "assistant" && cmd === "delivery.refresh";
discordBus.notify = async (botId, cmd, payload) => notified.push({ botId, cmd, payload });

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
const throws = (fn, status) => {
    try {
        fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};

(async () => {
    console.log("deliveryService");

    await test("empty at first; the first project to read owns it", () => {
        const m = deliveries.get();
        assert.deepStrictEqual([m.owner, m.types.length, m.rules.length], [null, 0, 0]);
        assert.ok(deliveries.canAccess("anyone"));
        deliveries.createRule({ text: "before the owner" });
        assert.strictEqual(notified.length, 0, "no owner yet — nobody to tell");
        assert.strictEqual(deliveries.readFor("assistant").owner, "assistant");
        assert.strictEqual(deliveries.readFor("shop").owner, "assistant", "a later reader does not take it");
        assert.ok(deliveries.canAccess("assistant"));
        assert.ok(!deliveries.canAccess("shop"));
        assert.strictEqual(notified.length, 0, "the bot's own read is no change");
    });

    let r1, r2;
    await test("rules: text required, name from the text, edit, move", () => {
        throws(() => deliveries.createRule({ name: "x", text: "  " }), 400);
        throws(() => deliveries.createRule({ text: "x".repeat(1001) }), 400);
        r1 = deliveries.createRule({ text: "- Không hoàn tiền sau khi nhận hàng" });
        assert.match(r1.id, /^[0-9a-f]{8}$/);
        assert.strictEqual(r1.name, "- Không hoàn tiền sau khi nhận hàng", "the name defaults to the text");
        r2 = deliveries.createRule({ name: "Mật khẩu", text: "- Đổi mật khẩu ngay" });
        assert.strictEqual(notified.at(-1).cmd, "delivery.refresh", "a page change tells the bot");
        assert.strictEqual(deliveries.updateRule(r2.id, { text: "- Đổi mật khẩu ngay sau khi nhận" }).name, "Mật khẩu", "the name stays");
        throws(() => deliveries.updateRule("nope", { text: "x" }), 404);
        assert.strictEqual(deliveries.moveRule(r2.id, 0).rules[0].id, r2.id);
    });

    await test("types: validation, defaults, limits", () => {
        throws(() => deliveries.createType({ key: "Có dấu", name: "x" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", keepDays: 0 }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", keepDays: 91 }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", keepDays: 2.5 }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", pledgeEmoji: "abc" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", goodsImage: "ftp://x/y.gif" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", blockedImage: "not a link" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", rules: ["nope"] }), 404);
        throws(() => deliveries.createType({ key: "t", name: "T", fields: Array.from({ length: 11 }, (_, i) => `f${i}`) }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", confirm: true, pledgeText: "" }), 400);
        throws(() => deliveries.createType({ key: "t", name: "T", goodsText: "x".repeat(2301) }), 400);

        const made = deliveries.createType({ key: "NB2M", name: "Nitro Boost 2m", fields: "Gmail| Password |Hash", rules: [r1.id, r2.id, r1.id] });
        assert.strictEqual(made.key, "nb2m");
        assert.deepStrictEqual([made.confirm, made.keepDays, made.enabled, made.separator, made.codeBlock], [true, 7, true, ":", true]);
        assert.deepStrictEqual(made.fields, ["Gmail", "Password", "Hash"]);
        assert.deepStrictEqual(made.rules, [r1.id, r2.id], "a rule ticked twice counts once, the order is kept");
        assert.strictEqual(made.pledgeButton, deliveries.DEFAULT_TYPE.pledgeButton);
        throws(() => deliveries.createType({ key: "nb2m", name: "again" }), 409);

        // No confirmation: no confirmation message is needed.
        const plain = deliveries.createType({ key: "promo", name: "Promo link", confirm: false, pledgeText: "", keepDays: "30", codeBlock: false, ticketNotice: "" });
        assert.deepStrictEqual([plain.confirm, plain.keepDays, plain.codeBlock, plain.ticketNotice, plain.fields], [false, 30, false, "", []]);
    });

    await test("types: an edit keeps what it does not send; move, delete", () => {
        const edited = deliveries.updateType("nb2m", { keepDays: 3, retryButton: "", fields: "", enabled: false });
        assert.deepStrictEqual([edited.keepDays, edited.enabled, edited.fields, edited.name], [3, false, [], "Nitro Boost 2m"]);
        assert.strictEqual(edited.retryButton, deliveries.DEFAULT_TYPE.retryButton, "an emptied button gets its default label");
        assert.deepStrictEqual(edited.rules, [r1.id, r2.id]);
        throws(() => deliveries.updateType("nope", { name: "x" }), 404);
        throws(() => deliveries.updateType("promo", { confirm: true }), 400, "turning the confirmation on needs its message");
        assert.deepStrictEqual(deliveries.moveType("promo", 0).types.map((t) => t.key), ["promo", "nb2m"]);
    });

    await test("the confirmation message must fit an embed with its rules — on the type and on a rule made longer", () => {
        const room = deliveries.EMBED_TEXT - 60;
        throws(() => deliveries.updateType("nb2m", { pledgeText: "x".repeat(room), rules: [r1.id, r2.id] }), 400);
        // Fits with one short rule…
        deliveries.updateType("nb2m", { pledgeText: `${"x".repeat(room - 40)}{rules}`, rules: [r2.id] });
        // …but not once that rule grows.
        const err = throws(() => deliveries.updateRule(r2.id, { text: "y".repeat(500) }), 400);
        assert.match(err.message, /Nitro Boost 2m/);
        assert.strictEqual(deliveries.get().rules.find((r) => r.id === r2.id).text, "- Đổi mật khẩu ngay sau khi nhận", "the refused edit changed nothing");
        deliveries.updateType("nb2m", { pledgeText: "Đọc kỹ:\n{rules}", rules: [r1.id, r2.id] });
    });

    await test("deleting a rule takes it off every type", () => {
        const m = deliveries.deleteRule(r1.id);
        assert.deepStrictEqual(m.types.find((t) => t.key === "nb2m").rules, [r2.id]);
        assert.ok(!m.rules.some((r) => r.id === r1.id));
        throws(() => deliveries.deleteRule(r1.id), 404);
    });

    await test("routes: the page sees the owner's name; another key is refused; the bot only reads", async () => {
        const express = require("express");
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.apiCaller = { botId: req.headers["x-bot"] };
            req.auth = { kind: "owner" };
            next();
        });
        const routes = require("../server/routes/deliveries");
        app.use("/page", routes.panel);
        app.use("/ext", routes.external);
        const server = app.listen(0);
        const base = `http://127.0.0.1:${server.address().port}`;
        const call = (bot, method, url, body) =>
            new Promise((resolve, reject) => {
                const req = http.request(base + url, { method, agent: false, headers: { "x-bot": bot, "content-type": "application/json" } }, (res) => {
                    let data = "";
                    res.on("data", (c) => (data += c));
                    res.on("end", () => resolve({ status: res.statusCode, json: data.startsWith("{") ? JSON.parse(data) : null }));
                });
                req.on("error", reject);
                req.end(body && JSON.stringify(body));
            });
        try {
            assert.strictEqual((await call("", "GET", "/page/")).json.ownerName, "ArnTo-assistant");
            assert.strictEqual((await call("shop", "GET", "/ext/")).status, 403);
            assert.strictEqual((await call("", "GET", "/ext/")).status, 403);
            const read = await call("assistant", "GET", "/ext/");
            assert.deepStrictEqual([read.json.owner, read.json.types.length, read.json.rules.length], ["assistant", 2, 2]);
            assert.strictEqual((await call("assistant", "POST", "/ext/types", { key: "x", name: "X" })).status, 404, "the bot only reads");

            const before = notified.length;
            const rule = await call("", "POST", "/page/rules", { text: "- Luật mới" });
            assert.match(rule.json.id, /^[0-9a-f]{8}$/);
            const made = await call("", "POST", "/page/types", { key: "gift", name: "Gift", rules: [rule.json.id] });
            assert.strictEqual(made.json.key, "gift");
            assert.strictEqual(notified.length, before + 2);
            assert.strictEqual((await call("", "PUT", "/page/types/gift", { retryEmoji: "nope" })).status, 400);
            assert.strictEqual((await call("", "POST", "/page/types/gift/move", { position: 0 })).json.types[0].key, "gift");
            assert.strictEqual((await call("", "PUT", `/page/rules/${rule.json.id}`, { name: "Mới" })).json.name, "Mới");
            assert.strictEqual((await call("", "POST", `/page/rules/${rule.json.id}/move`, { position: 0 })).json.rules[0].id, rule.json.id);
            assert.strictEqual((await call("", "DELETE", `/page/rules/${rule.json.id}`)).json.types[0].rules.length, 0);
            assert.strictEqual((await call("", "DELETE", "/page/types/gift")).status, 200);
        } finally {
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
        }
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
