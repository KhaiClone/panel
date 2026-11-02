#!/usr/bin/env node
/**
 * Checks for owner sign-in by device (server/services/ownerAccess.js +
 * routes/auth.js + middleware/auth.js + routes/ownerAccess.js): the owner
 * account works only on approved devices (an httpOnly cookie the panel gives
 * at a right password); a right password on a new device posts Allow / Deny on
 * Discord (pinging @everyone) and the browser waits for the answer — another
 * device on the same network asks on its own; an approved device keeps working
 * when its IP changes; Deny blocks the IP for 24 hours; wrong passwords are
 * limited per IP; the owner's token is refused without the device's cookie on
 * every request (bot logs and the terminal too); ADMIN_ALLOWED_IPS let any
 * device in; unused devices are forgotten after 30 days; the agent gateway
 * cannot pass an X-Real-IP of its choosing. Discord and the panel log are stubbed.
 * Run:  node scripts/ownerAccess.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owner-device-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-secret-for-owner-devices";
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
    canPost: async (channelId, extra) => ({ ok: true, channel: "panel-log", guild: "Khai", botTag: "ArnTo Panel#1805", channelId, extra }),
    userTag: async () => null,
});

const logged = [];
stub("services/panelLog", {
    add: (kind, text) => logged.push({ kind, text }),
    captureConsole: () => {},
});

// The clock, for expiry and forgetting.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const lifecycle = require("../server/services/lifecycle");
lifecycle.activate();
const owner = require("../server/services/ownerAccess");
const { authMiddleware, isOwnerToken, clientIp, DEVICE_NOT_APPROVED } = require("../server/middleware/auth");

// ── The app ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use("/api/auth", require("../server/routes/auth"));
app.use("/api/owner-access", authMiddleware, require("../server/routes/ownerAccess"));
app.get("/api/owner-only", authMiddleware, (req, res) => res.json({ ok: true }));
app.use("/api/logs", require("../server/routes/logs"));
let base;

const HOME = "203.0.113.7";
const MOBILE = "203.0.113.120";
const ELSE = "192.0.2.9";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** A browser: where it is, what it says it is, and the cookie it keeps. */
const browser = (ip, ua = WINDOWS_CHROME) => ({ ip, ua, cookie: null, setCookie: null });

