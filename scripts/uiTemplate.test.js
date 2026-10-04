#!/usr/bin/env node
/**
 * Checks for the message-template language (bot-lib/uiTemplate.js) that every
 * bot renders with and the Embeds page previews with.
 * Run:  node scripts/uiTemplate.test.js
 *
 * What matters most: a bad template must never crash a bot mid-order (parse
 * errors are reported, unknown variables stay visible instead of vanishing),
 * and a template can never drop a button the bot's code needs.
 */

const assert = require("assert");
const { execFileSync } = require("child_process");
const path = require("path");
const T = require("../bot-lib/uiTemplate");

let passed = 0;
const ok = (label, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ok   ${label}`);
    } catch (err) {
        console.error(`  FAIL ${label}\n       ${err.message}`);
        process.exitCode = 1;
    }
};

const scope = {
    buyer: { id: "111", mention: "<@111>", tag: "khach", __text: "<@111>" },
    order: { orderId: "arnto_9", price: 150000, status: "pending", note: "", items: [{ name: "A", price: 1000 }, { name: "B", price: 2000 }] },
    empty: [],
    n: 3,
};

ok("variables, nested paths, unknown names left as typed", () => {
    assert.strictEqual(T.interpolate("Đơn {order.orderId} của {buyer.tag}", scope), "Đơn arnto_9 của khach");
    assert.strictEqual(T.interpolate("{buyer}", scope), "<@111>");
    assert.strictEqual(T.interpolate("{nope.x} {order.missing}|", scope), "{nope.x} |");
    assert.strictEqual(T.interpolate("{ \"json\": 1 } {Tên}", scope), '{ "json": 1 } {Tên}');
    assert.strictEqual(T.interpolate("\\{order.orderId\\}", scope), "{order.orderId}");
    assert.strictEqual(T.interpolate("{order.items.length} món", scope), "2 món");
});

ok("filters and arguments", () => {
    assert.strictEqual(T.interpolate("{order.price|money}", scope), "150.000đ");
    assert.strictEqual(T.interpolate("{order.price|vnd}", scope), (150000).toLocaleString("vi-VN", { style: "currency", currency: "VND" }));
    assert.strictEqual(T.interpolate('{order.note|default:"Không có"}', scope), "Không có");
    assert.strictEqual(T.interpolate("{buyer.tag|upper|trunc:3}", scope), "KH…");
    assert.strictEqual(T.interpolate("{order.items|map:name|join:\" + \"}", scope), "A + B");
    assert.strictEqual(T.interpolate("{n|plus:2|times:10}", scope), "50");
    assert.strictEqual(T.interpolate("{1791100800000|time:R}", scope), "<t:1791100800:R>");
    assert.strictEqual(T.interpolate("{buyer.id|mention}", scope), "<@111>");
    assert.throws(() => T.interpolate("{n|nope}", scope), /bộ lọc/);
});

ok("conditions", () => {
    assert.strictEqual(T.interpolate('{#if order.status == "pending"}chờ{#else}xong{/if}', scope), "chờ");
    assert.strictEqual(T.interpolate("{#if order.note}có{#elseif n > 2}lớn{#else}không{/if}", scope), "lớn");
    assert.strictEqual(T.interpolate("{#if !empty}trống{/if}{#if empty}x{/if}", scope), "trống");
    assert.strictEqual(T.interpolate("{#if order.items|length >= 2 && buyer}ok{/if}", scope), "ok");
    assert.strictEqual(T.interpolate("{#if missing || n == 3}ok{/if}", scope), "ok");
});

ok("lists", () => {
    assert.strictEqual(T.interpolate("{#each order.items}{@number}. {name} {price|money}{#if !@last}\n{/if}{/each}", scope), "1. A 1.000đ\n2. B 2.000đ");
    assert.strictEqual(T.interpolate("{#each order.items as it}{it.name}{buyer.tag};{/each}", scope), "Akhach;Bkhach;");
    assert.strictEqual(T.interpolate("{#each empty}x{#else}trống{/each}", scope), "trống");
});

ok("malformed templates are reported, not half-rendered", () => {
    assert.throws(() => T.interpolate("{#if n}x", scope), /Thiếu \{\/if\}/);
    assert.throws(() => T.interpolate("{/each}", scope), /không khớp/);
    assert.throws(() => T.interpolate("{#loop x}", scope), /không hợp lệ/);
    assert.deepStrictEqual(T.checkMessage({ content: "{#if a}", embeds: [{ title: "ok", fields: [{ name: "{#each}", value: "x" }] }] }).length, 2);
});

ok("message: embeds, if / each, colors, empty parts dropped", () => {
    const msg = T.renderMessage(
        {
            content: "{buyer}",
            embeds: [
                {
                    title: "Đơn {order.orderId}",
                    color: "#ffff00",
                    fields: [
                        { name: "Giá", value: "{order.price|money}", inline: true },
                        { name: "Ghi chú", value: "{order.note}", if: "order.note" },
                        { each: "order.items", name: "{@number}. {name}", value: "{price|money}" },
                    ],
                    thumbnail: { url: "{order.thumb}" },
                    footer: { text: "x", icon_url: "not a url" },
                    timestamp: true,
                },
                { if: "empty", title: "hidden" },
                { title: "" },
            ],
        },
        scope,
    );
    assert.strictEqual(msg.content, "<@111>");
    assert.strictEqual(msg.embeds.length, 1);
    const e = msg.embeds[0];
    assert.strictEqual(e.color, 0xffff00);
    assert.deepStrictEqual(e.fields.map((f) => f.name), ["Giá", "1. A", "2. B"]);
    assert.strictEqual(e.thumbnail, undefined);
    assert.deepStrictEqual(e.footer, { text: "x" });
    assert(e.timestamp);
    assert.deepStrictEqual(T.validateMessage(msg), []);
});

ok("buttons: template places and relabels slots, code-needed slots are never dropped", () => {
    const slots = { done: { label: "Xong", emoji: "✅", style: "Success" }, cancel: { emoji: "❌" }, status: { label: "Xem" } };
    const present = { done: { customId: "done:1" }, cancel: { customId: "cancel:1" }, status: { url: "https://discord.com/x" } };
    const rows = T.renderComponents(
        [[{ slot: "status", label: "Trạng thái {order.orderId}" }, { type: "link", label: "Hướng dẫn", url: "https://g.co" }, { type: "link", label: "bad", url: "javascript:x" }], [{ slot: "done", style: "Danger" }]],
        [scope],
        slots,
        present,
    );
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows[0].components.map((b) => b.label), ["Trạng thái arnto_9", "Hướng dẫn"]);
    assert.strictEqual(rows[0].components[0].style, 5);
    assert.deepStrictEqual(rows[1].components[0], { type: 2, style: 4, custom_id: "done:1", label: "Xong", emoji: { name: "✅" } });
    assert.deepStrictEqual(rows[2].components[0], { type: 2, style: 2, custom_id: "cancel:1", emoji: { name: "❌" } });
    const absent = T.renderComponents([[{ slot: "done" }]], [scope], slots, {});
    assert.deepStrictEqual(absent, []);
    assert.deepStrictEqual(T.parseEmoji("<a:Love:1379091872747880670>"), { animated: true, name: "Love", id: "1379091872747880670" });
});

ok("limits", () => {
    const errs = T.validateMessage({ content: "x".repeat(2001), embeds: [{ title: "t".repeat(300), fields: [{ name: "a", value: "v".repeat(1100) }] }] });
    assert.strictEqual(errs.length, 3);
    assert.deepStrictEqual(T.validateMessage({ embeds: [] }), ["Tin nhắn trống — cần nội dung hoặc ít nhất một embed"]);
});

ok("cards merge per slot", () => {
    const card = T.mergeCard({ color: "#111111", texts: { a: "A", b: "B" }, buttons: { pay: { label: "Pay", emoji: "💳" } } }, { texts: { b: "BB" }, buttons: { pay: { label: "Trả" } } });
    assert.deepStrictEqual(card.texts, { a: "A", b: "BB" });
    assert.deepStrictEqual(card.buttons.pay, { label: "Trả", emoji: "💳" });
    assert.deepStrictEqual(T.checkCard({ texts: { x: "{#if}" } }).length, 1);
});

ok("samples and variable docs from a catalog", () => {
    const types = { order: { label: "Đơn", fields: { orderId: { label: "Mã", example: "arnto_1" }, price: { type: "money", label: "Giá" } } } };
    const def = { vars: { order: "order", buyer: "user", items: "order[]", reason: { type: "string", label: "Lý do", example: "Hết hàng" } } };
    const s = T.buildSample(def, types, { logo: "https://x/logo.png" });
    assert.strictEqual(s.order.orderId, "arnto_1");
    assert.strictEqual(s.order.price, 150000);
    assert.strictEqual(s.buyer.__text, "<@1133037157527859230>");
    assert.strictEqual(s.items.length, 2);
    assert.strictEqual(s.reason, "Hết hàng");
    assert.strictEqual(s.custom.logo, "https://x/logo.png");
    assert(s.guild.name);
    const d = T.describeVars(def, types, { logo: "x" });
    assert.deepStrictEqual(d.vars.map((v) => v.path), ["order", "buyer", "items", "reason"]);
    assert.deepStrictEqual(d.vars[0].children.map((c) => c.path), ["order.orderId", "order.price"]);
    assert.deepStrictEqual(d.vars[2].children.map((c) => c.path), ["orderId", "price"]);
    assert(d.globals.find((g) => g.path === "custom").children[0].path === "custom.logo");
});

ok("the Embeds page copy is generated from this file", () => {
    execFileSync(process.execPath, [path.join(__dirname, "sync-ui-template.js"), "--check"], { stdio: "pipe" });
});

console.log(`\n${passed} checks passed`);
