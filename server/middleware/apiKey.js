const apiKeyMiddleware = (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    const validKey = process.env.PANEL_API_KEY;

    if (!validKey) {
        console.error("[Middleware] PANEL_API_KEY is not set in environment variables.");
        return res.status(500).json({ error: "Server misconfiguration" });
    }

    if (!apiKey || apiKey !== validKey) {
        return res.status(401).json({ error: "Unauthorized: Invalid API Key" });
    }

    next();
};

module.exports = { apiKeyMiddleware };
