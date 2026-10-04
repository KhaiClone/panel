#!/usr/bin/env node
/**
 * Checks for the panel's own message templates (server/services/panelTemplates.js,
 * server/templates/panel.js) and the senders that use them (discordService, backup).
 * Run:  node scripts/panelTemplates.test.js
 *
 * Uses a throwaway shared.sqlite; panel.sqlite, axios and the Discord bus are stubbed.
 * The "legacy" builders below are the hand-written messages these templates replaced:
 * the defaults must render the same thing.
 */

const assert = require("assert");
const os = require("os");
const path = require("path");

const tmp = path.join(os.tmpdir(), `panel-ui-test-${process.pid}.sqlite`);
process.env.SHARED_DB_PATH = tmp;
require.cache[require.resolve("../server/db/index.js")] = { exports: { get: async () => [] } };
const busCalls = [];
require.cache[require.resolve("../server/services/discordBus.js")] = {
    exports: {
        canHandle: () => false,
        handlerOf: (cmd) => (cmd === "dm.send" ? "AUTO" : null),
        notify: async (botId, cmd, body) => busCalls.push({ botId, cmd, body }),
    },
};
const posts = [];
require.cache[require.resolve("axios")] = { exports: { post: async (url, body) => posts.push({ url, body }) } };

const ui = require("../server/services/uiTemplateService");
const pt = require("../server/services/panelTemplates");
const discord = require("../server/services/discordService");
const archive = require("../server/services/backupArchive");

let passed = 0;
const tests = [];
const ok = (label, fn) => tests.push([label, fn]);

const BOT = { _id: "b1", name: "MusicBot", botID: "1234567890123456789", buyerID: "871329074046435338", expiresAt: 1790000000000 };
const strip = (msg) => JSON.parse(JSON.stringify(msg, (k, v) => (k === "timestamp" ? "T" : v)));
const legacyWarning = (bot, hoursLeft) => ({
    title: "⚠️ Bot Expiry Warning",
    color: hoursLeft <= 24 ? 0xff4444 : hoursLeft <= 72 ? 0xff8c00 : 0xffd700,
    description: "**Bot is expiring soon!**",
    fields: [
        { name: "🤖 Bot Name", value: bot.name, inline: true },
        { name: "🆔 Bot ID", value: `\`${bot.botID}\``, inline: true },
        { name: "⏳ Time Left", value: `**${hoursLeft}** hour(s)`, inline: true },
        { name: "📅 Expires At", value: `<t:${Math.floor(bot.expiresAt / 1000)}:F>`, inline: true },
        { name: "🔗 Extend This Bot", value: "<#1480431381808152586> or create ticket at <#1246028759597846650> for a support.", inline: false },
    ],
    timestamp: "T",
});
const sameEmbed = (got, want) => {
    const g = strip(got);
    for (const k of Object.keys(want)) assert.deepStrictEqual(g[k], want[k], `embed.${k}`);
};

ok("the catalog is listed on the Embeds page as the panel's own project", async () => {
    pt.register();
    const o = await ui.overview();
    const p = o.projects.find((x) => x.botId === "__panel");
    assert(p, "panel project listed");
    assert.strictEqual(p.name, "Bot Panel (tin của panel)");
    assert.deepStrictEqual(Object.keys(p.templates).sort(), ["panel.backup.message", "panel.expiry.removed", "panel.expiry.suspended", "panel.expiry.warning", "panel.lavalink.report"]);
    assert.throws(() => ui.saveCatalog("SHOP", { templates: { "panel.expiry.warning": { kind: "message" } } }), /another project/);
});

