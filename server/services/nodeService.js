const axios = require("axios");
const si = require("systeminformation");
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  Node registry + agent HTTP client
//
//  Every VPS is a node, including the one the panel itself runs on: the panel
//  is a control plane and owns no worker code, so even "the machine right here"
//  is reached through its agent over HTTP. That keeps exactly one code path in
//  executor.js instead of a local/remote fork in every operation.
//
//  nodes collection:
//    { _id, name, host, port, apiKey, enabled, createdAt,
//      controlHost?, wgPubKey?, wgOverlayIp?, wgPort?, questProxy? }
//
//  host vs controlHost — read this before touching either:
//    host        the node's PUBLIC address. Also used as the WireGuard endpoint
//                pushed to every other node (wgService._peersFor) and as the
//                egress proxy address (executor.buildEgressProxyConf). Changing
//                it to a loopback address breaks the mesh and makes bots on
//                other nodes proxy back into themselves.
//    controlHost OPTIONAL. Used for panel → agent control traffic only. Set it
//                to 127.0.0.1 on the node that runs the panel so those calls
//                never leave the machine. Leave it unset everywhere else.
// ─────────────────────────────────────────────────────────────────────────────

// Legacy node id from before the panel/agent split. Bot records created back
// then carry nodeId "local" (or nothing at all); resolveNodeId maps those onto
// PANEL_NODE_ID so old rows keep working without a migration. Once the data is
// migrated this constant has no remaining users and can go.
const LEGACY_LOCAL_ID = "local";

// Default timeout covers control operations; long ops (clone/install) pass
// their own — slightly above the agent's internal timeouts so the agent's
// own error wins when something hangs.
const DEFAULT_TIMEOUT = 20_000;

const getNodes = async () => (await db.find("nodes")) || [];

/** _id of the node this panel runs on. Required config — never guessed. */
const panelNodeId = () => {
    const id = process.env.PANEL_NODE_ID;
    if (!id) {
        const err = new Error(
            "PANEL_NODE_ID is not set. Add the _id of the node running this panel " +
                "to the panel's .env — the panel reaches its own machine through that node's agent.",
        );
        err.status = 503;
        throw err;
    }
    return id;
};

/**
 * Map any stored nodeId onto a real node _id.
 * Missing or "local" means a record written before the split — those projects
 * live on the panel's own machine, which is now a normal node.
 */
const resolveNodeId = (nodeId) =>
    !nodeId || nodeId === LEGACY_LOCAL_ID ? panelNodeId() : nodeId;

/** The node record for a stored nodeId. Always a real record, never null. */
const getNode = async (nodeId) => {
    const id = resolveNodeId(nodeId);
    const node = await db.findOne("nodes", { _id: id });
    if (!node) throw new Error(`Node "${id}" no longer exists`);
    return node;
};

/**
 * Perform an HTTP request against a node's agent.
 * Agent errors are re-thrown with the node name so route error messages
 * make clear which VPS failed.
 */
const agentRequest = async (node, method, urlPath, { data, params, responseType, timeout } = {}) => {
    // controlHost keeps panel → agent traffic on the loopback for the node the
    // panel shares a machine with. host stays the public address for everyone else.
    const url = `http://${node.controlHost || node.host}:${node.port}${urlPath}`;
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
//  Stats (cached)
// ─────────────────────────────────────────────────────────────────────────────

const STATS_TTL = 10_000;
const statsCache = new Map(); // nodeId → { at, stats }

/**
 * Stats of the machine this process runs on, in the agent's /stats shape.
 *
 * Kept only as a fallback for the panel's own host when its agent cannot be
 * reached — the normal path reads /stats from the agent like any other node.
 */
const getLocalStats = async () => {
    const os = require("os");
    const [cpuLoad, mem, fsData, cpuInfo, netStats] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize().catch(() => []),
        si.cpu().catch(() => ({ brand: null, manufacturer: null })),
        si.networkStats().catch(() => []),
    ]);

    const mainFs =
        fsData.find((f) => f.mount === "/") ||
        fsData.sort((a, b) => b.size - a.size)[0] ||
        null;

    const iface = netStats.find((n) => n.iface && !n.iface.startsWith("lo")) || netStats[0] || null;

    return {
        cpu: {
            usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
            model: cpuInfo.brand
                ? `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim()
                : (os.cpus()[0]?.model || null),
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
                  fs: mainFs.type,
              }
            : null,
        network: iface
            ? {
                  rxBytesPerSec: iface.rx_sec ?? 0,
                  txBytesPerSec: iface.tx_sec ?? 0,
                  iface: iface.iface,
              }
            : null,
        uptime: os.uptime(),
        processCount: null,
    };
};

/**
 * Get stats for one node (cached ~10s).
 * Throws when the node is unreachable — callers decide how to handle that.
 */
const getNodeStats = async (nodeId) => {
    const id = resolveNodeId(nodeId);
    const cached = statsCache.get(id);
    if (cached && Date.now() - cached.at < STATS_TTL) return cached.stats;

    const node = await getNode(id);
    const stats = await agentRequest(node, "get", "/stats", { timeout: 8000 });

    statsCache.set(id, { at: Date.now(), stats });
    return stats;
};

// ─────────────────────────────────────────────────────────────────────────────
//  Health polling
// ─────────────────────────────────────────────────────────────────────────────

// nodeId → "online" | "offline"
const nodeStatus = new Map();

const isNodeOnline = (nodeId) => {
    try {
        return nodeStatus.get(resolveNodeId(nodeId)) === "online";
    } catch {
        return false; // PANEL_NODE_ID unset — treat as unknown, not online
    }
};

// Confirmed-offline only: an unpolled/unknown node returns false (treated as usable).
const isNodeOffline = (nodeId) => {
    try {
        return nodeStatus.get(resolveNodeId(nodeId)) === "offline";
    } catch {
        return false;
    }
};

/** Mark a node online immediately (e.g. right after a verified registration). */
const markOnline = (nodeId) => {
    if (nodeId) nodeStatus.set(nodeId, "online");
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
            // Re-push the WireGuard mesh to the recovered node in case it missed peer
            // changes while it was down (its own conf persists across reboot).
            try {
                require("./wgService").pushToNode(node, nodes).catch(() => {});
            } catch { /* wgService optional */ }
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
 * All registered nodes with live status and stats. The node the panel runs on
 * is flagged isPanelNode so the UI can label it; it is otherwise ordinary.
 * Stats are null when a node is unreachable. apiKey is never included.
 */
const getAllNodesWithStats = async () => {
    const panelId = process.env.PANEL_NODE_ID || null;
    const nodes = await getNodes();
    const result = [];

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
            controlHost: node.controlHost ?? null,
            port: node.port,
            isPanelNode: node._id === panelId,
            enabled: node.enabled !== false,
            status,
            stats,
            wgOverlayIp: node.wgOverlayIp ?? null,
            questProxy: node.questProxy !== false,
            createdAt: node.createdAt,
        });
    }

    // The panel's own node first, then alphabetical — a stable order for the switcher.
    result.sort((a, b) => {
        if (a.isPanelNode !== b.isPanelNode) return a.isPanelNode ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
    });

    return result;
};

module.exports = {
    LEGACY_LOCAL_ID,
    panelNodeId,
    resolveNodeId,
    getNodes,
    getNode,
    agentRequest,
    getNodeStats,
    getLocalStats,
    isNodeOnline,
    isNodeOffline,
    checkNodeHealth,
    startHealthPolling,
    getAllNodesWithStats,
    markOnline,
};
