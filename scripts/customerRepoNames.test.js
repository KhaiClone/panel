#!/usr/bin/env node
/**
 * Checks for customer repos, phase 5 (server/services/customerRepoNames.js and its routes):
 * New repo makes an empty private repo in the org named by the template ({username}-{botname}
 * unless the owner sets another), never a name GitHub still redirects; the weekly check renames
 * the customer repos when the names change — the projects' URLs and their checkouts' origin
 * follow (a node that cannot be reached is tried again at the next check) — and leaves alone
 * repos that are not a customer's, archived, shared, or no longer used. A name of its own is
 * kept until the owner puts the repo back on the template. GitHub and the nodes are fakes.
 * Run:  node scripts/customerRepoNames.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-customer-repo-names";

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const match = (e, q) => Object.keys(q).every((k) => e[k] === q[k]);
let nextId = 1;
const db = {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
    create: async (m, d) => {
        d._id = `id${nextId++}`;
        store.set(m, [...(store.get(m) || []), clone(d)]);
        return clone(d);
    },
    find: async (m, q = {}) => clone((store.get(m) || []).filter((e) => match(e, q))),
    findOne: async (m, q) => clone((store.get(m) || []).find((e) => match(e, q))),
    findOneAndUpdate: async (m, q, d) => {
        const arr = store.get(m) || [];
        const i = arr.findIndex((e) => match(e, q));
        if (i === -1) return null;
        arr[i] = { ...arr[i], ...clone(d) };
        return clone(arr[i]);
    },
    findOneAndDelete: async () => null,
};
stub("db", db);

const CUSTOMER = "427399742906040333";
const CUSTOMER_B = "427399742906040444";
const BOT = "1480411893448573009";
const BOT_2 = "1480411893448573010";
const PERSON = "427399742906040555";
const users = {
    [CUSTOMER]: { id: CUSTOMER, username: "khach.a", globalName: "Customer A", bot: false },
    [CUSTOMER_B]: { id: CUSTOMER_B, username: "khachb", globalName: null, bot: false },
    [PERSON]: { id: PERSON, username: "someone", globalName: null, bot: false },
    [BOT]: { id: BOT, username: "lofimusic", globalName: "Lofi Music", bot: true },
    [BOT_2]: { id: BOT_2, username: "Mèo Kiếm Cá", globalName: null, bot: true },
};
let busUp = true;
stub("services/discordBus", {
    fetchUser: async (id) => {
        if (!busUp) return undefined;
        if (!users[id]) throw Object.assign(new Error("Unknown User"), { code: 10013 });
        return { ...users[id] };
    },
    status: () => ({ ready: busUp }),
    discordClient: () => null,
});

// The nodes: each project's checkout origin, as its agent would report it.
const origins = new Map(); // project _id → origin URL
const offline = new Set(); // project _ids whose node does not answer
const oldAgent = new Set(); // project _ids on an agent without /git/remote
const ORIGIN = /^(.*[:/])([\w.-]+\/[\w.-]+?)(\.git)?(\/?)$/;
stub("services/executor", {
    gitInfo: async (bot) => ({ repoUrl: offline.has(bot._id) ? null : origins.get(bot._id) || null, branch: "main" }),
    setGitRemote: async (bot, from, to) => {
        if (offline.has(bot._id)) throw new Error("[Node vps] connect ECONNREFUSED");
        if (oldAgent.has(bot._id)) throw new Error("[Node vps] Request failed with status code 404 — this node's agent is older than 1.15.0; update it (Update Agent)");
        const m = ORIGIN.exec(origins.get(bot._id) || "");
        if (!m || m[2].toLowerCase() !== from.toLowerCase()) throw Object.assign(new Error("[Node vps] origin is something else — left as it is"), { status: 409 });
        origins.set(bot._id, `${m[1]}${to}${m[3] || ""}${m[4]}`);
        return { changed: true };
    },
});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });

// ── A fake GitHub API ────────────────────────────────────────────────────────
const ORG = "acme-customers";
const GOOD = ["test", "token", "good"].join("-");
const READONLY = ["test", "token", "readonly"].join("-");
let repoId = 100;
const repos = new Map(); // id → repo
const shape = (r) => {
    r.full_name = `${r.owner.login}/${r.name}`;
    r.html_url = `https://github.com/${r.full_name}`;
    r.ssh_url = `git@github.com:${r.full_name}.git`;
    r.clone_url = `https://github.com/${r.full_name}.git`;
    return r;
};
const addRepo = (name, extra = {}) => {
    const r = shape({ id: ++repoId, name, owner: { login: ORG }, private: true, archived: false, description: null, pushed_at: "2026-10-01T00:00:00Z", ...extra });
    repos.set(r.id, r);
    return r;
};
const moved = new Map(); // "owner/name" (lower) → repo id: GitHub's redirects after a rename
const find = (owner, name) => [...repos.values()].find((r) => r.full_name.toLowerCase() === `${owner}/${name}`.toLowerCase());
const gh = express();
gh.use(express.json());
const calls = [];
gh.use((req, res, next) => {
    calls.push(`${req.method} ${req.path}`);
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${GOOD}` && auth !== `Bearer ${READONLY}`) return res.status(401).json({ message: "Bad credentials" });
    req.readonly = auth === `Bearer ${READONLY}`;
    next();
});
gh.get("/orgs/:org", (req, res) => (req.params.org.toLowerCase() === ORG ? res.json({ login: ORG }) : res.status(404).json({ message: "Not Found" })));
gh.get("/orgs/:org/repos", (req, res) => {
    const all = [...repos.values()].filter((r) => r.owner.login === ORG).sort((a, b) => a.full_name.localeCompare(b.full_name));
    const per = Number(req.query.per_page) || 30;
    const page = Number(req.query.page) || 1;
    res.json(all.slice((page - 1) * per, page * per));
});
gh.post("/orgs/:org/repos", (req, res) => {
    if (req.readonly) return res.status(403).json({ message: "Resource not accessible by personal access token" });
    if (find(ORG, req.body.name)) return res.status(422).json({ message: "Repository creation failed." });
    moved.delete(`${ORG}/${req.body.name}`.toLowerCase()); // a new repo kills the redirect
    res.status(201).json(addRepo(req.body.name, { private: !!req.body.private, description: req.body.description || null, pushed_at: null }));
});
gh.get("/repositories/:id", (req, res) => {
    const r = repos.get(Number(req.params.id));
    return r ? res.json(r) : res.status(404).json({ message: "Not Found" });
});
const repoRoute = (req, res, next) => {
    const r = find(req.params.owner, req.params.name);
    if (r) {
        req.repo = r;
        return next();
    }
    const id = moved.get(`${req.params.owner}/${req.params.name}`.toLowerCase());
    if (id && req.method === "GET") return res.redirect(301, `/repositories/${id}`);
    res.status(404).json({ message: "Not Found" });
};
gh.get("/repos/:owner/:name", repoRoute, (req, res) => res.json(req.repo));
gh.patch("/repos/:owner/:name", repoRoute, (req, res) => {
    if (req.readonly) return res.status(403).json({ message: "Resource not accessible by personal access token" });
    if (req.repo.archived && req.body.archived !== false) return res.status(403).json({ message: "Repository was archived so is read-only." });
    if (req.body.name && req.body.name !== req.repo.name) {
        const other = find(ORG, req.body.name);
        if (other && other.id !== req.repo.id) return res.status(422).json({ message: "name already exists on this account" });
        moved.set(req.repo.full_name.toLowerCase(), req.repo.id);
        req.repo.name = req.body.name;
        shape(req.repo);
    }
    for (const k of ["description", "archived"]) if (k in req.body) req.repo[k] = req.body[k];
    res.json(req.repo);
});

const reposService = require("../server/services/customerRepos");
const names = require("../server/services/customerRepoNames");
const routes = require("../server/routes/customerProjects");

// ── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const check = async (name, fn) => {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        const where = err.stack.split("\n").find((l) => l.includes("customerRepoNames.test.js")) || "";
        console.log(`  ✗ ${name}\n      ${err.message.split("\n").slice(0, 8).join("\n      ")}\n      ${where.trim()}`);
    }
};
const app = express();
app.use(express.json());
app.use("/api/customer-projects", routes);
let base;
const call = (method, url, body) =>
    new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request(
            `${base}${url}`,
            { method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
            (res) => {
                let raw = "";
                res.on("data", (c) => (raw += c));
                res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
            },
        );
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });

/** A project on a node, cloned from `repo` (its origin as the agent's clone writes it). */
const project = async ({ repo, url, name = "P", customer = {}, enabled = true, buyerID = CUSTOMER }) => {
    const repoUrl = url || `git@github.com-deploy:${repo.full_name}.git`;
    const p = await db.create("bots", {
        buyerID,
        botID: `p${nextId}`,
        name,
        projectType: "discord",
        repoUrl,
        customer: { enabled, botUserId: BOT, buyerName: "khach.a", botName: "Lofi Music", ...customer },
    });
    origins.set(p._id, `git@github.com:${repo.full_name}.git`);
    return p;
};
const bot = (id) => db.findOne("bots", { _id: id });
const repoById = (id) => repos.get(id);
const runCheck = async () => {
    const r = await call("POST", "/api/customer-projects/repos/check-names");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
};
const listed = async () => {
    const r = await call("GET", "/api/customer-projects/repos");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body;
};

