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

module.exports = (req, res, next) => {
    const expected = process.env.AGENT_API_KEY;
    if (!expected) {
        return res.status(503).json({ error: "Agent not configured (AGENT_API_KEY missing)" });
    }

    const provided = req.headers["x-agent-key"];
    if (!provided || !timingSafeEqual(provided, expected)) {
        return res.status(401).json({ error: "Invalid agent key" });
    }

    next();
};
