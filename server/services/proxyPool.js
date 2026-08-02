/**
 * proxyPool.js
 * Uses the agent VPSes as a shared egress-proxy pool. Each agent exposes an
 * authenticated HTTPS CONNECT proxy on its agent port (see agent/services/proxy.js);
 * this module picks one for a given key and builds an axios-compatible httpsAgent.
 *
 * Generic on purpose — any feature that wants to route outbound HTTPS through an agent
 * IP can call agentForKey(). Auto Quest is the first consumer.
 *
 * Pool: by default EVERY enabled agent node is a proxy — any node added to the panel
 * automatically joins the pool (agents always run the CONNECT proxy). Confirmed-offline
 * nodes are skipped. Optional env QUEST_PROXY_NODES = comma list of node name aliases
 * (case-insensitive substring) restricts the pool to a subset; unset → all agents.
 *
 * Selection is STICKY per key (hash): the same key always maps to the same node, so an
 * account keeps one stable egress IP across restarts (until the node set changes).
 */

const nodeService = require("./nodeService");
const { HttpsProxyAgent } = require("https-proxy-agent");

function _restrictNames() {
    return (process.env.QUEST_PROXY_NODES || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/** Agent nodes usable as proxies (all enabled + online), in a stable order. */
async function proxyNodes() {
    const nodes = await nodeService.getNodes();
    const restrict = _restrictNames(); // empty → use ALL enabled agents
    return nodes
        .filter((n) => {
            if (n.enabled === false) return false;
            if (nodeService.isNodeOffline(n._id)) return false; // skip confirmed-down
            if (!restrict.length) return true; // default: every agent is a proxy
            const name = String(n.name).toLowerCase();
            return restrict.some((w) => name === w || name.includes(w));
        })
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

// djb2 string hash → unsigned int, for sticky assignment.
function _hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
}

/** Pick the proxy node for a sticky key (e.g. a token). null when none configured. */
async function pickProxyNode(key) {
    const nodes = await proxyNodes();
    if (!nodes.length) return null;
    return nodes[_hash(String(key)) % nodes.length];
}

function _proxyUrl(node) {
    // Auth embedded so https-proxy-agent sends Proxy-Authorization: Basic proxy:<key>.
    return `http://proxy:${encodeURIComponent(node.apiKey)}@${node.host}:${node.port}`;
}

/**
 * An axios httpsAgent that tunnels outbound HTTPS through the key's assigned proxy
 * node. Returns null when no proxy nodes are configured (caller egresses directly).
 */
async function agentForKey(key) {
    const node = await pickProxyNode(key);
    if (!node) return null;
    return new HttpsProxyAgent(_proxyUrl(node));
}

module.exports = { proxyNodes, pickProxyNode, agentForKey };
