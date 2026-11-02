#!/usr/bin/env node
/**
 * Checks for owner sign-in by IP (server/services/ownerAccess.js + routes/auth.js
 * + middleware/auth.js + routes/ownerIps.js): the owner account works only from
 * approved IPs; a right password from a new IP posts Allow / Deny on Discord and
 * the browser waits for the answer; Deny blocks the IP for 24 hours; wrong
 * passwords are limited per IP; the owner's token is refused from any other IP
 * on every request (bot logs and the terminal too); ADMIN_ALLOWED_IPS always
 * works; IPv6 goes by /64; unused IPs are forgotten after 30 days; the agent
 * gateway cannot pass an X-Real-IP of its choosing. Discord and the panel log
 * are stubbed.
 * Run:  node scripts/ownerAccess.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owner-ip-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-secret-for-owner-ips";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("right-pass", 4);
process.env.ADMIN_ALLOWED_IPS = "198.51.100.200";

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
stub("db", {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    find: async () => [],
    findOne: async () => null,
});

// The panel's bot: what it posted and edited, and the button handlers.
const discord = { posts: [], edits: [], handlers: new Map(), down: null };
stub("services/discordBus", {
    onButton: (prefix, fn) => discord.handlers.set(prefix, fn),
    post: async (channelId, payload) => {
        if (discord.down) throw new Error(discord.down);
        discord.posts.push({ channelId, payload });
        return { channelId, messageId: `m${discord.posts.length}` };
    },
    edit: async (ref, payload) => void discord.edits.push({ ref, payload }),
    canPost: async (channelId) => ({ ok: true, channel: "panel-log", guild: "Khai", botTag: "ArnTo Panel#1805", channelId }),
    userTag: async () => null,
});

const logged = [];
stub("services/panelLog", {
    add: (kind, text) => logged.push({ kind, text }),
    channel: async () => ({ channelId: "LOGCH", guildId: "G" }),
    captureConsole: () => {},
});

// The clock, for expiry and forgetting.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const lifecycle = require("../server/services/lifecycle");
lifecycle.activate();
const owner = require("../server/services/ownerAccess");
const { authMiddleware, isOwnerToken, clientIp, IP_NOT_APPROVED } = require("../server/middleware/auth");

// ── The app ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/auth", require("../server/routes/auth"));
app.use("/api/owner-ips", authMiddleware, require("../server/routes/ownerIps"));
app.get("/api/owner-only", authMiddleware, (req, res) => res.json({ ok: true }));
app.use("/api/logs", require("../server/routes/logs"));
let base;

const HOME = "203.0.113.7";
const CAFE = "203.0.113.50";
const ELSE = "192.0.2.9";

/** A request as nginx hands it over: from loopback, X-Real-IP = the browser. */
const call = async (method, url, { ip = HOME, body, token, headers = {} } = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            "content-type": "application/json",
            ...(ip ? { "x-real-ip": ip } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, data };
};
const signIn = (ip, password = "right-pass") => call("POST", "/api/auth/login", { ip, body: { username: "admin", password } });
const poll = (ip, w) => call("POST", "/api/auth/login/pending", { ip, body: { id: w.id, key: w.key } });

/** Somebody presses a button under the last approval message. */
const click = async (action, id, tag = "khai") => {
    const i = { user: { tag }, message: { embeds: [{ data: { title: "Owner sign-in from a new IP" } }] }, updated: null };
    i.update = async (p) => void (i.updated = p);
    await discord.handlers.get("owner-ip")(i, [action, id]);
    return i.updated;
};
const lastButtons = () => discord.posts.at(-1).payload.components[0].components.map((c) => c.custom_id);

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

