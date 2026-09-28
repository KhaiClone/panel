/**
 * Standalone checks for services/panelLease.js and utils/envFile.js — no test
 * framework needed.
 * Run:  node agent/services/panelLease.test.js
 *
 * The lease is what stops an old panel from driving the nodes after the panel
 * has moved, so the guarantees here are the ones a move depends on: a lower
 * epoch is always refused, the same or a higher one always passes, and the
 * lease survives a restart (it is read back from disk).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const LEASE = path.join(os.tmpdir(), `panel-lease-test-${process.pid}.json`);
process.env.PANEL_LEASE_PATH = LEASE;
fs.rmSync(LEASE, { force: true });

const lease = require("./panelLease");
const { setKeyInText } = require("../utils/envFile");

let failures = 0;
const test = (name, fn) => {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
};

/** Run the middleware against a fake request; returns { passed, status, body }. */
const through = (headers) => {
    const out = { passed: false, status: null, body: null };
    const res = {
        status(code) { out.status = code; return this; },
        json(body) { out.body = body; return this; },
    };
    lease.middleware({ headers }, res, () => { out.passed = true; });
    return out;
};

console.log("panelLease");

test("a fresh agent follows nobody (epoch 0) and lets everything through", () => {
    assert.deepStrictEqual(lease.read().epoch, 0);
    assert.ok(through({}).passed);
    assert.ok(through({ "x-panel-epoch": "1" }).passed);
});

test("a claim is persisted and read back after a restart", () => {
    const r = lease.claim(3, "node-a");
    assert.ok(r.ok);
    const onDisk = JSON.parse(fs.readFileSync(LEASE, "utf8"));
    assert.strictEqual(onDisk.epoch, 3);
    assert.strictEqual(onDisk.panelNodeId, "node-a");
});

test("the same panel re-claiming at its own epoch is accepted (every boot does it)", () => {
    assert.ok(lease.claim(3, "node-a").ok);
});

test("a lower epoch cannot claim", () => {
    const r = lease.claim(2, "node-old");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.lease.epoch, 3);
    assert.strictEqual(lease.read().panelNodeId, "node-a");
});

test("requests from an older panel get 409 PANEL_SUPERSEDED", () => {
    const r = through({ "x-panel-epoch": "2" });
    assert.strictEqual(r.passed, false);
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, "PANEL_SUPERSEDED");
    assert.strictEqual(r.body.lease.epoch, 3);
});

test("the current and newer panels pass; a garbage epoch does not", () => {
    assert.ok(through({ "x-panel-epoch": "3" }).passed);
    assert.ok(through({ "x-panel-epoch": "4" }).passed);
    assert.strictEqual(through({ "x-panel-epoch": "abc" }).status, 409);
});

test("requests without the header still pass (older panels, deliberate probes)", () => {
    assert.ok(through({}).passed);
});

test("a move's new epoch takes over and locks the previous panel out", () => {
    assert.ok(lease.claim(4, "node-b").ok);
    assert.strictEqual(through({ "x-panel-epoch": "3" }).status, 409);
    assert.ok(through({ "x-panel-epoch": "4" }).passed);
});

test("epochs must be positive integers", () => {
    assert.throws(() => lease.claim(0, "x"), /positive integer/);
    assert.throws(() => lease.claim(1.5, "x"), /positive integer/);
});

console.log("envFile.setKeyInText");

test("replaces a key in place, keeping comments and order", () => {
    const text = "# c\nA=1\nPANEL_DIR=/old\nB=2\n";
    assert.strictEqual(setKeyInText(text, "PANEL_DIR", "/new"), "# c\nA=1\nPANEL_DIR=/new\nB=2\n");
});

test("appends a missing key once, ending with a newline", () => {
    assert.strictEqual(setKeyInText("A=1\n\n", "PANEL_DIR", "/p"), "A=1\nPANEL_DIR=/p\n");
    assert.strictEqual(setKeyInText("", "K", "v"), "K=v\n");
});

test("null removes every line for the key", () => {
    assert.strictEqual(setKeyInText("A=1\nPANEL_DIR=/x\nPANEL_DIR=/y\nB=2", "PANEL_DIR", null), "A=1\nB=2");
});

test("does not touch commented-out lines or keys that merely share a prefix", () => {
    const text = "#PANEL_DIR=/c\nPANEL_DIR_X=1\n";
    assert.strictEqual(setKeyInText(text, "PANEL_DIR", "/p"), "#PANEL_DIR=/c\nPANEL_DIR_X=1\nPANEL_DIR=/p\n");
});

fs.rmSync(LEASE, { force: true });
fs.rmSync(`${LEASE}.tmp`, { force: true });

if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
