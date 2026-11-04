/**
 * Standalone checks for the agent's CONNECT proxy password — no test
 * framework needed: a real proxy on 127.0.0.1 and a local target to reach.
 * Run:  node agent/services/proxy.test.js
 *
 * A bot's egress tunnel keeps its proxy password in .proxychains4.conf, inside
 * the project folder the bot can read. Until agent 1.14.0 that password was
 * AGENT_API_KEY itself. Covered:
 *   - the proxy-only secret opens the tunnel, and so does the key (the panel's
 *     own egress, tunnels written before the change)
 *   - a wrong or missing password gets 407
 *   - the proxy-only secret opens no agent route
 */

const assert = require("assert");
const http = require("http");
const net = require("net");

const KEY = `fake-agent-key-${Date.now()}`;
process.env.AGENT_API_KEY = KEY;

const { createProxy } = require("./proxy");
const { proxySecret } = require("../utils/crypto");
const { isValidAgentKey } = require("../middleware/auth");

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** The status the proxy answers a CONNECT to the target with. */
const connect = (proxyPort, targetPort, password) =>
    new Promise((resolve, reject) => {
        const headers = password === undefined ? {} : { "proxy-authorization": `Basic ${Buffer.from(`proxy:${password}`).toString("base64")}` };
        const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `127.0.0.1:${targetPort}`, headers });
        req.on("connect", (res, socket) => {
            socket.destroy();
            resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
    });

(async () => {
    const target = net.createServer((s) => s.end());
    const targetPort = await listen(target);
    const proxy = http.createServer((req, res) => res.end());
    createProxy(proxy);
    const proxyPort = await listen(proxy);

    console.log("agent CONNECT proxy");

    await test("the proxy-only secret opens the tunnel", async () => {
        assert.strictEqual(await connect(proxyPort, targetPort, proxySecret(KEY)), 200);
    });

    await test("the agent key still opens it", async () => {
        assert.strictEqual(await connect(proxyPort, targetPort, KEY), 200);
    });

    await test("a wrong or missing password gets 407", async () => {
        assert.strictEqual(await connect(proxyPort, targetPort, "nope"), 407);
        assert.strictEqual(await connect(proxyPort, targetPort, proxySecret("another-key")), 407);
        assert.strictEqual(await connect(proxyPort, targetPort, undefined), 407);
    });

    await test("the proxy-only secret is not the key and opens no agent route", () => {
        assert.notStrictEqual(proxySecret(KEY), KEY);
        assert.strictEqual(proxySecret(KEY), proxySecret(KEY));
        assert.strictEqual(isValidAgentKey(proxySecret(KEY)), false);
        assert.strictEqual(isValidAgentKey(KEY), true);
    });

    proxy.close();
    target.close();
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
