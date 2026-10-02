/**
 * Standalone checks for who owns spotify-tokener on a node — no test
 * framework, and no PM2: pm2's functions are replaced below, and "a tokener
 * somebody else runs" is a real socket listening on the port.
 * Run:  node agent/services/spotifyTokener.test.js
 *
 * What is guaranteed: a tokener the panel did not start — something already
 * answering on the port, or a pm2 process by the same name — is never started
 * next to, stopped, replaced or removed. The panel only ever manages the
 * process it registered from its own directory.
 */

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tokener-test-"));
process.env.LAVALINK_DIR = TMP;
// Anything that answers --version stands in for Chrome.
const FAKE_CHROME = process.execPath.replace(/\\/g, "/");
process.env.SPOTIFY_TOKENER_CHROME_PATH = FAKE_CHROME;

const pm2 = require("./pm2");
const tokener = require("./spotifyTokener");

const DIR = path.join(TMP, "spotify-tokener");
const ours = (status) => ({
    name: "spotify-tokener",
    pm2_env: { status, pm_exec_path: path.join(DIR, ".noflex-start.sh"), pm_cwd: DIR },
});
const foreign = (status) => ({
    name: "spotify-tokener",
    pm2_env: { status, pm_exec_path: "/usr/local/bin/spotify-tokener", pm_cwd: "/opt/spotify-tokener" },
});

let procs = [];
let calls = [];
pm2.getProcessList = async () => procs;
pm2.getBotStatus = async (name, list) => {
    const p = (list || procs).find((x) => x.name === name);
    return p ? { status: p.pm2_env.status } : { status: "stopped" };
};
pm2.startBot = async (name, dir, cmd) => {
    calls.push(["start", name, dir, cmd]);
    procs = [ours("online")];
};
pm2.deleteBot = async (name) => {
    calls.push(["delete", name]);
    procs = procs.filter((p) => p.name !== name);
};
pm2.stopBot = async (name) => calls.push(["stop", name]);

const listen = () =>
    new Promise((resolve) => {
        const server = net.createServer((c) => c.end()).listen(0, "127.0.0.1", () => resolve(server));
    });
const freePort = async () => {
    const s = await listen();
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
};
const writeState = (state) => {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, "state.json"), JSON.stringify(state));
};
const reset = () => {
    procs = [];
    calls = [];
    fs.rmSync(DIR, { recursive: true, force: true });
    process.env.SPOTIFY_TOKENER_CHROME_PATH = FAKE_CHROME;
};

let failures = 0;
const test = async (name, fn) => {
    reset();
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

(async () => {
    console.log("spotifyTokener.ensure / stop / status");

    await test("a port something else already answers on: nothing is started next to it", async () => {
        const other = await listen();
        const { port } = other.address();
        const r = await tokener.ensure(port);
        other.close();
        assert.strictEqual(r.external, true);
        assert.strictEqual(r.running, true);
        assert.deepStrictEqual(calls, []);
    });

    await test("a pm2 process by that name the panel did not start is never replaced, stopped or removed", async () => {
        procs = [foreign("online")];
        const port = await freePort();
        const r = await tokener.ensure(port, { force: true });
        assert.strictEqual(r.external, true);
        await tokener.ensure(null);
        await tokener.stop();
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(procs.length, 1);
    });

    await test("nothing there: the panel starts its own, on that port, from its own directory", async () => {
        const port = await freePort();
        const r = await tokener.ensure(port);
        assert.strictEqual(r.started, true);
        assert.strictEqual(calls.length, 1);
        const [op, name, dir, cmd] = calls[0];
        assert.strictEqual(op, "start");
        assert.strictEqual(name, "spotify-tokener");
        assert.strictEqual(dir, DIR);
        assert.ok(cmd.includes(`--addr 127.0.0.1:${port}`), cmd);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DIR, "state.json"), "utf8")).port, port);
    });

    await test("its own one already on that port: left running — its open port is not someone else's", async () => {
        const mine = await listen();
        const { port } = mine.address();
        procs = [ours("online")];
        writeState({ port, chrome: FAKE_CHROME });
        const r = await tokener.ensure(port);
        mine.close();
        assert.strictEqual(r.running, true);
        assert.strictEqual(r.started, false);
        assert.ok(!r.external);
        assert.deepStrictEqual(calls, []);
    });

    await test("Restart (force) restarts its own one", async () => {
        const mine = await listen();
        const { port } = mine.address();
        procs = [ours("online")];
        writeState({ port, chrome: FAKE_CHROME });
        await tokener.ensure(port, { force: true });
        mine.close();
        assert.deepStrictEqual(calls.map((c) => c[0]), ["start"]);
    });

    await test("its own one, crash-looping next to a tokener that now holds the port, is removed", async () => {
        const other = await listen();
        const { port } = other.address();
        procs = [ours("errored")];
        writeState({ port, chrome: FAKE_CHROME });
        const r = await tokener.ensure(port);
        other.close();
        assert.strictEqual(r.external, true);
        assert.deepStrictEqual(calls.map((c) => c[0]), ["delete"]);
    });

    await test("switched off or not in the config: its own one is removed", async () => {
        procs = [ours("online")];
        writeState({ port: 8081, chrome: FAKE_CHROME });
        const r = await tokener.ensure(null);
        assert.strictEqual(r.wanted, false);
        assert.deepStrictEqual(calls.map((c) => c[0]), ["delete"]);
        assert.ok(!fs.existsSync(path.join(DIR, "state.json")));
    });

    await test("no Chrome: nothing is started, and that is reported instead of thrown", async () => {
        process.env.SPOTIFY_TOKENER_CHROME_PATH = path.join(TMP, "no-such-chrome").replace(/\\/g, "/");
        const r = await tokener.ensure(await freePort());
        assert.strictEqual(r.code, "chrome-missing");
        assert.deepStrictEqual(calls, []);
    });

    await test("status recognises a tokener the panel did not start", async () => {
        const other = await listen();
        const { port } = other.address();
        const s = await tokener.status(port);
        assert.strictEqual(s.external, true);
        assert.strictEqual(s.managed, false);
        procs = [foreign("online")];
        const s2 = await tokener.status(port);
        other.close();
        assert.strictEqual(s2.foreignPm2, true);
        assert.strictEqual(s2.managed, false);
    });

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exitCode = failures ? 1 : 0;
})();
