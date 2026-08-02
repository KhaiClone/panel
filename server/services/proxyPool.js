/**
 * proxyPool.js
 * Uses the agent VPSes as a shared egress-proxy pool. Each agent exposes an
 * authenticated HTTPS CONNECT proxy on its agent port (see agent/services/proxy.js);
 * this module picks one for a given key and builds an axios-compatible httpsAgent.
 *
 * Generic on purpose — any feature that wants to route outbound HTTPS through an agent
 * IP can call agentForKey(). Auto Quest is the first consumer.
 *
 * Config: env QUEST_PROXY_NODES = comma list of node NAMES (case-insensitive) to use
 * as proxies, e.g. "dio,pokeclaw". Empty/unset → no proxying (direct egress).
 *
 * Selection is STICKY per key (hash): the same key always maps to the same node, so an
 * account keeps one stable egress IP across restarts (until its token changes).
 */

const nodeService = require("./nodeService");
const { HttpsProxyAgent } = require("https-proxy-agent");

function _proxyNodeNames() {
    return (process.env.QUEST_PROXY_NODES || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/** Enabled agent nodes selected as proxies, in a stable order. */
async function proxyNodes() {
    const want = _proxyNodeNames();
    if (!want.length) return [];
    const nodes = await nodeService.getNodes();
    return nodes
        .filter((n) => {
            if (n.enabled === false) return false;
            const name = String(n.name).toLowerCase();
            // Match exact name OR a short alias contained in it (e.g. "dio" ~ "VPS dio").
            return want.some((w) => name === w || name.includes(w));
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
