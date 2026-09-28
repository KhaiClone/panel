const crypto = require("crypto");
const apiKeys = require("../services/apiKeyService");

// Equal-length digests, so the comparison takes the same time whatever the input.
const sameKey = (a, b) => {
    const h = (s) => crypto.createHash("sha256").update(String(s)).digest();
    return crypto.timingSafeEqual(h(a), h(b));
};

/**
 * /api/external/* — x-api-key is either the shared PANEL_API_KEY or a
 * project's own key (services/apiKeyService.js). Sets req.apiCaller:
 *   { shared: true }              the shared key — caller unknown
 *   { botId, keyId }              a project key — callbacks it registers
 *                                 follow that project (callbackService)
 */
const apiKeyMiddleware = async (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "Unauthorized: Invalid API Key" });

    const sharedKey = process.env.PANEL_API_KEY;
    if (sharedKey && sameKey(apiKey, sharedKey)) {
        req.apiCaller = { shared: true };
        return next();
    }

    try {
        const rec = await apiKeys.verify(apiKey);
        if (rec) {
            req.apiCaller = { botId: rec.botId, keyId: rec._id };
            apiKeys.touch(rec);
            return next();
        }
    } catch (err) {
        return next(err);
    }
    return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
};

module.exports = { apiKeyMiddleware };
