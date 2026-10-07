#!/usr/bin/env node
/**
 * Checks for the ticket menus (server/services/ticketMenuService.js): seeding
 * from ArnTo-Shop's old menus, services and products with Discord's limits,
 * "Khác" and sellers, telling the shop to re-read, and who may use the routes.
 * Run:  node scripts/ticketMenuService.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-menu-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (the page's GET looks up the owner's name).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { findOne: async (c, q) => (q._id === "shop" ? { name: "ArnTo-Shop" } : null), find: async () => [], get: async () => null },
};

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const menus = require("../server/services/ticketMenuService");

const notified = [];
discordBus.canHandle = (botId, cmd) => botId === "shop" && cmd === "ticketmenu.refresh";
discordBus.notify = async (botId, cmd, payload) => notified.push({ botId, cmd, payload });

const KHAI = "871329074046435338";
const ARNTO = "427399742906040333";

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

// What ArnTo-Shop sends the first time it starts (functions/ticketMenu.js).
const legacy = (name, extra = {}) =>
    ["buy", "bh", "sp"].map((type) => ({ type, name, description: `${name} desc`, emoji: "🛒", sellerId: KHAI, ticketPrefixName: name.toLowerCase(), ...extra }));
const IMPORT = {
    services: [
        { key: "buy", label: "Mua Sắm", emoji: "<:Store:1349717844476166144>", ping: "{seller} mua {product}" },
        { key: "bh", label: "Bảo Hành", emoji: "<:Admin_Blink_Rifle27:1349722115879862315>", ping: "{seller} bh {product}", category: "1397481540799168522" },
        { key: "sp", label: "Tư Vấn/Hỗ Trợ", emoji: "<a:chat:1379090437608046685>", ping: "{seller} sp {product}" },
    ],
    legacyProducts: [...legacy("Nitro"), ...legacy("Deco", { sellerId: ARNTO, emoji: "not-an-emoji" }), { type: "bh", name: "Only BH", sellerId: KHAI, ticketPrefixName: "Chỉ BH 1" }],
    other: { label: "Khác", description: "Chọn nếu không thấy", emoji: "<:Dot_Blue83:1349717838142902353>", sellerId: KHAI, suffix: "other" },
    sellers: [
        { id: KHAI, name: "KhaiDev", category: "1349719715500523581" },
        { id: ARNTO, name: "ArnTo", category: "1349719466686287924" },
    ],
};

(async () => {
    console.log("ticketMenuService");

    await test("empty until the shop imports; anyone may read it then", () => {
        const m = menus.get();
        assert.deepStrictEqual([m.imported, m.owner, m.services.length, m.products.length], [false, null, 0, 0]);
        assert.ok(menus.canAccess("anyone"));
    });

    await test("import: the shop's triplets become one product in three menus", () => {
        const r = menus.importFrom("shop", IMPORT);
        assert.deepStrictEqual(r, { imported: true, services: 3, products: 3 });
        const m = menus.get();
        assert.strictEqual(m.owner, "shop");
        assert.deepStrictEqual(m.services.map((s) => [s.key, s.products]), [["buy", 2], ["bh", 3], ["sp", 2]]);
        const nitro = m.products.find((p) => p.name === "Nitro");
        assert.deepStrictEqual(nitro.services, ["buy", "bh", "sp"]);
        assert.strictEqual(nitro.suffix, "nitro");
        assert.strictEqual(m.products.find((p) => p.name === "Deco").emoji, "", "a bad emoji is dropped, not fatal");
        assert.strictEqual(m.products.find((p) => p.name === "Only BH").suffix, "chỉ-bh-1");
        assert.strictEqual(m.services[1].category, "1397481540799168522");
        assert.strictEqual(m.other.sellerId, KHAI);
        assert.strictEqual(m.sellers.length, 2);
        assert.strictEqual(notified.length, 0, "the shop made it — no refresh");
    });

    await test("import runs once; then only the owner may use the menus", () => {
        assert.deepStrictEqual(menus.importFrom("shop", IMPORT), { imported: false, services: 0, products: 0 });
        assert.strictEqual(menus.get().products.length, 3);
        assert.ok(menus.canAccess("shop"));
        assert.ok(!menus.canAccess("assistant"));
    });

    await test("services: validation, edit, order, delete keeps the products", () => {
        throws(() => menus.createService({ key: "Có dấu", label: "x" }), 400);
        throws(() => menus.createService({ key: "buy", label: "x" }), 409);
        throws(() => menus.createService({ key: "nap", label: "" }), 400);
        throws(() => menus.createService({ key: "nap", label: "Nạp", emoji: "abc" }), 400);
        throws(() => menus.createService({ key: "nap", label: "Nạp", category: "123" }), 400);
        let m = menus.createService({ key: "Nap", label: "Nạp game", emoji: "🎮" });
        const nap = m.services.find((s) => s.key === "nap");
        assert.ok(nap.ping.includes("{service}"), "a default ping");
        assert.strictEqual(nap.category, "");
        assert.strictEqual(notified.at(-1).cmd, "ticketmenu.refresh", "a page change tells the shop");

        m = menus.updateService("nap", { label: "Nạp", ping: "{seller} nạp {product}", category: "1397481540799168522", enabled: false });
        assert.deepStrictEqual(
            ["label", "ping", "category", "enabled", "emoji"].map((k) => m.services.find((s) => s.key === "nap")[k]),
            ["Nạp", "{seller} nạp {product}", "1397481540799168522", false, "🎮"],
        );
        m = menus.moveService("nap", 0);
        assert.deepStrictEqual(m.services.map((s) => s.key), ["nap", "buy", "bh", "sp"]);

        menus.createProduct({ name: "Robux", services: ["nap", "sp"] });
        m = menus.deleteService("nap");
        assert.ok(!m.services.some((s) => s.key === "nap"));
        assert.deepStrictEqual(m.products.find((p) => p.name === "Robux").services, ["sp"]);
        throws(() => menus.updateService("nap", { label: "x" }), 404);
    });

    await test("products: services must exist, channel suffix, Discord's 24 per menu", () => {
        throws(() => menus.createProduct({ name: "x", services: ["nope"] }), 404);
        throws(() => menus.createProduct({ name: "x", sellerId: "abc" }), 400);
        const p = menus.createProduct({ name: "Nitro Boost 1 Tháng", sellerId: ARNTO, services: "buy, bh" });
        assert.strictEqual(p.suffix, "nitro-boost-1-tháng");
        assert.deepStrictEqual(p.services, ["buy", "bh"]);
        const edited = menus.updateProduct(p.id, { suffix: "NB 1m!", enabled: false });
        assert.deepStrictEqual([edited.suffix, edited.enabled, edited.name], ["nb-1m", false, "Nitro Boost 1 Tháng"]);

        const shown = menus.get().services.find((s) => s.key === "sp").products;
        for (let i = shown; i < menus.LIMIT; i++) menus.createProduct({ name: `P${i}`, services: ["sp"] });
        const err = throws(() => menus.createProduct({ name: "one too many", services: ["sp"] }), 409);
        assert.ok(err.message.includes("Khác"));
        menus.createProduct({ name: "off ones do not count", services: ["sp"], enabled: false });

        const m = menus.moveProduct(p.id, 0);
        assert.strictEqual(m.products[0].id, p.id);
        menus.deleteProduct(p.id);
        throws(() => menus.deleteProduct(p.id), 404);
    });

    await test("settings: Khác and sellers", () => {
        let m = menus.updateSettings({ other: { enabled: false, suffix: "Khác Nữa" } });
        assert.deepStrictEqual([m.other.enabled, m.other.suffix, m.other.label, m.other.sellerId], [false, "khác-nữa", "Khác", KHAI]);
        throws(() => menus.updateSettings({ other: { emoji: "x" } }), 400);
        throws(() => menus.updateSettings({ sellers: [{ id: KHAI }, { id: KHAI }] }), 400);
        throws(() => menus.updateSettings({ sellers: [{ name: "no id" }] }), 400);
        m = menus.updateSettings({ sellers: [{ id: ARNTO, name: "ArnTo", category: "" }] });
        assert.deepStrictEqual(m.sellers, [{ id: ARNTO, name: "ArnTo", category: "" }]);
    });

    await test("routes: the page sees the owner's name; another project's key is refused", async () => {
        const express = require("express");
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => ((req.apiCaller = { botId: req.headers["x-bot"] }), next()));
        const routes = require("../server/routes/ticketMenus");
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
            assert.strictEqual((await call("", "GET", "/page/")).json.ownerName, "ArnTo-Shop");
            assert.strictEqual((await call("assistant", "GET", "/ext/")).status, 403);
            assert.strictEqual((await call("", "GET", "/ext/")).status, 403);
            assert.strictEqual((await call("assistant", "POST", "/ext/products", { name: "x" })).status, 403);
            assert.strictEqual((await call("shop", "GET", "/ext/")).json.owner, "shop");
            assert.strictEqual((await call("", "POST", "/page/import", {})).status, 404, "import is the shop's");

            const before = notified.length;
            const made = await call("shop", "POST", "/ext/products", { name: "From /menu", services: ["buy"] });
            assert.strictEqual(made.json.name, "From /menu");
            assert.strictEqual(notified.length, before, "the shop's own change: no refresh");
            await call("", "PUT", `/page/products/${made.json.id}`, { name: "Renamed" });
            assert.strictEqual(notified.length, before + 1);
            assert.strictEqual((await call("shop", "PUT", "/ext/services/buy", { emoji: "nope" })).status, 400);
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
