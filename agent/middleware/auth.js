const crypto = require("crypto");

/**
 * API-key authentication for every agent route.
 * The panel sends the shared secret in the "x-agent-key" header.
 * Fails closed: if AGENT_API_KEY is not configured, everything is rejected.
 */
const timingSafeEqual = (a, b) => {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
};

/** True when `provided` matches the configured agent key. Used by the HTTP
 *  middleware and the WebSocket upgrade handler (which can't send JSON errors). */
const isValidAgentKey = (provided) => {
    const expected = process.env.AGENT_API_KEY;
    return !!expected && !!provided && timingSafeEqual(provided, expected);
};

module.exports = (req, res, next) => {
    if (!process.env.AGENT_API_KEY) {
        return res.status(503).json({ error: "Agent not configured (AGENT_API_KEY missing)" });
    }
    if (!isValidAgentKey(req.headers["x-agent-key"])) {
        return res.status(401).json({ error: "Invalid agent key" });
    }
    next();
};

module.exports.isValidAgentKey = isValidAgentKey;

/** Non-middleware variant for WebSocket upgrade handshakes (see services/term.js). */
module.exports.isValidKey = (provided) => {
    const expected = process.env.AGENT_API_KEY;
    return !!expected && !!provided && timingSafeEqual(provided, expected);
};