/** A request as nginx hands it over: from loopback, X-Real-IP = the browser. */
const call = async (b, method, url, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            "content-type": "application/json",
            "user-agent": b.ua,
            ...(b.ip ? { "x-real-ip": b.ip } : {}),
            ...(b.cookie ? { cookie: `${owner.COOKIE}=${b.cookie}` } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${owner.COOKIE}=`));
    if (set) {
        b.setCookie = set;
        b.cookie = set.split(";")[0].split("=")[1];
    }
    const text = await res.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, data };
};
const signIn = (b, password = "right-pass", headers) => call(b, "POST", "/api/auth/login", { body: { username: "admin", password }, headers });
const poll = (b, w) => call(b, "POST", "/api/auth/login/pending", { body: { id: w.id, key: w.key } });

/** Somebody presses a button under an approval message. */
const click = async (action, id, tag = "khai") => {
    const i = { user: { tag }, message: { embeds: [{ data: { title: "Owner sign-in from a new device" } }] }, updated: null };
    i.update = async (p) => void (i.updated = p);
    await discord.handlers.get("owner-device")(i, [action, id]);
    return i.updated;
};
const lastPayload = () => discord.posts.at(-1).payload;
const lastButtons = () => lastPayload().components[0].components.map((c) => c.custom_id);
const tick = () => new Promise((r) => setImmediate(r));

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

    console.log("addresses and devices");

    await test("IPv4 as it is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64", () => {
        assert.strictEqual(owner.ipKey("203.0.113.7"), "203.0.113.7");
        assert.strictEqual(owner.ipKey("::ffff:203.0.113.7"), "203.0.113.7");
        assert.strictEqual(owner.ipKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
        assert.strictEqual(owner.ipKey("2001:0db8:0001:0002::99"), "2001:db8:1:2::/64");
        assert.strictEqual(owner.ipKey("2001:db8::1"), "2001:db8:0:0::/64");
        assert.strictEqual(owner.ipKey("not an ip"), null);
        assert.strictEqual(owner.ipKey(""), null);
    });

    await test("X-Real-IP counts from nginx (loopback), never through the agent gateway", () => {
        const req = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
        assert.strictEqual(clientIp(req("127.0.0.1", { "x-real-ip": HOME })), HOME);
        assert.strictEqual(clientIp(req("127.0.0.1", { "x-real-ip": HOME, "x-panel-gateway": "1" })), "127.0.0.1");
        assert.strictEqual(clientIp(req("10.8.0.3", { "x-real-ip": HOME })), "10.8.0.3");
    });

    await test("a device has a readable name, and its key is read from the cookie only when well-formed", () => {
        assert.strictEqual(owner.deviceName(WINDOWS_CHROME), "Chrome on Windows");
        assert.strictEqual(owner.deviceName(IPHONE), "Safari on iOS");
        assert.strictEqual(owner.deviceName("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36"), "Chrome on Android");
        assert.strictEqual(owner.deviceName("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36 Edg/141.0"), "Edge on Windows");
        assert.strictEqual(owner.deviceName("Mozilla/5.0 (Windows NT 10.0) coc_coc_browser/150.0 Chrome/140.0 Safari/537.36"), "Coc Coc on Windows");
        assert.strictEqual(owner.deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/140.0"), "Firefox on macOS");
        assert.strictEqual(owner.deviceName(""), "A browser");
        const good = "a".repeat(43);
        assert.strictEqual(owner.deviceOf({ headers: { cookie: `x=1; ${owner.COOKIE}=${good}; y=2` } }), good);
        assert.strictEqual(owner.deviceOf({ headers: { cookie: `${owner.COOKIE}=short` } }), null);
        assert.strictEqual(owner.deviceOf({ headers: {} }), null);
    });

    console.log("wrong passwords");

    await test("a wrong password is 401, logged with the IP, gives no cookie and never reaches Discord", async () => {
        const b = browser(ELSE);
        const r = await signIn(b, "nope");
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.data.error, "Invalid credentials");
        assert.strictEqual(b.cookie, null);
        assert.match(logged.at(-1).text, /wrong username or password · IP 192\.0\.2\.9/);
        assert.strictEqual(logged.at(-1).kind, "warn");
        assert.strictEqual(discord.posts.length, 0);
    });

    await test("5 wrong in 15 minutes: that IP waits, even with the right password", async () => {
        const b = browser(ELSE);
        for (let i = 0; i < 4; i++) assert.strictEqual((await signIn(b, "nope")).status, 401);
        assert.match(logged.at(-1).text, /5 in a row/);
        const r = await signIn(b);
        assert.strictEqual(r.status, 429);
        assert.match(r.data.error, /Too many wrong sign-ins from this IP — try again in 15 minutes/);
        assert.strictEqual(discord.posts.length, 0);
        skew += 16 * 60 * 1000;
        assert.notStrictEqual((await signIn(b, "nope")).status, 429, "the window passed");
    });

    console.log("a new device");

    const laptop = browser(HOME);
    let first;
    let second;
    await test("right password on a new device: 202, an httpOnly device cookie, Allow / Deny posted with @everyone", async () => {
        const r = await signIn(laptop);
        assert.strictEqual(r.status, 202);
        assert.ok(!r.data.token);
        first = r.data.pending;
        assert.strictEqual(first.name, "Chrome on Windows");
        assert.strictEqual(first.ip, HOME);
        assert.ok(laptop.cookie && laptop.cookie.length === 43);
        assert.match(laptop.setCookie, /HttpOnly/);
        assert.match(laptop.setCookie, /SameSite=Lax/);
        assert.match(laptop.setCookie, /Path=\//);
        assert.doesNotMatch(laptop.setCookie, /Secure/, "plain http here");
        assert.strictEqual(discord.posts.length, 1);
        const { channelId, payload } = discord.posts[0];
        assert.strictEqual(channelId, "1497117161079181433", "the default approval channel");
        assert.strictEqual(payload.content, "@everyone");
        assert.deepStrictEqual(payload.allowedMentions, { parse: ["everyone"] });
        assert.strictEqual(payload.embeds[0].title, "Owner sign-in from a new device");
        assert.ok(payload.embeds[0].fields.some((f) => f.name === "Device" && f.value === "Chrome on Windows"));
        assert.ok(payload.embeds[0].fields.some((f) => f.name === "IP" && f.value.includes(HOME)));
        assert.deepStrictEqual(lastButtons(), [`owner-device:allow:${first.id}`, `owner-device:deny:${first.id}`]);
        assert.strictEqual(lastPayload().components[0].components[0].label, "Allow this device");
        assert.strictEqual((await poll(laptop, first)).data.status, "pending");
    });

    await test("behind HTTPS (nginx says so) the cookie is Secure too", async () => {
        const b = browser("192.0.2.30");
        await signIn(b, "right-pass", { "x-forwarded-proto": "https" });
        assert.match(b.setCookie, /Secure/);
    });

    await test("signing in again on that device joins the open request (one message), with its own key", async () => {
        const before = discord.posts.length;
        const r = await signIn(laptop);
        assert.strictEqual(r.status, 202);
        second = r.data.pending;
        assert.strictEqual(second.id, first.id);
        assert.notStrictEqual(second.key, first.key);
        assert.strictEqual(discord.posts.length, before);
        assert.strictEqual((await poll(laptop, { id: first.id, key: "guessed" })).data.status, "expired");
    });

    const phoneSameWifi = browser(HOME, IPHONE);
    let phoneWait;
    await test("another device on the same network asks on its own", async () => {
        const before = discord.posts.length;
        const r = await signIn(phoneSameWifi);
        assert.strictEqual(r.status, 202);
        phoneWait = r.data.pending;
        assert.notStrictEqual(phoneWait.id, first.id);
        assert.notStrictEqual(phoneSameWifi.cookie, laptop.cookie);
        assert.strictEqual(phoneWait.name, "Safari on iOS");
        assert.strictEqual(discord.posts.length, before + 1);
    });

    let token;
    await test("Allow: the message says so, the device's browsers get their token once, another device cannot collect it", async () => {
        const updated = await click("allow", first.id);
        assert.strictEqual(updated.embeds[0].title, "Owner sign-in allowed");
        assert.match(updated.embeds[0].description, /Chrome on Windows/);
        assert.deepStrictEqual(updated.components, []);
        assert.ok(updated.embeds[0].fields.some((f) => f.name === "Allowed by" && f.value.startsWith("khai")));
        assert.ok(logged.some((l) => l.kind === "owner" && /Owner device \*\*Chrome on Windows\*\* allowed on Discord by khai · IP 203\.0\.113\.7/.test(l.text)));

        const thief = browser(HOME, IPHONE);
        thief.cookie = phoneSameWifi.cookie;
        assert.strictEqual((await poll(thief, first)).data.status, "expired", "right key, wrong device");

        const a = await poll(laptop, first);
        assert.strictEqual(a.data.status, "approved");
        assert.strictEqual(a.data.username, "admin");
        token = a.data.token;
        assert.ok(token);
        assert.strictEqual((await poll(laptop, first)).data.status, "expired", "only once");
        assert.ok((await poll(laptop, second)).data.token);
        assert.match(logged.at(-1).text, /\*\*Owner\*\* signed in \(allowed on Discord by khai\) · Chrome on Windows · IP 203\.0\.113\.7/);
        const saved = store.get("owner_access").devices;
        assert.strictEqual(saved.length, 1);
        assert.strictEqual(saved[0].name, "Chrome on Windows");
        assert.ok(!JSON.stringify(saved).includes(laptop.cookie), "only the hash is kept");
        assert.strictEqual((await poll(phoneSameWifi, phoneWait)).data.status, "pending", "the phone still waits");
    });

    await test("a second click on the same message: no longer open", async () => {
        const updated = await click("deny", first.id);
        assert.match(updated.embeds[0].footer.text, /No longer open/);
        assert.deepStrictEqual(updated.components, []);
    });

    await test("next time on that device the password is enough — from another network too", async () => {
        const before = discord.posts.length;
        assert.strictEqual((await signIn(laptop)).status, 200);
        laptop.ip = MOBILE;
        const r = await signIn(laptop);
        assert.strictEqual(r.status, 200);
        assert.ok(r.data.token);
        assert.strictEqual(discord.posts.length, before);
        assert.match(logged.at(-1).text, /^\*\*Owner\*\* signed in · Chrome on Windows · IP 203\.0\.113\.120/);
    });

    console.log("every request");

    await test("the owner's token works with the device's cookie only, whatever the IP", async () => {
        assert.strictEqual((await call(laptop, "GET", "/api/owner-only", { token })).status, 200);
        const copied = browser(HOME);
        const away = await call(copied, "GET", "/api/owner-only", { token });
        assert.strictEqual(away.status, 401);
        assert.strictEqual(away.data.code, "AUTH_REQUIRED");
        assert.strictEqual(away.data.reason, DEVICE_NOT_APPROVED);
        const other = await call(phoneSameWifi, "GET", "/api/owner-only", { token });
        assert.strictEqual(other.status, 401, "a device not approved, same Wi-Fi");
        const verify = await call(copied, "GET", "/api/auth/verify", { token });
        assert.strictEqual(verify.status, 401);
        assert.strictEqual(verify.data.reason, DEVICE_NOT_APPROVED);
        assert.strictEqual((await call(laptop, "GET", "/api/auth/verify", { token })).data.kind, "owner");
    });

    await test("bot logs and the terminal (isOwnerToken) check the device too, and need the request", async () => {
        assert.strictEqual((await call(browser(HOME), "DELETE", "/api/logs/nope", { token })).status, 401);
        assert.strictEqual((await call(laptop, "DELETE", "/api/logs/nope", { token })).status, 404, "past the check: no such bot");
        const req = (cookie) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-real-ip": ELSE, ...(cookie ? { cookie: `${owner.COOKIE}=${cookie}` } : {}) } });
        assert.strictEqual(isOwnerToken(token, req(laptop.cookie)), true);
        assert.strictEqual(isOwnerToken(token, req(phoneSameWifi.cookie)), false);
        assert.strictEqual(isOwnerToken(token, req(null)), false);
        assert.strictEqual(isOwnerToken(token), false);
        assert.strictEqual(isOwnerToken("garbage", req(laptop.cookie)), false);
    });

    console.log("deny, expiry, Discord down");

    await test("Deny: the browser hears it, and that IP cannot ask again for 24 hours (any device)", async () => {
        const cafe = browser("203.0.113.50", IPHONE);
        const w = (await signIn(cafe)).data.pending;
        const updated = await click("deny", w.id, "khai");
        assert.strictEqual(updated.embeds[0].title, "Owner sign-in denied");
        assert.strictEqual((await poll(cafe, w)).data.status, "denied");
        const again = await signIn(browser("203.0.113.50"));
        assert.strictEqual(again.status, 403);
        assert.match(again.data.error, /denied on Discord — try again in 24 hours/);
        assert.deepStrictEqual(owner.list({ ip: HOME }).blocked.map((b) => b.ip), ["203.0.113.50"]);
    });

    await test("Unblock lets it ask again (owner page)", async () => {
        const before = discord.posts.length;
        assert.strictEqual((await call(laptop, "POST", "/api/owner-access/unblock", { token, body: { ip: "203.0.113.50" } })).status, 200);
        assert.strictEqual((await signIn(browser("203.0.113.50"))).status, 202);
        assert.strictEqual(discord.posts.length, before + 1);
        assert.strictEqual((await call(laptop, "POST", "/api/owner-access/unblock", { token, body: { ip: "203.0.113.50" } })).status, 404);
    });

    await test("nobody answers in 10 minutes: expired, and the message loses its buttons", async () => {
        skew += 11 * 60 * 1000;
        assert.strictEqual((await poll(phoneSameWifi, phoneWait)).data.status, "expired");
        owner._sweep();
        assert.ok(discord.edits.some((e) => e.payload.embeds[0].title === "Owner sign-in request expired" && e.payload.components.length === 0));
        assert.match((await click("allow", phoneWait.id)).embeds[0].footer.text, /No longer open/);
        assert.strictEqual((await call(phoneSameWifi, "GET", "/api/owner-only", { token })).status, 401);
    });

    await test("Discord down: 503 that says how to get in (ADMIN_ALLOWED_IPS)", async () => {
        discord.down = "the panel's Discord bot is not connected";
        const r = await signIn(browser("192.0.2.77"));
        discord.down = null;
        assert.strictEqual(r.status, 503);
        assert.match(r.data.error, /could not be posted on Discord \(the panel's Discord bot is not connected\)/);
        assert.match(r.data.error, /ADMIN_ALLOWED_IPS/);
    });

    console.log("ADMIN_ALLOWED_IPS, the page, forgetting");

    await test("ADMIN_ALLOWED_IPS: any device gets in with the password alone, only from there", async () => {
        const b = browser("198.51.100.200");
        const r = await signIn(b);
        assert.strictEqual(r.status, 200);
        b.cookie = null; // even without its cookie
        assert.strictEqual((await call(b, "GET", "/api/owner-only", { token: r.data.token })).status, 200);
        b.ip = ELSE;
        assert.strictEqual((await call(b, "GET", "/api/owner-only", { token: r.data.token })).status, 401);
    });

    await test("the page: devices (this one marked, no hash), env IPs, waiting ones, Discord status with @everyone", async () => {
        const w = (await signIn(browser("192.0.2.88", IPHONE))).data.pending;
        const r = await call(laptop, "GET", "/api/owner-access", { token });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.currentIp, MOBILE);
        const mine = r.data.devices.find((d) => d.current);
        assert.strictEqual(mine.name, "Chrome on Windows");
        assert.strictEqual(mine.approvedBy, "khai");
        assert.strictEqual(mine.lastIp, MOBILE);
        assert.ok(!("hash" in mine));
        assert.ok(!JSON.stringify(r.data).includes(laptop.cookie));
        assert.deepStrictEqual(r.data.env, [{ ip: "198.51.100.200", current: false }]);
        const waiting = r.data.pending.find((p) => p.id === w.id);
        assert.strictEqual(waiting.name, "Safari on iOS");
        assert.ok(!JSON.stringify(r.data.pending).includes(w.key), "no waiting browser's key");
        assert.strictEqual(r.data.discord.ok, true);
        assert.deepStrictEqual(r.data.discord.extra, ["MentionEveryone"]);
        assert.strictEqual((await call(browser(HOME), "GET", "/api/owner-access", { token })).status, 401);
    });

    await test("removing a device on the page: it is out at once", async () => {
        const tablet = browser("192.0.2.99");
        const w = (await signIn(tablet)).data.pending;
        await click("allow", w.id);
        const tabletToken = (await poll(tablet, w)).data.token;
        assert.strictEqual((await call(tablet, "GET", "/api/owner-only", { token: tabletToken })).status, 200);
        const list = (await call(laptop, "GET", "/api/owner-access", { token })).data.devices;
        const id = list.find((d) => !d.current).id;
        assert.strictEqual((await call(laptop, "POST", "/api/owner-access/remove", { token, body: { id } })).status, 200);
        assert.strictEqual((await call(tablet, "GET", "/api/owner-only", { token: tabletToken })).status, 401);
        assert.match(logged.at(-1).text, /Owner device \*\*Chrome on Windows\*\* removed on the panel/);
        assert.strictEqual((await call(laptop, "POST", "/api/owner-access/remove", { token, body: { id } })).status, 404);
        assert.strictEqual((await call(laptop, "GET", "/api/owner-only", { token })).status, 200, "the laptop is untouched");
    });

    await test("a device unused for 30 days is forgotten (and said so in the log)", async () => {
        const req = { ip: HOME, device: laptop.cookie };
        assert.strictEqual(owner.allowed(req), true);
        skew += 29 * 86_400_000;
        assert.strictEqual(owner.allowed(req), true, "used again: the 30 days start over");
        skew += 31 * 86_400_000;
        assert.strictEqual(owner.allowed(req), false);
        owner._sweep();
        await tick();
        assert.ok(logged.some((l) => /Owner device \*\*Chrome on Windows\*\* forgotten — not used for 30 days/.test(l.text)));
        assert.deepStrictEqual(store.get("owner_access").devices, []);
        assert.strictEqual(owner.allowed({ ip: "198.51.100.200", device: null }), true, "ADMIN_ALLOWED_IPS is never forgotten");
    });

    server.close();
    Date.now = realNow;
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
