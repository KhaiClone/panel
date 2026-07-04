const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  Scheduler — decides which node a new project lands on.
//
//  Rules:
//   - website/service projects need nginx/UFW/DNS on the panel VPS → always
//     "local". An explicit remote nodeId for them is rejected with a clear
//     error rather than silently moved.
//   - Discord bots: explicit nodeId wins (validated online), otherwise every
//     online node (including local) is scored and the best one is picked.
//
//  Scoring: free RAM matters most (bots are memory-bound), then CPU headroom,
//  then free disk. A node whose disk is below MIN_DISK_FREE_GB is excluded
//  entirely — placing anything on an almost-full disk risks corrupting
//  pm2 dumps and git clones.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_DISK_FREE_GB = 5;

const WEIGHTS = { ram: 0.5, cpu: 0.3, disk: 0.2 };

const scoreNode = (stats) => {
    const ramFree = stats.memory ? 100 - stats.memory.usedPercent : 0;
    const cpuFree = stats.cpu ? 100 - stats.cpu.usagePercent : 0;
    const diskFree = stats.disk ? 100 - stats.disk.usedPercent : 0;
    return ramFree * WEIGHTS.ram + cpuFree * WEIGHTS.cpu + diskFree * WEIGHTS.disk;
};

const diskFreeGB = (stats) =>
    stats?.disk ? stats.disk.freeBytes / (1024 * 1024 * 1024) : null;

/**
 * Pick the node for a new project.
 *
 * @param {Object} opts
 * @param {string|null} opts.requestedNodeId - explicit choice ("local", a node _id, or "auto"/null)
 * @param {string} opts.projectType - "discord" | "website" | "service"
 * @returns {Promise<{nodeId: string, nodeName: string, reason: string}>}
 */
const pickNode = async ({ requestedNodeId = null, projectType = "discord" } = {}) => {
    const wantsAuto = !requestedNodeId || requestedNodeId === "auto";

    // Websites and services are pinned to the panel VPS (nginx/UFW live there)
    if (projectType !== "discord") {
        if (!wantsAuto && requestedNodeId !== nodeService.LOCAL_NODE_ID) {
            throw new Error(
                `${projectType} projects can only run on the local node (nginx/UFW required) — remote nodes are not supported yet`,
            );
        }
        return { nodeId: nodeService.LOCAL_NODE_ID, nodeName: "Local", reason: `${projectType} is local-only` };
    }

    // Explicit choice
    if (!wantsAuto) {
        if (requestedNodeId === nodeService.LOCAL_NODE_ID) {
            return { nodeId: requestedNodeId, nodeName: "Local", reason: "manually selected" };
        }
        const node = await nodeService.getNode(requestedNodeId); // throws if unknown
        if (node.enabled === false) throw new Error(`Node "${node.name}" is disabled`);
        const healthy = await nodeService.checkNodeHealth(node);
        if (!healthy) throw new Error(`Node "${node.name}" is offline — cannot create the bot there`);
        return { nodeId: node._id, nodeName: node.name, reason: "manually selected" };
    }

    // Auto: score all reachable nodes
    const all = await nodeService.getAllNodesWithStats();
    const candidates = all.filter((n) => n.status === "online" && n.stats);

    if (candidates.length === 0) {
        // Should never happen (local is always a candidate unless stats failed)
        return { nodeId: nodeService.LOCAL_NODE_ID, nodeName: "Local", reason: "no stats available — defaulted to local" };
    }

    // Exclude nodes below the disk floor — unless that removes everything,
    // in which case creating is still allowed on the least-bad node.
    const withDisk = candidates.filter((n) => {
        const free = diskFreeGB(n.stats);
        return free === null || free >= MIN_DISK_FREE_GB;
    });
    const pool = withDisk.length > 0 ? withDisk : candidates;

    pool.sort((a, b) => scoreNode(b.stats) - scoreNode(a.stats));
    const best = pool[0];

    return {
        nodeId: best._id,
        nodeName: best.name,
        reason: `auto — best score (RAM free ${best.stats.memory ? (100 - best.stats.memory.usedPercent).toFixed(0) : "?"}%, disk free ${diskFreeGB(best.stats)?.toFixed(1) ?? "?"}GB)`,
    };
};

module.exports = { pickNode, MIN_DISK_FREE_GB };
