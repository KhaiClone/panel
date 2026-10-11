#!/usr/bin/env node
/**
 * Checks for the Messages page (server/services/botMessages.js): a message
 * checked against Discord's limits before it goes on the bus, the ping
 * options, sending / editing / deleting over the stubbed Discord bus, a send
 * whose answer comes late (pending, then settled from the outbox), opening a
 * message by its link, and saved messages.
 * Run:  node scripts/botMessages.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "messages-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (discordBus and status() load it; nothing here needs bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => ({ name: "ArnTo-assistant" }) } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const panelLog = require("../server/services/panelLog");
const messages = require("../server/services/botMessages");

// ── Bus stub ─────────────────────────────────────────────────────────────────
const GUILD = "1103736775815471257";
const CH = "1205054570074480710";
const CH2 = "1205054570074480711";
const MSG = "1300000000000000001";
const OTHER = "1300000000000000002";
const bus = { handler: "assistant", ready: true, requests: [], answer: {}, rows: new Map(), canHandle: true };
discordBus.handlerOf = (cmd) => (cmd.startsWith("message.") ? bus.handler : null);
discordBus.canHandle = () => bus.canHandle;
discordBus.status = () => ({ ready: bus.ready });
discordBus.get = (id) => bus.rows.get(id) || null;
discordBus.request = async (target, cmd, payload, opts = {}) => {
    const busId = `bus-${bus.requests.length + 1}`;
    bus.requests.push({ target, cmd, payload, opts, busId });
    opts.onQueued?.(busId);
    const a = bus.answer[cmd];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(payload, busId) : a;
};
const logs = [];
panelLog.add = (kind, text) => logs.push({ kind, text });

const owner = { kind: "owner", username: "khai" };
const staff = { kind: "staff", staff: { userId: "871329074046435338", userTag: "nghiihgn" } };

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
const rejects = async (fn, status, re) => {
    try {
        await fn();
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        if (re) assert.match(err.message, re);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};
const where = (messageId, extra = {}) => ({ guildId: GUILD, guildName: "ArnTo Shop", channelId: CH, channelName: "thông-báo", messageId, url: `https://discord.com/channels/${GUILD}/${CH}/${messageId}`, createdAt: 1_700_000_000_000, ...extra });

(async () => {
    console.log("botMessages");

    await test("normalize: the editor's message becomes Discord's shape", async () => {
        const m = messages.normalizeMessage({
            content: "Hello @everyone",
            embeds: [
                {
                    title: "Tết",
                    color: "#9f92ff",
                    timestamp: 1_700_000_000_000,
                    author: { name: "ArnTo", icon_url: "https://cdn.example/a.png", url: "" },
                    footer: { text: "", icon_url: "" },
                    image: { url: "https://cdn.example/b.png" },
                    thumbnail: { url: "" },
                    fields: [{ name: "Giá", value: "20k", inline: true }, { name: "", value: "" }],
                },
            ],
            components: [[{ label: "Shop", url: "https://arnto.vn", emoji: "<:arnto:1246001516893175818>" }, { emoji: "🔥", url: "discord://-/channels/1/2" }]],
        });
        assert.strictEqual(m.content, "Hello @everyone");
        assert.deepStrictEqual(m.embeds[0], {
            title: "Tết",
            color: 0x9f92ff,
            timestamp: new Date(1_700_000_000_000).toISOString(),
            author: { name: "ArnTo", icon_url: "https://cdn.example/a.png" },
            image: { url: "https://cdn.example/b.png" },
            fields: [{ name: "Giá", value: "20k", inline: true }],
        });
        assert.deepStrictEqual(m.components, [
            {
                type: 1,
                components: [
                    { type: 2, style: 5, url: "https://arnto.vn", label: "Shop", emoji: { id: "1246001516893175818", name: "arnto" } },
                    { type: 2, style: 5, url: "discord://-/channels/1/2", emoji: { name: "🔥" } },
                ],
            },
        ]);
        // Discord's own shape passes through unchanged (rows as { type: 1, components }).
        assert.deepStrictEqual(messages.normalizeMessage(m), m);
    });

    await test("normalize: whatever Discord would refuse is a 400 naming the part", async () => {
        const n = (x, opts) => messages.normalizeMessage(x, opts);
        await rejects(() => n({ content: "  " }), 400, /empty/);
        await rejects(() => n({ content: "x".repeat(2001) }), 400, /2001 characters — Discord allows 2000/);
        await rejects(() => n({ embeds: [{}] }), 400, /Embed 1 is empty/);
        await rejects(() => n({ embeds: Array.from({ length: 11 }, () => ({ title: "x" })) }), 400, /11 embeds/);
        await rejects(() => n({ embeds: [{ title: "x".repeat(257) }] }), 400, /Embed 1 · title/);
        await rejects(() => n({ embeds: [{ description: "a".repeat(4000) }, { description: "b".repeat(2001) }] }), 400, /6001 characters together/);
        await rejects(() => n({ embeds: [{ title: "x", fields: [{ name: "only a name" }] }] }), 400, /field 1 needs both/);
        await rejects(() => n({ embeds: [{ title: "x", color: "red" }] }), 400, /not a colour/);
        await rejects(() => n({ embeds: [{ title: "x", url: "javascript:alert(1)" }] }), 400, /must start with/);
        await rejects(() => n({ embeds: [{ title: "x", image: { url: "not a link" } }] }), 400, /not a link/);
        await rejects(() => n({ embeds: [{ title: "x", footer: { icon_url: "https://a.b/c.png" } }] }), 400, /icon needs footer text/);
        await rejects(() => n({ embeds: [{ title: "x", timestamp: "soon" }] }), 400, /not a date/);
        await rejects(() => n({ content: "x", components: [[{ label: "Buy", custom_id: "buy" }]] }), 400, /only link buttons/);
        await rejects(() => n({ content: "x", components: [{ type: 1, components: [{ type: 3, custom_id: "menu" }] }] }), 400, /only link buttons/);
        await rejects(() => n({ content: "x", components: [[{ label: "No link" }]] }), 400, /needs a link/);
        await rejects(() => n({ content: "x", components: [[{ url: "https://a.b" }]] }), 400, /label or an emoji/);
        await rejects(() => n({ content: "x", components: Array.from({ length: 6 }, () => [{ label: "a", url: "https://a.b" }]) }), 400, /6 button rows/);
        await rejects(() => n({ content: "x", components: [Array.from({ length: 6 }, () => ({ label: "a", url: "https://a.b" }))] }), 400, /6 buttons/);
        await rejects(() => n({ content: "x", components: "buttons" }), 400, /list of rows/);
        // components: null means "keep the message's own" on an edit; a new message just has none.
        assert.strictEqual(n({ content: "x", components: null }, { edit: true }).components, null);
        assert.deepStrictEqual(n({ content: "x", components: null }).components, []);
    });

    await test("emoji, links and options", async () => {
        assert.deepStrictEqual(messages.emoji("<a:party:1246001516893175818>"), { id: "1246001516893175818", name: "party", animated: true });
        assert.deepStrictEqual(messages.emoji("apple:1246001516893175818"), { id: "1246001516893175818", name: "apple", animated: undefined }, "a name starting with 'a' is not animated");
        assert.deepStrictEqual(messages.emoji("✅"), { name: "✅" });
        assert.deepStrictEqual(messages.parseLink(`https://discord.com/channels/${GUILD}/${CH}/${MSG}`), { guildId: GUILD, channelId: CH, messageId: MSG });
        assert.deepStrictEqual(messages.parseLink(`https://ptb.discordapp.com/channels/@me/${CH}/${MSG}`), { guildId: null, channelId: CH, messageId: MSG });
        assert.deepStrictEqual(messages.parseLink(`${CH}-${MSG}`), { guildId: null, channelId: CH, messageId: MSG }, "Shift+Copy ID form");
        await rejects(() => messages.parseLink("hello"), 400);
        assert.deepStrictEqual(messages.normalizeOptions({}), { mentions: { everyone: true, roles: true, users: true }, silent: false, publish: false }, "pings allowed unless switched off");
        assert.deepStrictEqual(messages.normalizeOptions({ mentions: { everyone: false }, silent: true }).mentions, { everyone: false, roles: true, users: true });
        assert.deepStrictEqual(messages.pingsOf(`@here <@&1246001516893175818> <@!871329074046435338> <@&1246001516893175818>`), {
            everyone: false,
            here: true,
            roles: ["1246001516893175818"],
            users: ["871329074046435338"],
        });
    });

    await test("status: who posts, which commands it took", async () => {
        const s = await messages.status();
        assert.strictEqual(s.bot, "assistant");
        assert.strictEqual(s.botName, "ArnTo-assistant");
        assert.strictEqual(s.busReady, true);
        assert.deepStrictEqual(s.can, { targets: true, send: true, edit: true, remove: true, fetch: true });
    });

    await test("targets: asked once, cached for a minute, refreshed on demand", async () => {
        bus.answer["message.targets"] = { bot: { username: "ArnTo Trợ Lý" }, guilds: [{ id: GUILD, name: "ArnTo Shop", channels: [{ id: CH, name: "thông-báo" }], roles: [] }] };
        const before = bus.requests.length;
        const a = await messages.targets();
        const b = await messages.targets();
        assert.strictEqual(bus.requests.length, before + 1);
        assert.strictEqual(a.guilds[0].channels[0].name, "thông-báo");
        assert.strictEqual(b.cachedAt, a.cachedAt);
        await messages.targets({ refresh: true });
        assert.strictEqual(bus.requests.length, before + 2);
    });

    let first;
    await test("send: the bot posts it, Sent lists it, the panel log names who and the pings", async () => {
        bus.answer["message.send"] = (p) => ({ ...where(MSG, { channelId: p.channelId }), warnings: ["@Staff did not ping"], published: false });
        const t0 = Date.now();
        first = await messages.send({ channelId: CH, message: { content: "Sale @everyone <@&1246001516893175818>" }, mentions: { users: false } }, staff);
        const req = bus.requests.at(-1);
        assert.strictEqual(req.cmd, "message.send");
        assert.strictEqual(req.payload.channelId, CH);
        assert.deepStrictEqual(req.payload.mentions, { everyone: true, roles: true, users: false });
        assert.ok(req.payload.notAfter >= t0 + 9 * 60_000, "a late bot refuses it");
        assert.strictEqual(first.status, "sent");
        assert.strictEqual(first.messageId, MSG);
        assert.strictEqual(first.url, `https://discord.com/channels/${GUILD}/${CH}/${MSG}`);
        assert.deepStrictEqual(first.warnings, ["@Staff did not ping"]);
        assert.deepStrictEqual(first.sentBy, { kind: "staff", id: "871329074046435338", tag: "nghiihgn" });
        assert.strictEqual(first.channelName, "thông-báo", "name from the bot's answer");
        const log = logs.at(-1);
        assert.strictEqual(log.kind, "staff");
        assert.match(log.text, /nghiihgn.*sent a message in \*\*#thông-báo\*\* \(ArnTo Shop\) · mentions @everyone, 1 role · ⚠️ @Staff did not ping — https/);
        await rejects(() => messages.send({ channelId: "general", message: { content: "x" } }, owner), 400, /Pick a channel/);
        await rejects(() => messages.send({ channelId: CH, message: { content: "" } }, owner), 400);
    });

    await test("send: the bot's refusal fails the row; no bot or no bus is a 503", async () => {
        bus.answer["message.send"] = Object.assign(new Error("The bot cannot send messages in #rules"), { status: 502 });
        await rejects(() => messages.send({ channelId: CH2, message: { content: "x" } }, owner), 502, /cannot send/);
        const row = messages.listSent().find((r) => r.channelId === CH2);
        assert.strictEqual(row.status, "failed");
        assert.match(row.error, /cannot send/);
        bus.ready = false;
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, owner), 503, /bus is not ready/);
        bus.ready = true;
        bus.handler = null;
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, owner), 503, /update ArnTo-assistant/);
        bus.handler = "assistant";
        messages.forget(row.id);
        assert.ok(!messages.listSent().some((r) => r.id === row.id));
    });

    await test("send: a late answer leaves it pending, and it settles from the outbox", async () => {
        bus.answer["message.send"] = Object.assign(new Error("No answer from the bot within 30s"), { status: 504 });
        const err = await rejects(() => messages.send({ channelId: CH, message: { content: "late" } }, owner), 504, /listed under Sent as waiting/);
        let row = messages.listSent().find((r) => r.id === err.id);
        assert.strictEqual(row.status, "pending");
        const busId = bus.requests.at(-1).busId;
        bus.rows.set(busId, { id: busId, status: "sent" });
        assert.strictEqual(messages.listSent().find((r) => r.id === err.id).status, "pending", "still on its way");
        bus.rows.set(busId, { id: busId, status: "done", result: where("1300000000000000009") });
        row = messages.listSent().find((r) => r.id === err.id);
        assert.strictEqual(row.status, "sent");
        assert.strictEqual(row.messageId, "1300000000000000009");
        assert.strictEqual(row.guildName, "ArnTo Shop");

        bus.answer["message.send"] = Object.assign(new Error("slow"), { status: 504 });
        const err2 = await rejects(() => messages.send({ channelId: CH, message: { content: "late again" } }, owner), 504);
        const busId2 = bus.requests.at(-1).busId;
        bus.rows.set(busId2, { id: busId2, status: "failed", error: "The command reached the bot too late and was dropped" });
        const row2 = messages.listSent().find((r) => r.id === err2.id);
        assert.strictEqual(row2.status, "failed");
        assert.match(row2.error, /too late/);
    });

    await test("edit: the Sent row is updated; a message opened by its link is added", async () => {
        bus.answer["message.edit"] = (p) => ({ ...where(p.messageId), components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: "buy" }] }], warnings: [] });
        const e = await messages.edit({ channelId: CH, messageId: MSG, message: { content: "Sale ends today" }, mentions: { everyone: false } }, owner);
        assert.strictEqual(e.id, first.id, "same row");
        assert.strictEqual(e.message.content, "Sale ends today");
        assert.deepStrictEqual(e.message.components, [], "plain buttons list replaced");
        assert.deepStrictEqual(e.editedBy, { kind: "owner", id: null, tag: "khai" });
        assert.deepStrictEqual(e.sentBy, first.sentBy, "the sender stays");
        assert.strictEqual(e.options.mentions.everyone, false);
        assert.strictEqual(bus.requests.at(-1).payload.messageId, MSG);
        assert.match(logs.at(-1).text, /Owner edited a message/);

        // A message the bot posted elsewhere, whose buttons run the bot's features: kept (components: null).
        const adopted = await messages.edit({ channelId: CH, messageId: OTHER, message: { embeds: [{ title: "Bảng giá" }], components: null } }, staff);
        assert.strictEqual(bus.requests.at(-1).payload.message.components, null, "the bot is told to leave them");
        assert.notStrictEqual(adopted.id, first.id);
        assert.strictEqual(adopted.sentBy, null, "not sent from the panel");
        assert.strictEqual(adopted.sentAt, 1_700_000_000_000, "its own time");
        assert.deepStrictEqual(adopted.message.components, [{ type: 1, components: [{ type: 2, style: 1, custom_id: "buy" }] }], "what Discord now holds");
        await rejects(() => messages.edit({ channelId: CH, messageId: "x", message: { content: "x" } }, owner), 400);
    });

    await test("delete: marked deleted with who; already gone counts as deleted", async () => {
        bus.answer["message.delete"] = { deleted: true, missing: false };
        const d = await messages.remove({ channelId: CH, messageId: MSG }, staff);
        assert.strictEqual(d.deleted, true);
        assert.strictEqual(d.row.status, "deleted");
        assert.deepStrictEqual(d.row.deletedBy.id, "871329074046435338");
        bus.answer["message.delete"] = { deleted: true, missing: true };
        const gone = await messages.remove({ channelId: CH, messageId: "1300000000000000077" }, owner);
        assert.deepStrictEqual(gone, { deleted: true, missing: true, row: null });
        assert.match(logs.at(-1).text, /already gone/);
    });

    await test("fetch by link: the bot reads it; its Sent row comes along", async () => {
        bus.answer["message.fetch"] = (p) => ({ ...where(p.messageId), own: true, v2: false, keepsComponents: false, message: { content: "hi", embeds: [], components: [] } });
        const r = await messages.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/${OTHER}`);
        assert.deepStrictEqual(bus.requests.at(-1).payload, { channelId: CH, messageId: OTHER });
        assert.strictEqual(r.own, true);
        assert.strictEqual(r.sent.messageId, OTHER);
        const none = await messages.fetchByLink(`${CH}/1300000000000000555`);
        assert.strictEqual(none.sent, null);
    });

    await test("saved messages: create, update, list, delete", async () => {
        const d = messages.createDraft({ name: " Weekly ", message: { content: "x", embeds: [{}] }, options: { channelId: CH, guildId: "nope", mentions: { roles: false } } }, staff);
        assert.strictEqual(d.name, "Weekly");
        assert.deepStrictEqual(d.message, { content: "x", embeds: [{}] }, "half-done messages may be saved");
        assert.deepStrictEqual(d.options, { guildId: null, channelId: CH, mentions: { everyone: true, roles: false, users: true }, silent: false, publish: false });
        assert.strictEqual(d.createdBy.tag, "nghiihgn");
        const u = messages.updateDraft(d.id, { name: "Weekly sale" }, owner);
        assert.strictEqual(u.name, "Weekly sale");
        assert.deepStrictEqual(u.message, d.message, "untouched parts stay");
        assert.strictEqual(u.updatedBy.kind, "owner");
        assert.strictEqual(messages.listDrafts()[0].id, d.id);
        await rejects(() => messages.createDraft({ name: "", message: {} }, owner), 400);
        await rejects(() => messages.createDraft({ name: "big", message: { content: "x".repeat(70_000) } }, owner), 400, /too big/);
        await rejects(() => messages.updateDraft("nope", { name: "x" }, owner), 404);
        messages.deleteDraft(d.id);
        assert.strictEqual(messages.listDrafts().length, 0);
        await rejects(() => messages.deleteDraft(d.id), 404);
    });

    sharedStore.close?.();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