ok("expiry warning: webhook pings the buyer, the DM does not; colours follow the hours left", async () => {
    for (const h of [12, 48, 120]) {
        posts.length = busCalls.length = 0;
        process.env.DISCORD_ALERT_WEBHOOK = "https://hook";
        await discord.sendExpiryWarning(BOT, h);
        assert.strictEqual(posts[0].body.content, `<@${BOT.buyerID}>`);
        sameEmbed(posts[0].body.embeds[0], legacyWarning(BOT, h));
        assert.strictEqual(busCalls[0].cmd, "dm.send");
        assert.strictEqual(busCalls[0].body.buyerID, BOT.buyerID);
        assert.strictEqual(busCalls[0].body.content, undefined);
        sameEmbed(busCalls[0].body.embeds[0], legacyWarning(BOT, h));
    }
});

ok("suspended and removed render like before", async () => {
    posts.length = busCalls.length = 0;
    await discord.sendExpirySuspended(BOT);
    await discord.sendExpiryRemoval(BOT);
    const [sus, rem] = posts.map((p) => p.body);
    assert.strictEqual(sus.content, `<@${BOT.buyerID}>`);
    sameEmbed(sus.embeds[0], {
        title: "🛑 Bot Expired & Suspended",
        color: 0xff0000,
        description: "**Your bot has expired and has been stopped.** Please extend the expiry within 7 days to avoid permanent deletion.",
        fields: legacyWarning(BOT, 1).fields.filter((f) => f.name !== "⏳ Time Left").map((f) => (f.name === "📅 Expires At" ? { ...f, name: "📅 Expired At" } : f)),
    });
    assert.strictEqual(rem.content, undefined);
    sameEmbed(rem.embeds[0], {
        title: "🗑️ Bot Expired & Auto-Removed",
        color: 0xff0000,
        fields: [
            { name: "🤖 Bot Name", value: BOT.name, inline: true },
            { name: "🆔 Bot ID", value: BOT.botID, inline: true },
            { name: "👤 Buyer ID", value: `\`${BOT.buyerID}\``, inline: true },
            { name: "📅 Expired At", value: `<t:${Math.floor(BOT.expiresAt / 1000)}:F>`, inline: false },
        ],
        footer: { text: "Bot folder has been deleted from the server." },
    });
});

ok("Lavalink report: the three outcomes, node lines and skipped nodes", async () => {
    process.env.DISCORD_LAVALINK_WEBHOOK = "https://lava";
    posts.length = 0;
    await discord.sendLavalinkReport({
        kind: "available",
        version: "4.1.1",
        url: "https://github.com/lavalink-devs/Lavalink/releases/tag/4.1.1",
        results: [{ nodeName: "sangs", ok: null, version: "4.0.8" }, { nodeName: "dio", ok: null }],
        skipped: [{ nodeName: "dio2", state: "offline" }],
    });
    let e = posts[0].body.embeds[0];
    assert.strictEqual(posts[0].url, "https://lava");
    assert.strictEqual(e.title, "🎵 Lavalink có bản mới");
    assert.strictEqual(e.color, 0x5865f2);
    assert.strictEqual(e.url, "https://github.com/lavalink-devs/Lavalink/releases/tag/4.1.1");
    assert.strictEqual(e.description, "Tự động cập nhật đang **tắt** — 2 node vẫn ở bản cũ. Vào trang Lavalink của panel để cập nhật tay.");
    assert.deepStrictEqual(e.fields, [
        { name: "Node", value: "• ⏳ **sangs** — đang ở `4.0.8`\n• ⏳ **dio** — đang ở `?`", inline: false },
        { name: "Bỏ qua", value: "• dio2 — `offline`", inline: false },
    ]);
    assert.strictEqual(e.footer.text, "Lavalink 4.1.1");

    posts.length = 0;
    await discord.sendLavalinkReport({
        kind: "partial",
        version: "4.1.1",
        results: [
            { nodeName: "sangs", ok: true, from: "4.0.8" },
            { nodeName: "dio", ok: true, from: "4.0.8", started: false },
            { nodeName: "dio2", ok: false, from: "4.0.8", rolledBack: true, error: "boom ".repeat(60) },
        ],
    });
    e = posts[0].body.embeds[0];
    assert.strictEqual(e.title, "⚠️ Lavalink cập nhật chưa trọn vẹn");
    assert.strictEqual(e.color, 0xff8c00);
    assert.strictEqual(e.url, undefined);
    assert.strictEqual(e.description, "2/3 node lên được **4.1.1**. Node lỗi đã được rollback về bản cũ và vẫn đang chạy.");
    assert.strictEqual(e.fields.length, 1);
    assert.strictEqual(
        e.fields[0].value,
        `• ✅ **sangs** — \`4.0.8\` → \`4.1.1\`\n• ✅ **dio** — \`4.0.8\` → \`4.1.1\` _(vẫn đang tắt)_\n• ❌ **dio2** — đã rollback về bản cũ: ${"boom ".repeat(60).slice(0, 180).trimEnd()}`,
    );

    posts.length = 0;
    await discord.sendLavalinkReport({ kind: "updated", version: "4.1.1", results: [{ nodeName: "sangs", ok: true, from: "4.0.8" }] });
    e = posts[0].body.embeds[0];
    assert.strictEqual(e.title, "🎵 Lavalink đã cập nhật");
    assert.strictEqual(e.color, 0x57f287);
    assert.strictEqual(e.description, "Đã cập nhật 1 node lên **4.1.1** và restart xong.");
});

