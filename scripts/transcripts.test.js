#!/usr/bin/env node
/**
 * Checks for the Transcripts page (server/services/transcriptService.js +
 * routes/transcripts.js): the shop bot's list (claim, state, bad entries), the
 * search, opening one over the stubbed Discord bus (not announced, deleted,
 * links that are not Discord's, the answer kept while signed), the view ticket
 * streaming the parts as one gzip body in a sandbox, and staff opens audited.
 * Run:  node scripts/transcripts.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const assert = require("assert");
const express = require("express");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "transcripts-test-"));
process.env.SHARED_DB_PATH = path.join(TMP, "shared.sqlite");

// Stand-in for server/db (the page names the project that sends the list).
const dbPath = require.resolve(path.join(__dirname, "..", "server", "db"));
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { findOne: async (c, q) => (q._id === "shop" ? { name: "ArnTo-Shop" } : null), find: async () => [], get: async () => null },
};

const sharedStore = require("../server/services/sharedStore");
const discordBus = require("../server/services/discordBus");
const staffService = require("../server/services/staffService");
const transcripts = require("../server/services/transcriptService");
const routes = require("../server/routes/transcripts");

// ── Bus stub: the shop answers transcript.get like ArnTo-Shop functions/transcripts.js ──
let announced = false;
let busCalls = 0;
let answer = null; // (messageId) → result
discordBus.canHandle = (botId, cmd) => announced && botId === "shop" && cmd === "transcript.get";
discordBus.request = async (botId, cmd, payload) => {
    busCalls++;
    return answer(payload.messageId);
};

// ── Discord's CDN stub ──
const HTML = `<!doctype html><html><body>${"<p>Xin chào — hello</p>".repeat(4000)}</body></html>`;
const GZ = zlib.gzipSync(Buffer.from(HTML));
const CUT = Math.ceil(GZ.length / 3);
const PARTS = [GZ.subarray(0, CUT), GZ.subarray(CUT, 2 * CUT), GZ.subarray(2 * CUT)];
const ex = (Math.floor(Date.now() / 1000) + 86400).toString(16);
const cdn = (att, name) => `https://cdn.discordapp.com/attachments/1246012502530195466/${att}/${name}?ex=${ex}&is=00&hm=${"a".repeat(64)}&`;
const CDN_FILES = new Map();
PARTS.forEach((p, i) => CDN_FILES.set(cdn(`13000000000000000${i}`, `ticket-7149.00${i}.gz`), p));
const LEGACY_URL = cdn("1300000000000000099", "ticket-12.html");
CDN_FILES.set(LEGACY_URL, Buffer.from("<html>old</html>"));
global.fetch = async (url) => {
    const body = CDN_FILES.get(String(url));
    return body ? new globalThis.Response(body, { status: 200 }) : new globalThis.Response("nope", { status: 404 });
};
const partFiles = () => [...CDN_FILES.keys()].filter((u) => u.includes(".gz")).map((url, i) => ({ name: `ticket-7149.00${i}.gz`, url, size: PARTS[i].length }));

// ── Orders on the panel: the ticket's order links by ticketId ──
sharedStore.declare("orders", "collection", "shop");
sharedStore.adopt("orders", "shop", [
    { orderId: "arnto_501", ticketId: "tkRef7149", name: "Nitro Basic", status: "completed", buyerId: "111111111111111111", orderDate: Date.UTC(2026, 9, 3) },
]);

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ✗ ${name}\n    ${err.stack}`);
    }
};
const rejects = async (p, status) => {
    try {
        await p;
    } catch (err) {
        assert.strictEqual(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
        return err;
    }
    throw new Error(`expected a ${status} error`);
};

const T = (id, over = {}) => ({
    messageId: id,
    name: "ticket-7149",
    ownerId: "111111111111111111",
    ownerTag: "buyer.one",
    channelId: "1400000000000000001",
    ticketRef: "tkRef7149",
    reason: "No reason given",
    createdAt: Date.UTC(2026, 9, 3, 2),
    closedAt: Date.UTC(2026, 9, 4, 3),
    parts: 3,
    size: GZ.length,
    legacy: false,
    ...over,
});
const ID1 = "1310000000000000001";
const ID2 = "1310000000000000002";
const ID3 = "1310000000000000010";

// A real HTTP round trip without anything unpacking the body.
const get = (port, p) =>
    new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: p }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on("error", reject);
    });

(async () => {
    console.log("transcripts");

    await test("the first project to ask claims the list; it starts from nothing", () => {
        assert.deepStrictEqual(transcripts.state("shop"), { newestId: null, count: 0 });
        assert.throws(() => transcripts.state("auto"), (e) => e.status === 403);
    });

    await test("ingest: good entries saved, bad ones skipped; state reads on from the newest", () => {
        const r = transcripts.ingest("shop", {
            entries: [
                T(ID1),
                T(ID2, { name: "ctv-88", ownerId: "222222222222222222", ownerTag: "reseller.two", ticketRef: null, reason: "Mua decor", closedAt: Date.UTC(2026, 10, 1, 9), parts: 1, legacy: true }),
                T(ID3, { name: "ticket-12", ownerTag: null, ownerId: "333333333333333333", ticketRef: null, closedAt: Date.UTC(2025, 5, 1) }),
                T("123", {}), // not a message id
                T("1310000000000000099", { name: "has spaces" }),
                T("1310000000000000098", { closedAt: "yesterday" }),
                null,
            ],
        });
        assert.deepStrictEqual(r, { saved: 3, skipped: 4 });
        // 1310000000000000010 > …002 as a number, though not as text.
        assert.deepStrictEqual(transcripts.state("shop"), { newestId: ID3, count: 3 });
        assert.throws(() => transcripts.ingest("auto", { entries: [] }), (e) => e.status === 403);
        assert.throws(() => transcripts.ingest("shop", { entries: "x" }), (e) => e.status === 400);
        assert.throws(() => transcripts.ingest("shop", { entries: new Array(201).fill(T(ID1)) }), (e) => e.status === 400);
    });

    await test("list: newest closed first, kinds counted, orders linked, the source named", async () => {
        const l = await transcripts.list({});
        assert.deepStrictEqual(l.items.map((t) => t.name), ["ctv-88", "ticket-7149", "ticket-12"]);
        assert.deepStrictEqual(l.kinds, { ticket: 2, ctv: 1 });
        assert.deepStrictEqual([l.total, l.matched, l.page, l.pages], [3, 3, 1, 1]);
        const t = l.items.find((x) => x.id === ID1);
        assert.deepStrictEqual(t.orders, [{ orderId: "arnto_501", name: "Nitro Basic", status: "completed" }]);
        assert.deepStrictEqual([t.number, t.kind, t.ownerTag, t.legacy, t.missing], [7149, "ticket", "buyer.one", false, false]);
        assert.deepStrictEqual(l.source.ownerName, "ArnTo-Shop");
        assert.strictEqual(l.source.canOpen, false);
        assert.ok(l.months.includes("2025-06") && l.months.includes("2026-11"));
    });

    await test("search: ticket number exactly, ids, names, reason, order id; kind and period", async () => {
        const names = async (args) => (await transcripts.list(args)).items.map((t) => t.name).sort();
        assert.deepStrictEqual(await names({ q: "7149" }), ["ticket-7149"]);
        assert.deepStrictEqual(await names({ q: "#12" }), ["ticket-12"]);
        assert.deepStrictEqual(await names({ q: "714" }), []); // a number is never a part of another
        assert.deepStrictEqual(await names({ q: "222222222222222222" }), ["ctv-88"]);
        assert.deepStrictEqual(await names({ q: "RESELLER" }), ["ctv-88"]);
        assert.deepStrictEqual(await names({ q: "mua decor" }), ["ctv-88"]);
        assert.deepStrictEqual(await names({ q: "ARNTO_501" }), ["ticket-7149"]);
        assert.deepStrictEqual(await names({ kind: "ctv" }), ["ctv-88"]);
        assert.deepStrictEqual(await names({ period: "2026-10" }), ["ticket-7149"]);
        assert.deepStrictEqual(await names({ period: "2026-10-04_2026-11-01" }), ["ctv-88", "ticket-7149"]);
        await rejects(transcripts.list({ period: "soon" }), 400);
        const paged = await transcripts.list({ pageSize: 10, page: 9 });
        assert.deepStrictEqual([paged.page, paged.pages, paged.items.length], [1, 1, 3]);
    });

    await test("open: refused until the bot announces transcript.get; unknown ids are 404", async () => {
        await rejects(transcripts.open(ID1), 503);
        await rejects(transcripts.open("1319999999999999999"), 404);
        await rejects(transcripts.open("../../etc"), 404);
        assert.strictEqual(busCalls, 0);
    });

    announced = true;

    await test("open: only Discord attachment links are fetched", async () => {
        answer = () => ({ legacy: false, files: [{ name: "a.000.gz", url: "http://127.0.0.1:4200/files", size: 1 }] });
        await rejects(transcripts.open(ID1), 502);
        answer = () => ({ legacy: false, files: [] });
        await rejects(transcripts.open(ID1), 502);
    });

    await test("open: a deleted message marks the row Gone; it comes back when found again", async () => {
        answer = () => ({ missing: true });
        await rejects(transcripts.open(ID1), 410);
        assert.strictEqual((await transcripts.list({ q: "7149" })).items[0].missing, true);
        answer = () => ({ legacy: false, files: partFiles() });
        const v = await transcripts.open(ID1);
        assert.strictEqual(v.name, "ticket-7149");
        assert.strictEqual((await transcripts.list({ q: "7149" })).items[0].missing, false);
    });

    await test("open: the bot's answer is reused while Discord's signature lasts", async () => {
        const before = busCalls;
        const a = await transcripts.open(ID1);
        const b = await transcripts.open(ID1);
        assert.strictEqual(busCalls, before);
        assert.notStrictEqual(a.ticket, b.ticket);
        assert.ok(a.expiresAt <= Date.now() + 15 * 60 * 1000 + 50);
    });

    // ── Over HTTP ──
    const app = express();
    app.use(express.json());
    let who = { kind: "owner" };
    app.use("/api/external/transcripts", (req, res, next) => ((req.apiCaller = { botId: "shop" }), next()), routes.external);
    app.use("/api/transcripts/view", routes.viewer);
    app.use("/api/transcripts", (req, res, next) => ((req.auth = who), next()), routes.panel);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = server.address().port;

    await test("view: the parts in order as one gzip body, sandboxed, not cached", async () => {
        const { ticket } = await transcripts.open(ID1);
        const r = await get(port, `/api/transcripts/view/${ticket}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers["content-encoding"], "gzip");
        assert.match(r.headers["content-type"], /^text\/html/);
        assert.strictEqual(r.headers["content-security-policy"], "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox");
        assert.strictEqual(r.headers["cache-control"], "no-store");
        assert.strictEqual(zlib.gunzipSync(r.body).toString(), HTML);
    });

    await test("view: an old single .html goes as it is", async () => {
        answer = () => ({ legacy: true, files: [{ name: "ticket-12.html", url: LEGACY_URL, size: 16 }] });
        const { ticket } = await transcripts.open(ID3);
        const r = await get(port, `/api/transcripts/view/${ticket}`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers["content-encoding"], undefined);
        assert.strictEqual(r.body.toString(), "<html>old</html>");
    });

    await test("view: an unknown ticket is a plain-text 410; Discord failing first is a 502", async () => {
        const r = await get(port, "/api/transcripts/view/not-a-ticket");
        assert.strictEqual(r.status, 410);
        assert.match(r.headers["content-type"], /^text\/plain/);
        assert.match(r.body.toString(), /expired/);
        answer = () => ({ legacy: true, files: [{ name: "x.html", url: cdn("1300000000000000077", "x.html"), size: 1 }] });
        const { ticket } = await transcripts.open(ID2);
        assert.strictEqual((await get(port, `/api/transcripts/view/${ticket}`)).status, 502);
    });

    await test("external routes: state and ingest with the project key", async () => {
        const r = await get(port, "/api/external/transcripts/state");
        assert.deepStrictEqual(JSON.parse(r.body), { newestId: ID3, count: 3 });
    });

    await test("staff opening a transcript is audited, failures too", async () => {
        const audits = [];
        const real = staffService.audit;
        staffService.audit = (a) => audits.push(a);
        try {
            who = { kind: "staff", staff: { userId: "999999999999999999" }, session: { id: "s1" } };
            answer = () => ({ legacy: false, files: partFiles() });
            const ok = await get(port, `/api/transcripts/${ID1}/open`);
            assert.strictEqual(ok.status, 200);
            assert.ok(JSON.parse(ok.body).ticket);
            assert.strictEqual((await get(port, "/api/transcripts/1319999999999999999/open")).status, 404);
            assert.deepStrictEqual(
                audits.map((a) => [a.userId, a.action, a.status, a.page]),
                [
                    ["999999999999999999", "open transcript ticket-7149", 200, "transcripts"],
                    ["999999999999999999", "open transcript 1319999999999999999", 404, "transcripts"],
                ],
            );
            who = { kind: "owner" };
            await get(port, `/api/transcripts/${ID1}/open`);
            assert.strictEqual(audits.length, 2);
        } finally {
            staffService.audit = real;
        }
    });

    await test("Transcripts is a staff page", () => {
        assert.ok(staffService.PAGES.some((p) => p.key === "transcripts"));
    });

    server.close();
    sharedStore.close();
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(failures ? `\n${failures} failed` : "\nall passed");
    process.exit(failures ? 1 : 0);
})();
