#!/usr/bin/env node
/**
 * Checks for CLI access keys (server/services/cliAccess.js + routes/cliAccess.js
 * + middleware/auth.js + the CLI sessions in services/termService.js +
 * scripts/panel-cli.js): a client asks with only its key's hash; the panel's
 * bot posts Allow 7/30/90 days / no expiry / Deny with a code; the key then is
 * the owner on every route with no device, and its writes are logged; Deny
 * blocks the IP for 24 hours; requests are limited per IP and in total and can
 * be turned off; keys expire and can be revoked; `exec` runs a command through
 * the Terminal WebSocket (a fake agent plays the shell) with the command in
 * the panel log, the exit code passed back, and Ctrl-C on a timeout; login
 * saves the key in the config file. Discord and the panel log are stubbed.
 * Run:  node scripts/cliAccess.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const express = require("express");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cli-access-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");
process.env.JWT_SECRET = "test-secret-for-cli-keys";
process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync("right-pass", 4);
process.env.ADMIN_ALLOWED_IPS = "";
process.env.BOT_PANEL_CLI_CONFIG = path.join(TMP, "cli.json");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const BOT = { _id: "b1", name: "Shop Bot", pm2Name: "123-shop", buyerID: "123", botID: "shop", nodeId: "n1" };
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
stub("db", {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    find: async () => [],
    findOne: async (col, q) => (col === "bots" && q._id === BOT._id ? clone(BOT) : null),
});

const discord = { posts: [], edits: [], handlers: new Map() };
stub("services/discordBus", {
    onButton: (prefix, fn) => discord.handlers.set(prefix, fn),
    post: async (channelId, payload) => {
        discord.posts.push({ channelId, payload });
        return { channelId, messageId: `m${discord.posts.length}` };
    },
    edit: async (ref, payload) => void discord.edits.push({ ref, payload }),
    canPost: async () => ({ ok: true, channel: "panel-log", guild: "Khai", botTag: "Panel#0001" }),
    userTag: async () => null,
});

const logged = [];
stub("services/panelLog", { add: (kind, text) => logged.push({ kind, text }), captureConsole: () => {} });

// The fake agent behind node n1 (its port is filled in once it listens).
const NODE = { _id: "n1", name: "alpha", host: "203.0.113.50", controlHost: "127.0.0.1", port: 0, apiKey: "agent-key" };
stub("services/nodeService", {
    getNode: async (id) => {
        if (id !== NODE._id) throw new Error("Node not found");
        return { ...NODE };
    },
});
stub("services/executor", { target: (bot) => ({ root: "bots", dir: `${bot.buyerID}/${bot.botID}` }) });

const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;

const lifecycle = require("../server/services/lifecycle");
lifecycle.activate();
const cli = require("../server/services/cliAccess");
const { authMiddleware, pageAuth, CLI_KEY_INVALID } = require("../server/middleware/auth");
const termService = require("../server/services/termService");
const panelCli = require("./panel-cli");

// ── The app ──────────────────────────────────────────────────────────────────
const health = { state: "active", ok: true, url: null };
const app = express();
app.use(express.json());
app.get("/api/health", (req, res) => res.json(health));
app.use("/api/auth", require("../server/routes/auth"));
app.use("/api/cli-access/login", require("../server/routes/cliAccess").login);
app.use("/api/cli-access", authMiddleware, require("../server/routes/cliAccess").panel);
app.get("/api/owner-only", authMiddleware, (req, res) => res.json({ ok: true, cli: req.auth.cli?.name || null }));
app.post("/api/owner-only", authMiddleware, (req, res) => res.json({ ok: true }));
app.get("/api/orders-page", pageAuth("orders"), (req, res) => res.json({ ok: true }));
app.get("/api/nodes", authMiddleware, (req, res) => res.json([{ _id: NODE._id, name: NODE.name, status: "online" }]));
app.get("/api/bots", authMiddleware, (req, res) => res.json([BOT]));
let base;

/** A request as nginx hands it over: from loopback, X-Real-IP = the client. */
const call = async (ip, method, url, { body, key } = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            "content-type": "application/json",
            ...(ip ? { "x-real-ip": ip } : {}),
            ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
};

