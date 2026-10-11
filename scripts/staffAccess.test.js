#!/usr/bin/env node
/**
 * Checks for staff access (server/services/staffService.js + middleware/auth.js):
 * settings, adding staff and their page permissions, the Discord login against a
 * stubbed Discord (identity, Staff role, one session at a time, new-device notice),
 * the owner-only default, page gates (view = GET, edit = everything), the audit
 * log and its lines in the panel log channel, the role re-check sweep, and
 * every way a session ends.
 * Run:  node scripts/staffAccess.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "staff-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-secret-for-staff-access";

// Stand-in for server/db (discordBus loads it; nothing here reads bots).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { get: async () => null, find: async () => [], findOne: async () => null } };

const axios = require("axios");
const jwt = require("jsonwebtoken");
const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const panelLog = require("../server/services/panelLog");
const staff = require("../server/services/staffService");
const { authMiddleware, pageAuth, isOwnerToken, identify } = require("../server/middleware/auth");

// ── Discord stub ─────────────────────────────────────────────────────────────
const GUILD = "1103736775815471257";
const STAFF_ROLE = "1134354122867482716";
const LAN = "953525563878948914"; // staff
const MINH = "612880338590498816"; // staff
const KHACH = "700000000000000001"; // has the role, never added

// access token → { user, member: { roles } | 404 | 401 | "down" }
const discord = { tokens: new Map(), codes: new Map(), used: new Set(), lastScope: "identify guilds.members.read" };
let issued = 0;
/** Pretend the person went through Discord: returns the code the callback would carry. */
const discordCode = (userId, member = { roles: [STAFF_ROLE] }) => {
    const code = `code${++issued}`;
    const access = `access${issued}`;
    discord.codes.set(code, access);
    discord.tokens.set(access, { user: { id: userId, username: `u${userId.slice(-3)}`, discriminator: "0", avatar: "abc" }, member });
    return { code, access };
};
const fail = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

axios.post = async (url, body, opts) => {
    assert.ok(url.endsWith("/oauth2/token"), url);
    const p = new URLSearchParams(body);
    assert.strictEqual(p.get("redirect_uri"), "https://panel.example.vn/auth/discord/callback");
    assert.strictEqual(opts.auth.username, "1300000000000000001");
    if (opts.auth.password !== "the-client-secret") throw fail(401, { error: "invalid_client" });
    const code = p.get("code");
    if (!discord.codes.has(code) || discord.used.has(code)) throw fail(400, { error: "invalid_grant" });
    discord.used.add(code);
    return { data: { access_token: discord.codes.get(code), scope: discord.lastScope, token_type: "Bearer" } };
};
axios.get = async (url, opts) => {
    const access = opts.headers.Authorization.replace("Bearer ", "");
    const t = discord.tokens.get(access);
    if (!t) throw fail(401, { message: "401: Unauthorized" });
    if (url.endsWith("/users/@me")) return { data: t.user };
    assert.ok(url.endsWith(`/users/@me/guilds/${GUILD}/member`), url);
    if (t.member === 404) throw fail(404, { code: 10004 });
    if (t.member === 401) throw fail(401, {});
    if (t.member === "down") throw fail(502, {});
    return { data: { roles: t.member.roles } };
};
// What goes to the panel log channel.
const logged = [];
panelLog.add = (kind, text) => logged.push({ kind, text });
const lastLog = () => logged.at(-1) || {};
discordBus.userTag = async (id) => (id === LAN ? "lan" : undefined);

// ── Express stand-ins ────────────────────────────────────────────────────────
const call = (mw, { token, method = "GET", url = "/api/stock/products", query = false } = {}) => {
    const req = {
        headers: token && !query ? { authorization: `Bearer ${token}` } : {},
        query: token && query ? { token } : {},
        method,
        originalUrl: url,
        socket: { remoteAddress: "127.0.0.1" },
    };
    req.headers["x-real-ip"] = "203.0.113.7";
    const res = {
        statusCode: 200,
        handlers: {},
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        on(ev, fn) { this.handlers[ev] = fn; },
    };
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { passed, res, req, finish: () => res.handlers.finish && res.handlers.finish() };
};

