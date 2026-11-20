#!/usr/bin/env node
/**
 * Checks for GET /api/decors/image (server/services/decorImageProxy.js + routes/decors.js),
 * the picture fetcher behind the Decors page's "Export image": only decor pictures on
 * Discord's CDN, never another host / port / path, never a redirect, never an SVG or
 * other non-raster answer; errors are English with a status and do not reach
 * errorHandler. axios and decorService are stubbed — nothing leaves the machine.
 * Run:  node scripts/decorImageProxy.test.js
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stubAbs = (p, exports) => {
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const stub = (rel, exports) => stubAbs(require.resolve(path.join(__dirname, "..", "server", rel)), exports);

// Fake Discord CDN: answers by URL.
const calls = [];
const answers = new Map();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
stubAbs(require.resolve("axios"), {
    get: async (url, opts) => {
        calls.push({ url, opts });
        const a = answers.get(url);
        if (!a) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return { status: a.status ?? 200, headers: { "content-type": a.type ?? "image/png" }, data: a.body ?? PNG };
    },
});
stub("services/decorService", {});

const { allowedUrl } = require("../server/services/decorImageProxy");
const decorRoutes = require("../server/routes/decors");

// ── Tiny harness ─────────────────────────────────────────────────────────────
let failed = 0;
const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        results.push(`  ✗ ${name}\n      ${err.message}`);
    }
}

function request(port, url) {
    return new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: url }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on("error", reject);
    });
}

(async () => {
    const OK = "https://cdn.discordapp.com/media/v1/collectibles-shop/1545193750261923880/1545193820377849937/static";
    const NAMEPLATE = "https://cdn.discordapp.com/assets/collectibles/nameplates/alt_raccoon_fur/1545193669932482620/static.png";
    const DECO = "https://cdn.discordapp.com/avatar-decoration-presets/a_628b1b338d3216a2a971083b2b2efffc.png?size=480&passthrough=false";

    await test("allowedUrl takes the four decor paths on Discord's CDN", () => {
        assert.strictEqual(allowedUrl(OK), OK);
        assert.strictEqual(allowedUrl(NAMEPLATE), NAMEPLATE);
        assert.strictEqual(allowedUrl(DECO), DECO);
        // Older profile effects and their stills (994 URLs in the 2026-11 data).
        const content = "https://cdn.discordapp.com/assets/content/7e802ac5dfdcf71e7a41d3a9eccbf882f947f01a296213638d8c686c42b55923";
        assert.strictEqual(allowedUrl(content), content);
        assert.ok(allowedUrl("https://media.discordapp.net/media/v1/collectibles-shop/1/2/static"));
    });

    await test("allowedUrl refuses other schemes, hosts, ports, logins and paths", () => {
        const bad = [
            "http://cdn.discordapp.com/media/v1/collectibles-shop/1/static",
            "https://cdn.discordapp.com.evil.test/media/v1/collectibles-shop/1/static",
            "https://evil.test/media/v1/collectibles-shop/1/static",
            "https://127.0.0.1/media/v1/collectibles-shop/1/static",
            "https://cdn.discordapp.com:4200/media/v1/collectibles-shop/1/static",
            "https://user:pw@cdn.discordapp.com/media/v1/collectibles-shop/1/static",
            "https://cdn.discordapp.com/attachments/1/2/x.svg",
            "https://cdn.discordapp.com/avatars/1/abc.png",
            "https://cdn.discordapp.com/assets-other/x.png",
            "https://cdn.discordapp.com/media/v1/collectibles-shop/../../attachments/1/2/x.svg",
            "https://cdn.discordapp.com/media/v1/collectibles-shop/%2e%2e/%2e%2e/attachments/x.svg",
            "file:///etc/passwd",
            "",
            null,
            "not a url",
        ];
        for (const u of bad) assert.strictEqual(allowedUrl(u), null, `should refuse ${u}`);
    });

    const app = express();
    app.use("/api/decors", decorRoutes);
    let reachedErrorHandler = 0;
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        reachedErrorHandler++;
        res.status(500).json({ error: err.message });
    });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address();
    const get = (u) => request(port, `/api/decors/image?url=${encodeURIComponent(u)}`);

    await test("a decor picture comes back as is, cached privately, sandboxed", async () => {
        answers.set(OK, { type: "image/png" });
        const r = await get(OK);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers["content-type"], "image/png");
        assert.ok(r.body.equals(PNG), "body changed");
        assert.match(r.headers["cache-control"], /private/);
        assert.match(r.headers["content-security-policy"], /sandbox/);
        const call = calls.at(-1);
        assert.strictEqual(call.url, OK);
        assert.strictEqual(call.opts.maxRedirects, 0, "must not follow redirects");
        assert.strictEqual(call.opts.responseType, "arraybuffer");
        assert.ok(call.opts.maxContentLength > 0 && call.opts.maxContentLength <= 50 * 1024 * 1024);
    });

    await test("a URL off the allow-list is refused with 400 and never fetched", async () => {
        const before = calls.length;
        const r = await get("https://evil.test/media/v1/collectibles-shop/1/static");
        assert.strictEqual(r.status, 400);
        assert.match(JSON.parse(r.body).error, /Discord's CDN/);
        assert.strictEqual(calls.length, before);
        const r2 = await request(port, "/api/decors/image");
        assert.strictEqual(r2.status, 400);
    });

    await test("an SVG (or any non-raster answer) is refused", async () => {
        const svg = "https://cdn.discordapp.com/media/v1/collectibles-shop/9/svg";
        answers.set(svg, { type: "image/svg+xml", body: Buffer.from("<svg onload=alert(1)>") });
        const r = await get(svg);
        assert.strictEqual(r.status, 502);
        assert.match(JSON.parse(r.body).error, /did not answer with a picture/);
        const html = "https://cdn.discordapp.com/media/v1/collectibles-shop/9/html";
        answers.set(html, { type: "text/html; charset=utf-8", body: Buffer.from("<script>") });
        assert.strictEqual((await get(html)).status, 502);
    });

    await test("Discord's 404 stays 404, other statuses and network errors are 502", async () => {
        const gone = "https://cdn.discordapp.com/media/v1/collectibles-shop/9/gone";
        answers.set(gone, { status: 404, type: "application/json" });
        assert.strictEqual((await get(gone)).status, 404);
        const moved = "https://cdn.discordapp.com/media/v1/collectibles-shop/9/moved";
        answers.set(moved, { status: 302, type: "text/html" });
        const r = await get(moved);
        assert.strictEqual(r.status, 502);
        assert.match(JSON.parse(r.body).error, /HTTP 302/);
        const down = await get("https://cdn.discordapp.com/media/v1/collectibles-shop/9/down");
        assert.strictEqual(down.status, 502);
        assert.match(JSON.parse(down.body).error, /did not answer \(ECONNREFUSED\)/);
    });

    await test("expected failures never reach errorHandler (no panel-log noise)", () => {
        assert.strictEqual(reachedErrorHandler, 0);
    });

    server.close();
    console.log(results.join("\n"));
    console.log(failed ? `\n${failed} failed` : "\nall passed");
    process.exit(failed ? 1 : 0);
})();
