/**
 * Standalone checks for utils/paths.js — no test framework needed.
 * Run:  node agent/utils/paths.test.js
 *
 * Covers the guarantees the agent's security boundary depends on:
 * traversal is blocked, sibling directories that merely share a name prefix are
 * not treated as inside, and EXTRA_ROOTS widens the allowlist without opening it.
 */

const path = require("path");
const assert = require("assert");

// Configure the module's environment before requiring it — it reads env lazily,
// but setting these first keeps the intent obvious.
process.env.BOTS_ROOT_DIR = path.resolve("/srv/bots");
process.env.SITES_ROOT_DIR = path.resolve("/srv/sites");
process.env.EXTRA_ROOTS = `${path.resolve("/opt/arnto")}, ${path.resolve("/opt/Lavalink")}`;

const { resolveSafe, resolveAbs, resolveTarget, allowedRoots, isInside } = require("./paths");

let passed = 0;
const ok = (label, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ok   ${label}`);
    } catch (err) {
        console.error(`  FAIL ${label}\n       ${err.message}`);
        process.exitCode = 1;
    }
};
const throws = (label, fn) =>
    ok(label, () => {
        let threw = false;
        try {
            fn();
        } catch {
            threw = true;
        }
        assert.ok(threw, "expected this to throw, but it returned normally");
    });

const P = (p) => path.resolve(p);

console.log("\nresolveSafe — the {root, dir} convention");
ok("joins root + dir + sub", () =>
    assert.strictEqual(resolveSafe("bots", "buyer/bot", "src/index.js"), P("/srv/bots/buyer/bot/src/index.js")));
ok("sites root is separate from bots", () =>
    assert.strictEqual(resolveSafe("sites", "x"), P("/srv/sites/x")));
throws("blocks ../ traversal out of the root", () => resolveSafe("bots", "../../etc", "passwd"));
throws("blocks traversal hidden in the sub path", () => resolveSafe("bots", "buyer/bot", "../../../etc/passwd"));
throws("rejects an unknown root name", () => resolveSafe("nope", "x"));

console.log("\nisInside — directory boundaries, not string prefixes");
ok("a directory is inside itself", () => assert.strictEqual(isInside(P("/a/b"), P("/a/b")), true));
ok("a child is inside", () => assert.strictEqual(isInside(P("/a/b/c"), P("/a/b")), true));
ok("/a/bc is NOT inside /a/b", () => assert.strictEqual(isInside(P("/a/bc"), P("/a/b")), false));

console.log("\nresolveAbs — the absPath convention against EXTRA_ROOTS");
ok("accepts a path under an extra root", () =>
    assert.strictEqual(resolveAbs(P("/opt/arnto/auto")), P("/opt/arnto/auto")));
ok("accepts an extra root itself", () =>
    assert.strictEqual(resolveAbs(P("/opt/Lavalink")), P("/opt/Lavalink")));
ok("accepts a path under the normal bots root", () =>
    assert.strictEqual(resolveAbs(P("/srv/bots/buyer/bot")), P("/srv/bots/buyer/bot")));
ok("collapses a doubled separator before comparing", () =>
    assert.strictEqual(resolveAbs("/srv//sites/research4student"), P("/srv/sites/research4student")));
ok("resolves a sub path below an approved base", () =>
    assert.strictEqual(resolveAbs(P("/opt/arnto/auto"), "configs/a.json"), P("/opt/arnto/auto/configs/a.json")));
throws("refuses a path outside every root", () => resolveAbs(P("/etc")));
throws("refuses a sibling that shares a name prefix", () => resolveAbs(P("/opt/arnto-secret")));
throws("refuses ../ escaping an approved base", () => resolveAbs(P("/opt/arnto/auto"), "../../../etc/passwd"));
throws("refuses a relative path", () => resolveAbs("relative/dir"));
throws("refuses an empty path", () => resolveAbs(""));

console.log("\nresolveTarget — one entry point, two conventions");
ok("uses absPath when present", () =>
    assert.strictEqual(resolveTarget({ absPath: P("/opt/arnto/shop") }), P("/opt/arnto/shop")));
ok("falls back to root+dir when absPath is absent", () =>
    assert.strictEqual(resolveTarget({ root: "bots", dir: "buyer/bot" }), P("/srv/bots/buyer/bot")));

console.log("\nEXTRA_ROOTS unset — original behaviour is unchanged");
{
    delete process.env.EXTRA_ROOTS;
    ok("allowlist falls back to bots + sites only", () =>
        assert.deepStrictEqual(allowedRoots(), [P("/srv/bots"), P("/srv/sites")]));
    throws("a formerly-allowed extra path is now refused", () => resolveAbs(P("/opt/arnto/auto")));
    ok("resolveSafe still works", () =>
        assert.strictEqual(resolveSafe("bots", "buyer/bot"), P("/srv/bots/buyer/bot")));
}

console.log(`\n${passed} checks passed${process.exitCode ? " — but some FAILED above" : ""}\n`);
