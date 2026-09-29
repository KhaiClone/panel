#!/usr/bin/env node
/**
 * Checks for adding a node — no test framework needed.
 * Run:  node scripts/nodeJoin.test.js
 *
 * The real panel DB is never opened: server/db is replaced by an in-memory
 * stand-in before anything requires it, and every agent call is stubbed.
 * Covered:
 *   - nodeJoin: invites (validation, one live invite per address, the token is
 *     never stored), the served script, the callback (IP binding, single use,
 *     retry after a failure, expiry, revoke, two runs at once), progress by token
 *   - nodeSetup.register: health check before saving, duplicates refused
 *   - nodeSetup.provision: every step runs even when one fails; the panel
 *     gateway rule goes to the panel's node for the new node's WireGuard IP
 *   - panelLease.claim: one node, with the address its gateway should use
 *   - agent ufw: the allow-from rule text and the interface check
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { execFileSync } = require("child_process");

// ── In-memory stand-in for server/db (QuickDB) ───────────────────────────────
const store = new Map();
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const matches = (e, q = {}) => Object.keys(q).every((k) => e[k] === q[k]);
let seq = 0;
const fakeDb = {
    async get(k) { return clone(store.get(k)); },
    async set(k, v) { store.set(k, clone(v)); return v; },
    async find(model, q) { return ((await this.get(model)) || []).filter((e) => matches(e, q)); },
    async findOne(model, q) { return (await this.find(model, q))[0]; },
    async create(model, data) {
        const rec = { _id: `id${++seq}`, ...data };
        await this.set(model, [...((await this.get(model)) || []), rec]);
        return clone(rec);
    },
    async findOneAndUpdate(model, q, data) {
        const arr = (await this.get(model)) || [];
        const i = arr.findIndex((e) => matches(e, q));
        if (i < 0) return null;
        arr[i] = { ...arr[i], ...data };
        await this.set(model, arr);
        return arr[i];
    },
};
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

process.env.PANEL_NODE_ID = "node-panel";
process.env.PORT = "1975";
delete process.env.NODE_JOIN_REPO_URL;

const nodeService = require("../server/services/nodeService");
const panelLease = require("../server/services/panelLease");
const panelDomains = require("../server/services/panelDomains");
const panelService = require("../server/services/panelService");
const agentCrypto = require("../server/services/agentCrypto");
const nodeSetup = require("../server/services/nodeSetup");
const nodeJoin = require("../server/services/nodeJoin");
const keySync = require("../server/services/keySyncService");
const wgService = require("../server/services/wgService");
const lavalinkStore = require("../server/services/lavalinkStore");
const lavalinkService = require("../server/services/lavalinkService");
const agentUfw = require("../agent/services/ufw");

const PANEL_NODE = { _id: "node-panel", name: "sangs", host: "160.191.87.150", port: 4200, apiKey: "k-panel", enabled: true, wgOverlayIp: "10.88.0.4" };
const COMMIT = "a".repeat(40);

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
panelService.getPanelStatus = async () => ({ git: { commitHash: COMMIT, branch: "main" } });

const reset = async () => {
    store.clear();
    calls.length = 0;
    agentReplies = {};
    await fakeDb.set("nodes", [PANEL_NODE]);
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
    console.log("invites");

    await test("create: validates name, IP and port", async () => {
        await rejects(nodeJoin.create({ name: "", ip: "203.0.113.10" }), 400, /name/);
        await rejects(nodeJoin.create({ name: "a\nb", ip: "203.0.113.10" }), 400, /name/);
        await rejects(nodeJoin.create({ name: "vps4", ip: "vps4.example.com" }), 400, /IP/);
        await rejects(nodeJoin.create({ name: "vps4", ip: "203.0.113.10", port: 70000 }), 400, /port/);
    });

    await test("create: refuses an address that is already a node", async () => {
        await rejects(nodeJoin.create({ name: "again", ip: PANEL_NODE.host, port: 4200 }), 409, /already exists/);
    });

    await test("create: the token is returned once and only its hash is stored", async () => {
        const r = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        assert.ok(r.token.length >= 30);
        assert.ok(r.secure);
        assert.strictEqual(r.command, `curl -sSL 'https://panel.example.com/api/join/${r.token}/install.sh' -o join-node.sh && sudo bash join-node.sh`);
        const raw = JSON.stringify(store.get("node_join_invites"));
        assert.ok(!raw.includes(r.token), "token stored in clear");
        assert.strictEqual(r.invite.tokenHash, undefined);
        assert.strictEqual(r.invite.status, "pending");
        assert.strictEqual(r.invite.port, 4200);
    });

    await test("create: a new invite for the same address revokes the old one", async () => {
        const a = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        const b = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        assert.strictEqual((await nodeJoin.get(a.invite.id)).status, "revoked");
        assert.strictEqual((await nodeJoin.get(b.invite.id)).status, "pending");
        await rejects(nodeJoin.script(a.token), 410, /revoked/);
    });

    await test("create: without an HTTPS panel address the admin's origin is used, loopback never", async () => {
        const saved = panelDomains.currentUrl;
        panelDomains.currentUrl = async () => "http://160.191.87.150:1975";
        try {
            const viaOrigin = await nodeJoin.create({ name: "a", ip: "203.0.113.11", origin: "https://panel.example.net" });
            assert.strictEqual(viaOrigin.invite.baseUrl, "https://panel.example.net");
            const viaLoopback = await nodeJoin.create({ name: "b", ip: "203.0.113.12", origin: "http://localhost:5173" });
            assert.strictEqual(viaLoopback.invite.baseUrl, "http://160.191.87.150:1975");
            assert.strictEqual(viaLoopback.secure, false);
        } finally {
            panelDomains.currentUrl = saved;
        }
    });

    await test("create: needs the panel's node to have an IP (the new firewall admits it)", async () => {
        await fakeDb.set("nodes", [{ ...PANEL_NODE, host: "sangs.example.com" }]);
        await rejects(nodeJoin.create({ name: "vps4", ip: "203.0.113.10" }), 400, /not an IP/);
    });

    console.log("script");

    await test("script: setup-agent.sh with the invite's settings in front", async () => {
        const { token } = await nodeJoin.create({ name: "VPS 'four'", ip: "203.0.113.10", port: 4300 });
        const text = await nodeJoin.script(token);
        const lines = text.split("\n");
        assert.strictEqual(lines[0], "#!/bin/bash");
        assert.ok(lines[1].startsWith("# bot-panel: joins VPS 'four' (203.0.113.10)"));
        assert.ok(text.includes(`export JOIN_URL='https://panel.example.com/api/join/${token}'`));
        assert.ok(text.includes(`export JOIN_TOKEN='${token}'`));
        assert.ok(text.includes("export REPO_BRANCH='main'"));
        assert.ok(text.includes(`export REPO_COMMIT='${COMMIT}'`));
        assert.match(text, /^set -- '160\.191\.87\.150' '4300'( 'https:\/\/[^']+')?$/m);
        // Exactly one shebang: the original one is dropped. LF only, even from a CRLF checkout.
        assert.strictEqual(text.match(/^#!/gm).length, 1);
        assert.ok(!text.includes("\r"));
        assert.ok(text.includes("PANEL_IP=\"${1:?"));
        if (bashAvailable) {
            const file = path.join(os.tmpdir(), `join-test-${process.pid}.sh`);
            fs.writeFileSync(file, text);
            try {
                execFileSync("bash", ["-n", file]);
            } finally {
                fs.unlinkSync(file);
            }
        }
    });

    await test("script: unknown, used and expired tokens say why", async () => {
        await rejects(nodeJoin.script("x".repeat(32)), 404, /Unknown/);
        await rejects(nodeJoin.script(undefined), 404);
        const { token, invite } = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        const rows = store.get("node_join_invites");
        rows.find((r) => r.id === invite.id).expiresAt = Date.now() - 1;
        await rejects(nodeJoin.script(token), 410, /expired/);
        assert.strictEqual((await nodeJoin.get(invite.id)).status, "expired");
        assert.match(nodeJoin.errorScript("it's gone\nrm -rf /"), /^#!\/bin\/bash\necho '✗ it'\\''s gone rm -rf \/' >&2\nexit 1\n$/);
    });

    await test("repo URL: SSH remotes become public https, credentials are dropped", () => {
        const { toPublicRepoUrl } = nodeJoin._internal;
        assert.strictEqual(toPublicRepoUrl("git@github.com:khaiclone/panel"), "https://github.com/khaiclone/panel.git");
        assert.strictEqual(toPublicRepoUrl("git@github.com:khaiclone/panel.git"), "https://github.com/khaiclone/panel.git");
        assert.strictEqual(toPublicRepoUrl("ssh://git@github.com/khaiclone/panel.git"), "https://github.com/khaiclone/panel.git");
        assert.strictEqual(toPublicRepoUrl("https://user:tok@github.com/khaiclone/panel.git"), "https://github.com/khaiclone/panel.git");
        assert.strictEqual(toPublicRepoUrl("file:///srv/panel"), null);
    });

    console.log("join callback");

    // register() and provision() are stubbed here; they get their own checks below.
    const realRegister = nodeSetup.register;
    const realProvision = nodeSetup.provision;
    let registered = [];
    const stubSetup = ({ failRegister = null } = {}) => {
        registered = [];
        nodeSetup.register = async (fields, opts) => {
            registered.push({ fields, opts });
            if (failRegister) throw Object.assign(new Error(failRegister), { status: 400 });
            return fakeDb.create("nodes", { ...fields, enabled: true });
        };
        nodeSetup.provision = async (node, { onStep }) => {
            const steps = [{ label: "one", status: "ok", detail: null }];
            await onStep(steps);
            return [...steps, { label: "two", status: "warn", detail: "look" }];
        };
    };
    const body = (token, key = "agent-key", agentPort = 4200) => ({ apiKey: agentCrypto.encrypt(key, token), agentPort });

    await test("join: registers the invite's IP with the decrypted key, then provisions", async () => {
        stubSetup();
        const { token, invite } = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        const r = await nodeJoin.join(token, { ...body(token, "secret-key", 4300), host: "198.51.100.66" });
        assert.deepStrictEqual(registered[0].fields, { name: "vps4", host: "203.0.113.10", port: 4300, apiKey: "secret-key" });
        assert.ok(registered[0].opts.healthAttempts > 1, "a just-started agent gets retries");
        assert.strictEqual(r.node.host, "203.0.113.10");
        await r.provisioned;
        const after = await nodeJoin.get(invite.id);
        assert.strictEqual(after.status, "done");
        assert.strictEqual(after.nodeId, r.node._id);
        assert.deepStrictEqual(after.steps.map((s) => s.status), ["ok", "warn"]);
        assert.deepStrictEqual((await nodeJoin.status(token)).steps.map((s) => s.label), ["one", "two"]);
        await rejects(nodeJoin.join(token, body(token)), 410, /already been used/);
    });

    await test("join: a key not encrypted with this token is refused, and the command stays usable", async () => {
        stubSetup();
        const { token, invite } = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        await rejects(nodeJoin.join(token, { apiKey: agentCrypto.encrypt("k", "another-token-entirely") }), 400, /decrypted/);
        await rejects(nodeJoin.join(token, {}), 400);
        assert.strictEqual(registered.length, 0);
        const after = await nodeJoin.get(invite.id);
        assert.strictEqual(after.status, "pending");
        assert.match(after.error, /decrypted/);
    });

    await test("join: an agent that does not answer leaves the invite pending for a retry", async () => {
        stubSetup({ failRegister: "Cannot reach the agent" });
        const { token, invite } = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        await rejects(nodeJoin.join(token, body(token)), 400, /Cannot reach/);
        assert.strictEqual((await nodeJoin.get(invite.id)).status, "pending");
        stubSetup();
        const r = await nodeJoin.join(token, body(token));
        await r.provisioned;
        const after = await nodeJoin.get(invite.id);
        assert.strictEqual(after.status, "done");
        assert.strictEqual(after.error, null);
    });

    await test("join: two runs at once — one registers, the other is told it is running", async () => {
        stubSetup();
        const { token } = await nodeJoin.create({ name: "vps4", ip: "203.0.113.10" });
        const results = await Promise.allSettled([nodeJoin.join(token, body(token)), nodeJoin.join(token, body(token))]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter((r) => r.status === "rejected");
        assert.strictEqual(ok.length, 1);
        assert.strictEqual(refused[0].reason.status, 409);
        assert.strictEqual(registered.length, 1);
        await ok[0].value.provisioned;
    });

    await test("join: expired and revoked commands are refused", async () => {
        stubSetup();
        const a = await nodeJoin.create({ name: "a", ip: "203.0.113.10" });
        store.get("node_join_invites").find((r) => r.id === a.invite.id).expiresAt = Date.now() - 1;
        await rejects(nodeJoin.join(a.token, body(a.token)), 410, /expired/);
        const b = await nodeJoin.create({ name: "b", ip: "203.0.113.11" });
        await nodeJoin.revoke(b.invite.id);
        await rejects(nodeJoin.join(b.token, body(b.token)), 410, /revoked/);
        await rejects(nodeJoin.revoke(b.invite.id), 409);
        assert.strictEqual(registered.length, 0);
    });

    nodeSetup.register = realRegister;
    nodeSetup.provision = realProvision;

    console.log("node setup");

    const realHealth = nodeService.checkNodeHealth;

    await test("register: saves only after the agent answers, refuses duplicates", async () => {
        const seen = [];
        nodeService.checkNodeHealth = async (n) => (seen.push(n), n.apiKey === "good");
        try {
            await rejects(nodeSetup.register({ name: "x", host: "203.0.113.10", port: 4200, apiKey: "bad" }, { healthAttempts: 2, healthDelayMs: 1 }), 400, /Cannot reach/);
            assert.strictEqual(seen.length, 2);
            assert.strictEqual((await fakeDb.find("nodes")).length, 1);
            const node = await nodeSetup.register({ name: "x", host: "203.0.113.10", port: "4200", apiKey: "good" });
            assert.strictEqual(node.port, 4200);
            assert.strictEqual(node.enabled, true);
            assert.ok(nodeService.isNodeOnline(node._id));
            await rejects(nodeSetup.register({ name: "y", host: "203.0.113.10", port: 4200, apiKey: "good" }), 409);
            await rejects(nodeSetup.register({ name: "y", host: "203.0.113.11", port: 0, apiKey: "good" }), 400);
        } finally {
            nodeService.checkNodeHealth = realHealth;
        }
    });

    await test("provision: every step runs in order; a failing one does not stop the rest", async () => {
        const node = await fakeDb.create("nodes", { name: "vps4", host: "203.0.113.10", port: 4200, apiKey: "k4", enabled: true });
        const saved = { sync: keySync.syncAllToNode, mesh: wgService.syncMesh, get: lavalinkStore.get, install: lavalinkService.installOnNode };
        keySync.syncAllToNode = async () => ({ pushed: ["github"], failed: [], gitConfig: true, gitConfigError: null });
        wgService.syncMesh = async () => {
            await fakeDb.findOneAndUpdate("nodes", { _id: node._id }, { wgOverlayIp: "10.88.0.5" });
            return [
                { nodeId: "node-panel", node: "sangs", ok: true, overlayIp: "10.88.0.4" },
                { nodeId: node._id, node: "vps4", ok: true, overlayIp: "10.88.0.5" },
            ];
        };
        lavalinkStore.get = async () => ({ enabled: true, autoInstallOnNewNode: true });
        lavalinkService.installOnNode = async () => ({ ok: false, error: "Java is not installed on this node" });
        agentReplies = {
            "/lease": new Error("[Node vps4] ECONNRESET"),
            "/ufw/allow-from": (n, o) => ({ message: `${o.data.ip} may now reach port ${o.data.port} on ${o.data.iface}` }),
            "/panel-host/probe": { results: [{ ok: true }] },
        };
        try {
            const progress = [];
            const steps = await nodeSetup.provision(node, { onStep: (s) => progress.push(s.map((x) => x.status).join(",")) });
            assert.deepStrictEqual(steps.map((s) => s.status), ["ok", "ok", "error", "ok", "warn"]);
            assert.match(steps[2].detail, /ECONNRESET/);
            assert.match(steps[4].detail, /Java/);
            assert.strictEqual(progress[0], "running");
            assert.strictEqual(progress.at(-1), "ok,ok,error,ok,warn");
            // The panel's node lets the new node's WireGuard IP through to the panel port, on wg0 only…
            const allow = calls.find((c) => c.urlPath === "/ufw/allow-from");
            assert.strictEqual(allow.node, "sangs");
            assert.deepStrictEqual(allow.data, { ip: "10.88.0.5", port: 1975, iface: "wg0" });
            // …and the new node checks it can get through.
            const probe = calls.find((c) => c.urlPath === "/panel-host/probe");
            assert.strictEqual(probe.node, "vps4");
            assert.deepStrictEqual(probe.data.targets, [{ host: "10.88.0.4", port: 1975 }]);
        } finally {
            keySync.syncAllToNode = saved.sync;
            wgService.syncMesh = saved.mesh;
            lavalinkStore.get = saved.get;
            lavalinkService.installOnNode = saved.install;
        }
    });

    await test("provision: a node with no WireGuard identity is an error that says what to install", async () => {
        const node = await fakeDb.create("nodes", { name: "vps4", host: "203.0.113.10", port: 4200, apiKey: "k4", enabled: true });
        const saved = wgService.syncMesh;
        wgService.syncMesh = async () => [{ nodeId: node._id, node: "vps4", ok: false, stage: "setup", error: "wg: not found" }];
        try {
            const steps = await nodeSetup.provision(node);
            const wg = steps.find((s) => s.label === "WireGuard mesh");
            assert.strictEqual(wg.status, "error");
            assert.match(wg.detail, /wireguard-tools/);
        } finally {
            wgService.syncMesh = saved;
        }
    });

    console.log("lease + agent firewall");

    await test("panelLease.claim: one node, told to reach the panel over WireGuard", async () => {
        await panelLease.load();
        const node = { _id: "n5", name: "vps5", host: "203.0.113.20", port: 4200, apiKey: "k5" };
        const r = await panelLease.claim(node);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.panelUrl, "http://10.88.0.4:1975");
        const c = calls.find((x) => x.urlPath === "/lease");
        assert.strictEqual(c.node, "vps5");
        assert.deepStrictEqual(c.data, { epoch: panelLease.current(), panelNodeId: "node-panel", panelUrl: "http://10.88.0.4:1975" });
    });

    await test("agent ufw: the rule is narrowed to an interface only when asked, names are checked", () => {
        assert.strictEqual(agentUfw.allowFromRule("10.88.0.5", 1975, "wg0"), "allow in on wg0 from 10.88.0.5 to any port 1975 proto tcp comment 'bot-panel: panel access'");
        assert.strictEqual(agentUfw.allowFromRule("203.0.113.10", 4200), "allow from 203.0.113.10 to any port 4200 proto tcp comment 'bot-panel: panel access'");
        assert.ok(agentUfw.IFACE_RE.test("wg0"));
        assert.ok(!agentUfw.IFACE_RE.test("wg0; reboot"));
        assert.ok(!agentUfw.IFACE_RE.test("a-very-long-interface-name"));
    });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
    process.exit(0);
})();
