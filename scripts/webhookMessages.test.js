#!/usr/bin/env node
/**
 * Checks for the Webhooks page (server/services/webhookMessages.js): the shop
 * server's webhooks loaded from the bot (once a day or with Reload, tokens kept
 * encrypted and never handed to the page), staff kept to the channels their
 * own Discord account can post in, posting / editing / deleting through
 * Discord's webhook API (stubbed fetch) with a name, an avatar, files, threads
 * and forum posts, a message opened by its link finding its own webhook, a
 * webhook deleted on Discord leaving the list, ArnTo-selfbot making a new one,
 * and saved messages.
 * Run:  node scripts/webhookMessages.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "webhooks-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-jwt-secret";

const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => ({ name: "ArnTo-assistant" }) } };

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const panelLog = require("../server/services/panelLog");
const messages = require("../server/services/botMessages");
const hooks = require("../server/services/webhookMessages");

// ── The shop server ──────────────────────────────────────────────────────────
const GUILD = "1103736775815471257"; // staffService's default staff server
const VIEW = 1n << 10n;
const SEND = 1n << 11n;
const str = (n) => String(n);
const R_STAFF = "1134354122867482716";
const CH = "1205054570074480710"; // announcements: read-only, Staff may post
const CH2 = "1205054570074480711"; // hidden from staff
const FORUM = "1205054570074480712";
const WH = "1400000000000000001";
const WH2 = "1400000000000000002"; // in the hidden channel
const WH_APP = "1400000000000000003"; // another app's: no token
const WH_FORUM = "1400000000000000004";
const TOKEN = "tok-announcements-SECRET";
const answerList = () => ({
    guild: {
        id: GUILD,
        name: "ArnTo Shop",
        ownerId: "999999999999999999",
        everyone: str(VIEW | SEND),
        roles: [{ id: R_STAFF, name: "Staff", color: 0xe67e22, mentionable: true, permissions: "0" }],
    },
    channels: [
        { id: CH, name: "thông-báo", type: "announcement", overwrites: [{ id: GUILD, type: 0, allow: "0", deny: str(SEND) }, { id: R_STAFF, type: 0, allow: str(SEND), deny: "0" }] },
        { id: CH2, name: "admin", type: "text", overwrites: [{ id: GUILD, type: 0, allow: "0", deny: str(VIEW) }] },
        { id: FORUM, name: "hỏi-đáp", type: "forum", overwrites: [] },
    ],
    webhooks: [
        { id: WH, name: "Thông báo", avatar: "https://cdn.discordapp.com/avatars/1/a.png", channelId: CH, token: TOKEN, applicationId: null, creator: { id: "871329074046435338", tag: "khai" }, createdAt: 1_700_000_000_000 },
        { id: WH2, name: "Admin log", channelId: CH2, token: "tok-admin" },
        { id: WH_APP, name: "MEE6", channelId: CH, token: null, applicationId: "159985870458322944" },
        { id: WH_FORUM, name: "Forum bot", channelId: FORUM, token: "tok-forum" },
    ],
});

// ── Stubs ────────────────────────────────────────────────────────────────────
const bus = { requests: [], answer: {}, handlers: { "webhook.list": "assistant", "webhook.fetch": "assistant", "webhook.create": "assistant" }, ready: true };
discordBus.handlerOf = (cmd) => bus.handlers[cmd] || null;
discordBus.status = () => ({ ready: bus.ready });
discordBus.request = async (target, cmd, payload, opts = {}) => {
    bus.requests.push({ target, cmd, payload, opts });
    const a = bus.answer[cmd];
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(payload) : a;
};
const logs = [];
panelLog.add = (kind, text) => logs.push({ kind, text });
const ROLES = new Map([["871329074046435338", [R_STAFF]]]);
require("../server/services/staffService").rolesOf = (id) => (ROLES.has(id) ? { roles: ROLES.get(id), at: Date.now() } : null);

// Discord's webhook API.
const calls = [];
let reply = () => ({ status: 200, body: {} });
global.fetch = async (url, init) => {
    const u = new URL(url);
    let body = null;
    let files = [];
    if (init.body instanceof FormData) {
        body = JSON.parse(init.body.get("payload_json"));
        files = [...init.body.entries()].filter(([k]) => k.startsWith("files[")).map(([k, v]) => ({ field: k, name: v.name, size: v.size }));
    } else if (init.body) body = JSON.parse(init.body);
    const call = { method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, files };
    calls.push(call);
    const r = reply(call);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
};

const owner = { kind: "owner", username: "khai" };
const staff = { kind: "staff", staff: { userId: "871329074046435338", userTag: "nghiihgn" } };
const noRoles = { kind: "staff", staff: { userId: "427399742906040333", userTag: "never-checked" } };
const kvRaw = (name) => sharedStore.raw().prepare("SELECT value FROM kv WHERE name = ?").get(name)?.value || null;
const kvSet = (name, value) => sharedStore.raw().prepare("INSERT OR REPLACE INTO kv (name, value) VALUES (?, ?)").run(name, JSON.stringify(value));
const file = (name, bytes = 10, mimetype = "image/png") => ({ originalname: name, mimetype, size: bytes, buffer: Buffer.alloc(bytes, 1) });
const posted = (id, channelId = CH, extra = {}) => ({ status: 200, body: { id, channel_id: channelId, attachments: [], ...extra } });

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

(async () => {
    console.log("webhookMessages");

    await test("before the first load: no list, sending says to Reload", async () => {
        const t = hooks.targets({ auth: owner });
        assert.strictEqual(t.loadedAt, null);
        assert.deepStrictEqual(t.channels, []);
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "hi" } }, [], owner), 503, /Reload/);
    });

    await test("the daily load asks the bot for the shop server; tokens are kept encrypted and never shown", async () => {
        bus.answer["webhook.list"] = answerList();
        await hooks.dailyTick();
        const req = bus.requests.find((r) => r.cmd === "webhook.list");
        assert.deepStrictEqual(req.payload, { guildId: GUILD });
        assert.ok(!kvRaw("__webhooks.scan").includes(TOKEN), "no token in shared.sqlite");
        const t = hooks.targets({ auth: owner });
        assert.ok(t.loadedAt);
        assert.strictEqual(t.guild.name, "ArnTo Shop");
        assert.ok(!("permissions" in t.guild.roles[0]));
        assert.ok(!JSON.stringify(t).includes("tok-"), "no token reaches the page");
        const ann = t.channels.find((c) => c.id === CH);
        assert.deepStrictEqual(ann.webhooks.map((w) => [w.name, w.usable]), [["MEE6", false], ["Thông báo", true]]);
        assert.match(ann.webhooks[0].why, /another app/);
        assert.ok(!("overwrites" in ann));
        // A second tick the same day does not ask again.
        const n = bus.requests.length;
        await hooks.dailyTick();
        assert.strictEqual(bus.requests.length, n);
    });

    await test("Reload: at most once every 10 minutes, for everyone", async () => {
        await rejects(() => hooks.reload(owner), 429, /reloaded again in 10 minutes/);
        kvSet("__webhooks.scanTried", Date.now() - 11 * 60_000);
        const t = await hooks.reload(owner);
        assert.strictEqual(t.channels.length, 3);
    });

    await test("staff see only the channels they can post in themselves", async () => {
        const t = hooks.targets({ auth: staff });
        assert.ok(t.viewer.found);
        assert.deepStrictEqual(t.channels.map((c) => c.id).sort(), [CH, FORUM].sort());
        const n = hooks.targets({ auth: noRoles });
        assert.strictEqual(n.viewer.found, false);
        assert.match(n.viewer.why, /roles/);
        await rejects(() => hooks.send({ webhookId: WH2, message: { content: "x" } }, [], staff), 403, /channels you can see and post in/);
        await rejects(() => hooks.create({ channelId: CH2, name: "Spy" }, staff), 403);
    });

    await test("send: name, avatar, pings, silent, link buttons — straight to the webhook", async () => {
        calls.length = 0;
        reply = () => posted("1500000000000000001");
        const row = await hooks.send(
            {
                webhookId: WH,
                message: { content: "Sale @everyone <@&1134354122867482716>", embeds: [{ title: "Tết" }], components: [[{ label: "Shop", url: "https://arnto.vn" }]] },
                username: "ArnTo Shop",
                avatarUrl: "https://cdn.example/logo.png",
                mentions: { everyone: true, roles: false, users: true },
                silent: true,
            },
            [],
            staff,
        );
        const c = calls[0];
        assert.strictEqual(c.method, "POST");
        assert.strictEqual(c.path, `/api/v10/webhooks/${WH}/${TOKEN}`);
        assert.deepStrictEqual(c.query, { wait: "true", with_components: "true" });
        assert.strictEqual(c.body.username, "ArnTo Shop");
        assert.strictEqual(c.body.avatar_url, "https://cdn.example/logo.png");
        assert.deepStrictEqual(c.body.allowed_mentions, { parse: ["users", "everyone"] });
        assert.strictEqual(c.body.flags, 1 << 12);
        assert.deepStrictEqual(c.body.components, [{ type: 1, components: [{ type: 2, style: 5, url: "https://arnto.vn", label: "Shop" }] }]);
        assert.strictEqual(row.url, `https://discord.com/channels/${GUILD}/${CH}/1500000000000000001`);
        assert.strictEqual(row.webhookName, "Thông báo");
        assert.strictEqual(row.username, "ArnTo Shop");
        assert.strictEqual(row.sentBy.tag, "nghiihgn");
        const log = logs.at(-1);
        assert.strictEqual(log.kind, "staff");
        assert.match(log.text, /sent a message as \*\*ArnTo Shop\*\* in \*\*#thông-báo\*\* · mentions @everyone \(silent\)/);
        assert.ok(!log.text.includes(TOKEN));
    });

    await test("send: what Discord would refuse never leaves the panel", async () => {
        calls.length = 0;
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "x" }, username: "Discord Bot" }, [], owner), 400, /"discord" or "clyde"/);
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "x" }, avatarUrl: "ftp://a/b.png" }, [], owner), 400, /https/);
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "  " } }, [], owner), 400, /empty/);
        await rejects(() => hooks.send({ webhookId: WH_APP, message: { content: "x" } }, [], owner), 400, /another app/);
        await rejects(() => hooks.send({ webhookId: "1499999999999999999", message: { content: "x" } }, [], owner), 404, /not in the list/);
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "x" }, threadName: "New post" }, [], owner), 400, /Only a forum/);
        await rejects(() => hooks.send({ webhookId: WH_FORUM, message: { content: "x" } }, [], owner), 400, /forum — give the new post a title/);
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "x" } }, Array.from({ length: 11 }, (_, i) => file(`${i}.png`)), owner), 400, /11 files/);
        assert.strictEqual(calls.length, 0);
    });

    await test("send with files: multipart, attachment:// in an embed, names safe for it", async () => {
        calls.length = 0;
        reply = () => posted("1500000000000000002", CH, { attachments: [{ id: "1600000000000000001", filename: "banner_tet.png", url: "https://cdn.discordapp.com/x/banner_tet.png", size: 10, content_type: "image/png" }] });
        const row = await hooks.send(
            { webhookId: WH, message: { embeds: [{ title: "Tết", image: { url: "attachment://banner_tet.png" } }] }, files: [{ name: "banner_tet.png" }, { name: "Bảng giá đẹp.pdf" }] },
            [file("banner_tet.png"), file("B?ng gi? ??p.pdf", 20, "application/pdf")],
            owner,
        );
        const c = calls[0];
        assert.deepStrictEqual(c.files.map((f) => [f.field, f.name]), [["files[0]", "banner_tet.png"], ["files[1]", "Bang_gia_dep.pdf"]]);
        assert.deepStrictEqual(c.body.attachments, [{ id: 0, filename: "banner_tet.png" }, { id: 1, filename: "Bang_gia_dep.pdf" }]);
        assert.strictEqual(c.body.embeds[0].image.url, "attachment://banner_tet.png");
        assert.strictEqual(row.attachments[0].filename, "banner_tet.png");
        // Files alone are a message too.
        reply = () => posted("1500000000000000003");
        await hooks.send({ webhookId: WH, message: { content: "" } }, [file("a.png")], owner);
        // The bot's own Messages page still takes http(s) pictures only.
        await rejects(() => messages.normalizeMessage({ embeds: [{ title: "x", image: { url: "attachment://a.png" } }] }), 400, /must start with/);
        assert.strictEqual(hooks.fileName("Ảnh sản phẩm (1).PNG", 0), "Anh_san_pham_1_.PNG");
    });

    await test("threads and forum posts", async () => {
        calls.length = 0;
        reply = () => posted("1500000000000000004", "1700000000000000001");
        const row = await hooks.send({ webhookId: WH_FORUM, message: { content: "Hỏi gì cũng được" }, threadName: "FAQ" }, [], owner);
        assert.strictEqual(calls[0].body.thread_name, "FAQ");
        assert.strictEqual(row.threadId, "1700000000000000001");
        assert.strictEqual(row.threadName, "FAQ");
        assert.strictEqual(row.url, `https://discord.com/channels/${GUILD}/1700000000000000001/1500000000000000004`);
        reply = () => posted("1500000000000000005", "1700000000000000001");
        await hooks.send({ webhookId: WH_FORUM, message: { content: "Thêm" }, threadId: "1700000000000000001", threadName: "ignored" }, [], owner);
        assert.strictEqual(calls[1].query.thread_id, "1700000000000000001");
        assert.ok(!("thread_name" in calls[1].body), "an existing post takes no title");
    });

    await test("edit: keeps the chosen files, adds new ones, pings nobody new", async () => {
        calls.length = 0;
        reply = () => ({ status: 200, body: { id: "1500000000000000002", channel_id: CH, content: "", embeds: [{ title: "Tết 2" }], components: [], attachments: [{ id: "1600000000000000001", filename: "banner_tet.png", url: "u", size: 10 }, { id: "1600000000000000009", filename: "new.png", url: "u2", size: 5 }] } });
        const row = await hooks.edit(
            { webhookId: WH, messageId: "1500000000000000002", message: { embeds: [{ title: "Tết 2" }] }, keepAttachments: ["1600000000000000001"], files: [{ name: "new.png" }], mentions: { everyone: false, roles: false, users: false } },
            [file("new.png", 5)],
            owner,
        );
        const c = calls[0];
        assert.strictEqual(c.method, "PATCH");
        assert.strictEqual(c.path, `/api/v10/webhooks/${WH}/${TOKEN}/messages/1500000000000000002`);
        assert.deepStrictEqual(c.body.attachments, [{ id: "1600000000000000001" }, { id: 0, filename: "new.png" }]);
        assert.strictEqual(c.body.content, "", "an emptied text is cleared on Discord");
        assert.deepStrictEqual(c.body.allowed_mentions, { parse: [] });
        assert.strictEqual(row.editedBy.kind, "owner");
        assert.strictEqual(row.attachments.length, 2);
        assert.match(logs.at(-1).text, /edited a message of \*\*Thông báo\*\*/);
    });

    await test("delete: on Discord, then marked in Sent; one already gone counts as deleted", async () => {
        calls.length = 0;
        reply = () => ({ status: 204, body: null });
        const r = await hooks.remove({ webhookId: WH, messageId: "1500000000000000001" }, owner);
        assert.strictEqual(calls[0].method, "DELETE");
        assert.strictEqual(r.row.status, "deleted");
        reply = () => ({ status: 404, body: { code: 10008, message: "Unknown Message" } });
        const g = await hooks.remove({ webhookId: WH, messageId: "1500000000000000099" }, owner);
        assert.strictEqual(g.missing, true);
    });

    await test("Discord's refusals read clearly; a deleted webhook leaves the list", async () => {
        reply = () => ({ status: 400, body: { code: 50035, message: "Invalid Form Body", errors: { embeds: { 0: { image: { url: { _errors: [{ code: "URL_TYPE_INVALID_URL", message: "Not a well formed URL." }] } } } } } } });
        await rejects(() => hooks.send({ webhookId: WH, message: { content: "x" } }, [], owner), 400, /embeds\.0\.image\.url: Not a well formed URL/);
        reply = () => ({ status: 404, body: { code: 10015, message: "Unknown Webhook" } });
        await rejects(() => hooks.send({ webhookId: WH2, message: { content: "x" } }, [], owner), 410, /deleted on Discord/);
        assert.ok(!hooks.targets({ auth: owner }).channels.find((c) => c.id === CH2).webhooks.length);
    });

    await test("open by link: the bot names the webhook (sealed token) and it can be edited", async () => {
        const WH_NEW = "1400000000000000009";
        bus.answer["webhook.fetch"] = (p) => ({
            channelId: p.channelId,
            channelName: "thông-báo",
            messageId: p.messageId,
            webhookId: WH_NEW,
            author: { username: "Shop", bot: true },
            createdAt: 1_700_000_000_000,
            message: { content: "Cũ", embeds: [{ type: "rich", title: "A" }, { type: "link", url: "https://x" }], components: [], attachments: [{ id: "1600000000000000005", filename: "a.png", url: "u", size: 3 }] },
            webhook: { id: WH_NEW, name: "Made by hand", channelId: CH, token: "tok-hand" },
        });
        const res = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/1500000000000000050`, staff);
        const req = bus.requests.at(-1);
        assert.deepStrictEqual(req.payload.viewer, { userId: "871329074046435338", guildId: GUILD }, "the bot checks staff again, live");
        assert.strictEqual(res.kind, "webhook");
        assert.strictEqual(res.editable, true);
        assert.strictEqual(res.webhook.name, "Made by hand");
        assert.ok(!JSON.stringify(res).includes("tok-hand"));
        assert.strictEqual(res.message.embeds.length, 1, "link previews are not part of the message");
        assert.strictEqual(res.attachments[0].filename, "a.png");
        assert.ok(hooks.targets({ auth: owner }).channels.find((c) => c.id === CH).webhooks.some((w) => w.id === WH_NEW), "now in the list");
        // …and editing it goes through that webhook.
        calls.length = 0;
        reply = () => ({ status: 200, body: { id: "1500000000000000050", channel_id: CH, content: "Mới", embeds: [], components: [], attachments: [] } });
        await hooks.edit({ webhookId: WH_NEW, messageId: "1500000000000000050", message: { content: "Mới" }, keepAttachments: [] }, [], staff);
        assert.strictEqual(calls[0].path, `/api/v10/webhooks/${WH_NEW}/tok-hand/messages/1500000000000000050`);
    });

    await test("open by link: in a thread, not a webhook's, another app's, another server", async () => {
        bus.answer["webhook.fetch"] = (p) => ({ channelId: p.channelId, channelName: "Câu hỏi 1", parentId: FORUM, parentName: "hỏi-đáp", messageId: p.messageId, webhookId: WH_FORUM, message: { content: "x" }, webhook: { id: WH_FORUM, name: "Forum bot", channelId: FORUM, token: "tok-forum" } });
        const t = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/1700000000000000001/1500000000000000060`, owner);
        assert.strictEqual(t.channelId, FORUM);
        assert.strictEqual(t.threadId, "1700000000000000001");
        assert.strictEqual(t.threadName, "Câu hỏi 1");
        assert.ok(t.editable);

        bus.answer["webhook.fetch"] = (p) => ({ channelId: p.channelId, messageId: p.messageId, webhookId: null, author: { username: "ArnTo Trợ Lý", bot: true }, message: { content: "x" } });
        const b = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/1500000000000000061`, owner);
        assert.strictEqual(b.kind, "bot");
        assert.strictEqual(b.editable, false);
        assert.match(b.why, /Messages page/);

        bus.answer["webhook.fetch"] = (p) => ({ channelId: p.channelId, messageId: p.messageId, webhookId: WH_APP, message: { content: "x" }, webhook: { id: WH_APP, name: "MEE6", channelId: CH, token: null, applicationId: "159985870458322944" } });
        const a = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/1500000000000000062`, owner);
        assert.strictEqual(a.editable, false);
        assert.match(a.why, /another app/);

        bus.answer["webhook.fetch"] = (p) => ({ channelId: p.channelId, messageId: p.messageId, webhookId: "1400000000000000077", message: { content: "x" }, webhook: null });
        const g = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/1500000000000000063`, owner);
        assert.strictEqual(g.kind, "gone");
        assert.match(g.why, /deleted/);

        bus.answer["webhook.fetch"] = (p) => ({ channelId: p.channelId, messageId: p.messageId, webhookId: "1400000000000000078", message: { content: "x" }, webhook: null, webhookError: "Missing Permissions" });
        const h = await hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH}/1500000000000000066`, owner);
        assert.strictEqual(h.kind, "hidden");
        assert.match(h.why, /cannot read the webhook.*Missing Permissions/);

        await rejects(() => hooks.fetchByLink(`https://discord.com/channels/1183033659838697542/${CH}/1500000000000000064`, owner), 400, /not in ArnTo Shop/);
        bus.answer["webhook.fetch"] = (p) => ({ channelId: CH2, messageId: p.messageId, webhookId: null, message: { content: "x" } });
        await rejects(() => hooks.fetchByLink(`https://discord.com/channels/${GUILD}/${CH2}/1500000000000000065`, staff), 403);
    });

    await test("a Sent row reopens through its own webhook, no bot", async () => {
        const n = bus.requests.length;
        calls.length = 0;
        reply = () => ({ status: 200, body: { id: "1500000000000000002", channel_id: CH, content: "", embeds: [{ title: "Tết 2" }], components: [], attachments: [], author: { id: WH, username: "Thông báo", avatar: null }, timestamp: "2026-10-14T03:00:00.000Z" } });
        const r = await hooks.readThroughWebhook({ webhookId: WH, messageId: "1500000000000000002" }, owner);
        assert.strictEqual(calls[0].method, "GET");
        assert.strictEqual(bus.requests.length, n);
        assert.ok(r.editable);
        assert.strictEqual(r.sent.messageId, "1500000000000000002");
    });

    await test("new webhook: ArnTo-assistant has ArnTo-selfbot make it, and it is usable at once", async () => {
        bus.answer["webhook.create"] = (p) => ({ id: "1400000000000000010", name: p.name, channelId: p.channelId, token: "tok-new", avatar: null, creator: { id: "1", tag: "selfbot" } });
        const w = await hooks.create({ channelId: CH, name: "Khuyến mãi", avatarUrl: "https://cdn.example/a.png" }, staff);
        const req = bus.requests.at(-1);
        assert.strictEqual(req.target, "assistant");
        const { notAfter, ...payload } = req.payload;
        assert.deepStrictEqual(payload, { guildId: GUILD, channelId: CH, name: "Khuyến mãi", avatar: "https://cdn.example/a.png", viewer: { userId: "871329074046435338", guildId: GUILD } });
        assert.ok(notAfter > Date.now() && notAfter <= Date.now() + 2 * 60_000, "a late command makes nothing");
        assert.ok(w.usable);
        assert.ok(!("token" in w));
        assert.match(logs.at(-1).text, /made the webhook \*\*Khuyến mãi\*\*/);
        await rejects(() => hooks.create({ channelId: CH, name: "" }, owner), 400, /name/);
        bus.answer["webhook.create"] = new Error("ArnTo-selfbot's account lacks Manage Webhooks in that channel");
        await assert.rejects(() => hooks.create({ channelId: CH, name: "X" }, owner), /lacks Manage Webhooks/);
        delete bus.handlers["webhook.create"];
        await rejects(() => hooks.create({ channelId: CH, name: "X" }, owner), 503, /ArnTo-assistant/);
        bus.handlers["webhook.create"] = "assistant";
    });

    await test("Sent: staff see their channels; kept 3 days after the last change", async () => {
        const mine = hooks.listSent({ auth: staff });
        assert.ok(mine.length && mine.every((r) => r.channelId === CH || r.channelId === FORUM));
        const all = hooks.listSent({ auth: owner });
        assert.ok(all.length >= mine.length);
        sharedStore.raw().prepare("UPDATE webhook_messages SET sent_at = ?, edited_at = NULL, deleted_at = NULL WHERE message_id = ?").run(Date.now() - hooks.SENT_KEEP_MS - 1000, "1500000000000000003");
        hooks.prune();
        assert.ok(!hooks.listSent({ auth: owner }).some((r) => r.messageId === "1500000000000000003"));
    });

    await test("saved messages: several messages with their target", async () => {
        const d = hooks.createDraft({ name: "Tết", messages: [{ draft: { content: "1" } }, { draft: { content: "2" } }], target: { webhookId: WH, threadName: "x" }, options: { silent: true } }, owner);
        assert.strictEqual(d.messages.length, 2);
        assert.strictEqual(d.target.webhookId, WH);
        assert.strictEqual(d.options.silent, true);
        const u = hooks.updateDraft(d.id, { name: "Tết 2" }, staff);
        assert.strictEqual(u.name, "Tết 2");
        assert.strictEqual(u.messages.length, 2);
        assert.throws(() => hooks.createDraft({ name: "x", messages: [] }, owner), /No message/);
        hooks.deleteDraft(d.id);
        assert.strictEqual(hooks.listDrafts().length, 0);
    });

    sharedStore.close?.();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
