const nodeService = require("../services/nodeService");

/**
 * Resolves the global "remote view" context from the X-Panel-Node header.
 *
 * The client sends the header on every request when an admin has switched the
 * panel's view to a remote node. Routes that honor the context read
 * req.nodeId / req.node; everything else simply ignores them.
 *
 * - No header, "local", or non-admin user → local view (today's behavior).
 * - Unknown node → 410 NODE_GONE, disabled node → 409 NODE_DISABLED; the
 *   client resets its stored selection on these codes.
 * - Offline nodes are NOT blocked here — the health cache can be stale, so
 *   requests fail naturally with the agent's "[Node X]" error instead.
 */
const nodeContext = async (req, res, next) => {
    const header = req.get("X-Panel-Node");

    if (!header || header === nodeService.LOCAL_NODE_ID || req.user?.role !== "admin") {
        req.nodeId = nodeService.LOCAL_NODE_ID;
        req.node = null;
        return next();
    }

    let node;
    try {
        node = await nodeService.getNode(header);
    } catch {
        return res.status(410).json({ error: "Selected node no longer exists", code: "NODE_GONE" });
    }
    if (node.enabled === false) {
        return res.status(409).json({ error: `Node "${node.name}" is disabled`, code: "NODE_DISABLED" });
    }

    req.nodeId = header;
    req.node = node;
    next();
};

module.exports = nodeContext;