const newKey = () => {
    const key = "bpc_" + crypto.randomBytes(32).toString("base64url");
    return { key, keyHash: crypto.createHash("sha256").update(key).digest("hex") };
};
const ask = (ip, k, name = "DESKTOP-TEST (dev)") => call(ip, "POST", "/api/cli-access/login", { body: { name, keyHash: k.keyHash } });
const pollFor = (ip, id, k) => call(ip, "POST", "/api/cli-access/login/poll", { body: { id, keyHash: k.keyHash } });

/** Somebody presses a button under a request on Discord. */
const click = async (action, id, days, tag = "khai") => {
    const i = { user: { tag }, message: { embeds: [{ data: { title: "CLI access key requested" } }] }, updated: null };
    i.update = async (p) => void (i.updated = p);
    await discord.handlers.get("cli-key")(i, days === undefined ? [action, id] : [action, id, String(days)]);
    return i.updated;
};
const lastPayload = () => discord.posts.at(-1).payload;
const logsSince = (n) => logged.slice(n).map((l) => l.text);

/** A writable that keeps what it was given. */
const sink = () => {
    const s = { text: "", write: (t) => void (s.text += t) };
    return s;
};

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

// ── The fake agent: a "shell" that understands the panel's run line ──────────
const agent = { sessions: [], hang: false, splitEnd: false };
const startAgent = async () => {
    const server = http.createServer((req, res) => res.end());
    const wss = new WebSocket.Server({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        if (req.headers["x-agent-key"] !== NODE.apiKey) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (ws, req) => {
        const s = { query: Object.fromEntries(new URL(req.url, "http://x").searchParams), frames: [] };
        agent.sessions.push(s);
        const send = (data) => ws.send(JSON.stringify({ type: "data", data }));
        send("Welcome to the test node\r\nuser@alpha:~$ ");
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            s.frames.push(msg);
            if (msg.type !== "input") return;
            if (msg.data === "\x03") return send("^C\r\nuser@alpha:~$ ");
            const b64 = msg.data.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/);
            const tag = msg.data.match(/__PCLI_BEGIN_([a-z0-9]+);/);
            if (!b64 || !tag) return;
            const command = Buffer.from(b64[1], "base64").toString("utf8");
            s.command = command;
            // The terminal echoes the whole line first (stty -echo comes too late for it).
            send(msg.data.replace(/\r$/, "") + "\r\n");
            if (agent.hang) return;
            send(`__PCLI_BEGIN_${tag[1]}:\r\n`);
            if (command === "echo hello") {
                send("hello\r\n");
                send(`\r\n__PCLI_END_${tag[1]}:0\r\nuser@alpha:~$ `);
            } else {
                // Coloured output in pieces, and the END marker split over two frames.
                send("\x1b[32mline one\x1b[0m\r\nline ");
                send("two\r\n");
                const end = `\r\n__PCLI_END_${tag[1]}:3\r\n`;
                send(end.slice(0, 9));
                send(end.slice(9) + "user@alpha:~$ ");
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    NODE.port = server.address().port;
    return server;
};

(async () => {
    await cli._ready;
    const agentServer = await startAgent();
    const server = http.createServer(app).listen(0, "127.0.0.1");
    termService.attachTermServer(server);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    const HOME = "203.0.113.7";
    const ELSE = "198.51.100.9";
    const FAR = "192.0.2.44";

    console.log("asking for a key");

    await test("a request needs a sha256 hash and a machine name", async () => {
        assert.strictEqual((await call(HOME, "POST", "/api/cli-access/login", { body: { name: "x", keyHash: "bpc_plainkey" } })).status, 400);
        assert.strictEqual((await call(HOME, "POST", "/api/cli-access/login", { body: { name: "  ", keyHash: newKey().keyHash } })).status, 400);
        assert.strictEqual(discord.posts.length, 0);
    });

    const k1 = newKey();
    let req1;
    await test("a request posts Allow 30/7/90/no expiry + Deny with its code, pinging @everyone", async () => {
        const r = await ask(HOME, k1);
        assert.strictEqual(r.status, 200);
        req1 = r.data;
        assert.match(req1.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
        const p = lastPayload();
        assert.strictEqual(p.content, "@everyone");
        assert.deepStrictEqual(p.allowedMentions, { parse: ["everyone"] });
        assert.deepStrictEqual(
            p.components[0].components.map((c) => c.custom_id),
            [`cli-key:allow:${req1.id}:30`, `cli-key:allow:${req1.id}:7`, `cli-key:allow:${req1.id}:90`, `cli-key:allow:${req1.id}:0`, `cli-key:deny:${req1.id}`],
        );
        const f = Object.fromEntries(p.embeds[0].fields.map((x) => [x.name, x.value]));
        assert.strictEqual(f.Code, `\`${req1.code}\``);
        assert.strictEqual(f.IP, `\`${HOME}\``);
        assert.strictEqual(f.Machine, "DESKTOP-TEST (dev)");
        assert.ok(!JSON.stringify(p).includes(k1.key), "the key itself never reaches Discord");
        assert.match(logged.at(-1).text, /CLI key requested for \*\*DESKTOP-TEST \(dev\)\*\*/);
    });

    await test("while it waits the key opens nothing, and only the asker's hash can poll", async () => {
        const r = await call(HOME, "GET", "/api/owner-only", { key: k1.key });
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.data.code, "AUTH_REQUIRED");
        assert.strictEqual(r.data.reason, CLI_KEY_INVALID);
        assert.strictEqual((await pollFor(HOME, req1.id, k1)).data.status, "pending");
        assert.strictEqual((await pollFor(HOME, req1.id, newKey())).data.status, "expired");
    });

    await test("asking again with the same hash is refused", async () => {
        assert.strictEqual((await ask(HOME, k1)).status, 409);
    });

    console.log("allowed");

    await test("Allow 30 days: the message closes, the client hears it, the key lasts 30 days", async () => {
        const msg = await click("allow", req1.id, 30);
        assert.strictEqual(msg.embeds[0].title, "CLI access key allowed");
        assert.deepStrictEqual(msg.components, []);
        const r = await pollFor(HOME, req1.id, k1);
        assert.strictEqual(r.data.status, "approved");
        assert.strictEqual(r.data.decidedBy, "khai");
        assert.ok(Math.abs(r.data.expiresAt - (Date.now() + 30 * 86_400_000)) < 5000);
        assert.ok(logged.some((l) => /CLI key for \*\*DESKTOP-TEST \(dev\)\*\* allowed on Discord by khai · 30 days/.test(l.text)));
        // A second click on the closed request changes nothing.
        const again = await click("allow", req1.id, 0);
        assert.match(again.embeds[0].footer.text, /No longer open/);
    });

    await test("the key is the owner — with no device cookie, from any IP — and the first use is logged", async () => {
        const n = logged.length;
        const r = await call(HOME, "GET", "/api/owner-only", { key: k1.key });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.cli, "DESKTOP-TEST (dev)");
        assert.ok(logsSince(n).some((t) => /used for the first time · IP 203\.0\.113\.7/.test(t)));
        assert.strictEqual((await call(HOME, "GET", "/api/orders-page", { key: k1.key })).status, 200);
        const v = await call(HOME, "GET", "/api/auth/verify", { key: k1.key });
        assert.strictEqual(v.data.kind, "owner");
        assert.strictEqual(v.data.cli.name, "DESKTOP-TEST (dev)");
        const m = logged.length;
        assert.strictEqual((await call(FAR, "GET", "/api/owner-only", { key: k1.key })).status, 200);
        assert.ok(logsSince(m).some((t) => /used from a new IP · IP 192\.0\.2\.44/.test(t)));
    });

    await test("reads are not logged; writes are, with the route and the status", async () => {
        const n = logged.length;
        await call(FAR, "GET", "/api/owner-only", { key: k1.key });
        assert.strictEqual(logged.length, n);
        await call(FAR, "POST", "/api/owner-only", { key: k1.key, body: {} });
        assert.match(logged.at(-1).text, /CLI \*\*DESKTOP-TEST \(dev\)\*\* · `POST \/api\/owner-only` → 200/);
    });

    await test("a made-up or malformed key is refused", async () => {
        assert.strictEqual((await call(HOME, "GET", "/api/owner-only", { key: newKey().key })).status, 401);
        assert.strictEqual((await call(HOME, "GET", "/api/owner-only", { key: "bpc_short" })).status, 401);
    });

    await test("the Security page lists the key without its hash", async () => {
        const r = await call(HOME, "GET", "/api/cli-access", { key: k1.key });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.data.keys.length, 1);
        assert.strictEqual(r.data.keys[0].name, "DESKTOP-TEST (dev)");
        assert.strictEqual(r.data.keys[0].askedIp, HOME);
        assert.ok(!("hash" in r.data.keys[0]));
        assert.strictEqual(r.data.accepting, true);
        assert.strictEqual(r.data.discord.ok, true);
    });

    console.log("denied, limited, turned off");

    await test("Deny: the client hears it and that IP cannot ask for 24 hours, until unblocked", async () => {
        const k = newKey();
        const r = await ask(ELSE, k);
        assert.strictEqual(r.status, 200);
        const msg = await click("deny", r.data.id);
        assert.strictEqual(msg.embeds[0].title, "CLI access key denied");
        assert.strictEqual((await pollFor(ELSE, r.data.id, k)).data.status, "denied");
        const again = await ask(ELSE, newKey());
        assert.strictEqual(again.status, 403);
        assert.match(again.data.error, /denied on Discord/);
        assert.strictEqual((await call(HOME, "GET", "/api/owner-only", { key: k.key })).status, 401);
        assert.strictEqual((await call(HOME, "POST", "/api/cli-access/unblock", { key: k1.key, body: { ip: ELSE } })).status, 200);
        const third = await ask(ELSE, newKey());
        assert.strictEqual(third.status, 200);
        await click("deny", third.data.id);
        await call(HOME, "POST", "/api/cli-access/unblock", { key: k1.key, body: { ip: ELSE } });
    });

    await test("3 requests per IP in 15 minutes; at most 3 waiting from everyone", async () => {
        const ip = "198.51.100.77";
        const ids = [];
        for (let i = 0; i < 3; i++) {
            const r = await ask(ip, newKey());
            assert.strictEqual(r.status, 200, JSON.stringify(r.data));
            ids.push(r.data.id);
        }
        const busy = await ask("198.51.100.78", newKey());
        assert.strictEqual(busy.status, 429);
        assert.match(busy.data.error, /waiting for approval/);
        // Ten minutes on, the requests have expired but the IP's count has not.
        skew += 11 * 60_000;
        cli._sweep();
        assert.ok(discord.edits.some((e) => e.payload.embeds[0].title === "CLI access key request expired"));
        const tooMany = await ask(ip, newKey());
        assert.strictEqual(tooMany.status, 429);
        assert.match(tooMany.data.error, /from this IP/);
        const other = await ask("198.51.100.78", newKey());
        assert.strictEqual(other.status, 200);
        await click("deny", other.data.id);
        await call(HOME, "POST", "/api/cli-access/unblock", { key: k1.key, body: { ip: "198.51.100.78" } });
        skew += 5 * 60_000;
        cli._sweep();
    });

    await test("Accept new requests off: asking is refused, keys keep working", async () => {
        assert.strictEqual((await call(HOME, "POST", "/api/cli-access/accepting", { key: k1.key, body: { on: false } })).status, 200);
        const r = await ask(FAR, newKey());
        assert.strictEqual(r.status, 403);
        assert.match(r.data.error, /turned off/);
        assert.strictEqual((await call(HOME, "GET", "/api/owner-only", { key: k1.key })).status, 200);
        await call(HOME, "POST", "/api/cli-access/accepting", { key: k1.key, body: { on: true } });
        assert.strictEqual(store.get("cli_access").accepting, true);
    });

    console.log("expiry and revoking");

    await test("Allow 7 days ends after 7 days; no expiry stays; the sweep logs the end", async () => {
        const short = newKey();
        const forever = newKey();
        const a = await ask(FAR, short, "LAPTOP");
        await click("allow", a.data.id, 7);
        const b = await ask(FAR, forever, "SERVER");
        await click("allow", b.data.id, 0);
        assert.strictEqual((await pollFor(FAR, b.data.id, forever)).data.expiresAt, null);
        assert.strictEqual((await call(FAR, "GET", "/api/owner-only", { key: short.key })).status, 200);
        skew += 8 * 86_400_000;
        assert.strictEqual((await call(FAR, "GET", "/api/owner-only", { key: short.key })).status, 401);
        assert.strictEqual((await call(FAR, "GET", "/api/owner-only", { key: forever.key })).status, 200);
        cli._sweep();
        await new Promise((r) => setTimeout(r, 20)); // the write behind persist()
        assert.ok(logged.some((l) => /CLI key \*\*LAPTOP\*\* expired/.test(l.text)));
        assert.ok(!store.get("cli_access").keys.some((k) => k.name === "LAPTOP"));
        // Revoke the forever key: it stops at once.
        const id = store.get("cli_access").keys.find((k) => k.name === "SERVER").id;
        assert.strictEqual((await call(HOME, "POST", "/api/cli-access/revoke", { key: forever.key, body: { id } })).status, 200);
        assert.strictEqual((await call(FAR, "GET", "/api/owner-only", { key: forever.key })).status, 401);
        // The revoke, then (it was this key's own write) the write itself.
        assert.match(logged.at(-2).text, /CLI key \*\*SERVER\*\* revoked/);
        assert.match(logged.at(-1).text, /CLI \*\*SERVER\*\* · `POST \/api\/cli-access\/revoke` → 200/);
    });

    // k1 was allowed for 30 days; 8 days have passed. Make a fresh one for the rest.
    console.log("login and exec (scripts/panel-cli.js)");

    let key;
    await test("login asks with a hash, waits for Allow and saves the key in the config file", async () => {
        const lines = [];
        const done = panelCli.login(base, { name: "CLAUDE-BOX", log: (l) => lines.push(l), pollMs: 50 });
        for (let i = 0; i < 100 && !discord.posts.some((p) => JSON.stringify(p.payload).includes("CLAUDE-BOX")); i++) await new Promise((r) => setTimeout(r, 20));
        const post = discord.posts.at(-1).payload;
        const code = post.embeds[0].fields.find((f) => f.name === "Code").value.replace(/`/g, "");
        assert.ok(lines.some((l) => l.includes(code)), "the terminal shows the same code");
        const id = post.components[0].components[0].custom_id.split(":")[2];
        await click("allow", id, 90);
        const r = await done;
        const cfg = JSON.parse(fs.readFileSync(process.env.BOT_PANEL_CLI_CONFIG, "utf8"));
        assert.strictEqual(cfg.url, base);
        assert.match(cfg.key, /^bpc_[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(cfg.expiresAt, r.expiresAt);
        assert.ok(!lines.join("\n").includes(cfg.key), "the key is never printed");
        key = cfg.key;
        assert.strictEqual((await call(null, "GET", "/api/owner-only", { key })).status, 200);
    });

    await test("resolveBase follows /api/health: its url, or where a fenced panel went", async () => {
        assert.strictEqual(await panelCli.resolveBase(base), base);
        health.url = "https://panel.example.test/";
        assert.strictEqual(await panelCli.resolveBase(base), "https://panel.example.test");
        health.url = null;
        Object.assign(health, { state: "fenced", movedTo: base });
        // movedTo points back here, so it hops until the limit — a loop is refused, not followed forever.
        await assert.rejects(panelCli.resolveBase(base), /Too many hops/);
        Object.assign(health, { state: "active", movedTo: undefined });
    });

    await test("exec on a node: the output alone, exit code 0, the command in the panel log", async () => {
        const out = sink();
        const err = sink();
        const n = logged.length;
        const code = await panelCli.exec({ base, key, node: "alpha", command: "echo hello", timeoutS: 10, out, err });
        assert.strictEqual(code, 0);
        assert.strictEqual(out.text, "hello\n");
        const s = agent.sessions.at(-1);
        assert.strictEqual(s.command, "echo hello");
        assert.deepStrictEqual(s.query, {}, "a node shell has no project target");
        const input = s.frames.find((f) => f.type === "input").data;
        assert.ok(input.startsWith(" stty -echo"), "the run line starts with a space (kept out of history)");
        assert.ok(!input.includes("echo hello"), "the command travels base64");
        assert.ok(logsSince(n).some((t) => t === "CLI **CLAUDE-BOX** · shell on node **alpha** · ran `echo hello`"), logsSince(n).join("\n"));
    });

    await test("exec in a project: its folder on its node; split markers and colours; the exit code passes back", async () => {
        const out = sink();
        const n = logged.length;
        const code = await panelCli.exec({ base, key, bot: "123-shop", command: "ls\nfalse", timeoutS: 10, out, err: sink() });
        assert.strictEqual(code, 3);
        assert.strictEqual(out.text, "line one\nline two\n");
        const s = agent.sessions.at(-1);
        assert.deepStrictEqual(s.query, { root: "bots", dir: "123/shop" });
        assert.strictEqual(s.command, "ls\nfalse");
        assert.ok(logsSince(n).some((t) => t.startsWith("CLI **CLAUDE-BOX** · shell on **Shop Bot** on node **alpha** · ran `ls")));
    });

    await test("a command that does not finish gets Ctrl-C at the timeout (exit 124), and the Ctrl-C is logged", async () => {
        agent.hang = true;
        const err = sink();
        const n = logged.length;
        const code = await panelCli.exec({ base, key, node: "n1", command: "sleep 100", timeoutS: 1, out: sink(), err });
        agent.hang = false;
        assert.strictEqual(code, 124);
        assert.match(err.text, /timed out after 1 s/);
        assert.ok(agent.sessions.at(-1).frames.some((f) => f.type === "input" && f.data === "\x03"));
        assert.ok(logsSince(n).some((t) => /typed `\^C`/.test(t)));
    });

    await test("unknown names are refused before any shell opens", async () => {
        const before = agent.sessions.length;
        await assert.rejects(panelCli.exec({ base, key, node: "beta", command: "id", out: sink(), err: sink() }), /No node "beta"/);
        await assert.rejects(panelCli.exec({ base, key, node: "alpha", bot: "x", command: "id", out: sink(), err: sink() }), /Say where/);
        assert.strictEqual(agent.sessions.length, before);
    });

    await test("a revoked key opens no shell", async () => {
        const id = store.get("cli_access").keys.find((k) => k.name === "CLAUDE-BOX").id;
        cli.revoke(id);
        const before = agent.sessions.length;
        const ws = new WebSocket(`${base.replace("http", "ws")}/api/term?node=n1`, { headers: { authorization: `Bearer ${key}` } });
        const status = await new Promise((r) => {
            ws.on("unexpected-response", (req, res) => r(res.statusCode));
            ws.on("open", () => r("open"));
            ws.on("error", () => r("error"));
        });
        assert.ok(status === 401 || status === "error", `got ${status}`);
        assert.strictEqual(agent.sessions.length, before);
    });

    console.log("pieces");

    await test("the run line carries any command intact (lines, quotes, Unicode)", () => {
        const command = "cat <<'EOF'\nxin chào — 'quotes' \"too\" $HOME `tick`\nEOF";
        const line = termService.runLine(command, "abcdef12");
        const b64 = line.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/)[1];
        assert.strictEqual(Buffer.from(b64, "base64").toString("utf8"), command);
        assert.ok(!line.slice(0, -1).includes("\n") && !line.slice(0, -1).includes("\r"), "one line");
        assert.ok(line.endsWith("\r"));
    });

    await test("the marker reader never mistakes the echoed line for a marker", () => {
        const r = panelCli.markerReader("abcdef12");
        const line = termService.runLine("echo hi", "abcdef12");
        assert.strictEqual(r.feed(line + "\r\n"), "");
        assert.strictEqual(r.feed("__PCLI_BEGIN_abcdef12:\r\nhi\r\n\r\n__PCLI_END_abcdef12:0\r\n"), "hi\n");
        assert.strictEqual(r.done, 0);
    });

    await test("parseArgs: flags, positionals, and everything after -- as the command", () => {
        const a = panelCli.parseArgs(["exec", "--node", "alpha", "--timeout=30", "--", "pm2", "jlist", "--no-color"]);
        assert.strictEqual(a.cmd, "exec");
        assert.deepStrictEqual(a.flags, { node: "alpha", timeout: "30" });
        assert.deepStrictEqual(a.tail, ["pm2", "jlist", "--no-color"]);
    });

    agentServer.close();
    server.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
