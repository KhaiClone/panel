#!/usr/bin/env node
/**
 * Checks for the Embeds page's store (server/services/uiTemplateService.js).
 * Run:  node scripts/uiTemplateService.test.js
 *
 * Uses a throwaway shared.sqlite; panel.sqlite and the Discord bus are stubbed.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = path.join(os.tmpdir(), `ui-test-${process.pid}.sqlite`);
process.env.SHARED_DB_PATH = tmp;
require.cache[require.resolve("../server/db/index.js")] = { exports: { get: async () => [{ _id: "SHOP", name: "ArnTo-Shop" }] } };
const busCalls = [];
require.cache[require.resolve("../server/services/discordBus.js")] = {
    exports: {
        canHandle: (botId, cmd) => botId === "SHOP" && cmd.startsWith("ui."),
        request: async (botId, cmd, payload) => {
            busCalls.push({ botId, cmd, payload });
            return cmd === "ui.refresh" ? { updated: 2, removed: 0, skipped: 0, failed: [] } : { adopted: true };
        },
    },
};
const ui = require("../server/services/uiTemplateService");

let passed = 0;
const tests = [];
const ok = (label, fn) => tests.push([label, fn]);

const catalog = {
    hash: "h1",
    types: { order: { fields: { orderId: { example: "arnto_1" } } } },
    globals: { shop: { type: "string" } },
    templates: {
        "shop.a": { kind: "message", group: "G", label: "A", vars: { order: "order" }, slots: { done: { emoji: "✅" } }, default: { content: "Đơn {order.orderId}" } },
        "shop.panel": { kind: "card", group: "G", label: "P", refreshable: true, vars: {}, default: { texts: { a: "x" } } },
    },
};

ok("a bot's catalog is stored; a key another bot owns is refused", () => {
    assert.deepStrictEqual(ui.saveCatalog("SHOP", catalog), { version: 0, count: 2 });
    assert.throws(() => ui.saveCatalog("AUTO", { templates: { "shop.a": { kind: "message" } } }), /another project/);
    assert.throws(() => ui.saveCatalog("AUTO", { templates: { "bad key!": { kind: "message" } } }), /Invalid template key/);
});

ok("poll: unchanged until something changes; asks for the catalog when the hash differs", () => {
    assert.deepStrictEqual(ui.forBot("SHOP", { version: 0, hash: "h1" }), { version: 0, unchanged: true });
    assert.strictEqual(ui.forBot("SHOP", { version: 0, hash: "h2" }).needCatalog, true);
    assert.strictEqual(ui.forBot("AUTO", { version: 0 }).needCatalog, true);
});

ok("saving: parse errors block, sample-data limits only warn, empty messages block", () => {
    assert.throws(() => ui.setOverride("shop.a", { content: "{#if order}" }), /Thiếu/);
    assert.throws(() => ui.setOverride("shop.a", { content: "" }), /trống/);
    assert.throws(() => ui.setOverride("shop.zzz", { content: "x" }), /No template/);
    const r = ui.setOverride("shop.a", { content: "{order.orderId}" + "x".repeat(2100) });
    assert.strictEqual(r.version, 1);
    assert(r.warnings[0].includes("2000"));
    assert.deepStrictEqual(ui.check("shop.a", { content: "Mới {order.orderId}" }), { errors: [], warnings: [] });
    ui.setOverride("shop.a", { content: "Mới {order.orderId}" });
    const poll = ui.forBot("SHOP", { version: 1, hash: "h1" });
    assert.deepStrictEqual(poll.overrides, { "shop.a": { content: "Mới {order.orderId}" } });
    assert.throws(() => ui.setOverride("shop.panel", { texts: { a: "{/if}" } }), /không khớp/);
    ui.setOverride("shop.panel", { texts: { a: "y" } });
    assert.strictEqual(ui.resetOverride("shop.panel").version, 4);
    assert.deepStrictEqual(Object.keys(ui.forBot("SHOP", { version: 0, hash: "h1" }).overrides), ["shop.a"]);
});

ok("custom variables: names checked, given to every bot", () => {
    assert.throws(() => ui.setCustom({ "bad-name": "x" }), /Invalid variable name/);
    ui.setCustom({ logo: "https://x/logo.png", color: "#ff0000" });
    assert.deepStrictEqual(ui.forBot("SHOP", { version: 0, hash: "h1" }).custom, { logo: "https://x/logo.png", color: "#ff0000" });
});

ok("overview for the page", async () => {
    ui.savePosted("SHOP", [{ key: "shop.panel", channelId: "1", messageId: "2" }, { key: "x" }]);
    const o = await ui.overview();
    assert.strictEqual(o.projects[0].name, "ArnTo-Shop");
    assert.strictEqual(o.projects[0].canRefresh, true);
    assert.deepStrictEqual(Object.keys(o.overrides), ["shop.a"]);
    assert.deepStrictEqual(o.posted.SHOP, [{ key: "shop.panel", guildId: null, channelId: "1", messageId: "2", at: null }]);
});

ok("posted panels: refresh asks the bots; adopt parses the link and needs a refreshable template", async () => {
    const r = await ui.refreshPosted({ keys: ["shop.panel"] });
    assert.deepStrictEqual(r.results, [{ botId: "SHOP", updated: 2, removed: 0, skipped: 0, failed: [] }]);
    await assert.rejects(ui.adopt({ key: "shop.a", link: "https://discord.com/channels/1/2/3" }), /not a posted panel/);
    await assert.rejects(ui.adopt({ key: "shop.panel", link: "hello" }), /message link/);
    await ui.adopt({ key: "shop.panel", link: "https://discord.com/channels/10/20/30" });
    assert.deepStrictEqual(busCalls.at(-1), { botId: "SHOP", cmd: "ui.adopt", payload: { key: "shop.panel", guildId: "10", channelId: "20", messageId: "30" } });
});

(async () => {
    for (const [label, fn] of tests) {
        try {
            await fn();
            passed++;
            console.log(`  ok   ${label}`);
        } catch (err) {
            console.error(`  FAIL ${label}\n       ${err.message}`);
            process.exitCode = 1;
        }
    }
    // The store keeps its SQLite handle open; Windows will not delete an open file.
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        try {
            fs.rmSync(f, { force: true });
        } catch {}
    }
    console.log(`\n${passed} checks passed`);
})();
