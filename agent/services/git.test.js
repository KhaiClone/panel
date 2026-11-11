/**
 * Standalone checks that clone/pull trust GitHub's published host keys without
 * a prompt — no test framework, no network, no real git: child_process.exec is
 * replaced before services/git loads and records what each command was given.
 * Run:  node agent/services/git.test.js
 *
 * The incident (2026-11-11): creating a bot on VPS dio 2 failed with "Host key
 * verification failed" — that node had never SSHed to GitHub, so it had no
 * ~/.ssh/known_hosts, and the agent's clone has no TTY to answer ssh's prompt.
 * Covered:
 *   - agent/github_known_hosts holds exactly GitHub's published keys
 *   - git clone and git pull run with GIT_SSH_COMMAND pointing ssh at that file
 *     (pull still without the agent's key — utils/projectEnv.js)
 *   - a GIT_SSH_COMMAND already in the environment is kept
 *   - ssh reads the option as three global known-hosts files and leaves
 *     StrictHostKeyChecking alone (needs sh + ssh on PATH, skipped otherwise)
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const childProcess = require("child_process");

const KEY = `fake-agent-key-${Date.now()}`;
process.env.AGENT_API_KEY = KEY;
delete process.env.GIT_SSH_COMMAND;

// Every exec services/git makes lands here instead of a shell.
const calls = [];
const fakeExec = (cmd, opts, cb) => {
    if (typeof opts === "function") [opts, cb] = [{}, opts];
    calls.push({ cmd, env: opts?.env });
    process.nextTick(() => cb(null, "", ""));
};
fakeExec[util.promisify.custom] = (cmd, opts = {}) =>
    new Promise((resolve) => {
        calls.push({ cmd, env: opts.env });
        resolve({ stdout: "", stderr: "" });
    });
childProcess.exec = fakeExec;

const git = require("./git");

// GitHub's published fingerprints (docs: "GitHub's SSH key fingerprints",
// also https://api.github.com/meta "ssh_key_fingerprints").
const PUBLISHED = [
    "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
];

let failures = 0;
const test = async (name, fn) => {
    try {
        const skipped = await fn();
        console.log(skipped ? `  skip ${name} — ${skipped}` : `  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
    }
};

/** The env of the last call whose command matches `re`. */
const envOf = (re) => {
    const call = [...calls].reverse().find((c) => re.test(c.cmd));
    assert.ok(call, `no call matching ${re}`);
    assert.ok(call.env, `call ${re} ran without an explicit env`);
    return call.env;
};

/** Whether `cmd` runs (exit status 0 not required, just found). */
const has = (cmd, args) => !childProcess.spawnSync(cmd, args, { stdio: "ignore" }).error;

(async () => {
    await test("github_known_hosts holds exactly GitHub's published keys", async () => {
        const lines = fs.readFileSync(git.GITHUB_KNOWN_HOSTS, "utf8")
            .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
        assert.strictEqual(lines.length, PUBLISHED.length);
        for (const line of lines) assert.ok(line.startsWith("github.com "), line.slice(0, 40));
        if (!has("ssh-keygen", ["-?"])) return "ssh-keygen not on PATH (keys not fingerprinted)";
        const out = childProcess.execFileSync("ssh-keygen", ["-lf", git.GITHUB_KNOWN_HOSTS], { encoding: "utf8" });
        const prints = out.trim().split(/\r?\n/).map((l) => l.split(/\s+/)[1]).sort();
        assert.deepStrictEqual(prints, [...PUBLISHED].sort());
    });

    await test("git clone runs with the pinned host keys", async () => {
        await git.cloneRepo("https://github.com/acme/bot", path.join(os.tmpdir(), "x"), "main");
        const env = envOf(/^git clone /);
        assert.ok(env.GIT_SSH_COMMAND.includes(git.GITHUB_KNOWN_HOSTS), env.GIT_SSH_COMMAND);
        assert.ok(env.GIT_SSH_COMMAND.includes("GlobalKnownHostsFile="));
        assert.ok(!/StrictHostKeyChecking/i.test(env.GIT_SSH_COMMAND), "must not loosen host key checking");
        assert.strictEqual(env.PATH, process.env.PATH);
    });

    await test("git pull runs with them too, still without the agent's key", async () => {
        await git.pullRepo(os.tmpdir());
        const env = envOf(/^git pull$/);
        assert.ok(env.GIT_SSH_COMMAND.includes(git.GITHUB_KNOWN_HOSTS));
        assert.strictEqual(env.AGENT_API_KEY, undefined);
    });

    await test("a GIT_SSH_COMMAND already set is kept", async () => {
        const env = git.sshEnv({ PATH: "/bin", GIT_SSH_COMMAND: "ssh -i /k" });
        assert.strictEqual(env.GIT_SSH_COMMAND, "ssh -i /k");
    });

    await test("ssh reads it as three global known-hosts files, strict checking untouched", async () => {
        if (!has("sh", ["-c", "exit 0"]) || !has("ssh", ["-V"])) return "sh or ssh not on PATH";
        const { GIT_SSH_COMMAND } = git.sshEnv({});
        // git runs GIT_SSH_COMMAND through sh, so do the same; -G only prints
        // the resolved config (no connection).
        const res = childProcess.spawnSync("sh", ["-c", `${GIT_SSH_COMMAND} -G github.com`], { encoding: "utf8" });
        assert.strictEqual(res.status, 0, res.stderr);
        const conf = Object.fromEntries(res.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
            const i = l.indexOf(" ");
            return [l.slice(0, i), l.slice(i + 1)];
        }));
        const files = conf.globalknownhostsfile;
        assert.ok(files.startsWith(git.GITHUB_KNOWN_HOSTS + " ") || files.startsWith(git.GITHUB_KNOWN_HOSTS.replace(/\\/g, "/") + " "), files);
        assert.ok(files.endsWith(" /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2"), files);
        assert.ok(!["no", "off", "accept-new"].includes(conf.stricthostkeychecking), conf.stricthostkeychecking);
    });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
