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

const {
    renderYaml, sha256, hasYoutubePlugin, parseYaml, effective, applyEdits, describeUnsupported,
} = require("../server/services/lavalinkConfig");
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

// ── applyEdits ───────────────────────────────────────────────────────────────
//
// The panel offers two ways to edit the same config: the yaml itself, and the
// form fields. For the second to be usable on a hand-tuned file, an edit has to
// change ONLY the value it targets — re-serialising the document would reflow
// 160 lines, move every comment and turn a one-field change into an unreviewable
// diff. Each edit is therefore spliced over the exact byte range of its value.

// Deliberately awkward, the way a real file is: comments, 4-space indent, an
// unquoted scalar, an explicit `snapshot: false` this renderer leaves implicit,
// and a second `plugins:` key that is NOT the plugin list.
const HAND_TUNED = [
    "# hand written - keep me",
    "server:",
    "    port: 1012   # privileged, needs sudo",
    "    address: 0.0.0.0",
    "lavalink:",
    "    server:",
    '        password: "lavalink"',
    "        httpConfig:",
    '          proxyHost: "127.0.0.1"',
    "        sources:",
    "            spotify: true",
    "            youtube: false",
    "    plugins:",
    '        - dependency: "com.dunctebot:skybot-lavalink-plugin:1.7.0"',
    '          repository: "https://maven.lavalink.dev/releases"',
    "          snapshot: false",
    "plugins:",
    "    lavasrc:",
    "        spotify:",
    '            clientSecret: "keep-this-secret"',
    "",
].join("\n");

const current = (text) => {
    const p = parseYaml(text);
    return { port: p.port, address: p.address, password: p.password, sources: p.sources, plugins: p.plugins };
};

ok("saving with nothing changed leaves the file byte-identical", () => {
    // Anything less and every save would rewrite the file and mark every node
    // as drifted — including re-quoting `address: 0.0.0.0`.
    const r = applyEdits(HAND_TUNED, current(HAND_TUNED));
    assert.strictEqual(r.yaml, HAND_TUNED);
    assert.strictEqual(r.reformatted, false);
});

ok("changing one field rewrites one line and nothing else", () => {
    const r = applyEdits(HAND_TUNED, { port: 3636 });
    const before = HAND_TUNED.split("\n");
    const after = r.yaml.split("\n");
    assert.strictEqual(after.length, before.length);
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    assert.deepStrictEqual(changed, [2]);
    assert.strictEqual(after[2], "    port: 3636   # privileged, needs sudo"); // comment survives
    assert.strictEqual(parseYaml(r.yaml).port, 3636);
});

ok("edits never disturb the rest of the document", () => {
    const r = applyEdits(HAND_TUNED, { password: "moi", sources: { spotify: false } });
    assert.ok(r.yaml.includes('clientSecret: "keep-this-secret"'));
    assert.ok(r.yaml.includes('proxyHost: "127.0.0.1"'));
    assert.ok(r.yaml.includes("# hand written - keep me"));
    assert.strictEqual(parseYaml(r.yaml).password, "moi");
    assert.strictEqual(parseYaml(r.yaml).sources.spotify, false);
});

ok("an unchanged plugin list is left alone, explicit snapshot:false and all", () => {
    const r = applyEdits(HAND_TUNED, { plugins: current(HAND_TUNED).plugins });
    assert.strictEqual(r.yaml, HAND_TUNED);
});

ok("a changed plugin list keeps its indentation and the rest of the file", () => {
    const plugins = [
        ...current(HAND_TUNED).plugins,
        { dependency: "dev.lavalink.youtube:youtube-plugin:1.18.2", repository: "", snapshot: true },
    ];
    const r = applyEdits(HAND_TUNED, { plugins });
    const parsed = parseYaml(r.yaml);
    assert.strictEqual(parsed.plugins.length, 2);
    assert.strictEqual(parsed.plugins[1].snapshot, true);
    assert.match(r.yaml, /\n {8}- dependency: "dev\.lavalink\.youtube/); // same 8-space indent
    assert.ok(r.yaml.includes('clientSecret: "keep-this-secret"'));
    assert.strictEqual(r.reformatted, false);
});

ok("a key the file does not have is inserted, and that is reported", () => {
    const r = applyEdits(HAND_TUNED, { filters: { volume: false } });
    assert.strictEqual(r.reformatted, true);
    assert.deepStrictEqual(r.inserted, ["lavalink.server.filters.volume"]);
    assert.strictEqual(parseYaml(r.yaml).filters.volume, false);
});

ok("applyEdits refuses broken YAML rather than writing it", () => {
    assert.throws(() => applyEdits("server:\n  port: 1\n bad: [", { port: 2 }), /not valid YAML/);
});

// ── describeUnsupported ──────────────────────────────────────────────────────

ok("switching back to the form reports every block the form cannot render", () => {
    const { error, dropped } = describeUnsupported(HAND_TUNED);
    assert.strictEqual(error, null);
    assert.ok(dropped.includes("plugins"), "top-level plugin settings block");
    assert.ok(dropped.includes("lavalink.server.httpConfig"), "proxy config");
    assert.ok(dropped.includes("lavalink.server.sources.spotify"), "a source with no checkbox");
});

ok("a config the form fully models reports nothing dropped", () => {
    assert.deepStrictEqual(describeUnsupported(renderYaml(BASE)).dropped, []);
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
