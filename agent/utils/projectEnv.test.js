/**
 * Standalone checks that project code never inherits the agent's key — no
 * test framework needed, and no PM2 or git: child_process.exec is replaced
 * before the agent's services load, and records what each command was given.
 * Run:  node agent/utils/projectEnv.test.js
 *
 * The incident (found in the 2026-11-04 review): the pm2 CLI copies its own
 * environment into every app it starts, and the agent ran it with its whole
 * process.env — so every bot, site, Lavalink and install script had
 * AGENT_API_KEY, the key to /term, /fs and /self/env of that node.
 * Covered:
 *   - projectEnv drops what agent/.env defines and AGENT_API_KEY, keeps the rest
 *     (and PATH/HOME/PM2_HOME even when agent/.env sets them)
 *   - `pm2 start` for a bot runs without the key
 *   - install commands and `git pull` run without it
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const childProcess = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-projectenv-"));
const KEY = `fake-agent-key-${Date.now()}`;
process.env.AGENT_API_KEY = KEY;
// pm2.js keeps a known-good copy of dump.pm2 next to it: a scratch PM2_HOME.
process.env.PM2_HOME = path.join(tmp, "pm2");
fs.mkdirSync(process.env.PM2_HOME);
fs.writeFileSync(path.join(process.env.PM2_HOME, "dump.pm2"), "[]");

// Every exec the agent makes lands here instead of a shell.
const calls = [];
const fakeExec = (cmd, opts, cb) => {
    if (typeof opts === "function") [opts, cb] = [{}, opts];
    calls.push({ cmd, env: opts?.env });
    process.nextTick(() => cb(null, cmd.includes("jlist") ? "[]" : "", ""));
};
fakeExec[util.promisify.custom] = (cmd, opts = {}) =>
    new Promise((resolve) => {
        calls.push({ cmd, env: opts.env });
        resolve({ stdout: cmd.includes("jlist") ? "[]" : "", stderr: "" });
    });
childProcess.exec = fakeExec;

const { projectEnv, agentKeys } = require("./projectEnv");
const pm2 = require("../services/pm2");
const git = require("../services/git");

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

/** The env a command matching `re` ran with — the agent's own when none was passed. */
const envOf = (re) => {
    const call = calls.filter((c) => re.test(c.cmd)).pop();
    assert.ok(call, `no command matched ${re}`);
    return call.env || process.env;
};

(async () => {
    console.log("projectEnv");

    const envFile = path.join(tmp, "agent.env");
    fs.writeFileSync(envFile, `AGENT_PORT=4200\nAGENT_API_KEY=${KEY}\nBOTS_ROOT_DIR=/srv/bots\nPM2_HOME=/srv/.pm2\n`);
    const base = { PATH: "/usr/bin", HOME: "/home/x", PM2_HOME: "/srv/.pm2", LANG: "C.UTF-8", NODE_ENV: "production", AGENT_API_KEY: KEY, AGENT_PORT: "4200", BOTS_ROOT_DIR: "/srv/bots" };

    await test("drops every agent/.env variable and keeps the machine's", () => {
        const env = projectEnv(base, envFile);
        assert.strictEqual(env.AGENT_API_KEY, undefined);
        assert.strictEqual(env.AGENT_PORT, undefined);
        assert.strictEqual(env.BOTS_ROOT_DIR, undefined);
        assert.deepStrictEqual(
            { PATH: env.PATH, HOME: env.HOME, PM2_HOME: env.PM2_HOME, LANG: env.LANG, NODE_ENV: env.NODE_ENV },
            { PATH: "/usr/bin", HOME: "/home/x", PM2_HOME: "/srv/.pm2", LANG: "C.UTF-8", NODE_ENV: "production" },
        );
        assert.strictEqual(base.AGENT_API_KEY, KEY, "the agent's own environment is left alone");
    });

    await test("without agent/.env: AGENT_API_KEY still goes", () => {
        const env = projectEnv(base, path.join(tmp, "missing.env"));
        assert.strictEqual(env.AGENT_API_KEY, undefined);
        assert.strictEqual(env.BOTS_ROOT_DIR, "/srv/bots");
        assert.deepStrictEqual(agentKeys(path.join(tmp, "missing.env")), ["AGENT_API_KEY"]);
    });

    console.log("project code the agent starts");

    const botPath = path.join(tmp, "bot");
    fs.mkdirSync(botPath);

    await test("pm2 start for a bot runs without the key", async () => {
        await pm2.startBot("123-mybot", botPath, "node index.js", "300M", null);
        const env = envOf(/pm2 start /);
        assert.strictEqual(env.AGENT_API_KEY, undefined);
        assert.strictEqual(env.PATH, process.env.PATH);
    });

    await test("a bot behind an egress proxy: the same, and the tunnel conf holds what the panel sent", async () => {
        await pm2.startBot("123-mybot", botPath, "node index.js", null, { type: "http", host: "203.0.113.9", port: 4200, username: "proxy", password: "proxy-only" });
        assert.strictEqual(envOf(/pm2 start /).AGENT_API_KEY, undefined);
        const conf = fs.readFileSync(path.join(botPath, ".proxychains4.conf"), "utf8");
        assert.ok(conf.includes("http 203.0.113.9 4200 proxy proxy-only"));
        assert.ok(!conf.includes(KEY));
    });

    await test("install commands run without the key", async () => {
        await git.installDeps(botPath, "npm install --omit=dev", null);
        assert.strictEqual(envOf(/npm install/).AGENT_API_KEY, undefined);
    });

    await test("git pull (and the project's hooks) runs without the key", async () => {
        await git.pullRepo(botPath);
        assert.strictEqual(envOf(/^git pull$/).AGENT_API_KEY, undefined);
    });

    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
