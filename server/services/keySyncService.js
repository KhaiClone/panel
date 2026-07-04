const crypto = require("./agentCrypto");
const nodeService = require("./nodeService");
const githubService = require("./githubService");

// ─────────────────────────────────────────────────────────────────────────────
//  Keeps SSH keys + git config identical across worker nodes.
//
//  Only the local (panel) node holds the source of truth. Every change made on
//  the panel's GitHub Keys page is pushed to each online node's agent. Private
//  key bytes are AES-256-GCM encrypted with the node's own API key before they
//  leave this process (see agentCrypto).
// ─────────────────────────────────────────────────────────────────────────────

/** Push one key (with private material) to a single node. */
const pushKeyToNode = async (node, name) => {
    const { privateKey, publicKey } = githubService.readKeyMaterial(name);
    const encPrivate = crypto.encrypt(privateKey, node.apiKey);
    const encPublic = publicKey ? crypto.encrypt(publicKey, node.apiKey) : null;
    return nodeService.agentRequest(node, "post", "/keys/import", {
        data: { name, encPrivate, encPublic, overwrite: true },
        timeout: 20_000,
    });
};

const deleteKeyOnNode = (node, name) =>
    nodeService.agentRequest(node, "post", "/keys/delete", { data: { name }, timeout: 15_000 });

const pushGitConfigToNode = async (node) => {
    const cfg = await githubService.getGitConfig();
    return nodeService.agentRequest(node, "post", "/keys/git-config", { data: cfg, timeout: 15_000 });
};

/** Only nodes that are enabled AND currently reachable. */
const targetNodes = async () => {
    const nodes = await nodeService.getNodes();
    return nodes.filter((n) => n.enabled !== false && nodeService.isNodeOnline(n._id));
};

/**
 * Run `fn(node)` against every target node, collecting per-node outcomes so
 * routes can surface partial failures without aborting the whole request.
 */
const forEachNode = async (fn) => {
    const nodes = await targetNodes();
    return Promise.all(
        nodes.map(async (node) => {
            try {
                await fn(node);
                return { nodeId: node._id, name: node.name, ok: true };
            } catch (err) {
                return { nodeId: node._id, name: node.name, ok: false, error: err.message };
            }
        }),
    );
};

const syncKeyToAllNodes = (name) => forEachNode((node) => pushKeyToNode(node, name));
const deleteKeyOnAllNodes = (name) => forEachNode((node) => deleteKeyOnNode(node, name));
const syncGitConfigToAllNodes = () => forEachNode((node) => pushGitConfigToNode(node));

/**
 * Full sync of every key (that has private material) + git config to one node.
 * Used when a node is first registered.
 */
const syncAllToNode = async (node) => {
    const keys = await githubService.listKeys();
    for (const k of keys) {
        if (k.hasPrivate) {
            try { await pushKeyToNode(node, k.name); }
            catch (err) { console.error(`[KeySync] Failed to push "${k.name}" to ${node.name}:`, err.message); }
        }
    }
    try { await pushGitConfigToNode(node); }
    catch (err) { console.error(`[KeySync] Failed to push git config to ${node.name}:`, err.message); }
};

/**
 * Compare the panel's keys/git-config against every node.
 * Returns per-node: reachable, matched/missing/mismatched key names, gitConfigInSync.
 */
const getSyncStatus = async () => {
    const localKeys = (await githubService.listKeys()).filter((k) => k.hasPrivate);
    const localFp = Object.fromEntries(localKeys.map((k) => [k.name, k.fingerprint]));
    const localCfg = await githubService.getGitConfig();
    const nodes = await nodeService.getNodes();

    const result = [];
    for (const node of nodes) {
        const entry = { nodeId: node._id, name: node.name, enabled: node.enabled !== false, reachable: false,
            missing: [], mismatched: [], matched: [], gitConfigInSync: false };

        if (node.enabled === false) { result.push(entry); continue; }

        try {
            const { keys: remoteKeys } = await nodeService.agentRequest(node, "get", "/keys/list", { timeout: 10_000 });
            const remoteFp = Object.fromEntries((remoteKeys || []).map((k) => [k.name, k.fingerprint]));
            entry.reachable = true;

            for (const name of Object.keys(localFp)) {
                if (!(name in remoteFp)) entry.missing.push(name);
                else if (remoteFp[name] !== localFp[name]) entry.mismatched.push(name);
                else entry.matched.push(name);
            }

            const remoteCfg = await nodeService.agentRequest(node, "get", "/keys/git-config", { timeout: 10_000 });
            entry.gitConfigInSync = remoteCfg.name === localCfg.name && remoteCfg.email === localCfg.email;
        } catch {
            entry.reachable = false;
        }

        entry.inSync = entry.reachable && entry.missing.length === 0 && entry.mismatched.length === 0 && entry.gitConfigInSync;
        result.push(entry);
    }
    return result;
};

module.exports = {
    pushKeyToNode,
    deleteKeyOnNode,
    pushGitConfigToNode,
    syncKeyToAllNodes,
    deleteKeyOnAllNodes,
    syncGitConfigToAllNodes,
    syncAllToNode,
    getSyncStatus,
};
