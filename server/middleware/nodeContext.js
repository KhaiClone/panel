const nodeService = require("../services/nodeService");

/**
 * Resolves the global node-view context from the X-Panel-Node header.
 *
 * The client sends the header when the panel is scoped to one node.
 * Routes that honor the context read req.nodeId / req.node.
 *
 * - No header → req.node = null, meaning EVERY node.
 *   Routes decide what that means: /bots lists them all, /system falls back to
 *   the panel's own node.
 * - The legacy value "local" is accepted and resolved to the panel's node, so a
 *   browser still holding the old localStorage value keeps working.
 * - Unknown node → 410 NODE_GONE, disabled node → 409 NODE_DISABLED; the
 *   client resets its stored selection on these codes.
 * - Offline nodes are NOT blocked here — the health cache can be stale, so
 *   requests fail naturally with the agent's "[Node X]" error instead.
 */
const nodeContext = async (req, res, next) => {
    const header = req.get("X-Panel-Node");

    if (!header) {
        req.nodeId = null;
        req.node = null;
        return next();
    }

    let node;
    try {
        // resolveNodeId inside getNode turns the legacy "local" into the panel's node
        node = await nodeService.getNode(header);
    } catch {
        return res.status(410).json({ error: "Selected node no longer exists", code: "NODE_GONE" });
    }
    if (node.enabled === false) {
        return res.status(409).json({ error: `Node "${node.name}" is disabled`, code: "NODE_DISABLED" });
    }

    req.nodeId = node._id;
    req.node = node;
    next();
};

module.exports = nodeContext;
