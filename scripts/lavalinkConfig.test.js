#!/usr/bin/env node
/**
 * Checks for the Lavalink config renderer and the updater's version compare.
 * Run:  node scripts/lavalinkConfig.test.js
 *
 * Neither module touches the database, so this needs no fixture.
 *
 * The guarantee that matters most here is DETERMINISM: the panel decides which
 * nodes are out of sync by comparing sha256(renderYaml(settings)) against the
 * sha each agent reports. A renderer that varies between calls would mark every
 * node as drifted and restart the whole fleet on every sync.
 */

const assert = require("assert");

const { renderYaml, sha256, hasYoutubePlugin, parseYaml, effective } = require("../server/services/lavalinkConfig");
const { cmpVersion } = require("../server/services/lavalinkUpdater");
const { pm2MemoryCeiling } = require("../agent/services/lavalink");

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

const BASE = {
    port: 2333,
    address: "0.0.0.0",
    password: "s3cret",
    heap: "512M",
    sources: { youtube: true, bandcamp: true, soundcloud: true, twitch: false, vimeo: true, nico: true, http: true, local: false },
    filters: { volume: true, karaoke: false },
    plugins: [],
    yamlOverride: null,
};

// ── renderYaml ───────────────────────────────────────────────────────────────

ok("same settings render byte-identical output", () => {
    assert.strictEqual(renderYaml(BASE), renderYaml({ ...BASE }));
    assert.strictEqual(sha256(renderYaml(BASE)), sha256(renderYaml({ ...BASE })));
});

ok("a different password changes the sha", () => {
    assert.notStrictEqual(sha256(renderYaml(BASE)), sha256(renderYaml({ ...BASE, password: "other" })));
});

ok("port and address land under server:", () => {
    const yaml = renderYaml({ ...BASE, port: 2444, address: "127.0.0.1" });
    assert.match(yaml, /server:\n {2}port: 2444\n {2}address: "127\.0\.0\.1"/);
});

ok("password lands under lavalink.server, quoted", () => {
    assert.match(renderYaml(BASE), /\n {2}server:\n {4}password: "s3cret"/);
});