(async () => {
    await owner._ready;
    const server = http.createServer(app).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    console.log("addresses");

    await test("IPv4 as it is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64", () => {
        assert.strictEqual(owner.ipKey("203.0.113.7"), "203.0.113.7");
        assert.strictEqual(owner.ipKey("::ffff:203.0.113.7"), "203.0.113.7");
        assert.strictEqual(owner.ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
        assert.strictEqual(owner.ipKey("2001:0db8:0001:0002::99"), "2001:db8:1:2::/64");
        assert.strictEqual(owner.ipKey("2001:db8::1"), "2001:db8:0:0::/64");
        assert.strictEqual(owner.ipKey("2001:db8:1:2::/64"), "2001:db8:1:2::/64");
        assert.strictEqual(owner.ipKey("fe80::1%eth0"), "fe80:0:0:0::/64");
        assert.strictEqual(owner.ipKey("not an ip"), null);
        assert.strictEqual(owner.ipKey(""), null);
    });

    await test("X-Real-IP counts from nginx (loopback), never through the agent gateway", () => {
        const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
        assert.strictEqual(clientIp(req("127.0.0.1", { "x-real-ip": HOME })), HOME);
        assert.strictEqual(clientIp(req("127.0.0.1", { "x-real-ip": HOME, "x-panel-gateway": "1" })), "127.0.0.1");
        assert.strictEqual(clientIp(req("10.8.0.3", { "x-real-ip": HOME })), "10.8.0.3");
    });

    console.log("wrong passwords");

    await test("a wrong password is 401, logged with the IP, and never reaches Discord", async () => {
        const r = await signIn(ELSE, "nope");
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.data.error, "Invalid credentials");
        assert.match(logged.at(-1).text, /wrong username or password · IP 192\.0\.2\.9/);
        assert.strictEqual(logged.at(-1).kind, "warn");
        assert.strictEqual((await call("POST", "/api/auth/login", { ip: ELSE, body: { username: "root", password: "right-pass" } })).status, 401);
        assert.strictEqual(discord.posts.length, 0);
    });

    await test("5 wrong in 15 minutes: that IP waits, even with the right password; others do not", async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await signIn(ELSE, "nope")).status, 401);
        assert.match(logged.at(-1).text, /5 in a row/);
        const r = await signIn(ELSE);
        assert.strictEqual(r.status, 429);
        assert.match(r.data.error, /Too many wrong sign-ins from this IP — try again in 15 minutes/);
        assert.strictEqual(discord.posts.length, 0);
        skew += 16 * 60 * 1000;
        assert.notStrictEqual((await signIn(ELSE, "nope")).status, 429, "the window passed");
    });

    console.log("a new IP");

    let first;
    let second;
    await test("right password from a new IP: 202, no token, Allow / Deny posted in the panel log channel", async () => {
        const r = await signIn(HOME);
        assert.strictEqual(r.status, 202);
        assert.ok(!r.data.token);
        first = r.data.pending;
        assert.strictEqual(first.ip, HOME);
        assert.ok(first.key.length >= 30 && first.expiresAt > Date.now());
        assert.strictEqual(discord.posts.length, 1);
        const { channelId, payload } = discord.posts[0];
        assert.strictEqual(channelId, "LOGCH");
        assert.strictEqual(payload.embeds[0].title, "Owner sign-in from a new IP");
        assert.ok(payload.embeds[0].fields.some((f) => f.value.includes(HOME)));
        assert.deepStrictEqual(lastButtons(), [`owner-ip:allow:${first.id}`, `owner-ip:deny:${first.id}`]);
        assert.deepStrictEqual(payload.allowedMentions, { parse: [] });
        assert.deepStrictEqual((await poll(HOME, first)).data.status, "pending");
    });

    await test("signing in again from that IP joins the open request (one message), with its own key", async () => {
        const r = await signIn(HOME);
        assert.strictEqual(r.status, 202);
        second = r.data.pending;
        assert.strictEqual(second.id, first.id);
        assert.notStrictEqual(second.key, first.key);
        assert.strictEqual(discord.posts.length, 1);
        assert.strictEqual((await poll(HOME, { id: first.id, key: "guessed" })).data.status, "expired");
    });

    let token;
    await test("Allow: the message says so, each waiting browser gets its token once", async () => {
        const updated = await click("allow", first.id);
        assert.strictEqual(updated.embeds[0].title, "Owner sign-in allowed");
        assert.deepStrictEqual(updated.components, []);
        assert.ok(updated.embeds[0].fields.some((f) => f.name === "Allowed by" && f.value.startsWith("khai")));
        assert.match(logged.find((l) => l.kind === "owner" && /allowed on Discord by khai/.test(l.text)).text, /203\.0\.113\.7/);

        const a = await poll(HOME, first);
        assert.strictEqual(a.data.status, "approved");
        assert.strictEqual(a.data.username, "admin");
        token = a.data.token;
        assert.ok(token);
        assert.strictEqual((await poll(HOME, first)).data.status, "expired", "only once");
        assert.ok((await poll(HOME, second)).data.token);
        assert.match(logged.at(-1).text, /\*\*Owner\*\* signed in \(allowed on Discord by khai\)/);
        assert.deepStrictEqual(store.get("owner_access").ips.map((e) => e.ip), [HOME]);
    });

    await test("a second click on the same message: no longer open", async () => {
        const updated = await click("deny", first.id);
        assert.match(updated.embeds[0].footer.text, /No longer open/);
        assert.deepStrictEqual(updated.components, []);
        assert.strictEqual(owner.allowed(HOME), true, "still allowed");
    });

    await test("next time from that IP the password is enough", async () => {
        const before = discord.posts.length;
        const r = await signIn(HOME);
        assert.strictEqual(r.status, 200);
        assert.ok(r.data.token);
        assert.strictEqual(discord.posts.length, before);
        assert.match(logged.at(-1).text, /^\*\*Owner\*\* signed in · IP 203\.0\.113\.7/);
    });

    console.log("every request");

    await test("the owner's token works from the approved IP only", async () => {
        assert.strictEqual((await call("GET", "/api/owner-only", { token })).status, 200);
        const away = await call("GET", "/api/owner-only", { ip: CAFE, token });
        assert.strictEqual(away.status, 401);
        assert.strictEqual(away.data.code, "AUTH_REQUIRED");
        assert.strictEqual(away.data.reason, IP_NOT_APPROVED);
        const verify = await call("GET", "/api/auth/verify", { ip: CAFE, token });
        assert.strictEqual(verify.status, 401);
        assert.strictEqual(verify.data.reason, IP_NOT_APPROVED);
        assert.strictEqual((await call("GET", "/api/auth/verify", { token })).data.kind, "owner");
    });

    await test("an X-Real-IP sent through the agent gateway is not believed", async () => {
        const r = await call("GET", "/api/owner-only", { token, headers: { "x-panel-gateway": "1" } });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.data.reason, IP_NOT_APPROVED);
    });

    await test("bot logs and the terminal (isOwnerToken) check the IP too, and need the request", async () => {
        assert.strictEqual((await call("DELETE", "/api/logs/nope", { ip: CAFE, token })).status, 401);
        assert.strictEqual((await call("DELETE", "/api/logs/nope", { token })).status, 404, "past the check: no such bot");
        const req = (ip) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": ip } });
        assert.strictEqual(isOwnerToken(token, req(HOME)), true);
        assert.strictEqual(isOwnerToken(token, req(CAFE)), false);
        assert.strictEqual(isOwnerToken(token), false);
        assert.strictEqual(isOwnerToken("garbage", req(HOME)), false);
    });

    console.log("deny, expiry, Discord down");

    await test("Deny: the browser hears it, and that IP cannot ask again for 24 hours", async () => {
        const w = (await signIn(CAFE)).data.pending;
        const updated = await click("deny", w.id, "khai");
        assert.strictEqual(updated.embeds[0].title, "Owner sign-in denied");
        assert.strictEqual((await poll(CAFE, w)).data.status, "denied");
        const again = await signIn(CAFE);
        assert.strictEqual(again.status, 403);
        assert.match(again.data.error, /denied on Discord — try again in 24 hours/);
        assert.deepStrictEqual(owner.list(HOME).blocked.map((b) => b.ip), [CAFE]);
        assert.strictEqual(owner.allowed(CAFE), false);
    });

    await test("Unblock lets it ask again (owner page)", async () => {
        const before = discord.posts.length;
        assert.strictEqual((await call("POST", "/api/owner-ips/unblock", { token, body: { ip: CAFE } })).status, 200);
        assert.strictEqual((await signIn(CAFE)).status, 202);
        assert.strictEqual(discord.posts.length, before + 1);
        assert.strictEqual((await call("POST", "/api/owner-ips/unblock", { token, body: { ip: CAFE } })).status, 404);
    });

    await test("nobody answers in 10 minutes: expired, and the message loses its buttons", async () => {
        const w = owner.list(HOME).pending.find((p) => p.ip === CAFE);
        assert.ok(w);
        const key = (await signIn(CAFE)).data.pending.key;
        skew += 11 * 60 * 1000;
        assert.strictEqual((await poll(CAFE, { id: w.id, key })).data.status, "expired");
        owner._sweep();
        assert.ok(discord.edits.some((e) => e.payload.embeds[0].title === "Owner sign-in request expired" && e.payload.components.length === 0));
        assert.match((await click("allow", w.id)).embeds[0].footer.text, /No longer open/);
        assert.strictEqual(owner.allowed(CAFE), false);
    });

    await test("Discord down: 503 that says how to get in (ADMIN_ALLOWED_IPS)", async () => {
        discord.down = "the panel's Discord bot is not connected";
        const r = await signIn("192.0.2.77");
        discord.down = null;
        assert.strictEqual(r.status, 503);
        assert.match(r.data.error, /could not be posted on Discord \(the panel's Discord bot is not connected\)/);
        assert.match(r.data.error, /ADMIN_ALLOWED_IPS/);
    });

    console.log("ADMIN_ALLOWED_IPS, IPv6, forgetting, the page");

    await test("ADMIN_ALLOWED_IPS gets in with the password alone, and cannot be removed on the page", async () => {
        const r = await signIn("198.51.100.200");
        assert.strictEqual(r.status, 200);
        assert.ok(r.data.token);
        const rm = await call("POST", "/api/owner-ips/remove", { token, body: { ip: "198.51.100.200" } });
        assert.strictEqual(rm.status, 400);
        assert.match(rm.data.error, /ADMIN_ALLOWED_IPS/);
    });

    await test("IPv6: an approved /64 lets the browser's next address in too", async () => {
        const w = (await signIn("2001:db8:1:2::10")).data.pending;
        await click("allow", w.id);
        assert.strictEqual((await signIn("2001:db8:1:2:ffff::99")).status, 200);
        assert.strictEqual((await signIn("2001:db8:1:3::10")).status, 202);
    });

    await test("the page: the list (this device marked), env ones, waiting ones, Discord status", async () => {
        const r = await call("GET", "/api/owner-ips", { token });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.currentIp, HOME);
        assert.ok(r.data.ips.find((e) => e.ip === HOME).current);
        assert.strictEqual(r.data.ips.find((e) => e.ip === HOME).approvedBy, "khai");
        assert.ok(r.data.ips.some((e) => e.ip === "2001:db8:1:2::/64"));
        assert.deepStrictEqual(r.data.env, [{ ip: "198.51.100.200", current: false }]);
        assert.ok(r.data.pending.some((p) => p.ip === "2001:db8:1:3::10"));
        assert.ok(!JSON.stringify(r.data.pending).includes("key"), "no waiting browser's key");
        assert.strictEqual(r.data.discord.ok, true);
        assert.strictEqual((await call("GET", "/api/owner-ips", { ip: CAFE, token })).status, 401);
    });

    await test("removing an IP on the page: that IP is out at once", async () => {
        assert.strictEqual((await call("POST", "/api/owner-ips/remove", { token, body: { ip: "2001:db8:1:2::5" } })).status, 200);
        assert.strictEqual(owner.allowed("2001:db8:1:2::77"), false);
        assert.match(logged.at(-1).text, /Owner IP `2001:db8:1:2::\/64` removed/);
        assert.strictEqual((await call("POST", "/api/owner-ips/remove", { token, body: { ip: "2001:db8:1:2::5" } })).status, 404);
    });

    await test("an IP unused for 30 days is forgotten (and said so in the log)", async () => {
        assert.strictEqual(owner.allowed(HOME), true);
        skew += 29 * 86_400_000;
        assert.strictEqual(owner.allowed(HOME), true, "used again: the 30 days start over");
        skew += 31 * 86_400_000;
        assert.strictEqual(owner.allowed(HOME), false);
        owner._sweep();
        await new Promise((r) => setImmediate(r)); // the write is queued behind the ones before it
        assert.ok(logged.some((l) => /Owner IP `203\.0\.113\.7` forgotten — not used for 30 days/.test(l.text)));
        assert.ok(!store.get("owner_access").ips.some((e) => e.ip === HOME));
        assert.strictEqual(owner.allowed("198.51.100.200"), true, "ADMIN_ALLOWED_IPS is never forgotten");
    });

    server.close();
    Date.now = realNow;
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
