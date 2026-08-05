/**
 * wgService.js — the panel is the WireGuard coordinator (a self-hosted control plane).
 * Each agent owns its private key; the panel collects public keys, assigns an overlay
 * IP per node, computes the mesh, and pushes the full peer list to every node. Adding a
 * node auto-joins it and re-pushes the mesh to all — no manual per-machine config.
 *
 * Node record fields (on the `nodes` collection): wgPubKey, wgOverlayIp, wgPort.
 * Control traffic still uses the public IP + agent key (see nodeService); WireGuard is
 * only the data-plane overlay that lets co-located-style services talk across VPSes.
 */

const db = require("../db");
const nodeService = require("./nodeService");

const SUBNET_PREFIX = "10.88.0."; // 10.88.0.0/24 overlay
const CIDR = "/24";
const HOST_MIN = 2;
const HOST_MAX = 254;

/** Lowest free host in the overlay among currently-assigned nodes. */
function _assignIp(nodes) {
    const taken = new Set(
        nodes
            .map((n) => n.wgOverlayIp)
            .filter(Boolean)
            .map((ip) => parseInt(String(ip).split(".")[3], 10)),
    );
    for (let h = HOST_MIN; h <= HOST_MAX; h++) if (!taken.has(h)) return `${SUBNET_PREFIX}${h}`;
    throw new Error("WireGuard overlay pool exhausted");
}

/**
 * Ensure a node has a WG identity: fetch its public key from the agent and assign an
 * overlay IP if it has none. Persists wgPubKey/wgOverlayIp/wgPort. Returns the node.
 */
async function setupNode(node, allNodes = null) {
    const nodes = allNodes || (await nodeService.getNodes());
    const id = await nodeService.agentRequest(node, "get", "/wg/pubkey", { timeout: 15_000 });
    const patch = { wgPubKey: id.pubKey, wgPort: id.listenPort || 51820 };
    if (!node.wgOverlayIp) patch.wgOverlayIp = _assignIp(nodes);
    const updated = await db.findOneAndUpdate("nodes", { _id: node._id }, patch);
    return updated;
}

/** Peer list for `target`: every OTHER node that has a WG identity. */
function _peersFor(target, nodes) {
    return nodes
        .filter((n) => n._id !== target._id && n.wgPubKey && n.wgOverlayIp && n.enabled !== false)
        .map((n) => ({
            pubKey: n.wgPubKey,
            allowedIps: `${n.wgOverlayIp}/32`,
            endpoint: `${n.host}:${n.wgPort || 51820}`,
            keepalive: 25,
        }));
}

/** Push the interface config + peers to one node's agent. */
async function pushToNode(node, nodes) {
    if (!node.wgOverlayIp || !node.wgPubKey) return false;
    await nodeService.agentRequest(node, "post", "/wg/config", {
        data: {
            address: `${node.wgOverlayIp}${CIDR}`,
            listenPort: node.wgPort || 51820,
            peers: _peersFor(node, nodes),
        },
        timeout: 20_000,
    });
    return true;
}

/**
 * Recompute the whole mesh and push it to every enabled node. Any node missing a WG
 * identity is set up first. Offline / unreachable nodes are skipped and retried on
 * the next sync (e.g. when they come back online). Returns a per-node result.
 */
async function syncMesh() {
    let nodes = await nodeService.getNodes();
    const results = [];

    // 1) Ensure every enabled node has an identity (pubkey + overlay IP).
    for (const n of nodes.filter((x) => x.enabled !== false)) {
        if (n.wgPubKey && n.wgOverlayIp) continue;
        try {
            await setupNode(n, nodes);
        } catch (e) {
            results.push({ node: n.name, ok: false, stage: "setup", error: e.message });
        }
    }
    nodes = await nodeService.getNodes(); // reload with fresh identities

    // 2) Push the mesh to each node.
    for (const n of nodes.filter((x) => x.enabled !== false && x.wgPubKey)) {
        try {
            await pushToNode(n, nodes);
            results.push({ node: n.name, ok: true, overlayIp: n.wgOverlayIp });
        } catch (e) {
            results.push({ node: n.name, ok: false, stage: "push", error: e.message });
        }
    }
    return results;
}

module.exports = { setupNode, pushToNode, syncMesh, _assignIp };