const OWNER = jwt.sign({ username: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

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
        assert.strictEqual(err.status, status, `status ${err.status} (${err.message})`);
        if (re) assert.match(err.message, re);
        return err;
    }
    throw new Error(`expected a ${status}`);
};
const login = (userId, member, extra = {}) => {
    const { code } = discordCode(userId, member);
    return staff.login({ code, state: staff.authorizeUrl().state, device: "deviceAAAA1111", ip: "203.0.113.7", ua: "Firefox", ...extra });
};

(async () => {
    console.log("settings");

    await test("not set up until client, secret, redirect, server and role are there", async () => {
        const s = staff.getSettings();
        assert.strictEqual(s.configured, false);
        assert.strictEqual(s.guildId, GUILD);
        assert.strictEqual(s.roleId, STAFF_ROLE);
        assert.throws(() => staff.authorizeUrl(), /not set up/);
        await rejects(() => staff.login({ code: "x", state: "y" }), 503);
    });

    await test("bad values are refused", () => {
        assert.throws(() => staff.setSettings({ clientId: "abc" }), /numeric/);
        assert.throws(() => staff.setSettings({ redirectUri: "http://panel.example.vn/auth/discord/callback" }), /https/);
        assert.throws(() => staff.setSettings({ redirectUri: "https://panel.example.vn/login" }), /auth\/discord\/callback/);
        assert.throws(() => staff.setSettings({ roleId: "staff" }), /Discord ID/);
    });

    await test("the secret is stored sealed and never read back", () => {
        const s = staff.setSettings({
            clientId: "1300000000000000001",
            clientSecret: "the-client-secret",
            redirectUri: "https://panel.example.vn/auth/discord/callback",
        });
        assert.strictEqual(s.configured, true);
        assert.strictEqual(s.hasSecret, true);
        assert.ok(!JSON.stringify(s).includes("the-client-secret"));
        const raw = sharedStore.raw().prepare("SELECT value FROM kv WHERE name = '__staff.settings'").get().value;
        assert.ok(!raw.includes("the-client-secret"));
        // An empty secret keeps the stored one.
        assert.strictEqual(staff.setSettings({ clientSecret: "" }).hasSecret, true);
    });

    await test("the authorize URL asks only for identify + guilds.members.read", () => {
        const { url, state } = staff.authorizeUrl();
        const u = new URL(url);
        assert.strictEqual(u.searchParams.get("scope"), "identify guilds.members.read");
        assert.strictEqual(u.searchParams.get("redirect_uri"), "https://panel.example.vn/auth/discord/callback");
        assert.strictEqual(u.searchParams.get("state"), state);
        assert.ok(staff._checkState(state));
    });

    await test("a tampered or old state is refused", () => {
        const s = staff._makeState();
        const [a, b, c] = s.split(".");
        assert.ok(!staff._checkState(`${a}x.${b}.${c}`));
        assert.ok(!staff._checkState(`${a}.${Number(b) - 1}.${c}`));
        assert.ok(!staff._checkState("garbage"));
        const realNow = Date.now;
        Date.now = () => realNow() + 11 * 60 * 1000;
        try { assert.ok(!staff._checkState(s)); } finally { Date.now = realNow; }
    });

    console.log("staff");

    await test("added by Discord ID, with their name when the bot can see it", async () => {
        await rejects(() => staff.add({ userId: "lan" }), 400);
        const lan = await staff.add({ userId: LAN, perms: { stock: "view", orders: "edit", vouchers: "none" }, note: "ca sáng" });
        assert.strictEqual(lan.userTag, "lan");
        assert.deepStrictEqual(lan.perms, { stock: "view", orders: "edit" });
        await rejects(() => staff.add({ userId: LAN }), 409);
        const minh = await staff.add({ userId: MINH });
        assert.strictEqual(minh.userTag, null);
        assert.deepStrictEqual(minh.perms, {});
    });

    await test("only known pages and levels", async () => {
        assert.throws(() => staff.update(LAN, { perms: { terminal: "edit" } }), /Unknown page/);
        assert.throws(() => staff.update(LAN, { perms: { stock: "admin" } }), /view or edit/);
        assert.throws(() => staff.update(KHACH, { perms: {} }), /Not a staff member/);
    });

    await test("view covers reads, edit covers everything", () => {
        const lan = staff.getStaff(LAN);
        assert.ok(staff.can(lan, "stock", "GET"));
        assert.ok(!staff.can(lan, "stock", "POST"));
        assert.ok(staff.can(lan, "orders", "DELETE"));
        assert.ok(!staff.can(lan, "supporters", "GET"));
    });

    console.log("login");

    let lanToken;
    await test("someone who was never added cannot sign in, Staff role or not", async () => {
        await rejects(() => login(KHACH), 403, /no access/);
    });

    await test("the Staff role is required", async () => {
        await rejects(() => login(LAN, { roles: ["123456789012345678"] }), 403, /Staff role/);
        await rejects(() => login(LAN, 404), 403, /not in the server/);
    });

    await test("a code works once, and a wrong secret says so", async () => {
        const { code } = discordCode(LAN);
        const state = staff.authorizeUrl().state;
        await staff.login({ code, state, device: "deviceAAAA1111" });
        await rejects(() => staff.login({ code, state }), 400, /already used/);
        staff.setSettings({ clientSecret: "wrong" });
        await rejects(() => login(LAN), 502, /Client ID/);
        staff.setSettings({ clientSecret: "the-client-secret" });
    });

    await test("missing scopes are refused", async () => {
        discord.lastScope = "identify";
        await rejects(() => login(LAN), 400, /permissions/);
        discord.lastScope = "identify guilds.members.read";
    });

    await test("a good login gives a staff token with their pages", async () => {
        logged.length = 0;
        const out = await login(LAN, undefined, { device: "deviceBBBB2222" });
        lanToken = out.token;
        const who = identify(lanToken);
        assert.strictEqual(who.kind, "staff");
        assert.strictEqual(who.staff.userId, LAN);
        assert.deepStrictEqual(who.staff.perms, { stock: "view", orders: "edit" });
        assert.strictEqual(who.staff.avatar, "abc");
        const decoded = jwt.decode(lanToken);
        assert.ok(decoded.exp - decoded.iat <= 12 * 3600);
    });

    await test("sign-ins go to the panel log, a new device flagged", async () => {
        assert.strictEqual(logged.length, 1);
        assert.strictEqual(logged[0].kind, "staff");
        assert.match(logged[0].text, /\*\*u914\*\* signed in · 🆕 \*\*new device\*\* · IP 203\.0\.113\.7/);
        const again = await login(LAN, undefined, { device: "deviceBBBB2222" });
        assert.doesNotMatch(lastLog().text, /new device/);
        lanToken = again.token;
    });

    await test("one place at a time: a new login ends the old session", async () => {
        const old = lanToken;
        const fresh = await login(LAN, undefined, { device: "deviceCCCC3333" });
        assert.throws(() => identify(old), (e) => e.status === 401 && e.reason === "replaced");
        assert.strictEqual(identify(fresh.token).staff.userId, LAN);
        assert.match(lastLog().text, /new device.*ended 1 other session/);
        lanToken = fresh.token;
        const active = staff.sessions({ userId: LAN }).filter((s) => s.active);
        assert.strictEqual(active.length, 1);
        assert.ok(staff.list().find((s) => s.userId === LAN).online);
    });

    console.log("gates");

    await test("owner-only routes refuse staff", () => {
        const s = call(authMiddleware, { token: lanToken, url: "/api/bots" });
        assert.ok(!s.passed);
        assert.strictEqual(s.res.statusCode, 403);
        assert.strictEqual(s.res.body.code, "FORBIDDEN");
        assert.ok(call(authMiddleware, { token: OWNER, url: "/api/bots" }).passed);
        const none = call(authMiddleware, {});
        assert.strictEqual(none.res.statusCode, 401);
        assert.strictEqual(none.res.body.code, "AUTH_REQUIRED");
    });

    await test("the terminal and bot logs take the owner's token only", () => {
        assert.strictEqual(isOwnerToken(OWNER), true);
        assert.strictEqual(isOwnerToken(lanToken), false);
        assert.strictEqual(isOwnerToken("garbage"), false);
        assert.strictEqual(isOwnerToken(""), false);
        // A token signed for something else is not the owner's either.
        assert.strictEqual(isOwnerToken(jwt.sign({ kind: "other", username: "admin" }, process.env.JWT_SECRET)), false);
        assert.strictEqual(isOwnerToken(jwt.sign({ foo: 1 }, process.env.JWT_SECRET)), false);
    });

    await test("view lets GET through and stops writes", () => {
        assert.ok(call(pageAuth("stock"), { token: lanToken }).passed);
        const w = call(pageAuth("stock"), { token: lanToken, method: "POST" });
        assert.ok(!w.passed);
        assert.strictEqual(w.res.statusCode, 403);
        assert.match(w.res.body.error, /only view/);
        const other = call(pageAuth("supporters"), { token: lanToken });
        assert.strictEqual(other.res.statusCode, 403);
        assert.match(other.res.body.error, /no access/);
    });

    await test("the owner passes every page gate", () => {
        assert.ok(call(pageAuth("supporters"), { token: OWNER, method: "DELETE" }).passed);
    });

    await test("SSE / downloads with ?token= work the same", () => {
        assert.ok(call(pageAuth("stock"), { token: lanToken, query: true }).passed);
        assert.ok(!call(authMiddleware, { token: lanToken, query: true }).passed);
    });

    await test("edit writes go through and land in the audit log", () => {
        const w = call(pageAuth("orders"), { token: lanToken, method: "POST", url: "/api/shop/orders/2612/done?x=1" });
        assert.ok(w.passed);
        w.res.statusCode = 200;
        w.finish();
        const last = staff.auditLog({ userId: LAN, limit: 1 })[0];
        assert.strictEqual(last.action, "POST /api/shop/orders/2612/done");
        assert.strictEqual(last.status, 200);
        assert.strictEqual(last.ip, "203.0.113.7");
        assert.deepStrictEqual(lastLog(), { kind: "staff", text: "**u914** · Orders · `POST /api/shop/orders/2612/done` → ✅ 200" });
    });

    await test("permission changes apply to the very next request", () => {
        staff.update(LAN, { perms: { stock: "edit" } });
        assert.ok(call(pageAuth("stock"), { token: lanToken, method: "POST" }).passed);
        assert.strictEqual(call(pageAuth("orders"), { token: lanToken }).res.statusCode, 403);
    });

    console.log("ending sessions");

    await test("losing the Staff role signs them out at the next sweep", async () => {
        const { token } = await login(MINH, undefined, { device: "deviceMMMM0001" });
        staff.update(MINH, { perms: { decors: "view" } });
        // Make both sessions due for a check.
        sharedStore.raw().prepare("UPDATE staff_sessions SET role_checked_at = 0 WHERE ended_at IS NULL").run();
        const minhAccess = [...discord.tokens.entries()].filter(([, v]) => v.user.id === MINH).at(-1)[1];
        minhAccess.member = { roles: [] };
        await staff.sweep();
        assert.throws(() => identify(token), (e) => e.reason === "role_lost");
        assert.strictEqual(identify(lanToken).staff.userId, LAN);
        // Getting the role back is enough to sign in again: the entry stayed.
        assert.ok(staff.getStaff(MINH));
        await login(MINH, undefined, { device: "deviceMMMM0001" });
    });

    await test("Discord being down keeps them in; leaving the server or revoking does not", async () => {
        const lanAccess = [...discord.tokens.entries()].filter(([, v]) => v.user.id === LAN).at(-1)[1];
        sharedStore.raw().prepare("UPDATE staff_sessions SET role_checked_at = 0 WHERE ended_at IS NULL").run();
        lanAccess.member = "down";
        const warn = console.warn;
        console.warn = () => {};
        try { await staff.sweep(); } finally { console.warn = warn; }
        assert.strictEqual(identify(lanToken).staff.userId, LAN);

        const minhAccess = [...discord.tokens.entries()].filter(([, v]) => v.user.id === MINH).at(-1)[1];
        minhAccess.member = 404;
        lanAccess.member = 401;
        sharedStore.raw().prepare("UPDATE staff_sessions SET role_checked_at = 0 WHERE ended_at IS NULL").run();
        const log = console.log;
        console.log = () => {};
        try { await staff.sweep(); } finally { console.log = log; }
        assert.throws(() => identify(lanToken), (e) => e.reason === "discord_revoked");
        const minh = staff.sessions({ userId: MINH })[0];
        assert.strictEqual(minh.endReason, "left_guild");
    });

    await test("the owner can sign one session out", async () => {
        const { token } = await login(LAN, undefined, { device: "deviceBBBB2222" });
        const sid = jwt.decode(token).sid;
        staff.kick(sid);
        assert.throws(() => identify(token), (e) => e.reason === "kicked");
        assert.throws(() => staff.kick(sid), /already ended/);
        assert.strictEqual(staff.auditLog({ userId: LAN, limit: 1 })[0].action, "kicked by owner");
    });

    await test("signing out ends the session", async () => {
        const { token } = await login(LAN, undefined, { device: "deviceBBBB2222" });
        staff.logout(jwt.decode(token).sid);
        assert.throws(() => identify(token), (e) => e.reason === "logout");
    });

    await test("expired sessions end", async () => {
        const { token } = await login(LAN, undefined, { device: "deviceBBBB2222" });
        sharedStore.raw().prepare("UPDATE staff_sessions SET expires_at = 1 WHERE id = ?").run(jwt.decode(token).sid);
        assert.throws(() => identify(token), (e) => e.reason === "expired");
    });

    await test("removing someone ends their session and keeps the audit", async () => {
        const { token } = await login(LAN, undefined, { device: "deviceBBBB2222" });
        staff.remove(LAN);
        assert.throws(() => identify(token), (e) => e.reason === "removed");
        await rejects(() => login(LAN), 403, /no access/);
        assert.ok(staff.auditLog({ userId: LAN }).length > 3);
        assert.ok(!staff.list().some((s) => s.userId === LAN));
    });

    await test("a session row can't be borrowed by another user's token", async () => {
        await staff.add({ userId: LAN, perms: { stock: "view" } });
        const { token } = await login(LAN, undefined, { device: "deviceBBBB2222" });
        const forged = jwt.sign({ kind: "staff", sub: MINH, sid: jwt.decode(token).sid }, process.env.JWT_SECRET);
        assert.throws(() => identify(forged), (e) => e.status === 401);
    });

    await test("ended sessions drop the stored Discord token", () => {
        const rows = sharedStore.raw().prepare("SELECT discord_token FROM staff_sessions WHERE ended_at IS NOT NULL").all();
        assert.ok(rows.length > 3);
        assert.ok(rows.every((r) => r.discord_token === null));
        const live = sharedStore.raw().prepare("SELECT discord_token FROM staff_sessions WHERE ended_at IS NULL").all();
        assert.ok(live.every((r) => r.discord_token && !r.discord_token.includes("access")));
    });

    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
