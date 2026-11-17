/**
 * Checks for POST /git/remote's work (services/git.js setOrigin): after the
 * panel renames a customer's repo it points the checkout's origin at the new
 * name — only from the owner/name it expects, keeping the URL's form and host
 * alias. Runs real git in a temp folder (skipped when git is not on PATH).
 * Run:  node agent/services/gitRemote.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const git = require("./git");

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.log(`  FAIL ${name}\n       ${err.message}`);
    }
};

const hasGit = () => {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
};

const repoWith = (url) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-remote-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    if (url) execFileSync("git", ["remote", "add", "origin", url], { cwd: dir });
    return dir;
};
const origin = (dir) => execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir }).toString().trim();

(async () => {
    if (!hasGit()) {
        console.log("  skip git remote checks — git is not on PATH");
        return;
    }

    await test("scp form with .git: only owner/name changes", async () => {
        const dir = repoWith("git@github.com:acme/meomeo.git");
        const r = await git.setOrigin(dir, "acme/meomeo", "acme/meomeo-meo-kiem-ca");
        assert.deepStrictEqual(r, { changed: true, url: "git@github.com:acme/meomeo-meo-kiem-ca.git" });
        assert.strictEqual(origin(dir), "git@github.com:acme/meomeo-meo-kiem-ca.git");
    });

    await test("an SSH host alias and https keep their form", async () => {
        const a = repoWith("git@github.com-deploy:acme/lofi");
        await git.setOrigin(a, "acme/lofi", "acme/khach.a-lofi-music");
        assert.strictEqual(origin(a), "git@github.com-deploy:acme/khach.a-lofi-music");
        const b = repoWith("https://github.com/acme/lofi.git/");
        await git.setOrigin(b, "ACME/Lofi", "acme/khach.a-lofi-music");
        assert.strictEqual(origin(b), "https://github.com/acme/khach.a-lofi-music.git/");
    });

    await test("already at the new name → nothing to do", async () => {
        const dir = repoWith("git@github.com:acme/new-name.git");
        const r = await git.setOrigin(dir, "acme/old-name", "acme/new-name");
        assert.strictEqual(r.changed, false);
    });

    await test("origin pointing anywhere else is refused, not overwritten", async () => {
        const dir = repoWith("git@github.com:someone/else.git");
        await assert.rejects(() => git.setOrigin(dir, "acme/old", "acme/new"), (e) => e.status === 409 && /left as it is/.test(e.message));
        assert.strictEqual(origin(dir), "git@github.com:someone/else.git");
    });

    await test("no origin, or from/to not owner/name → refused", async () => {
        await assert.rejects(() => git.setOrigin(repoWith(null), "acme/a", "acme/b"), (e) => e.status === 409);
        const dir = repoWith("git@github.com:acme/a.git");
        await assert.rejects(() => git.setOrigin(dir, "acme/a", "acme/b; rm -rf /"), (e) => e.status === 400);
        await assert.rejects(() => git.setOrigin(dir, "acme/a", "x/y/z"), (e) => e.status === 400);
        assert.strictEqual(origin(dir), "git@github.com:acme/a.git");
    });
})().then(() => {
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
});
