/**
 * Standalone checks for the agent's pm2-logrotate guarantee — no test
 * framework needed, and no PM2: ensureInstalled() takes its status and install
 * steps as parameters.
 * Run:  node agent/services/logrotate.test.js
 *
 * What is guaranteed: an existing install is never touched, a missing one is
 * installed once however many callers ask at the same moment (agent start and
 * the panel's setup step do), and PM2_LOGROTATE=off opts a node out.
 */

const assert = require("assert");
const logrotate = require("./logrotate");

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

const INSTALLED = { installed: true, status: "online", config: { max_size: "50M", retain: "7", compress: "true" } };

(async () => {
    console.log("logrotate.ensureInstalled");

    await test("already installed: nothing runs, settings are reported as they are", async () => {
        let runs = 0;
        const r = await logrotate.ensureInstalled({ status: async () => INSTALLED, run: async () => (runs++, INSTALLED) });
        assert.strictEqual(runs, 0);
        assert.strictEqual(r.changed, false);
        assert.strictEqual(r.config.max_size, "50M");
    });

    await test("stopped or errored counts as installed — it is repaired by hand, not reinstalled", async () => {
        let runs = 0;
        const r = await logrotate.ensureInstalled({ status: async () => ({ installed: true, status: "errored", config: null }), run: async () => (runs++, INSTALLED) });
        assert.strictEqual(runs, 0);
        assert.strictEqual(r.status, "errored");
    });

    await test("missing: installed, once, however many ask at the same moment", async () => {
        let runs = 0;
        let release;
        const gate = new Promise((r) => (release = r));
        const deps = {
            status: async () => ({ installed: false, status: "not_installed", config: null }),
            run: async () => {
                runs++;
                await gate;
                return INSTALLED;
            },
        };
        const a = logrotate.ensureInstalled(deps);
        const b = logrotate.ensureInstalled(deps);
        assert.strictEqual(a, b, "the second caller joins the first");
        release();
        const [ra, rb] = await Promise.all([a, b]);
        assert.strictEqual(runs, 1);
        assert.strictEqual(ra.changed, true);
        assert.strictEqual(rb.status, "online");
    });

    await test("PM2 unreadable: an error, not a false 'already there'", async () => {
        let runs = 0;
        await assert.rejects(
            logrotate.ensureInstalled({ status: async () => ({ installed: false, status: "unknown", config: null }), run: async () => (runs++, INSTALLED) }),
            /Could not read PM2's process list/,
        );
        assert.strictEqual(runs, 0);
    });

    await test("a failed install is reported, and the next call tries again", async () => {
        let runs = 0;
        const deps = { status: async () => ({ installed: false, status: "not_installed" }), run: async () => { runs++; throw new Error("npm ERR! network"); } };
        await assert.rejects(logrotate.ensureInstalled(deps), /network/);
        await assert.rejects(logrotate.ensureInstalled(deps), /network/);
        assert.strictEqual(runs, 2);
    });

    await test("PM2_LOGROTATE=off opts out, any case; anything else keeps it on", () => {
        const saved = process.env.PM2_LOGROTATE;
        try {
            process.env.PM2_LOGROTATE = "OFF";
            assert.strictEqual(logrotate.optedOut(), true);
            process.env.PM2_LOGROTATE = "on";
            assert.strictEqual(logrotate.optedOut(), false);
            delete process.env.PM2_LOGROTATE;
            assert.strictEqual(logrotate.optedOut(), false);
        } finally {
            if (saved === undefined) delete process.env.PM2_LOGROTATE;
            else process.env.PM2_LOGROTATE = saved;
        }
    });

    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
