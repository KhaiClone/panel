#!/usr/bin/env node
/**
 * Checks what a bot's egress tunnel is given as its proxy password — no test
 * framework needed.
 * Run:  node scripts/egressProxySecret.test.js
 *
 * The incident (2026-11-04 review): executor.buildEgressProxyConf handed the
 * egress node's AGENT_API_KEY to the bot's agent, which wrote it into
 * .proxychains4.conf inside the project folder — readable by the bot, and the
 * key to that node's /term, /fs and /self/env. Since agent 1.14.0 the proxy
 * also takes agentCrypto.proxySecret(key), which opens nothing else.
 *
 * nodeService is stubbed (two fake nodes); nothing leaves the process. Covered:
 *   - an egress agent that says proxySecret → the bot gets the secret, never the key
 *   - an agent before 1.14.0 → still the key (its proxy takes nothing else), with a warning
 *   - an unreachable egress agent → the secret
 *   - egress on the bot's own node → no tunnel
 *   - /pm2/start carries the secret
 *   - the panel's and the agent's copies of the crypto file agree
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");

const SERVER = path.join(__dirname, "..", "server");
const stubAbs = (p, exports) => {
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const KEY_A = `fake-key-a-${Date.now()}`;
const KEY_B = `fake-key-b-${Date.now()}`;
const nodes = {
    a: { _id: "a", name: "node-a", host: "198.51.100.1", port: 4200, apiKey: KEY_A },
    b: { _id: "b", name: "node-b", host: "198.51.100.2", port: 4200, apiKey: KEY_B },
};
let health = {}; // node id → /health answer, or an Error to throw
const sent = [];
stubAbs(path.join(SERVER, "services", "nodeService.js"), {
    resolveNodeId: (id) => id,
    getNode: async (id) => nodes[id],
    agentRequest: async (node, method, urlPath, opts) => {
        if (urlPath === "/health") {
            const h = health[node._id];
            if (h instanceof Error) throw h;
            return h;
        }
        sent.push({ node: node._id, urlPath, data: opts?.data });
        return { output: "ok" };
    },
});

const executor = require(path.join(SERVER, "services", "executor.js"));
const agentCrypto = require(path.join(SERVER, "services", "agentCrypto.js"));

const warnings = [];
console.warn = (...a) => warnings.push(a.join(" "));

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n      ${err.stack || err.message}`);
    }
};

const bot = { _id: "x", pm2Name: "123-mybot", buyerID: "123", botID: "mybot", nodeId: "a", egressNodeId: "b", startScript: "node index.js" };

(async () => {
    console.log("egress tunnel password");

    await test("an agent that says proxySecret: the bot gets the secret, never the key", async () => {
        health = { b: { ok: true, version: "1.14.0", proxySecret: true } };
        const conf = await executor.buildEgressProxyConf(bot);
        assert.deepStrictEqual(conf, { type: "http", host: "198.51.100.2", port: 4200, username: "proxy", password: agentCrypto.proxySecret(KEY_B) });
        assert.notStrictEqual(conf.password, KEY_B);
    });

    await test("an agent before 1.14.0: still the key, with a warning to update it", async () => {
        health = { b: { ok: true, version: "1.13.0" } };
        warnings.length = 0;
        const conf = await executor.buildEgressProxyConf(bot);
        assert.strictEqual(conf.password, KEY_B);
        assert.ok(warnings.some((w) => w.includes("node-b") && w.includes("1.14.0")), warnings.join("\n"));
        assert.ok(!warnings.some((w) => w.includes(KEY_B)), "the warning never carries the key");
    });

    await test("an unreachable egress agent: the secret", async () => {
        health = { b: new Error("connect ECONNREFUSED") };
        const conf = await executor.buildEgressProxyConf(bot);
        assert.strictEqual(conf.password, agentCrypto.proxySecret(KEY_B));
    });

    await test("egress on the bot's own node: no tunnel", async () => {
        assert.strictEqual(await executor.buildEgressProxyConf({ ...bot, egressNodeId: "a" }), null);
        assert.strictEqual(await executor.buildEgressProxyConf({ ...bot, egressNodeId: null }), null);
    });

    await test("/pm2/start carries the secret to the bot's node", async () => {
        health = { b: { ok: true, version: "1.14.0", proxySecret: true } };
        sent.length = 0;
        await executor.startBot(bot);
        const start = sent.find((s) => s.urlPath === "/pm2/start");
        assert.strictEqual(start.node, "a");
        assert.strictEqual(start.data.proxyConf.password, agentCrypto.proxySecret(KEY_B));
        assert.ok(!JSON.stringify(start.data).includes(KEY_B));
    });

    await test("the panel's and the agent's crypto files are the same", () => {
        const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
        assert.strictEqual(read(path.join(SERVER, "services", "agentCrypto.js")), read(path.join(__dirname, "..", "agent", "utils", "crypto.js")));
        const agentSide = require(path.join(__dirname, "..", "agent", "utils", "crypto.js"));
        assert.strictEqual(agentSide.proxySecret(KEY_B), agentCrypto.proxySecret(KEY_B));
    });

    if (failures) {
        console.log(`\n${failures} failed`);
        process.exit(1);
    }
    console.log("\nall passed");
})();
