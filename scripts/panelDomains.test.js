#!/usr/bin/env node
/**
 * Checks for the primary panel domain (server/services/panelDomains.js setPrimary
 * + routes/panel.js): a node with several domains is opened at the one the owner
 * picked, else at its oldest; picking one on the panel's node moves the panel's
 * address and re-points the other nodes' redirects, picking one elsewhere writes
 * nothing; removing the primary falls back to the oldest. GET /api/panel/domains
 * says which domain is each node's primary. The db, the nodes and the agents are
 * stubbed — no nginx is touched.
 * Run:  node scripts/panelDomains.test.js
 */

const path = require("path");
const http = require("http");
const assert = require("assert");
const express = require("express");

// ── Stubs ────────────────────────────────────────────────────────────────────
const stub = (rel, exports) => {
    const p = require.resolve(path.join(__dirname, "..", "server", rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
stub("db", {
    get: async (k) => clone(store.get(k)) ?? null,
    set: async (k, v) => void store.set(k, clone(v)),
});

process.env.PORT = "1975";
const nodes = {
    "node-dio2": { _id: "node-dio2", name: "VPS dio 2", host: "203.0.113.20" },
    "node-dio": { _id: "node-dio", name: "VPS dio", host: "203.0.113.10" },
};
// Every vhost the panel asks an agent to write: { nodeId, sites }.
const writes = [];
stub("services/nodeService", {
    panelNodeId: () => "node-dio2",
    getNode: async (id) => {
        if (!nodes[id]) throw new Error("Node not found");
        return nodes[id];
    },
    getNodes: async () => Object.values(nodes),
    agentRequest: async (node, method, p, opts) => {
        if (p === "/nginx/panel-sites") writes.push({ nodeId: node._id, sites: opts.data.sites });
        // Every domain here already has its certificate.
        return { certs: (opts?.data?.sites || []).map((s) => s.domain) };
    },
});
// The rest of the panel router's services are not reached by the domain routes.
for (const s of ["panelService", "panelMigration", "sharedStore", "discordBus", "decorSitePublisher",
    "backupService", "apiKeyService", "callbackService", "executor"]) stub(`services/${s}`, {});

const panelDomains = require("../server/services/panelDomains");
const panelRoutes = require("../server/routes/panel");

let failures = 0;
const test = async (name, fn) => {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ✗ ${name}\n      ${err.stack || err.message}`);
    }
};

// The live layout after the 2026-10-22 move: a new and an old name on each node.
const seed = () => {
    writes.length = 0;
    store.set("panel_domains", [
        { domain: "panel4.old.vn", nodeId: "node-dio2", sslEnabled: true, addedAt: 1 },
        { domain: "panel2.old.vn", nodeId: "node-dio", sslEnabled: true, addedAt: 2 },
        { domain: "panel3.new.gd", nodeId: "node-dio2", sslEnabled: true, addedAt: 3 },
        { domain: "panel1.new.gd", nodeId: "node-dio", sslEnabled: false, addedAt: 4 },
    ]);
};
const rows = () => clone(store.get("panel_domains"));

(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/panel", panelRoutes);
    app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message })); // eslint-disable-line no-unused-vars
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const call = (method, p, body) =>
        new Promise((resolve, reject) => {
            const data = body ? JSON.stringify(body) : null;
            const req = http.request(
                { host: "127.0.0.1", port: server.address().port, method, path: p, headers: data ? { "content-type": "application/json" } : {} },
                (res) => {
                    let raw = "";
                    res.on("data", (c) => (raw += c));
                    res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
                },
            );
            req.on("error", reject);
            req.end(data);
        });

    console.log("primary panel domain");

    await test("without a pick the oldest domain of the node is its address (records from before stay as they were)", async () => {
        seed();
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel4.old.vn");
        assert.deepStrictEqual([...panelDomains.primaries(rows())].sort(), ["panel2.old.vn", "panel4.old.vn"]);
    });

    await test("the primary goes first whatever its age", () => {
        const r = [
            { domain: "a", nodeId: "n", addedAt: 1 },
            { domain: "b", nodeId: "n", addedAt: 2, primary: true },
            { domain: "c", nodeId: "n", addedAt: 3 },
        ];
        assert.deepStrictEqual(panelDomains.ofNode(r, "n").map((d) => d.domain), ["b", "a", "c"]);
    });

    await test("a pick on the panel's node moves the panel's address and re-points the other nodes", async () => {
        seed();
        await panelDomains.setPrimary("panel3.new.gd");
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel3.new.gd");
        // Only the other node is rewritten: the panel's own node serves every name either way.
        assert.deepStrictEqual(writes.map((w) => w.nodeId), ["node-dio"]);
        assert.ok(writes[0].sites.every((s) => s.mode === "redirect" && s.to === "https://panel3.new.gd"));
    });

    await test("one primary per node: picking another one takes the flag away", async () => {
        seed();
        await panelDomains.setPrimary("panel3.new.gd");
        await panelDomains.setPrimary("panel4.old.vn");
        const flagged = rows().filter((d) => d.primary).map((d) => d.domain);
        assert.deepStrictEqual(flagged, ["panel4.old.vn"]);
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel4.old.vn");
    });

    await test("a pick on another node changes nothing now — it is that node's address once the panel runs there", async () => {
        seed();
        await panelDomains.setPrimary("panel1.new.gd");
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel4.old.vn");
        const dio = { _id: "node-dio", host: "203.0.113.10" };
        // No certificate on panel1.new.gd: the address is plain http, as the page warns.
        assert.strictEqual(panelDomains.publicUrl(rows(), dio), "http://panel1.new.gd");
        // The other node's flag is untouched.
        assert.strictEqual(rows().find((d) => d.domain === "panel3.new.gd").primary, undefined);
    });

    await test("removing the primary falls back to the oldest domain left", async () => {
        seed();
        await panelDomains.setPrimary("panel3.new.gd");
        await panelDomains.remove("panel3.new.gd");
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel4.old.vn");
    });

    await test("re-adding a domain does not make it primary", async () => {
        seed();
        await panelDomains.setPrimary("panel3.new.gd");
        await panelDomains.remove("panel4.old.vn");
        await panelDomains.add({ domain: "panel4.old.vn", nodeId: "node-dio2" });
        assert.strictEqual(await panelDomains.currentUrl(), "https://panel3.new.gd");
    });

    await test("an unknown domain is a 404", async () => {
        seed();
        await assert.rejects(panelDomains.setPrimary("nope.example.com"), (err) => err.status === 404 && err.message === "Domain not found");
    });

    console.log("routes");

    await test("GET /api/panel/domains marks each node's primary", async () => {
        seed();
        await panelDomains.setPrimary("panel3.new.gd");
        const res = await call("GET", "/api/panel/domains");
        assert.strictEqual(res.status, 200);
        const marked = Object.fromEntries(res.body.domains.map((d) => [d.domain, d.isPrimary]));
        assert.deepStrictEqual(marked, { "panel4.old.vn": false, "panel2.old.vn": true, "panel3.new.gd": true, "panel1.new.gd": false });
        assert.strictEqual(res.body.publicUrl, "https://panel3.new.gd");
    });

    await test("POST /api/panel/domains/:domain/primary answers the new address; an unknown domain is 404 in English", async () => {
        seed();
        const ok = await call("POST", `/api/panel/domains/${encodeURIComponent("panel3.new.gd")}/primary`, {});
        assert.deepStrictEqual(ok, { status: 200, body: { ok: true, domain: "panel3.new.gd", publicUrl: "https://panel3.new.gd" } });
        const missing = await call("POST", "/api/panel/domains/nope.example.com/primary", {});
        assert.deepStrictEqual(missing, { status: 404, body: { error: "Domain not found" } });
    });

    server.close();
    if (failures) {
        console.error(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("\nall checks passed");
})();
