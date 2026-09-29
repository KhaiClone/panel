const db = require("../db");
const lifecycle = require("./lifecycle");

// ─────────────────────────────────────────────────────────────────────────────
//  This panel's epoch — the fencing token that makes a panel move safe.
//
//  Every agent remembers the highest epoch it has been told to follow and
//  refuses (409 PANEL_SUPERSEDED) any request carrying a lower one; see
//  agent/services/panelLease.js. A move hands the new panel epoch + 1, so the
//  moment it claims the agents, the old panel is locked out of every node.
//
//  Stored in the panel DB, so it travels with the data: the new panel boots
//  with the old epoch and bumps it from data/migration-in.json (panelMigration).
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "panel_lease";
const HEADER = "x-panel-epoch";
const SUPERSEDED = "PANEL_SUPERSEDED";

let epoch = 0;

/** Load the epoch from the DB; a panel that never had one starts at 1. */
const load = async () => {
    const rec = await db.get(KEY);
    if (Number.isInteger(rec?.epoch) && rec.epoch > 0) {
        epoch = rec.epoch;
    } else {
        epoch = 1;
        await db.set(KEY, { epoch, nodeId: process.env.PANEL_NODE_ID || null, since: Date.now() });
    }
    return epoch;
};

const current = () => epoch;

const set = async (next, nodeId) => {
    epoch = next;
    await db.set(KEY, { epoch: next, nodeId: nodeId || null, since: Date.now() });
};

/** Headers every agent request carries (none before load()). */
const headers = () => (epoch ? { [HEADER]: String(epoch) } : {});

/** An agent answered 409 PANEL_SUPERSEDED — a newer panel exists. */
const superseded = (node, body) => {
    lifecycle.fence({
        reason: "superseded",
        seenOn: node?.name || null,
        byEpoch: body?.lease?.epoch ?? null,
        byNodeId: body?.lease?.panelNodeId ?? null,
    });
};

/**
 * Where `node`'s panel gateway reaches this panel (agent/services/panelGateway.js):
 * loopback on the panel's own node, its WireGuard IP (else public host) elsewhere.
 * The panel listens on 0.0.0.0, so only the firewall decides — a move's
 * preflight checks every node can get through.
 */
const panelUrlFor = (node, panelNode) => {
    const port = parseInt(process.env.PORT, 10) || 3000;
    if (!panelNode) return null;
    if (node._id === panelNode._id) return `http://127.0.0.1:${port}`;
    const host = panelNode.wgOverlayIp || panelNode.host;
    return host ? `http://${host.includes(":") ? `[${host}]` : host}:${port}` : null;
};

/**
 * Claim every enabled node at the current epoch, telling each where its
 * gateway finds this panel. A node that already follows a newer panel fences
 * this one (inside agentRequest). Offline nodes and agents too old to know
 * /lease are reported, not fatal. Repeated every few minutes while active, so
 * an agent that was down at boot, or restarted since, learns the address too.
 */
const claimAll = async () => {
    const nodeService = require("./nodeService");
    const nodes = (await nodeService.getNodes()).filter((n) => n.enabled !== false);
    const panelNode = nodes.find((n) => n._id === process.env.PANEL_NODE_ID) || null;
    return Promise.all(nodes.map((node) => claimNode(node, panelNode)));
};

const claimNode = async (node, panelNode) => {
    const nodeService = require("./nodeService");
    const panelUrl = panelUrlFor(node, panelNode);
    try {
        await nodeService.agentRequest(node, "post", "/lease", {
            data: { epoch, panelNodeId: process.env.PANEL_NODE_ID || null, panelUrl },
            timeout: 8000,
        });
        return { nodeId: node._id, name: node.name, ok: true, panelUrl };
    } catch (err) {
        return { nodeId: node._id, name: node.name, ok: false, status: err.status || null, error: err.message };
    }
};

/** Claim one node now — a node just added should not wait for the next round. */
const claim = async (node) => {
    const nodeService = require("./nodeService");
    const panelNode = (await nodeService.getNodes()).find((n) => n._id === process.env.PANEL_NODE_ID) || null;
    return claimNode(node, panelNode);
};

module.exports = { load, current, set, headers, superseded, claimAll, claim, panelUrlFor, HEADER, SUPERSEDED };
