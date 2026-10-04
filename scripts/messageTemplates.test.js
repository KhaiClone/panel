#!/usr/bin/env node
/**
 * Checks for the bots' template runtime (bot-lib/MessageTemplates.js).
 * Run:  node scripts/messageTemplates.test.js
 *
 * What matters: an admin's change on the Embeds page shows up in the bot, and a
 * broken one can never stop a message — it falls back to the default.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const MessageTemplates = require("../bot-lib/MessageTemplates");

let passed = 0;
const tests = [];
const ok = (label, fn) => tests.push([label, fn]);

// A throwaway project with one template file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-"));
fs.mkdirSync(path.join(dir, "templates"));
fs.writeFileSync(
    path.join(dir, "templates", "a.js"),
    `module.exports = {
        types: { order: { label: "Đơn", fields: { orderId: { example: "arnto_1" }, price: { type: "money" } } } },
        globals: { shop: { type: "string", label: "Shop", value: () => "ArnTo" } },
        templates: {
            "t.order": {
                group: "G", label: "Order", vars: { order: "order", buyer: "user" },
                slots: { done: { emoji: "✅", style: "Success" }, link: { label: "Xem" } },
                message: { content: "{buyer.mention}", embeds: [{ title: "Đơn {order.orderId} — {shop}", description: "{order.price|money}" }], components: [[{ slot: "done" }, { slot: "link" }]] },
                selects: { pick: { placeholder: "Chọn", label: "{order.orderId}", options: { other: { label: "Khác", emoji: "🛒" } } } },
            },
            "t.card": {
                kind: "card", group: "G", label: "Card", refreshable: true, vars: { cart: "string" }, color: "#112233",
                texts: { header: "## Giỏ {cart}", empty: "Trống" }, buttons: { pay: { label: "Trả {cart}", emoji: "💳", style: "Success" } },
            },
        },
    };`,
);
const prevCwd = process.cwd();
process.chdir(dir);

const store = new Map();
const client = {
    db: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) },
    guilds: { cache: new Map([["G", { id: "G", name: "Guild", iconURL: () => "https://cdn/g.png", memberCount: 3 }]]) },
    user: { id: "999", tag: "Bot", username: "Bot", displayAvatarURL: () => "https://cdn/b.png" },
    channels: { fetch: async () => null },
};
const ui = new MessageTemplates(client, { guildId: "G", invite: "inv" });
const vars = { order: { orderId: "arnto_7", price: 150000 }, buyer: ui.user({ id: "111", tag: "khach", username: "khach", displayAvatarURL: () => "x" }) };
const buttons = { done: { customId: "done:7" }, link: { url: "https://discord.com/x" } };

ok("catalog: templates, types, the bot's own globals", () => {
    const cat = ui.catalog();
    assert.deepStrictEqual(Object.keys(cat.templates), ["t.order", "t.card"]);
    assert.strictEqual(cat.templates["t.card"].kind, "card");
    assert.strictEqual(cat.templates["t.card"].refreshable, true);
    assert.deepStrictEqual(cat.globals, { shop: { type: "string", label: "Shop" } });
    assert(cat.types.order);
});

ok("message: default render with globals, slots and flags", () => {
    const m = ui.message("t.order", vars, { buttons, ephemeral: true });
    assert.strictEqual(m.content, "<@111>");
    assert.strictEqual(m.embeds[0].title, "Đơn arnto_7 — ArnTo");
    assert.strictEqual(m.embeds[0].description, "150.000đ");
    assert.deepStrictEqual(m.components[0].components.map((b) => b.custom_id || b.url), ["done:7", "https://discord.com/x"]);
    assert.strictEqual(m.flags, 64);
});

ok("message: the panel's version wins; a broken or unsendable one falls back", () => {
    ui.overrides["t.order"] = { content: "Mới {order.orderId}", embeds: [], components: [[{ slot: "link", label: "Link mới" }]] };
    let m = ui.message("t.order", vars, { buttons });
    assert.strictEqual(m.content, "Mới arnto_7");
    assert.deepStrictEqual(m.embeds, []);
    assert.deepStrictEqual(
        m.components.map((r) => r.components.map((b) => b.label || b.emoji?.name)),
        [["Link mới"], ["✅"]],
        "the done slot was not placed by the override, so it is appended",
    );
    ui.overrides["t.order"] = { content: "{#if order}" };
    m = ui.message("t.order", vars, { buttons });
    assert.strictEqual(m.embeds[0].title, "Đơn arnto_7 — ArnTo");
    ui.overrides["t.order"] = { content: "x".repeat(2500) };
    m = ui.message("t.order", vars, { buttons });
    assert.strictEqual(m.content, "<@111>");
    delete ui.overrides["t.order"];
});

ok("message: edit clears what the new render does not have", () => {
    ui.overrides["t.order"] = { embeds: [{ title: "Chỉ embed" }] };
    const m = ui.message("t.order", vars, { edit: true });
    assert.strictEqual(m.content, "");
    delete ui.overrides["t.order"];
});

ok("select texts and fixed options, overridable per value", () => {
    let sel = ui.select("t.order", vars);
    assert.strictEqual(sel.placeholder("pick"), "Chọn");
    assert.deepStrictEqual(sel.option("pick", { order: { orderId: "arnto_9" } }), { label: "arnto_9" });
    assert.deepStrictEqual(sel.fixed("pick"), [{ value: "other", label: "Khác", emoji: "🛒" }]);
    ui.overrides["t.order"] = { content: "x", selects: { pick: { options: { other: { label: "Không thấy" } } } } };
    sel = ui.select("t.order", vars);
    assert.deepStrictEqual(sel.fixed("pick"), [{ value: "other", label: "Không thấy", emoji: "🛒" }]);
    delete ui.overrides["t.order"];
});

ok("card: per-slot override, colour, buttons; a broken override is ignored", () => {
    let c = ui.card("t.card", { cart: 2 });
    assert.strictEqual(c.text("header"), "## Giỏ 2");
    assert.strictEqual(c.color, 0x112233);
    assert.deepStrictEqual(c.button("pay"), { label: "Trả 2", emoji: { name: "💳" }, style: "Success" });
    ui.overrides["t.card"] = { color: "#ff0000", texts: { header: "Giỏ: {cart}" } };
    c = ui.card("t.card", { cart: 3 });
    assert.strictEqual(c.text("header"), "Giỏ: 3");
    assert.strictEqual(c.text("empty"), "Trống");
    assert.strictEqual(c.color, 0xff0000);
    ui.overrides["t.card"] = { texts: { header: "{#each}" } };
    c = ui.card("t.card", { cart: 4 });
    assert.strictEqual(c.text("header"), "## Giỏ 4");
    delete ui.overrides["t.card"];
});

ok("sync: uploads the catalog, applies and keeps the panel's changes", async () => {
    ui.base = "http://panel";
    ui.key = "k";
    const calls = [];
    let answer = { version: 3, needCatalog: false, overrides: { "t.card": { texts: { empty: "Không có gì" } } }, custom: { logo: "L" } };
    global.fetch = async (url, init) => {
        calls.push([init.method, url.replace("http://panel/api/external/ui", "")]);
        const body = url.includes("?") ? answer : { ok: true };
        return { ok: true, json: async () => body };
    };
    await ui.sync();
    assert.deepStrictEqual(calls.map((c) => c.join(" ")).slice(0, 2), ["POST /catalog", "POST /posted"]);
    assert(calls[2][1].startsWith("?version=0&hash="));
    assert.strictEqual(ui.card("t.card").text("empty"), "Không có gì");
    assert.deepStrictEqual(ui.custom, { logo: "L" });
    assert.strictEqual(store.get("uiOverrides").version, 3);
    answer = { version: 3, unchanged: true };
    calls.length = 0;
    await ui.sync();
    assert.deepStrictEqual(calls.map((c) => c[0]), ["GET"], "an unchanged poll does not re-upload");
    // A fresh process starts from the saved copy.
    const again = new MessageTemplates(client, { guildId: "G" });
    await again._restored;
    assert.strictEqual(again.card("t.card").text("empty"), "Không có gì");
});

ok("posted panels: refresh edits, forgets deleted ones; adopt checks the author", async () => {
    const edits = [];
    const msgs = {
        m1: { id: "m1", channelId: "c1", guildId: "G", author: { id: "999" }, url: "u1", edit: async (p) => edits.push(["m1", p]) },
        m3: { id: "m3", channelId: "c1", guildId: "G", author: { id: "someone" }, edit: async () => {} },
    };
    client.channels.fetch = async () => ({
        messages: {
            fetch: async (id) => {
                if (msgs[id]) return msgs[id];
                throw Object.assign(new Error("Unknown Message"), { code: 10008 });
            },
        },
    });
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    ui.refreshable("t.card", async () => ({ content: "rebuilt" }));
    await ui.track("t.card", msgs.m1);
    await ui.track("t.card", { id: "m2", channelId: "c1" });
    const r = await ui.refresh(["t.card"]);
    assert.deepStrictEqual(r, { updated: 1, removed: 1, skipped: 0, failed: [] });
    assert.deepStrictEqual(edits, [["m1", { content: "rebuilt" }]]);
    assert.deepStrictEqual(ui.posted.map((p) => p.messageId), ["m1"]);
    await assert.rejects(ui.adopt({ key: "t.card", channelId: "c1", messageId: "m3" }), /not sent by this bot/);
    await assert.rejects(ui.adopt({ key: "t.order", channelId: "c1", messageId: "m1" }), /cannot be updated/);
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
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} checks passed`);
})();
