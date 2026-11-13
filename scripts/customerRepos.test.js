#!/usr/bin/env node
/**
 * Checks for customer projects, phase 4 (server/services/customerRepos.js, utils/githubUrl.js
 * and their routes): the customers' GitHub org is listed with the project using each repo
 * (by URL, or through a transfer — GitHub redirects), retired projects' repos and repos
 * nothing uses; personal repos never show. The panel touches only repos in the org: Archive /
 * Unarchive, Delete with the name typed back and never while a project uses the repo (even
 * through an old URL). "Update repo URL" keeps the URL's form and SSH host alias. The token is
 * checked before it is saved and never comes back. The daily sync keeps a repo's description
 * to the project's name (who the customer is only on a private repo). GitHub is a local fake.
 * Run:  node scripts/customerRepos.test.js
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-customer-repos";

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

const BOT = "1480411893448573009";
const BUYER = "427399742906040333";
const users = {
    [BOT]: { id: BOT, username: "lofimusic", globalName: "Lofi Music", bot: true },
    [BUYER]: { id: BUYER, username: "khach.a", globalName: "Customer A", bot: false },
};
stub("services/discordBus", {
    fetchUser: async (id) => ({ ...users[id] }),
    status: () => ({ ready: true }),
    discordClient: () => null,
});
stub("services/executor", {});
const logLines = [];
stub("services/panelLog", { add: (kind, text) => void logLines.push(`${kind}: ${text}`) });
stub("services/lifecycle", { guard: (fn) => fn, isActive: () => true });

// ── A fake GitHub API ────────────────────────────────────────────────────────
const ORG = "acme-customers";
const GOOD = ["test", "token", "good"].join("-");
const READONLY = ["test", "token", "readonly"].join("-");
let repoId = 100;
const repos = new Map(); // id → repo
const addRepo = (owner, name, extra = {}) => {
    const r = { id: ++repoId, name, full_name: `${owner}/${name}`, owner: { login: owner }, private: true, archived: false, description: null, pushed_at: "2026-10-01T00:00:00Z", html_url: `https://github.com/${owner}/${name}`, ...extra };
    repos.set(r.id, r);
    return r;
};
const moved = new Map(); // "owner/name" (lower) → repo id, like GitHub's redirects
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
    Object.assign(req.repo, req.body);
    res.json(req.repo);
});
gh.delete("/repos/:owner/:name", repoRoute, (req, res) => {
    if (req.readonly) return res.status(403).json({ message: "Resource not accessible by personal access token" });
    repos.delete(req.repo.id);
    res.status(204).end();
});

// The org's repos
const LOFI = addRepo(ORG, "lofi");
const TICKET = addRepo(ORG, "ticket");
moved.set("me/ticket", TICKET.id); // transferred from the owner's account
const OLDSHOP = addRepo(ORG, "old-shop");
const JUNK = addRepo(ORG, "junk", { private: false });
addRepo(ORG, "archived-thing", { archived: true });
for (let i = 0; i < 101; i++) addRepo(ORG, `zz-filler-${String(i).padStart(3, "0")}`); // a second page
addRepo("me", "personal");

const customers = require("../server/services/customerProjects");
const retire = require("../server/services/customerRetire");
const reposService = require("../server/services/customerRepos");
const githubUrl = require("../server/utils/githubUrl");
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
        const where = err.stack.split("\n").find((l) => l.includes("customerRepos.test.js")) || "";
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
// syncName off: the test names its projects; the daily-sync tests use the bot's name.
const project = async (fields, customer = true) => {
    const p = await db.create("bots", { buyerID: BUYER, botID: `p${nextId}`, name: "P", projectType: "discord", ...fields });
    if (customer) await customers.enable(p._id, { botUserId: BOT, syncName: false });
    return db.findOne("bots", { _id: p._id });
};
// What Delete does: write the project down, then drop its record.
const retireAndDrop = async (bot, reason = "deleted") => {
    await retire.retire(bot, { reason });
    await db.set("bots", (await db.get("bots")).filter((b) => b._id !== bot._id));
};

// ── Tests ────────────────────────────────────────────────────────────────────
(async () => {
    const ghServer = gh.listen(0);
    await new Promise((r) => ghServer.once("listening", r));
    reposService._setApiBase(`http://127.0.0.1:${ghServer.address().port}`);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;

    console.log("repo URLs");
    await check("parse: SSH host alias, ssh://, https; anything else → null", () => {
        assert.deepStrictEqual(githubUrl.parse("git@github.com-deploy:Me/Lofi.git"), { form: "scp", user: "git", host: "github.com-deploy", owner: "Me", name: "Lofi", dotGit: true });
        assert.strictEqual(githubUrl.parse("ssh://git@github.com:22/me/x").name, "x");
        assert.strictEqual(githubUrl.parse("https://github.com/me/x.git/").owner, "me");
        assert.strictEqual(githubUrl.parse("https://gitlab.com/me/x.git"), null);
        assert.strictEqual(githubUrl.parse(""), null);
    });
    await check("rewrite keeps the form, the host alias and .git", () => {
        assert.strictEqual(githubUrl.rewrite("git@github.com-deploy:me/ticket.git", ORG, "ticket"), `git@github.com-deploy:${ORG}/ticket.git`);
        assert.strictEqual(githubUrl.rewrite("https://github.com/me/ticket", ORG, "ticket"), `https://github.com/${ORG}/ticket`);
        assert.strictEqual(githubUrl.rewrite("ssh://git@github.com/me/t.git", ORG, "t"), `ssh://git@github.com/${ORG}/t.git`);
    });

    console.log("settings");
    await check("not set up → the Repos page says so; an unknown org or a bad token is not saved", async () => {
        assert.deepStrictEqual((await call("GET", "/api/customer-projects/repos")).body, { configured: false, repos: [], notInOrg: [] });
        let res = await call("PUT", "/api/customer-projects/github-settings", { org: "nobody-here", token: GOOD });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /no organization "nobody-here"/);
        res = await call("PUT", "/api/customer-projects/github-settings", { org: ORG, token: "nope" });
        assert.strictEqual(res.status, 502);
        assert.match(res.body.error, /refused the token/);
        res = await call("PUT", "/api/customer-projects/github-settings", { org: "bad_name!" });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not a GitHub organization name/);
        // The display name, as typed on the live panel the first time.
        res = await call("PUT", "/api/customer-projects/github-settings", { org: "ArnTo Shop", token: GOOD });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /"ArnTo Shop" is the organization's display name/);
        assert.strictEqual((await call("GET", "/api/customer-projects/github-settings")).body.configured, false);
    });
    await check("a good org + token is saved encrypted and never comes back", async () => {
        const res = await call("PUT", "/api/customer-projects/github-settings", { org: "ACME-Customers", token: GOOD });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.deepStrictEqual([res.body.org, res.body.configured, res.body.hasToken], [ORG, true, true]);
        assert.ok(!JSON.stringify(res.body).includes(GOOD));
        assert.ok(!JSON.stringify(store.get("customer_github_settings")).includes(GOOD), "encrypted at rest");
        const again = await call("PUT", "/api/customer-projects/github-settings", { org: ORG, token: "" });
        assert.strictEqual(again.status, 200, "an empty token keeps the stored one");
        for (const link of [`https://github.com/${ORG}`, `github.com/${ORG}/`, `https://github.com/orgs/${ORG}/repositories`, `https://www.github.com/${ORG}?tab=repositories`]) {
            const r = await call("PUT", "/api/customer-projects/github-settings", { org: link });
            assert.strictEqual(r.status, 200, `${link}: ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.org, ORG);
        }
        assert.ok(!logLines.join("\n").includes(GOOD));
    });

    console.log("the Repos page");
    let lofiP, ticketP, stillMine;
    await check("every org repo with who uses it; moved and missing customer repos listed; personal ones never", async () => {
        lofiP = await project({ name: "Lofi", repoUrl: `git@github.com-deploy:${ORG}/lofi.git` });
        ticketP = await project({ name: "Ticket", repoUrl: "git@github.com-deploy:me/ticket.git" });
        stillMine = await project({ name: "Still mine", repoUrl: "https://github.com/me/still-mine.git" });
        await project({ name: "Personal", repoUrl: "https://github.com/me/personal.git" }, false);
        const expiredP = await project({ name: "Expired", repoUrl: `https://github.com/${ORG}/archived-thing`, expiresAt: Date.now() - 1000 });
        void expiredP;
        const gone = await project({ name: "Old shop", repoUrl: `https://github.com/${ORG}/old-shop.git` });
        await retireAndDrop(gone);

        const res = await call("GET", "/api/customer-projects/repos");
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const by = Object.fromEntries(res.body.repos.map((r) => [r.name, r]));
        assert.strictEqual(res.body.repos.length, 5 + 101, "both pages read");
        assert.deepStrictEqual([by.lofi.state, by.lofi.projects.map((p) => p.name)], ["in-use", ["Lofi"]]);
        assert.deepStrictEqual([by.ticket.state, by.ticket.projects.map((p) => p.name)], ["in-use", ["Ticket"]], "used through the transfer");
        assert.strictEqual(by["old-shop"].state, "retired");
        assert.strictEqual(by["old-shop"].retired.name, "Old shop");
        assert.deepStrictEqual([by.junk.state, by.junk.private], ["unused", false]);
        assert.deepStrictEqual([by["archived-thing"].state, by["archived-thing"].archived], ["expired", true]);
        assert.strictEqual(by.personal, undefined);
        const missing = Object.fromEntries(res.body.notInOrg.map((p) => [p.name, p]));
        assert.deepStrictEqual([missing.Ticket.state, missing.Ticket.movedTo], ["moved", `${ORG}/ticket`]);
        assert.strictEqual(missing["Still mine"].state, "unknown");
        assert.strictEqual(missing.Personal, undefined, "personal projects are not this page's business");
    });
    await check("Update repo URL rewrites the moved project only, keeping its SSH alias", async () => {
        let res = await call("POST", `/api/customer-projects/${ticketP._id}/repo/update-url`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.bot.repoUrl, `git@github.com-deploy:${ORG}/ticket.git`);
        res = await call("POST", `/api/customer-projects/${ticketP._id}/repo/update-url`);
        assert.strictEqual(res.status, 409);
        res = await call("POST", `/api/customer-projects/${stillMine._id}/repo/update-url`);
        assert.strictEqual(res.status, 404);
    });
    await check("Archive / Unarchive a repo of the org; nothing outside the org is touched", async () => {
        let res = await call("POST", "/api/customer-projects/repos/junk/archive", { archived: true });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(JUNK.archived, true);
        res = await call("POST", "/api/customer-projects/repos/junk/archive", { archived: false });
        assert.strictEqual(JUNK.archived, false);
        res = await call("POST", "/api/customer-projects/repos/personal/archive", {});
        assert.strictEqual(res.status, 404);
        assert.strictEqual(find("me", "personal").archived, false);
        res = await call("POST", "/api/customer-projects/repos/..%2F..%2Fx/archive", {});
        assert.ok(res.status >= 400);
    });
    await check("Delete needs the name typed back and is refused while a project uses the repo — even by an old URL", async () => {
        let res = await call("DELETE", "/api/customer-projects/repos/junk", { confirm: "jnuk" });
        assert.strictEqual(res.status, 400);
        res = await call("DELETE", "/api/customer-projects/repos/lofi", { confirm: "lofi" });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /still used by "Lofi"/);
        await project({ name: "Old link", repoUrl: "https://github.com/me/ticket" }); // old URL, redirects to the org's ticket
        res = await call("DELETE", "/api/customer-projects/repos/ticket", { confirm: "ticket" });
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /"Old link"/);
        res = await call("DELETE", "/api/customer-projects/repos/junk", { confirm: "junk" });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(find(ORG, "junk"), undefined);
        assert.ok(logLines.some((l) => l.includes(`deleted the repo ${ORG}/junk`)));
    });
    await check("a token without Administration: write gets a clear 403", async () => {
        await db.set("customer_github_settings", { ...(await db.get("customer_github_settings")), tokenEnc: require("../server/services/agentCrypto").encrypt(READONLY, process.env.JWT_SECRET) });
        const res = await call("POST", "/api/customer-projects/repos/lofi/archive", { archived: true });
        assert.strictEqual(res.status, 403);
        assert.match(res.body.error, /Administration: read and write/);
        await call("PUT", "/api/customer-projects/github-settings", { org: ORG, token: GOOD });
    });

    console.log("Bots → Retired");
    await check("archive a retired project's repo from its line; the entry's line is done", async () => {
        const e = (await retire.entries()).find((x) => x.repo.url.includes("old-shop"));
        const res = await call("POST", `/api/customer-projects/retired/${e._id}/repo/archive`);
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(OLDSHOP.archived, true);
        assert.strictEqual(res.body.finished, true, "nothing else was pending");
    });
    await check("a retired repo outside the org is refused (mark it handled instead); delete needs the name", async () => {
        const gone = await project({ name: "Mine", repoUrl: "https://github.com/me/personal.git" });
        await retireAndDrop(gone);
        const e = (await retire.entries()).find((x) => x.botId === gone._id);
        let res = await call("POST", `/api/customer-projects/retired/${e._id}/repo/archive`);
        assert.strictEqual(res.status, 409);
        assert.match(res.body.error, /only touches the org's repos/);
        const gone2 = await project({ name: "Gone2", repoUrl: `git@github.com:${ORG}/zz-filler-000.git` });
        await retireAndDrop(gone2, "expired");
        const e2 = (await retire.entries()).find((x) => x.botId === gone2._id);
        res = await call("POST", `/api/customer-projects/retired/${e2._id}/repo/delete`, { confirm: "nope" });
        assert.strictEqual(res.status, 400);
        res = await call("POST", `/api/customer-projects/retired/${e2._id}/repo/delete`, { confirm: "zz-filler-000" });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(find(ORG, "zz-filler-000"), undefined);
    });
    await check("deleting from the Repos page also closes the retired line waiting on that repo", async () => {
        const gone = await project({ name: "Gone3", repoUrl: `https://github.com/${ORG}/zz-filler-001` });
        await retireAndDrop(gone);
        const res = await call("DELETE", "/api/customer-projects/repos/zz-filler-001", { confirm: "zz-filler-001" });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual((await retire.entries()).find((x) => x.botId === gone._id), undefined, "its only line is done → left the list");
    });

    console.log("daily sync");
    await check("the description follows the project; the customer only on a private repo; archived ones untouched", async () => {
        await customers.syncOne(await db.findOne("bots", { _id: lofiP._id }));
        assert.strictEqual(LOFI.description, `Lofi · customer @khach.a (${BUYER})`, "the panel name while it does not follow the bot");
        await customers.update(lofiP._id, { syncName: true }); // now it follows the bot → "Lofi Music"
        assert.strictEqual(LOFI.description, `Lofi Music · customer @khach.a (${BUYER})`);
        const pub = addRepo(ORG, "public-one", { private: false });
        const pubP = await project({ name: "Pub", repoUrl: `https://github.com/${ORG}/public-one` });
        await customers.syncOne(pubP);
        assert.strictEqual(pub.description, "Pub", "a public repo gets the name only");
        const arch = addRepo(ORG, "frozen", { archived: true, description: "old" });
        const archP = await project({ name: "Frozen", repoUrl: `https://github.com/${ORG}/frozen` });
        const r = await customers.syncOne(archP);
        assert.strictEqual(arch.description, "old");
        assert.strictEqual(r.error, null);
        const before = calls.length;
        await customers.syncOne(await db.findOne("bots", { _id: lofiP._id }));
        assert.ok(!calls.slice(before).some((c) => c.startsWith("PATCH")), "unchanged → no write");
    });
    await check("a project whose org repo is gone shows it on the project; repos outside the org are left alone", async () => {
        const p = await project({ name: "Lost", repoUrl: `https://github.com/${ORG}/never-existed` });
        const r = await customers.syncOne(p);
        assert.match(r.error, /GitHub: The repo .*never-existed was not found/);
        const before = calls.length;
        await customers.syncOne(await db.findOne("bots", { _id: stillMine._id }));
        assert.strictEqual(calls.length, before, "no GitHub call for a repo outside the org");
    });

    server.close();
    ghServer.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
