#!/usr/bin/env node
/**
 * Checks for the Discord bus envelopes (server/services/discordBus.js and
 * bot-lib/PanelBus.js): a command or a reply carrying emoji, Vietnamese or a
 * custom emoji goes into the message text as ASCII only, so Discord rewriting
 * an emoji cannot break the signature, and both sides read back the exact
 * same body. A big envelope still travels as an attached file.
 * Run:  node scripts/discordBus.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bus-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus loads it; nothing here needs bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const KEY = "test-project-key";
process.env.PANEL_API_KEY = KEY;
process.env.PANEL_API_URL = "";

const discordBus = require("../server/services/discordBus");
const PanelBus = require("../bot-lib/PanelBus");

const PANEL_BOT = "1100000000000000001";
const BOT = "1100000000000000002";
const bot = new PanelBus({ user: { id: BOT, tag: "assistant#0001" } });
bot.panelBotId = PANEL_BOT;

const ASCII = /^[\x00-\x7f]*$/;
// What Discord might do to an emoji in a message's text.
const rewrite = (s) => s.replace(/️/g, "").replace(/👍🏽/g, "👍");

const BODY = {
    channelId: "1205054570074480710",
    message: {
        content: "Chào mọi người ❤️ 👍🏽 🇻🇳 👨‍👩‍👧 <:pepe:1205054570074480799> - sale 50%",
        embeds: [{ title: "🔥 Ưu đãi", description: "✅ Còn hàng\n⚠️ Số lượng có hạn" }],
        components: [{ type: 1, components: [{ type: 2, style: 5, url: "https://example.com", label: "Mua", emoji: { name: "🛒" } }] }],
    },
    mentions: { everyone: true, roles: true, users: true },
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("a command with emoji: ASCII text, the bot verifies it and reads the same body", async () => {
    const env = { v: 1, id: "cmd-1", ts: Date.now(), kind: "cmd", cmd: "message.send", body: BODY };
    env.sig = discordBus.sign(KEY, env);
    const out = discordBus.toMessage(BOT, "message.send · cmd-1", env);
    assert.ok(!out.files, "small enough to be inline");
    const block = /```json\n([\s\S]+?)\n```/.exec(out.content)[1];
    assert.match(block, ASCII);
    const got = await bot.parse({ content: rewrite(out.content) });
    assert.ok(bot.verify(got), "signature still matches");
    assert.deepStrictEqual(bot.open(got.body), BODY);
});

test("the same command as raw JSON would not survive an emoji rewrite (why the text is ASCII)", () => {
    const env = { v: 1, id: "cmd-2", ts: Date.now(), kind: "cmd", cmd: "message.send", body: BODY };
    env.sig = discordBus.sign(KEY, env);
    const raw = JSON.parse(rewrite(JSON.stringify(env)));
    assert.ok(!bot.verify(raw));
});

test("a reply with emoji: ASCII text, the panel verifies it and reads the same result", async () => {
    const result = { messageId: "1300000000000000001", channelName: "📢・thông-báo", guildName: "ArnTo Shop 🛍️", message: BODY.message };
    const reply = { v: 1, id: "cmd-3", ts: Date.now(), kind: "reply", cmd: "message.fetch", body: { ok: true, result } };
    reply.sig = bot.sign(reply);
    const out = bot.toMessage("✅ message.fetch · cmd-3", reply);
    assert.ok(!out.files, "small enough to be inline");
    assert.match(/```json\n([\s\S]+?)\n```/.exec(out.content)[1], ASCII);
    const got = await discordBus.fromMessage({ content: rewrite(out.content) });
    assert.ok(discordBus.verify(KEY, got), "signature still matches");
    assert.deepStrictEqual(got.body.result, result);
});

test("an envelope over the inline limit once escaped goes as a file and reads back the same", async () => {
    const body = { ...BODY, message: { content: "😀".repeat(200) } }; // 400 characters, 2400 escaped
    const env = { v: 1, id: "cmd-4", ts: Date.now(), kind: "cmd", cmd: "message.send", body };
    env.sig = discordBus.sign(KEY, env);
    const out = discordBus.toMessage(BOT, "message.send · cmd-4", env);
    assert.ok(out.files?.length === 1, "attached");
    const text = out.files[0].attachment.toString("utf8");
    const got = JSON.parse(text);
    assert.ok(bot.verify(got));
    assert.deepStrictEqual(bot.open(got.body), body);
    assert.ok(out.content.length < 200);
});

(async () => {
    let failed = 0;
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`  ✓ ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`  ✗ ${t.name}\n    ${err.stack}`);
        }
    }
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nAll ${tests.length} passed`);
    process.exit(failed ? 1 : 0);
})();