ok("a password with quotes or backslashes stays valid YAML", () => {
    const yaml = renderYaml({ ...BASE, password: 'a"b\\c' });
    assert.match(yaml, /password: "a\\"b\\\\c"/);
});

ok("a disabled source renders false, an enabled one true", () => {
    const yaml = renderYaml(BASE);
    assert.match(yaml, /\n {6}twitch: false/);
    assert.match(yaml, /\n {6}bandcamp: true/);
});

ok("a filter defaults to true and is only false when explicitly disabled", () => {
    const yaml = renderYaml(BASE);
    assert.match(yaml, /\n {6}karaoke: false/); // explicitly false in BASE
    assert.match(yaml, /\n {6}timescale: true/); // absent from BASE → default
});

ok("the youtube plugin turns the built-in youtube source off", () => {
    const plugins = [{ dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2", repository: "https://maven.lavalink.dev/releases" }];
    const yaml = renderYaml({ ...BASE, plugins });
    assert.ok(hasYoutubePlugin(plugins));
    assert.match(yaml, /\n {6}youtube: false/);
    assert.match(yaml, /dependency: "dev\.lavalink\.youtube:youtube-plugin:1\.18\.2"/);
});

ok("no plugins means no plugins: block at all", () => {
    assert.ok(!renderYaml(BASE).includes("plugins:"));
});

ok("yamlOverride is used verbatim and wins over every other field", () => {
    const yaml = renderYaml({ ...BASE, yamlOverride: "server:\n  port: 9999" });
    assert.strictEqual(yaml, "server:\n  port: 9999\n");
    assert.ok(!yaml.includes("s3cret"));
});

ok("an empty yamlOverride falls back to the form", () => {
    assert.strictEqual(renderYaml({ ...BASE, yamlOverride: "   " }), renderYaml(BASE));
});

// ── parseYaml / effective ────────────────────────────────────────────────────
//
// A hand-written application.yml is the source of truth once it is set, so the
// panel has to read the port, password and plugin list back OUT of it. Getting
// this wrong is not cosmetic: the health check would knock on the stored port
// with the stored password while the node listens somewhere else entirely.

// Shaped like the real config in production: 4-space indent, and TWO different
// "plugins" keys — lavalink.plugins is the jar list, the top-level plugins: is
// per-plugin settings.
const HAND_WRITTEN = [
    "server:",
    "    port: 3636",
    '    address: "0.0.0.0"',
    "lavalink:",
    "    server:",
    '        password: "lavalink"',
    "        sources:",
    "            spotify: true",
    "            youtube: false",
    "    plugins:",
    '        - dependency: "com.dunctebot:skybot-lavalink-plugin:1.7.0"',
    '          repository: "https://maven.lavalink.dev/releases"',
    '        - dependency: "dev.lavalink.youtube:youtube-plugin:abc123"',
    "          snapshot: true",
    "plugins:",
    "    youtube:",
    "        enabled: true",
    "        clients:",
    "            - TV",
    "            - WEB",
    "",
].join("\n");

ok("parseYaml reads port, address and password", () => {
    const p = parseYaml(HAND_WRITTEN);
    assert.strictEqual(p.error, null);
    assert.strictEqual(p.port, 3636);
    assert.strictEqual(p.address, "0.0.0.0");
    assert.strictEqual(p.password, "lavalink");
});

ok("parseYaml takes lavalink.plugins, not the top-level plugins: settings block", () => {
    const p = parseYaml(HAND_WRITTEN);
    assert.strictEqual(p.plugins.length, 2);
    assert.strictEqual(p.plugins[0].dependency, "com.dunctebot:skybot-lavalink-plugin:1.7.0");
    assert.strictEqual(p.plugins[0].repository, "https://maven.lavalink.dev/releases");
    assert.strictEqual(p.plugins[0].snapshot, false);
    assert.strictEqual(p.plugins[1].snapshot, true);
    assert.strictEqual(p.plugins[1].repository, "");
});

ok("parseYaml keeps sources the file declares, including ones the form has no box for", () => {
    const p = parseYaml(HAND_WRITTEN);
    assert.strictEqual(p.sources.spotify, true);
    assert.strictEqual(p.sources.youtube, false);
});

ok("parseYaml reports broken YAML instead of throwing", () => {
    const p = parseYaml("server:\n  port: 1\n bad indent: [");
    assert.ok(p.error, "expected an error message");
    assert.deepStrictEqual(p.plugins, []);
});

ok("effective without an override is just the stored settings", () => {
    const e = effective(BASE);
    assert.strictEqual(e.custom, false);
    assert.strictEqual(e.port, BASE.port);
    assert.strictEqual(e.password, BASE.password);
});

ok("effective with an override reads every value out of the file", () => {
    const e = effective({ ...BASE, yamlOverride: HAND_WRITTEN });
    assert.strictEqual(e.custom, true);
    assert.strictEqual(e.parseError, null);
    assert.strictEqual(e.port, 3636);
    assert.strictEqual(e.password, "lavalink");
    assert.strictEqual(e.plugins.length, 2);
    // The stored form values are NOT what the nodes run.
    assert.notStrictEqual(e.password, BASE.password);
    assert.notStrictEqual(e.plugins.length, BASE.plugins.length);
});

ok("effective on unparseable YAML keeps the stored values and says why", () => {
    const e = effective({ ...BASE, yamlOverride: "server:\n  port: 1\n bad: [" });
    assert.strictEqual(e.custom, true);
    assert.ok(e.parseError);
    assert.strictEqual(e.port, BASE.port);
});

// ── pm2MemoryCeiling ─────────────────────────────────────────────────────────
//
// pm2 7 applies a 200MB max_memory_restart when the caller passes none — pm2 6
// did not. A JVM crosses 200MB before it finishes booting, so on a pm2 7 node
// Lavalink booted, reported ready, was SIGKILLed and restarted every 30 seconds
// with nothing in its log. The ceiling is therefore always passed explicitly,
// and must leave room for everything -Xmx does NOT cover: metaspace, the code
// cache, thread stacks and the direct byte buffers an audio server lives on.

ok("the ceiling is twice the heap", () => {
    assert.strictEqual(pm2MemoryCeiling("1G"), "2048M");
    assert.strictEqual(pm2MemoryCeiling("2G"), "4096M");
});

ok("a small heap still gets at least 1G — the JVM overhead does not shrink with it", () => {
    assert.strictEqual(pm2MemoryCeiling("512M"), "1024M");
    assert.strictEqual(pm2MemoryCeiling("256M"), "1024M");
});

ok("an unreadable heap value falls back to a safe ceiling, never to no limit", () => {
    for (const bad of ["", null, undefined, "bogus", "1GB"]) {
        assert.strictEqual(pm2MemoryCeiling(bad), "2048M", `for ${JSON.stringify(bad)}`);
    }
});

// ── cmpVersion ───────────────────────────────────────────────────────────────

ok("4.2.10 is newer than 4.2.9 (numeric, not lexical)", () => {
    assert.ok(cmpVersion("4.2.9", "4.2.10") < 0);
    assert.ok(cmpVersion("4.2.10", "4.2.9") > 0);
});

ok("identical tags compare equal, with or without a v prefix", () => {
    assert.strictEqual(cmpVersion("4.2.2", "4.2.2"), 0);
    assert.strictEqual(cmpVersion("v4.2.2", "4.2.2"), 0);
});

ok("a shorter tag is not newer than its own patch release", () => {
    assert.ok(cmpVersion("4.2", "4.2.1") < 0);
});

console.log(`\n${passed} checks passed${process.exitCode ? " — but some FAILED above" : ""}\n`);
