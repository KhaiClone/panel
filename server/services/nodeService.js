const axios = require("axios");
const si = require("systeminformation");
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  Node registry + agent HTTP client
//
//  A "node" is a worker VPS running the agent (see /agent). The panel itself
//  is the special node "local" — it has no DB record and no agent; operations
//  on it call the local services directly (see executor.js).
//
//  nodes collection: { _id, name, host, port, apiKey, enabled, createdAt }
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_NODE_ID = "local";

// Default timeout covers control operations; long ops (clone/install) pass
// their own — slightly above the agent's internal timeouts so the agent's
// own error wins when something hangs.
const DEFAULT_TIMEOUT = 20_000;

const getNodes = async () => (await db.find("nodes")) || [];

const getNode = async (nodeId) => {
    if (!nodeId || nodeId === LOCAL_NODE_ID) return null;
    const node = await db.findOne("nodes", { _id: nodeId });
    if (!node) throw new Error(`Node "${nodeId}" no longer exists`);
    return node;
};

/**
 * Perform an HTTP request against a node's agent.
 * Agent errors are re-thrown with the node name so route error messages
 * make clear which VPS failed.
 */
const agentRequest = async (node, method, urlPath, { data, params, responseType, timeout } = {}) => {
    const url = `http://${node.host}:${node.port}${urlPath}`;
    try {
        const res = await axios({
            method,
            url,
            data,
            params,
            responseType,
            timeout: timeout ?? DEFAULT_TIMEOUT,
            headers: { "x-agent-key": node.apiKey },
            maxContentLength: 200 * 1024 * 1024,
            maxBodyLength: 200 * 1024 * 1024,
        });
        return res.data;
    } catch (err) {
        if (err.response?.data?.error) {
            const e = new Error(`[Node ${node.name}] ${err.response.data.error}`);
            e.status = err.response.status;
            throw e;
        }
        throw new Error(`[Node ${node.name}] ${err.code || ""} ${err.message}`.trim());
    }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Stats (cached) + local node stats
// ─────────────────────────────────────────────────────────────────────────────

const STATS_TTL = 10_000;
const statsCache = new Map(); // nodeId → { at, stats }

/** Stats of the panel's own VPS — same shape the agent's /stats returns. */
const getLocalStats = async () => {
    const pm2Service = require("./pm2Service");
    const [cpuLoad, mem, fsData, cpuInfo, pm2List] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize().catch(() => []),
        si.cpu().catch(() => ({ brand: null, manufacturer: null })),
        pm2Service.getProcessList(),
    ]);

    const mainFs =
        fsData.find((f) => f.mount === "/") ||
        fsData.sort((a, b) => b.size - a.size)[0] ||
        null;

    return {
        cpu: {
            usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
            model: cpuInfo.brand ? `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim() : null,
            cores: cpuLoad.cpus?.length ?? null,
        },
        memory: {
            totalBytes: mem.total,
            usedBytes: mem.active,
            freeBytes: mem.available,
            usedPercent: parseFloat(((mem.active / mem.total) * 100).toFixed(2)),
        },
        disk: mainFs
            ? {
                  totalBytes: mainFs.size,
                  usedBytes: mainFs.used,
                  freeBytes: mainFs.size - mainFs.used,
                  usedPercent: parseFloat(((mainFs.used / mainFs.size) * 100).toFixed(2)),
                  mount: mainFs.mount,
              }
            : null,
        processCount: pm2List.length,
    };
};

/**
 * Get stats for one node (cached ~10s). nodeId "local" → panel's own stats.
 * Throws when the node is unreachable — callers decide how to handle that.
 */
const getNodeStats = async (nodeId) => {
    const cached = statsCache.get(nodeId);
    if (cached && Date.now() - cached.at < STATS_TTL) return cached.stats;

    let stats;
    if (!nodeId || nodeId === LOCAL_NODE_ID) {
        stats = await getLocalStats();
    } else {
        const node = await getNode(nodeId);
        stats = await agentRequest(node, "get", "/stats", { timeout: 8000 });
    }

    statsCache.set(nodeId, { at: Date.now(), stats });
    return stats;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Health polling
// ─────────────────────────────────────────────────────────────────────────────

// nodeId → "online" | "offline" (remote nodes only; local is always online)
const nodeStatus = new Map();

const isNodeOnline = (nodeId) => {
    if (!nodeId || nodeId === LOCAL_NODE_ID) return true;
    return nodeStatus.get(nodeId) === "online";
};

/** Mark a node online immediately (e.g. right after a verified registration). */
const markOnline = (nodeId) => {
    if (nodeId && nodeId !== LOCAL_NODE_ID) nodeStatus.set(nodeId, "online");
};

const checkNodeHealth = async (node) => {
    try {
        const data = await agentRequest(node, "get", "/health", { timeout: 5000 });
        return data?.ok === true;
    } catch {
        return false;
    }
};

const pollAllNodes = async () => {
    const nodes = await getNodes();
    for (const node of nodes) {
        if (node.enabled === false) {
            nodeStatus.delete(node._id);
            continue;
        }
        const ok = await checkNodeHealth(node);
        const prev = nodeStatus.get(node._id);
        nodeStatus.set(node._id, ok ? "online" : "offline");

        // Notify only on the online → offline transition (not on every poll)
        if (prev === "online" && !ok) {
            try {
                const { createNotification } = require("../routes/notifications");
                await createNotification(`Node "${node.name}" (${node.host}) is not responding.`, "error");
            } catch (err) {
                console.error("[Nodes] Could not create offline notification:", err.message);
            }
        }
        if (prev === "offline" && ok) {
            try {
                const { createNotification } = require("../routes/notifications");
                await createNotification(`Node "${node.name}" (${node.host}) is back online.`, "info");
            } catch (err) { /* best-effort */ }
        }
    }
};

let pollTimer = null;
const startHealthPolling = () => {
    if (pollTimer) return;
    pollAllNodes().catch(() => {});
    pollTimer = setInterval(() => pollAllNodes().catch(() => {}), 30_000);
    console.log("[Nodes] Health polling started — every 30s");
};

// ─────────────────────────────────────────────────────────────────────────────
//  Aggregated view for UI / scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All nodes (virtual "local" first) with live status and stats.
 * Stats are null when a node is unreachable. apiKey is never included.
 */
const getAllNodesWithStats = async () => {
    const result = [];

    let localStats = null;
    try { localStats = await getNodeStats(LOCAL_NODE_ID); } catch { /* keep null */ }
    result.push({
        _id: LOCAL_NODE_ID,
        name: "Local (panel VPS)",
        host: null,
        port: null,
        local: true,
        enabled: true,
        status: "online",
        stats: localStats,
    });

    const nodes = await getNodes();
    for (const node of nodes) {
        let stats = null;
        let status = node.enabled === false ? "disabled" : (nodeStatus.get(node._id) || "unknown");
        if (node.enabled !== false) {
            try {
                stats = await getNodeStats(node._id);
                status = "online";
                nodeStatus.set(node._id, "online");
            } catch {
                status = "offline";
                nodeStatus.set(node._id, "offline");
            }
        }
        result.push({
            _id: node._id,
            name: node.name,
            host: node.host,
            port: node.port,
            local: false,
            enabled: node.enabled !== false,
            status,
            stats,
            createdAt: node.createdAt,
        });
    }

    return result;
};

module.exports = {
    LOCAL_NODE_ID,
    getNodes,
    getNode,
    agentRequest,
    getNodeStats,
    getLocalStats,
    isNodeOnline,
    checkNodeHealth,
    startHealthPolling,
    getAllNodesWithStats,
    markOnline,
};
