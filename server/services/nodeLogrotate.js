const nodeService = require("./nodeService");

// ─────────────────────────────────────────────────────────────────────────────
//  pm2-logrotate on any node, through that node's agent (agent/routes/logrotate.js).
//
//  Every agent runs the same code, so each node rotates its own PM2 logs and is
//  managed on its own page. The panel's node is one of them: panelService keeps
//  /api/panel/logrotate pointed at it with these same calls.
// ─────────────────────────────────────────────────────────────────────────────

/** { installed, status, config } as the agent reports it. */
const status = (node) => nodeService.agentRequest(node, "get", "/logrotate", { timeout: 20_000 });

/** `pm2 install` on the node, then the default limits — minutes on a slow VPS. */
const install = (node) => nodeService.agentRequest(node, "post", "/logrotate/install", { timeout: 200_000 });

/** The agent validates the settings and answers 400 for a bad one. */
const set = (node, settings) => nodeService.agentRequest(node, "put", "/logrotate", { data: settings, timeout: 60_000 });

/**
 * One node's row for the overview. state:
 *   "on"      installed and its PM2 process is online
 *   "off"     not installed, or installed but stopped / errored
 *   "unknown" the node is offline, its agent did not answer, or PM2 did not —
 *             nothing is known about its logs, which is not the same as "off"
 */
const rowFor = async (node) => {
    const base = { nodeId: node._id, name: node.name };
    // The health poll already knows: asking would only wait out the timeout.
    if (nodeService.isNodeOffline(node._id)) return { ...base, state: "unknown", reason: "offline" };
    let s;
    try {
        s = await status(node);
    } catch (err) {
        return { ...base, state: "unknown", reason: "no answer", error: err.message };
    }
    const row = { ...base, installed: !!s.installed, status: s.status, config: s.config || null };
    if (s.status === "unknown") return { ...row, state: "unknown", reason: "PM2 did not answer" };
    return { ...row, state: s.installed && s.status === "online" ? "on" : "off" };
};

/** Every enabled node, asked at once. → { nodes: [row] } in the nodes' stored order. */
const overview = async () => {
    const nodes = (await nodeService.getNodes()).filter((n) => n.enabled !== false);
    return { nodes: await Promise.all(nodes.map(rowFor)) };
};

module.exports = { status, install, set, overview };
