#!/usr/bin/env node
/**
 * Checks for removing a node — no test framework needed.
 * Run:  node scripts/nodeRemoval.test.js
 *
 * The real panel DB is never opened: server/db is replaced by an in-memory
 * stand-in before anything requires it, and every agent call is stubbed.
 * Covered:
 *   - nodeRemoval.remove: refused for the panel's node and while projects live
 *     on it; "panel" touches nothing on the VPS; "vps" asks the agent to
 *     uninstall itself with the right parts, report URL and certificates, and
 *     keeps the node when that fails (with the command to run by hand)
 *   - impact: projects on the node, stale copies, Egress Proxy pins through it;
 *     removing clears those pins and forgets the stale copies
 *   - the panel's side: domains dropped, other nodes' access rules for the
 *     node's addresses removed, WireGuard re-synced
 *   - the script's reports: by token, only while running, "lost" when silent
 *   - the public report route (text/plain body, ?status=)
 *   - agent: uninstall-agent.sh arguments, the ufw rule finder
 *   - uninstall-agent.sh: parses (bash -n) and refuses bad arguments
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execFileSync } = require("child_process");

// ── In-memory stand-in for server/db (QuickDB) ───────────────────────────────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => (Array.isArray(q[k]) ? q[k].includes(e[k]) : e[k] === q[k]));
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0]; },
    async findOneAndDelete(model, q) {
        const arr = (await this.get(model)) || [];
        const i = arr.findIndex((e) => matches(e, q));
        if (i < 0) return null;
        const [gone] = arr.splice(i, 1);
        await this.set(model, arr);
        return gone;
    },
    async updateMany(model, q, data) {
        const arr = ((await this.get(model)) || []).map((e) => (matches(e, q) ? { ...e, ...data } : e));
        await this.set(model, arr);
    },
    async deleteMany(model, q) {
        const arr = (await this.get(model)) || [];
        await this.set(model, arr.filter((e) => !matches(e, q)));
        return arr.filter((e) => matches(e, q));
    },
};
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

process.env.PANEL_NODE_ID = "node-panel";
process.env.PORT = "1975";

const nodeService = require("../server/services/nodeService");
const panelDomains = require("../server/services/panelDomains");
const wgService = require("../server/services/wgService");
const nodeRemoval = require("../server/services/nodeRemoval");
const agentUninstall = require("../agent/services/uninstall");
const agentUfw = require("../agent/services/ufw");

const PANEL_NODE = { _id: "node-panel", name: "sangs", host: "160.191.87.150", port: 4200, apiKey: "k-panel", enabled: true, wgOverlayIp: "10.88.0.4" };
const DIO = { _id: "node-dio", name: "dio", host: "160.191.87.61", port: 4200, apiKey: "k-dio", enabled: true, wgOverlayIp: "10.88.0.3" };
const OLD = { _id: "node-old", name: "dio 2", host: "163.227.230.36", port: 4200, apiKey: "k-old", enabled: true, wgOverlayIp: "10.88.0.5" };

// Agent calls, recorded; `agentReplies[path]` decides the answer.
const calls = [];
let agentReplies = {};
nodeService.agentRequest = async (node, method, urlPath, opts = {}) => {
    calls.push({ node: node.name, method, urlPath, data: opts.data });
    const reply = agentReplies[urlPath];
    if (typeof reply === "function") return reply(node, opts);
    if (reply instanceof Error) throw reply;
    return reply ?? {};
};
panelDomains.currentUrl = async () => "https://panel.example.com";
let meshSyncs = 0;
wgService.syncMesh = async () => {
    meshSyncs++;
    return (await nodeService.getNodes()).map((n) => ({ nodeId: n._id, node: n.name, ok: true }));
};

const reset = async () => {
    store.clear();
    calls.length = 0;
    agentReplies = {};
    meshSyncs = 0;
    await fakeDb.set("nodes", [PANEL_NODE, DIO, OLD]);
    await fakeDb.set("bots", [{ _id: "b1", name: "arnto-auto", nodeId: "node-panel" }]);
    await fakeDb.set("panel_domains", [
        { domain: "panel1.example.com", nodeId: "node-panel", sslEnabled: true, addedAt: 1 },
        { domain: "panel4.example.com", nodeId: "node-old", sslEnabled: true, addedAt: 2 },
    ]);
};

/** The background clean-up after remove() — wait until it is recorded as done. */
const settled = async (id) => {
    for (let i = 0; i < 100; i++) {
        const r = await nodeRemoval.get(id);
        if (r.done) return r;
        await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("the panel's clean-up never finished");
};

/** The token the panel put in the report URL it gave the agent. */
const tokenFromCalls = () => {
    const c = calls.find((x) => x.urlPath === "/self/uninstall");
    return c.data.reportUrl.split("/").pop();
};

let failures = 0;
const test = async (name, fn) => {
    try {
        await reset();
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

const rejects = async (p, status, re) => {
    try {
        await p;
    } catch (err) {
        assert.strictEqual(err.status, status, `status ${err.status} (${err.message})`);
        if (re) assert.match(err.message, re);
        return err;
    }
    throw new Error(`expected a ${status}`);
};

const bashAvailable = (() => {
    try {
        execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
})();

(async () => {
    console.log("refusals");

    await test("the panel's own node is never removed", async () => {
        await rejects(nodeRemoval.remove("node-panel", { mode: "panel" }), 400, /runs the panel/);
        assert.ok(await fakeDb.findOne("nodes", { _id: "node-panel" }));
    });

    await test("a node with projects is refused, and says which", async () => {
        await fakeDb.set("bots", [{ _id: "b2", name: "music-bot", nodeId: "node-old" }]);
        await rejects(nodeRemoval.remove("node-old", { mode: "vps", parts: ["ssh"] }), 400, /1 project\(s\) still run on it \(music-bot\)/);
        assert.strictEqual(calls.length, 0, "nothing asked of any agent");
        assert.ok(await fakeDb.findOne("nodes", { _id: "node-old" }));
    });

    await test("a project with no nodeId lives on the panel's node, not on this one", async () => {
        await fakeDb.set("bots", [{ _id: "b3", name: "legacy" }, { _id: "b4", name: "old-local", nodeId: "local" }]);
        const r = await nodeRemoval.remove("node-old", { mode: "panel" });
        await settled(r.id);
    });

    await test("unknown node, unknown mode", async () => {
        await rejects(nodeRemoval.remove("nope", { mode: "panel" }), 404);
        await rejects(nodeRemoval.remove("node-old", { mode: "wipe" }), 400);
    });

    console.log("impact");

    await test("impact: projects on the node, stale copies, egress pins through it", async () => {
        await fakeDb.set("bots", [
            { _id: "b1", name: "arnto-auto", nodeId: "node-panel", egressNodeId: "node-old" },
            { _id: "b2", name: "music-bot", nodeId: "node-old", repoUrl: "https://github.com/x/music-bot", egressNodeId: "node-old" },
            { _id: "b3", name: "shop-site", nodeId: "node-old", projectType: "website" },
        ]);
        await fakeDb.set("stale_copies", [{ _id: "s1", botId: "b9", nodeId: "node-old", name: "ticket-bot", pm2Name: "bot-ticket", createdAt: 5 }]);
        const i = await nodeRemoval.impact(OLD);
        assert.strictEqual(i.isPanelNode, false);
        assert.deepStrictEqual(i.bots.map((b) => [b.name, b.projectType, b.canRebuild]), [["music-bot", "discord", true], ["shop-site", "website", false]]);
        assert.deepStrictEqual(i.staleCopies, [{ name: "ticket-bot", pm2Name: "bot-ticket", createdAt: 5 }]);
        assert.deepStrictEqual(i.egressBots.map((b) => b.name), ["arnto-auto"], "a project on the node itself is in bots, not here");
        assert.strictEqual((await nodeRemoval.impact(PANEL_NODE)).isPanelNode, true);
    });

    await test("removing clears the egress pins through the node and forgets its stale copies", async () => {
        await fakeDb.set("bots", [
            { _id: "b1", name: "arnto-auto", nodeId: "node-panel", egressNodeId: "node-old" },
            { _id: "b5", name: "other", nodeId: "node-dio", egressNodeId: "node-dio" },
        ]);
        await fakeDb.set("stale_copies", [
            { _id: "s1", botId: "b9", nodeId: "node-old", name: "ticket-bot", pm2Name: "bot-ticket", createdAt: 5 },
            { _id: "s2", botId: "b8", nodeId: "node-dio", name: "kept", pm2Name: "bot-kept", createdAt: 6 },
        ]);
        const r = await nodeRemoval.remove("node-old", { mode: "panel" });
        assert.deepStrictEqual(r.egressBots.map((b) => b.name), ["arnto-auto"]);
        assert.deepStrictEqual(r.staleCopies.map((c) => c.pm2Name), ["bot-ticket"]);
        assert.strictEqual((await fakeDb.findOne("bots", { _id: "b1" })).egressNodeId, "");
        assert.strictEqual((await fakeDb.findOne("bots", { _id: "b5" })).egressNodeId, "node-dio", "other pins stay");
        assert.deepStrictEqual((await fakeDb.find("stale_copies")).map((c) => c._id), ["s2"]);

        const done = await settled(r.id);
        const egress = done.steps.find((x) => x.label === "Egress Proxy");
        assert.strictEqual(egress.status, "warn");
        assert.match(egress.detail, /arnto-auto/);
        assert.match(done.steps.find((x) => x.label === "Old copies left in its PM2 list").detail, /ticket-bot: pm2 delete bot-ticket && pm2 save/);
    });

    console.log("panel only");

    await test("panel only: the node goes, nothing is asked of its agent, the panel cleans up after it", async () => {
        agentReplies["/ufw/remove-from"] = (node) => ({ removed: node.name === "sangs" ? 1 : 0 });
        const r = await nodeRemoval.remove("node-old", { mode: "panel" });
        assert.strictEqual(r.mode, "panel");
        assert.strictEqual(r.vps, null);
        assert.deepStrictEqual(r.parts, []);
        assert.strictEqual(await fakeDb.findOne("nodes", { _id: "node-old" }), undefined);

        const done = await settled(r.id);
        assert.ok(!calls.some((c) => c.node === "dio 2"), "the removed node is not called");
        const access = calls.filter((c) => c.urlPath === "/ufw/remove-from");
        assert.deepStrictEqual(access.map((c) => c.node).sort(), ["dio", "sangs"]);
        assert.deepStrictEqual(access[0].data, { ips: ["163.227.230.36", "10.88.0.5"] });
        assert.strictEqual(meshSyncs, 1);
        assert.deepStrictEqual((await panelDomains.list()).map((d) => d.domain), ["panel1.example.com"]);

        assert.deepStrictEqual(done.steps.map((s) => [s.label, s.status]), [
            ["Removed from the panel", "ok"],
            ["Panel domains", "ok"],
            ["Firewall rules on the other nodes", "ok"],
            ["WireGuard mesh", "ok"],
        ]);
        assert.match(done.steps[1].detail, /panel4\.example\.com/);
        assert.match(done.steps[2].detail, /sangs: 1 rule\(s\) removed/);
    });

    await test("panel only: an old agent elsewhere is a warning, not a failure", async () => {
        agentReplies["/ufw/remove-from"] = (node) => {
            if (node.name === "dio") throw Object.assign(new Error("[Node dio] 404"), { agentStatus: 404 });
            return { removed: 0 };
        };
        const done = await settled((await nodeRemoval.remove("node-old", { mode: "panel" })).id);
        const s = done.steps.find((x) => x.label === "Firewall rules on the other nodes");
        assert.strictEqual(s.status, "warn");
        assert.match(s.detail, /dio: its agent is too old/);
    });

    console.log("cleaning up the VPS");

    await test("vps: the agent is asked to uninstall itself with the parts, a report URL and its certificates", async () => {
        agentReplies["/self/uninstall"] = { message: "Uninstall started", detail: "bot-panel-uninstall-1 (its output: journalctl -u bot-panel-uninstall-1)" };
        const r = await nodeRemoval.remove("node-old", { mode: "vps", parts: ["packages", "ssh", "bogus", "ssh"], origin: "http://10.0.0.1:1975" });

        const c = calls.find((x) => x.urlPath === "/self/uninstall");
        assert.strictEqual(c.node, "dio 2");
        assert.deepStrictEqual(c.data.parts, ["packages", "ssh"]);
        assert.deepStrictEqual(c.data.certs, ["panel4.example.com"]);
        assert.match(c.data.reportUrl, /^https:\/\/panel\.example\.com\/api\/node-removal\/[A-Za-z0-9_-]{32}$/);

        assert.deepStrictEqual(r.parts, ["packages", "ssh"]);
        assert.strictEqual(r.vps.status, "running");
        assert.match(r.vps.detail, /bot-panel-uninstall-1/);
        assert.strictEqual(r.vps.tokenHash, undefined, "the token's hash stays on the server");
        const stored = JSON.stringify(store.get("node_removals"));
        assert.ok(!stored.includes(tokenFromCalls()), "the token itself is never stored");
        assert.strictEqual(await fakeDb.findOne("nodes", { _id: "node-old" }), undefined);
        await settled(r.id);
    });

    await test("vps: an agent without /self/uninstall keeps the node and says to update it", async () => {
        agentReplies["/self/uninstall"] = Object.assign(new Error("[Node dio 2] ERR_BAD_REQUEST Request failed with status code 404"), { agentStatus: 404 });
        const err = await rejects(nodeRemoval.remove("node-old", { mode: "vps", parts: ["ssh"] }), 409, /too old to remove itself/);
        assert.match(err.message, /sudo bash ~\/panel\/agent\/uninstall-agent\.sh "\$USER" --keep-packages --keep-firewall$/);
        assert.ok(await fakeDb.findOne("nodes", { _id: "node-old" }), "still on the panel");
        assert.deepStrictEqual(await nodeRemoval.list(), []);
    });

    await test("vps: an unreachable agent keeps the node (502, never the agent's own 401)", async () => {
        agentReplies["/self/uninstall"] = new Error("[Node dio 2] ECONNREFUSED connect ECONNREFUSED");
        await rejects(nodeRemoval.remove("node-old", { mode: "vps", parts: [] }), 502, /The node was not removed/);
        agentReplies["/self/uninstall"] = Object.assign(new Error("[Node dio 2] Invalid agent key"), { status: 401 });
        await rejects(nodeRemoval.remove("node-old", { mode: "vps", parts: [] }), 502);
        agentReplies["/self/uninstall"] = Object.assign(new Error("[Node dio 2] uninstall-agent.sh did not start: This looks like the node that runs the panel"), { status: 409 });
        await rejects(nodeRemoval.remove("node-old", { mode: "vps", parts: [] }), 409, /runs the panel/);
        assert.ok(await fakeDb.findOne("nodes", { _id: "node-old" }));
    });

    await test("manual command: --keep-packages first, only for what is kept", () => {
        assert.strictEqual(nodeRemoval.manualCommand(["ssh", "firewall", "packages"]), `sudo bash ~/panel/agent/uninstall-agent.sh "$USER"`);
        assert.strictEqual(nodeRemoval.manualCommand([]), `sudo bash ~/panel/agent/uninstall-agent.sh "$USER" --keep-packages --keep-ssh-keys --keep-firewall`);
        assert.strictEqual(nodeRemoval.manualCommand(["packages"]), `sudo bash ~/panel/agent/uninstall-agent.sh "$USER" --keep-ssh-keys --keep-firewall`);
    });

    console.log("reports from the VPS");

    await test("reports: output as it comes, then done; nothing after that, nothing without the token", async () => {
        const r = await nodeRemoval.remove("node-old", { mode: "vps", parts: ["ssh", "firewall", "packages"] });
        const token = tokenFromCalls();

        await nodeRemoval.report(token, { status: "running", log: "[uninstall] PM2: removed panel-agent\n" });
        let now = await nodeRemoval.get(r.id);
        assert.strictEqual(now.vps.status, "running");
        assert.match(now.vps.log, /removed panel-agent/);

        await nodeRemoval.report(token, { status: "done", log: "…\n Done. UFW is inactive.\n" });
        now = await nodeRemoval.get(r.id);
        assert.strictEqual(now.vps.status, "done");
        assert.ok(now.vps.finishedAt);

        await rejects(nodeRemoval.report(token, { status: "running", log: "again" }), 409);
        await rejects(nodeRemoval.report("x".repeat(32), { status: "done", log: "" }), 404);
        await rejects(nodeRemoval.report("short", { status: "done", log: "" }), 404);
        await settled(r.id);
    });

    await test("reports: an odd status counts as running, the log is capped, silence becomes 'lost'", async () => {
        const r = await nodeRemoval.remove("node-old", { mode: "vps", parts: [] });
        const token = tokenFromCalls();
        await nodeRemoval.report(token, { status: "rm -rf", log: "x".repeat(200 * 1024) });
        let now = await nodeRemoval.get(r.id);
        assert.strictEqual(now.vps.status, "running");
        assert.strictEqual(now.vps.log.length, 64 * 1024);

        const rows = store.get("node_removals");
        rows[0].vps.updatedAt = Date.now() - nodeRemoval.LOST_MS - 1000;
        now = await nodeRemoval.get(r.id);
        assert.strictEqual(now.vps.status, "lost");
        // A late report still lands.
        await nodeRemoval.report(token, { status: "failed", log: "stopped before the end" });
        assert.strictEqual((await nodeRemoval.get(r.id)).vps.status, "failed");
        await settled(r.id);
    });

    await test("the public route takes text/plain and ?status=", async () => {
        const express = require("express");
        const app = express();
        app.use(express.json());
        app.use("/api/node-removal", require("../server/routes/nodeRemoval"));
        app.use(require("../server/middleware/errorHandler"));
        const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/node-removal`;
        const prevEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production"; // the error handler logs less
        try {
            const r = await nodeRemoval.remove("node-old", { mode: "vps", parts: [] });
            const token = tokenFromCalls();
            const post = (t, status, body) =>
                fetch(`${base}/${t}?status=${status}`, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body });
            assert.strictEqual((await post(token, "running", "[uninstall] WireGuard: wg0 down\n")).status, 200);
            assert.match((await nodeRemoval.get(r.id)).vps.log, /wg0 down/);
            assert.strictEqual((await post(token, "done", "Done.")).status, 200);
            assert.strictEqual((await nodeRemoval.get(r.id)).vps.status, "done");
            assert.strictEqual((await post(token, "done", "again")).status, 409);
            assert.strictEqual((await post("y".repeat(32), "done", "")).status, 404);
            await settled(r.id);
        } finally {
            process.env.NODE_ENV = prevEnv;
            server.close();
        }
    });

    console.log("agent");

    await test("agent: uninstall-agent.sh arguments — keep flags for what stays, --keep-packages first", () => {
        assert.deepStrictEqual(agentUninstall.scriptArgs({ user: "khaidev", parts: ["ssh", "firewall", "packages"] }), ["khaidev"]);
        assert.deepStrictEqual(
            agentUninstall.scriptArgs({ user: "root", parts: ["firewall"], certs: ["panel4.example.com"], reportUrl: "https://panel.example.com/api/node-removal/abc" }),
            ["root", "--keep-packages", "--keep-ssh-keys", "--cert", "panel4.example.com", "--report", "https://panel.example.com/api/node-removal/abc"],
        );
    });

    await test("agent: bad user, part, certificate or report URL is refused", () => {
        const bad = (opts) => assert.throws(() => agentUninstall.scriptArgs({ user: "khaidev", ...opts }), (e) => e.status === 400);
        bad({ user: "" });
        bad({ user: "-rf" });
        bad({ user: "a b" });
        bad({ parts: ["everything"] });
        bad({ parts: "ssh" });
        bad({ certs: ["../../etc"] });
        bad({ certs: ["a.example.com; reboot"] });
        bad({ reportUrl: "file:///etc/passwd" });
        bad({ reportUrl: "https://panel.example.com/x y" });
        bad({ reportUrl: "not a url" });
    });

    await test("agent ufw: finds the panel-access rules for these sources only, highest number first", () => {
        const status = [
            "Status: active",
            "",
            "     To                         Action      From",
            "     --                         ------      ----",
            "[ 1] 22/tcp                     ALLOW IN    Anywhere",
            "[ 2] 1975/tcp on wg0            ALLOW IN    10.88.0.5                  # bot-panel: panel access",
            "[ 3] 4200/tcp                   ALLOW IN    163.227.230.36             # bot-panel: panel access",
            "[ 4] 4200/tcp                   ALLOW IN    160.191.87.150             # bot-panel: panel access",
            "[ 5] 8080/tcp                   ALLOW IN    163.227.230.36             # my own rule",
            "[ 6] 1975/tcp on wg0            ALLOW IN    10.88.0.50                 # bot-panel: panel access",
            "[ 7] 22/tcp (v6)                ALLOW IN    Anywhere (v6)",
        ].join("\n");
        assert.deepStrictEqual(agentUfw.panelAccessRuleNumbers(status, ["163.227.230.36", "10.88.0.5"]), [3, 2]);
        assert.deepStrictEqual(agentUfw.panelAccessRuleNumbers(status, ["1.2.3.4"]), []);
        assert.deepStrictEqual(agentUfw.panelAccessRuleNumbers("Status: inactive\n", ["10.88.0.5"]), []);
        assert.match(agentUfw.allowFromRule("10.88.0.5", 1975, "wg0"), /comment 'bot-panel: panel access'$/);
    });

    console.log("uninstall-agent.sh");

    await test("the script parses, and refuses bad arguments before anything else", () => {
        if (!bashAvailable) {
            console.log("       (bash not available — skipped)");
            return;
        }
        // LF whatever the checkout has: bash reads a CR as part of every command.
        const src = fs.readFileSync(path.join(__dirname, "..", "agent", "uninstall-agent.sh"), "utf8").replace(/\r\n/g, "\n");
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-")), "uninstall-agent.sh");
        fs.writeFileSync(file, src);
        execFileSync("bash", ["-n", file]);
        const fails = (args, re) => {
            try {
                execFileSync("bash", [file, ...args], { stdio: "pipe" });
            } catch (err) {
                assert.match(String(err.stderr), re);
                return;
            }
            throw new Error(`expected ${args.join(" ")} to fail`);
        };
        fails([], /^Usage:/);
        fails(["--keep-packages"], /^Usage:/);
        fails(["khaidev", "--everything"], /Unknown option: --everything/);
        fails(["khaidev", "--cert", "../../etc"], /--cert needs a domain name/);
        fails(["khaidev", "--cert"], /--cert needs a domain name/);
        fails(["khaidev", "--report", "file:///etc/passwd"], /--report needs an http\(s\) URL/);
        // Good arguments get as far as the root check (this is not root).
        if (typeof process.getuid !== "function" || process.getuid() !== 0) {
            fails(["khaidev", "--keep-ssh-keys", "--cert", "panel4.example.com", "--report", "https://p.example.com/api/node-removal/abc", "--detach"],
                /Run it as root: sudo bash .* khaidev --keep-ssh-keys --cert panel4\.example\.com --report https:\/\/p\.example\.com\/api\/node-removal\/abc$/m);
        }
    });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