ok("backup message: same words as backupArchive's describe()", () => {
    const summary = { ts: "20261004-130000", dbs: { panel: { size: 13000000, gz: 3200000, chunks: 1, hash8: "a1b2c3d4" }, shared: { size: 5000000, gz: 900000, chunks: 1, hash8: "e5f6a7b8" } }, env: true };
    const vars = {
        ts: archive.readableTs(summary.ts),
        dbs: Object.entries(summary.dbs).map(([kind, d]) => ({ kind, size: archive.fmtSize(d.size), gz: archive.fmtSize(d.gz), chunks: d.chunks, hash8: d.hash8 })),
        env: true,
    };
    const want = [
        `Backup • ${archive.readableTs(summary.ts)}`,
        `panel.sqlite ${archive.fmtSize(13000000)} → ${archive.fmtSize(3200000)} (1 mảnh) · SHA-256 a1b2c3d4…`,
        `shared.sqlite ${archive.fmtSize(5000000)} → ${archive.fmtSize(900000)} (1 mảnh) · SHA-256 e5f6a7b8…`,
        "+ .env",
        "Rollback: Copy Message Link → Panel Settings → Backup & Rollback",
    ].join("\n");
    assert.strictEqual(pt.message("panel.backup.message", vars).content, want);
    assert.match(pt.message("panel.backup.message", { ...vars, env: false }).content, /\(không có \.env\)/);
});

ok("an admin version is used; one that cannot be sent falls back to the default", async () => {
    ui.setOverride("panel.expiry.removed", { content: "Bot {customerBot.name} đã bị xoá {custom.tag}", embeds: [] });
    ui.setCustom({ tag: "🗑️" });
    assert.deepStrictEqual(pt.message("panel.expiry.removed", { customerBot: { name: "MusicBot" }, where: "dm" }), { content: "Bot MusicBot đã bị xoá 🗑️", embeds: [] });
    // Over Discord's 2000 characters with real data → the default.
    ui.setOverride("panel.expiry.removed", { content: "{customerBot.name}" + "x".repeat(1995) });
    const long = pt.message("panel.expiry.removed", { customerBot: BOT, where: "dm" });
    assert.strictEqual(long.embeds[0].title, "🗑️ Bot Expired & Auto-Removed");
    ui.resetOverride("panel.expiry.removed");
});

(async () => {
    for (const [label, fn] of tests) {
        try {
            await fn();
            passed++;
        } catch (e) {
            console.error(`✗ ${label}\n  ${e.stack}`);
            process.exitCode = 1;
        }
    }
    try {
        require("../server/services/sharedStore").raw().close();
        require("fs").rmSync(tmp, { force: true });
    } catch {
        // Windows keeps the file open until exit.
    }
    console.log(`${passed}/${tests.length} checks passed`);
})();
