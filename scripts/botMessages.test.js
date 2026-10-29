#!/usr/bin/env node
/**
 * Checks for the Messages page (server/services/botMessages.js): a message
 * checked against Discord's limits before it goes on the bus, the ping
 * options, the server map (loaded once a day or with Reload, never on a page
 * open) and Discord's permission formula, sending / editing / deleting over the stubbed Discord bus, a send
 * whose answer comes late (pending, then settled from the outbox), opening a
 * message by its link, saved messages, and staff kept to the shop server's
 * channels their own Discord account can see and post in.
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
const supporter = { kind: "staff", staff: { userId: "1133037157527859230", userTag: "hotro" } };
const admin = { kind: "staff", staff: { userId: "1246001516893175877", userTag: "quanly" } };
const noRoles = { kind: "staff", staff: { userId: "427399742906040333", userTag: "never-checked" } };

// The server map the assistant answers to message.targets (format 2: with permissions).
const BOT = { username: "ArnTo Trợ Lý" };
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const ADMIN = 1n << 3n;
const str = (n) => String(n);
const R_STAFF = "1134354122867482716";
const R_SUPPORTER = "1557669714505769030";
const R_ADMIN = "1246001516893175900";
const CH3 = "1205054570074480712";
const CH4 = "1205054570074480713";
const CH5 = "1205054570074480714";
const SHOP = {
    id: GUILD,
    name: "ArnTo Shop",
    ownerId: "999999999999999999",
    everyone: str(VIEW | SEND),
    roles: [
        { id: R_ADMIN, name: "Admin", color: 0, mentionable: false, permissions: str(ADMIN) },
        { id: R_STAFF, name: "Staff", color: 0xe67e22, mentionable: true, permissions: "0" },
        { id: R_SUPPORTER, name: "Supporter", color: 0x3498db, mentionable: false, permissions: "0" },
    ],
    channels: [
        // read-only for @everyone, Staff may post
        { id: CH, name: "thông-báo", overwrites: [{ id: GUILD, type: 0, allow: "0", deny: str(SEND) }, { id: R_STAFF, type: 0, allow: str(SEND), deny: "0" }] },
        // hidden, Supporter sees it
        { id: CH2, name: "staff-room", overwrites: [{ id: GUILD, type: 0, allow: "0", deny: str(VIEW) }, { id: R_SUPPORTER, type: 0, allow: str(VIEW), deny: "0" }] },
        // read-only for everybody
        { id: CH3, name: "rules", overwrites: [{ id: GUILD, type: 0, allow: "0", deny: str(SEND) }] },
        { id: CH4, name: "chat", overwrites: [] },
        // this one member is shut out
        { id: CH5, name: "events", overwrites: [{ id: "871329074046435338", type: 1, allow: "0", deny: str(VIEW) }] },
    ],
};
const KHO = { id: "1183033659838697542", name: "Kho", ownerId: "999999999999999999", everyone: str(VIEW | SEND), bus: true, roles: [], channels: [{ id: "1300000000000000101", name: "log", overwrites: [] }] };
const targetsAnswer = () => ({ format: 2, bot: BOT, guilds: [SHOP, KHO] });

// Their roles as staffService last read them from Discord (null = never checked).
const ROLES = new Map([
    ["871329074046435338", [R_STAFF]],
    ["1133037157527859230", [R_SUPPORTER]],
    ["1246001516893175877", [R_ADMIN]],
]);
require("../server/services/staffService").rolesOf = (id) => (ROLES.has(id) ? { roles: ROLES.get(id), at: Date.now() } : null);
const kv = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));
const kvGet = (name) => JSON.parse(sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name)?.value || "null");
const ids = (t) => t.guilds.flatMap((g) => g.channels.map((c) => c.id));

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
        assert.deepStrictEqual(s.can, { targets: true, send: true, edit: true, remove: true, fetch: true, images: true });
    });

    await test("map: loaded from the bot once a day — opening the page never asks it", async () => {
        bus.answer["message.targets"] = targetsAnswer;
        const empty = await messages.targets({ auth: owner });
        assert.deepStrictEqual(empty.guilds, []);
        assert.strictEqual(empty.loadedAt, null);
        assert.strictEqual((await messages.targets({ auth: staff })).viewer.reason, "no_map");
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, staff), 503, /not been loaded/);

        const before = bus.requests.length;
        await messages.dailyTick();
        assert.strictEqual(bus.requests.length, before + 1);
        assert.deepStrictEqual(bus.requests.at(-1).payload, {}, "one map for everyone");
        const a = await messages.targets({ auth: owner });
        await messages.targets({ auth: owner });
        await messages.targets({ auth: staff });
        assert.strictEqual(bus.requests.length, before + 1, "reading the page costs nothing");
        assert.deepStrictEqual(a.guilds.map((g) => g.id), [GUILD, KHO.id], "the owner gets every server");
        assert.ok(a.loadedAt > Date.now() - 5000);
        assert.ok(!("overwrites" in a.guilds[0].channels[0]) && !("permissions" in a.guilds[0].roles[0]), "permission data stays on the panel");
        await messages.dailyTick();
        assert.strictEqual(bus.requests.length, before + 1, "fresh: the daily check does nothing");

        // Reload: once every 10 minutes, counting the daily load.
        await rejects(() => messages.reload(owner), 429, /reloaded again in 10 minutes/);
        kv("__messages.mapTried", Date.now() - 11 * 60_000);
        const r = await messages.reload(staff);
        assert.strictEqual(bus.requests.length, before + 2);
        assert.ok(r.viewer.found, "answers with the caller's own view");
        await rejects(() => messages.reload(staff), 429);

        // A day later the daily check loads it again; a failed try waits an hour while the old map serves.
        const dayAgo = () => {
            kv("__messages.map", { ...kvGet("__messages.map"), at: Date.now() - 25 * 3600_000 });
            kv("__messages.mapTried", Date.now() - 25 * 3600_000 - 1000);
        };
        dayAgo();
        await messages.dailyTick();
        assert.strictEqual(bus.requests.length, before + 3);
        dayAgo();
        bus.answer["message.targets"] = Object.assign(new Error("No answer"), { status: 504 });
        await messages.dailyTick();
        assert.strictEqual(bus.requests.length, before + 4);
        await messages.dailyTick();
        assert.strictEqual(bus.requests.length, before + 4, "no retry within the hour");
        assert.strictEqual((await messages.targets({ auth: owner })).guilds.length, 2, "the old map still serves");
        bus.answer["message.targets"] = targetsAnswer;
        kv("__messages.mapTried", Date.now() - 11 * 60_000);
        await messages.reload(owner);
    });

    await test("permissions: Discord's formula", async () => {
        const can = (p) => ({ view: (p & VIEW) === VIEW, send: (p & SEND) === SEND });
        const ch = (id) => SHOP.channels.find((c) => c.id === id);
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH), "1", [])), { view: true, send: false }, "@everyone overwrite denies sending");
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH), "1", [R_STAFF])), { view: true, send: true }, "a role overwrite allows it back");
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH2), "1", [R_STAFF])), { view: false, send: true }, "sending without seeing is not posting");
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH5), "871329074046435338", [R_STAFF])), { view: false, send: true }, "their own overwrite comes last");
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH5), "871329074046435338", [R_ADMIN])), { view: true, send: true }, "Administrator ignores overwrites");
        assert.deepStrictEqual(can(messages.permissionsIn(SHOP, ch(CH3), SHOP.ownerId, [])), { view: true, send: true }, "the owner can do everything");
        const both = { ...ch(CH4), overwrites: [{ id: R_STAFF, type: 0, allow: "0", deny: str(SEND) }, { id: R_SUPPORTER, type: 0, allow: str(SEND), deny: "0" }] };
        assert.strictEqual(can(messages.permissionsIn(SHOP, both, "1", [R_STAFF, R_SUPPORTER])).send, true, "between roles, allow wins");
    });

    await test("staff: only the shop server, only the channels their own account can see and post in", async () => {
        const t = await messages.targets({ auth: staff });
        assert.deepStrictEqual(t.guilds.map((g) => g.id), [GUILD], "not Kho");
        assert.deepStrictEqual(ids(t), [CH, CH4], "not the hidden, read-only or shut-out ones");
        assert.strictEqual(t.viewer.found, true);
        assert.deepStrictEqual(ids(await messages.targets({ auth: supporter })), [CH2, CH4, CH5], "each person their own channels");
        assert.deepStrictEqual(ids(await messages.targets({ auth: admin })), [CH, CH2, CH3, CH4, CH5], "Administrator: all of them");

        const before = bus.requests.length;
        for (const channelId of [CH2, CH3, CH5, "1300000000000000101"]) {
            await rejects(() => messages.send({ channelId, message: { content: "x" } }, staff), 403, /channels you can see and post in/);
        }
        await rejects(() => messages.edit({ channelId: CH2, messageId: OTHER, message: { content: "x" } }, staff), 403);
        await rejects(() => messages.remove({ channelId: CH2, messageId: OTHER }, staff), 403);
        await rejects(() => messages.fetchByLink(`https://discord.com/channels/${GUILD}/${CH2}/${OTHER}`, staff), 403);
        assert.strictEqual(bus.requests.length, before, "nothing reached the bot");

        // Roles never read yet (signed in before this version): told to sign in again.
        const nr = await messages.targets({ auth: noRoles });
        assert.deepStrictEqual(nr.guilds, []);
        assert.strictEqual(nr.viewer.reason, "no_roles");
        await rejects(() => messages.send({ channelId: CH4, message: { content: "x" } }, noRoles), 403, /roles/);

        // A map from an assistant without permission data: staff refused, the owner still fine.
        const map = kvGet("__messages.map");
        kv("__messages.map", { ...map, data: { ...map.data, format: 1 } });
        assert.strictEqual((await messages.targets({ auth: staff })).viewer.reason, "old_bot");
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, staff), 503, /update it/);
        assert.strictEqual((await messages.targets({ auth: owner })).guilds.length, 2);
        kv("__messages.map", map);
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
        assert.deepStrictEqual(req.payload.viewer, { userId: "871329074046435338", guildId: GUILD }, "the bot checks the channel again");
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
        assert.strictEqual(bus.requests.at(-1).payload.viewer, undefined, "the owner posts anywhere");
        const row = (await messages.listSent()).find((r) => r.channelId === CH2);
        assert.strictEqual(row.status, "failed");
        assert.match(row.error, /cannot send/);
        bus.ready = false;
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, owner), 503, /bus is not ready/);
        bus.ready = true;
        bus.handler = null;
        await rejects(() => messages.send({ channelId: CH, message: { content: "x" } }, owner), 503, /update ArnTo-assistant/);
        bus.handler = "assistant";
        await messages.forget(row.id, owner);
        assert.ok(!(await messages.listSent()).some((r) => r.id === row.id));
    });

    await test("send: a late answer leaves it pending, and it settles from the outbox", async () => {
        bus.answer["message.send"] = Object.assign(new Error("No answer from the bot within 30s"), { status: 504 });
        const err = await rejects(() => messages.send({ channelId: CH, message: { content: "late" } }, owner), 504, /listed under Sent as waiting/);
        let row = (await messages.listSent()).find((r) => r.id === err.id);
        assert.strictEqual(row.status, "pending");
        const busId = bus.requests.at(-1).busId;
        bus.rows.set(busId, { id: busId, status: "sent" });
        assert.strictEqual((await messages.listSent()).find((r) => r.id === err.id).status, "pending", "still on its way");
        bus.rows.set(busId, { id: busId, status: "done", result: where("1300000000000000009") });
        row = (await messages.listSent()).find((r) => r.id === err.id);
        assert.strictEqual(row.status, "sent");
        assert.strictEqual(row.messageId, "1300000000000000009");
        assert.strictEqual(row.guildName, "ArnTo Shop");

        bus.answer["message.send"] = Object.assign(new Error("slow"), { status: 504 });
        const err2 = await rejects(() => messages.send({ channelId: CH, message: { content: "late again" } }, owner), 504);
        const busId2 = bus.requests.at(-1).busId;
        bus.rows.set(busId2, { id: busId2, status: "failed", error: "The command reached the bot too late and was dropped" });
        const row2 = (await messages.listSent()).find((r) => r.id === err2.id);
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
        assert.strictEqual(bus.requests.at(-1).payload.viewer, undefined);
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

    await test("images by link: the bot attaches them; one that cannot is never sent any", async () => {
        const PIC = "1600000000000000001";
        const IMG = "1300000000000000003";
        const img = (n) => ({ url: `https://cdn.example/${n}.png?x=1`, name: `${n}.png` });
        bus.answer["message.send"] = (p) => where(IMG);
        const row = await messages.send({ channelId: CH, message: { content: "", images: [img("banner"), { url: "https://i.imgur.com/abc" }] } }, owner);
        const sent = bus.requests.at(-1);
        assert.deepStrictEqual(sent.payload.message.images, [img("banner"), { url: "https://i.imgur.com/abc", name: "abc.png" }], "a picture alone is a message");
        assert.strictEqual(sent.opts.timeoutMs, 40_000, "the bot downloads them first");
        assert.deepStrictEqual(row.message.images.length, 2, "Sent keeps the links (a copy brings them along)");
        assert.match(logs.at(-1).text, / · 2 images/);
        await rejects(() => messages.send({ channelId: CH, message: { images: [{ url: "javascript:alert(1)" }] } }, owner), 400, /Image 1 must start with https/);
        await rejects(() => messages.send({ channelId: CH, message: { images: Array.from({ length: 11 }, (_, i) => img(i)) } }, owner), 400, /11 images/);

        // Edit: keep one file (abc.png goes), add a picture. Sent keeps the links
        // of the files still on it, then the new one.
        bus.answer["message.edit"] = (p) => ({ ...where(p.messageId), components: [], attachments: [{ id: PIC, filename: "banner.png", url: "https://cdn.discordapp.com/b.png" }, { id: "1600000000000000002", filename: "new.png", url: "u" }], warnings: [] });
        const e = await messages.edit({ channelId: CH, messageId: IMG, message: { content: "Tết", images: [img("new")] }, keepAttachments: [PIC, "nope"] }, owner);
        const req = bus.requests.at(-1).payload;
        assert.deepStrictEqual(req.keepAttachments, [PIC], "ids only");
        assert.deepStrictEqual(req.message.images, [img("new")]);
        assert.deepStrictEqual(e.attachments.map((a) => a.filename), ["banner.png", "new.png"], "the page gets the message's files back");
        assert.deepStrictEqual(e.message.images, [img("banner"), img("new")]);
        assert.match(logs.at(-1).text, /Owner edited a message .* · 1 image/);
        await rejects(() => messages.edit({ channelId: CH, messageId: IMG, message: { content: "x", images: [img("a")] }, keepAttachments: Array.from({ length: 10 }, (_, i) => `16000000000000001${String(i).padStart(2, "0")}`) }, owner), 400, /11 files/);
        // Only kept files, no text: still a message.
        await messages.edit({ channelId: CH, messageId: IMG, message: { content: "" }, keepAttachments: [PIC] }, owner);
        await rejects(() => messages.edit({ channelId: CH, messageId: IMG, message: { content: "" }, keepAttachments: [] }, owner), 400, /empty/);

        // A bot that has not announced message.images would drop them: refused before the bus.
        const n = bus.requests.length;
        bus.canHandle = false;
        try {
            await rejects(() => messages.send({ channelId: CH, message: { content: "x", images: [img("a")] } }, owner), 503, /cannot attach images yet/);
            await rejects(() => messages.edit({ channelId: CH, messageId: IMG, message: { content: "x", images: [img("a")] } }, owner), 503, /cannot attach images yet/);
            const plain = await messages.edit({ channelId: CH, messageId: IMG, message: { content: "text only" } }, owner);
            assert.strictEqual(plain.message.content, "text only", "text alone still goes to an older bot");
        } finally {
            bus.canHandle = true;
        }
        assert.strictEqual(bus.requests.length, n + 1);
        assert.strictEqual(bus.requests.at(-1).payload.keepAttachments, undefined, "no list from the page: its files stay as they are");
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

    await test("staff Sent list: only the channels they can post in; only their own sends when that is unknown", async () => {
        bus.answer["message.send"] = (p) => ({ ...where("1300000000000000088", { channelId: p.channelId, channelName: "staff-room" }), warnings: [] });
        const hidden = await messages.send({ channelId: CH2, message: { content: "staff room only" } }, owner);
        const ownerList = await messages.listSent({ auth: owner });
        const staffList = await messages.listSent({ auth: staff });
        assert.ok(ownerList.some((r) => r.id === hidden.id));
        assert.ok(!staffList.some((r) => r.id === hidden.id), "a channel they cannot see is left out");
        assert.ok(staffList.length > 0 && staffList.every((r) => r.channelId === CH));
        await rejects(() => messages.forget(hidden.id, staff), 403);
        assert.deepStrictEqual(await messages.listSent({ auth: noRoles }), [], "nothing of their own");
    });

    await test("fetch by link: the bot reads it; its Sent row comes along", async () => {
        bus.answer["message.fetch"] = (p) => ({ ...where(p.messageId), own: true, v2: false, keepsComponents: false, message: { content: "hi", embeds: [], components: [] } });
        const r = await messages.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/${OTHER}`);
        assert.deepStrictEqual(bus.requests.at(-1).payload, { channelId: CH, messageId: OTHER });
        await messages.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/${OTHER}`, staff);
        assert.deepStrictEqual(bus.requests.at(-1).payload.viewer, { userId: "871329074046435338", guildId: GUILD });
        assert.strictEqual(r.own, true);
        assert.strictEqual(r.sent.messageId, OTHER);
        const none = await messages.fetchByLink(`${CH}/1300000000000000555`);
        assert.strictEqual(none.sent, null);
    });

    await test("Sent keeps 3 days from a message's last send, edit or delete", async () => {
        const sendOne = async (messageId, content) => {
            bus.answer["message.send"] = (p) => ({ ...where(messageId, { channelId: p.channelId }), warnings: [] });
            return messages.send({ channelId: CH, message: { content } }, owner);
        };
        const old = await sendOne("1300000000000000101", "old");
        const edited = await sendOne("1300000000000000102", "edited lately");
        const deleted = await sendOne("1300000000000000103", "deleted lately");
        const fresh = await sendOne("1300000000000000104", "today");
        const db = sharedStore.raw();
        const ago = (days) => Date.now() - days * 86_400_000;
        const has = (id) => db.prepare("SELECT COUNT(*) n FROM bot_messages WHERE id = ?").get(id).n === 1;
        db.prepare("UPDATE bot_messages SET sent_at = ? WHERE id = ?").run(ago(3) - 60_000, old.id);
        db.prepare("UPDATE bot_messages SET sent_at = ?, edited_at = ? WHERE id = ?").run(ago(5), ago(1), edited.id);
        db.prepare("UPDATE bot_messages SET sent_at = ?, deleted_at = ? WHERE id = ?").run(ago(5), ago(2), deleted.id);
        const ids = (await messages.listSent()).map((r) => r.id);
        assert.ok(!ids.includes(old.id) && !has(old.id), "sent over 3 days ago: removed, not just hidden");
        assert.ok(ids.includes(edited.id), "edited within 3 days: kept");
        assert.ok(ids.includes(deleted.id), "deleted within 3 days: kept");
        assert.ok(ids.includes(fresh.id));
        // The 10-minute tick removes them too, with nobody opening the page.
        db.prepare("UPDATE bot_messages SET edited_at = ? WHERE id = ?").run(ago(3) - 1000, edited.id);
        messages.prune();
        assert.ok(!has(edited.id));
        assert.ok(has(deleted.id) && has(fresh.id));
        assert.strictEqual(messages.SENT_KEEP_MS, 3 * 86_400_000);
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