// ── Tests ────────────────────────────────────────────────────────────────────
(async () => {
    const ghServer = gh.listen(0);
    await new Promise((r) => ghServer.once("listening", r));
    reposService._setApiBase(`http://127.0.0.1:${ghServer.address().port}`);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
    await reposService.setSettings({ org: ORG, token: GOOD });

    console.log("names");
    await check("a field becomes what GitHub takes: marks, đ and fancy letters gone; '.' and '_' kept", () => {
        assert.strictEqual(names.part("Mèo Kiếm Cá"), "meo-kiem-ca");
        assert.strictEqual(names.part("Đồ Ăn Ngon!!"), "do-an-ngon");
        assert.strictEqual(names.part("𝓐𝓻𝓷 Bot"), "arn-bot");
        assert.strictEqual(names.part("khach.a"), "khach.a");
        assert.strictEqual(names.part("louw_"), "louw_");
        assert.deepStrictEqual(names.render("{username}-{botname}", { username: "khach.a", botname: "Lofi Music" }), { name: "khach.a-lofi-music" });
        assert.deepStrictEqual(names.render("{username}-{botname}", { username: "khach.a" }), { missing: ["botname"] });
        assert.strictEqual(names.render("{username}-{botname}", { username: "a".repeat(80), botname: "b".repeat(80) }).name.length, 100);
    });
    await check("a template needs a known field and only repo-name characters around them", () => {
        assert.strictEqual(names.checkTemplate(" bot-{username}_{botid} "), "bot-{username}_{botid}");
        assert.throws(() => names.checkTemplate("bot"), /at least one field/);
        assert.throws(() => names.checkTemplate("{user}-{botname}"), /no field \{user\}/);
        assert.throws(() => names.checkTemplate("{username} {botname}"), /letters, digits/);
    });

    console.log("New repo");
    await check("the template names it from the Discord ids; an empty private repo in the org, the customer in its description", async () => {
        const pre = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER, botUserId: BOT });
        assert.strictEqual(pre.status, 200, JSON.stringify(pre.body));
        assert.deepStrictEqual(pre.body, { org: ORG, name: "khach.a-lofi-music", custom: false, username: "khach.a", botName: "Lofi Music" });
        assert.ok(!calls.includes(`POST /orgs/${ORG}/repos`), "a preview makes nothing");
        const r = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER, botUserId: BOT });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.fullName, `${ORG}/khach.a-lofi-music`);
        assert.strictEqual(r.body.sshUrl, `git@github.com:${ORG}/khach.a-lofi-music.git`);
        const made = find(ORG, "khach.a-lofi-music");
        assert.strictEqual(made.private, true);
        assert.strictEqual(made.description, `Lofi Music · customer @khach.a (${CUSTOMER})`);
        assert.ok(logLines.some((l) => l === `owner: Owner made the repo ${ORG}/khach.a-lofi-music for @khach.a`));
    });
    await check("the same customer and bot name again → -2; a project with no bot takes the name typed for it", async () => {
        const again = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER, botUserId: BOT });
        assert.strictEqual(again.body.name, "khach.a-lofi-music-2");
        const web = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER, label: "Shop Web" });
        assert.strictEqual(web.body.name, "khach.a-shop-web");
        const noName = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER });
        assert.strictEqual(noName.status, 400);
        assert.match(noName.body.error, /the bot's name on Discord is not known yet/);
    });
    await check("a name of its own; a taken one, a person as the bot, a bot as the customer are refused", async () => {
        const own = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER_B, botUserId: BOT_2, name: "special-one" });
        assert.strictEqual(own.body.name, "special-one");
        const taken = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER, name: "special-one" });
        assert.strictEqual(taken.status, 409);
        assert.match(taken.body.error, /special-one is taken/);
        const person = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER, botUserId: PERSON });
        assert.match(person.body.error, /someone is a person, not a bot/);
        const botAsCustomer = await call("POST", "/api/customer-projects/repos/preview", { buyerID: BOT });
        assert.match(botAsCustomer.body.error, /lofimusic is a bot/);
        const bad = await call("POST", "/api/customer-projects/repos/preview", { buyerID: "abc" });
        assert.strictEqual(bad.status, 400);
    });
    await check("with Discord down the name cannot be made — it says so; a typed name still works", async () => {
        busUp = false;
        try {
            const r = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER, botUserId: BOT });
            assert.strictEqual(r.status, 400);
            assert.match(r.body.error, /Discord bot is not connected/);
            const typed = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER, name: "typed-by-hand" });
            assert.strictEqual(typed.body.name, "typed-by-hand");
        } finally {
            busUp = true;
        }
    });
    await check("a token that may not make repos gets a clear 403", async () => {
        await reposService.setSettings({ token: READONLY });
        try {
            const r = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER_B, botUserId: BOT_2 });
            assert.strictEqual(r.status, 403);
            assert.match(r.body.error, /did not let the token make a repo in acme-customers/);
        } finally {
            await reposService.setSettings({ token: GOOD });
        }
    });

    console.log("the weekly check");
    // Repos named by hand after the customer's username, as before.
    const KHACH = addRepo("khach.a");
    const kP = await project({ repo: KHACH });
    const MEO = addRepo("khachb");
    const meoP = await project({ repo: MEO, buyerID: CUSTOMER_B, customer: { botUserId: BOT_2, buyerName: "khachb", botName: "Mèo Kiếm Cá" } });
    const PERSONAL = addRepo("team-tool");
    await project({ repo: PERSONAL, enabled: false });
    const SPARE = addRepo("spare-thing");
    const OLD = addRepo("old-archived", { archived: true });
    await project({ repo: OLD });
    const SHARED = addRepo("shared-code");
    await project({ repo: SHARED });
    await project({ repo: SHARED });

    await check("the Repos page shows what the next check would call each repo, before anything changes", async () => {
        const body = await listed();
        const by = (n) => body.repos.find((r) => r.name === n).naming;
        assert.strictEqual(body.naming.template, "{username}-{botname}");
        assert.strictEqual(by("khach.a").next, "khach.a-lofi-music-3");
        assert.strictEqual(by("khachb").next, "khachb-meo-kiem-ca");
        assert.strictEqual(by("team-tool").managed, false);
        assert.strictEqual(by("spare-thing").managed, false);
        assert.match(by("old-archived").note, /Archived/);
        assert.match(by("shared-code").problem, /Used by 2 customer projects/);
        assert.strictEqual(by("special-one").custom, true);
        assert.strictEqual(KHACH.name, "khach.a", "nothing renamed yet");
    });
    await check("renamed to the template; the project's URL keeps its SSH alias and its checkout pulls the new name", async () => {
        const out = await runCheck();
        assert.deepStrictEqual(out.renamed.map((x) => `${x.from}→${x.to}`).sort(), ["khach.a→khach.a-lofi-music-3", "khachb→khachb-meo-kiem-ca"]);
        assert.strictEqual((await bot(kP._id)).repoUrl, `git@github.com-deploy:${ORG}/khach.a-lofi-music-3.git`);
        assert.strictEqual(origins.get(kP._id), `git@github.com:${ORG}/khach.a-lofi-music-3.git`);
        assert.strictEqual(origins.get(meoP._id), `git@github.com:${ORG}/khachb-meo-kiem-ca.git`);
        assert.strictEqual(PERSONAL.name, "team-tool");
        assert.strictEqual(SPARE.name, "spare-thing");
        assert.strictEqual(OLD.name, "old-archived");
        assert.strictEqual(SHARED.name, "shared-code");
        assert.ok(out.problems.some((p) => p.repo === "shared-code" && /2 customer projects/.test(p.text)));
        assert.ok(logLines.some((l) => l === `owner: Renamed the customer repo ${ORG}/khach.a → ${ORG}/khach.a-lofi-music-3 (name check)`));
    });
    await check("a second check renames nothing — and -2, -3 do not flip between repos", async () => {
        const before = calls.filter((c) => c.startsWith("PATCH")).length;
        const out = await runCheck();
        assert.deepStrictEqual(out.renamed, []);
        assert.strictEqual(calls.filter((c) => c.startsWith("PATCH")).length, before);
        assert.ok(find(ORG, "khach.a-lofi-music") && find(ORG, "khach.a-lofi-music-2") && find(ORG, "khach.a-lofi-music-3"));
    });
    await check("the customer changes their username → renamed again; a node that cannot be reached is tried at the next check", async () => {
        await db.findOneAndUpdate("bots", { _id: meoP._id }, { customer: { ...(await bot(meoP._id)).customer, buyerName: "meo.moi" } });
        offline.add(meoP._id);
        const out = await runCheck();
        assert.deepStrictEqual(out.renamed.map((x) => x.to), ["meo.moi-meo-kiem-ca"]);
        assert.ok(out.problems.some((p) => /could not be read \(node offline\?\)/.test(p.text)));
        assert.strictEqual(origins.get(meoP._id), `git@github.com:${ORG}/khachb-meo-kiem-ca.git`, "not reached");
        assert.strictEqual((await bot(meoP._id)).repoUrl, `git@github.com-deploy:${ORG}/meo.moi-meo-kiem-ca.git`, "the record follows anyway");
        assert.strictEqual((await listed()).repos.find((r) => r.name === "meo.moi-meo-kiem-ca").naming.pendingOrigins, 1);
        offline.delete(meoP._id);
        const next = await runCheck();
        assert.deepStrictEqual(next.renamed, []);
        assert.ok(!next.problems.some((p) => p.repo === "meo.moi-meo-kiem-ca"), JSON.stringify(next.problems));
        assert.strictEqual(origins.get(meoP._id), `git@github.com:${ORG}/meo.moi-meo-kiem-ca.git`, "fixed through the redirect");
        assert.strictEqual((await listed()).repos.find((r) => r.name === "meo.moi-meo-kiem-ca").naming.pendingOrigins, 0);
    });
    await check("an agent without /git/remote: the problem says to update it, and it stays pending", async () => {
        await db.findOneAndUpdate("bots", { _id: meoP._id }, { customer: { ...(await bot(meoP._id)).customer, buyerName: "meo.moi2" } });
        oldAgent.add(meoP._id);
        const out = await runCheck();
        assert.ok(out.problems.some((p) => /older than 1\.15\.0/.test(p.text)), JSON.stringify(out.problems));
        oldAgent.delete(meoP._id);
        await runCheck();
        assert.strictEqual(origins.get(meoP._id), `git@github.com:${ORG}/meo.moi2-meo-kiem-ca.git`);
    });
    await check("a name GitHub still redirects is never handed out: New repo takes the next free one", async () => {
        // "khachb-meo-kiem-ca" and "meo.moi-meo-kiem-ca" are old names now.
        users[CUSTOMER_B] = { ...users[CUSTOMER_B], username: "meo.moi" };
        const r = await call("POST", "/api/customer-projects/repos/preview", { buyerID: CUSTOMER_B, botUserId: BOT_2 });
        assert.strictEqual(r.body.name, "meo.moi-meo-kiem-ca-2");
        users[CUSTOMER_B] = { ...users[CUSTOMER_B], username: "khachb" };
    });
    await check("a repo the panel made, waiting for its first project, follows Discord; once a project used it and left, it keeps its name", async () => {
        const made = await call("POST", "/api/customer-projects/repos", { buyerID: CUSTOMER_B, botUserId: BOT });
        assert.strictEqual(made.body.name, "khachb-lofi-music");
        users[CUSTOMER_B] = { ...users[CUSTOMER_B], username: "khachb.new" };
        const out = await runCheck();
        assert.ok(out.renamed.some((x) => x.from === "khachb-lofi-music" && x.to === "khachb.new-lofi-music"), JSON.stringify(out.renamed));
        const repo = find(ORG, "khachb.new-lofi-music");
        const p = await project({ repo, buyerID: CUSTOMER_B, customer: { buyerName: "khachb.new" } });
        await runCheck(); // adopted: used now
        await db.set("bots", (await db.get("bots")).filter((b) => b._id !== p._id)); // the project is deleted
        users[CUSTOMER_B] = { ...users[CUSTOMER_B], username: "khachb.newer" };
        const after = await runCheck();
        assert.ok(!after.renamed.some((x) => x.id === repo.id));
        assert.match((await listed()).repos.find((r) => r.id === repo.id).naming.note, /No project uses it any more/);
    });

    console.log("a name of its own");
    await check("set → renamed now, its project follows; the weekly check leaves it; back to the template → renamed now", async () => {
        const r = await call("PUT", `/api/customer-projects/repos/${encodeURIComponent("khach.a-lofi-music-3")}/name`, { customName: "vip-lofi" });
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual(r.body, { name: "vip-lofi", problems: [] });
        assert.strictEqual(origins.get(kP._id), `git@github.com:${ORG}/vip-lofi.git`);
        assert.strictEqual((await bot(kP._id)).repoUrl, `git@github.com-deploy:${ORG}/vip-lofi.git`);
        const out = await runCheck();
        assert.ok(!out.renamed.some((x) => x.from === "vip-lofi"));
        const back = await call("PUT", "/api/customer-projects/repos/vip-lofi/name", { customName: null });
        assert.strictEqual(back.status, 200, JSON.stringify(back.body));
        assert.strictEqual(back.body.name, "khach.a-lofi-music-3", "its old name is its own redirect, so it may have it back");
        assert.strictEqual(origins.get(kP._id), `git@github.com:${ORG}/khach.a-lofi-music-3.git`);
    });
    await check("a taken name, an archived repo, a repo no customer uses → refused with why", async () => {
        const taken = await call("PUT", "/api/customer-projects/repos/khach.a-lofi-music-3/name", { customName: "khach.a-lofi-music" });
        assert.strictEqual(taken.status, 409);
        const arch = await call("PUT", "/api/customer-projects/repos/old-archived/name", { customName: "x-y" });
        assert.match(arch.body.error, /archived/);
        const spare = await call("PUT", "/api/customer-projects/repos/spare-thing/name", { customName: null });
        assert.strictEqual(spare.status, 409);
        assert.match(spare.body.error, /No customer project uses this repo/);
        const bad = await call("PUT", "/api/customer-projects/repos/spare-thing/name", { customName: "has space" });
        assert.strictEqual(bad.status, 400);
    });

    console.log("the template");
    await check("a new template renames at the next check; a bad one is refused; empty goes back to the default", async () => {
        const bad = await call("PUT", "/api/customer-projects/repo-naming", { template: "{nope}" });
        assert.strictEqual(bad.status, 400);
        const set = await call("PUT", "/api/customer-projects/repo-naming", { template: "{username}-{botid}" });
        assert.strictEqual(set.body.template, "{username}-{botid}");
        const out = await runCheck();
        assert.ok(out.renamed.some((x) => x.to === `khach.a-${BOT}`), JSON.stringify(out.renamed));
        const reset = await call("PUT", "/api/customer-projects/repo-naming", { template: "" });
        assert.strictEqual(reset.body.template, "{username}-{botname}");
        const naming = await call("GET", "/api/customer-projects/repo-naming");
        assert.strictEqual(naming.body.lastCheck.by, "owner");
        assert.strictEqual(naming.body.schedule.day, "Monday");
    });

    server.close();
    ghServer.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
