const jwt = require("jsonwebtoken");

/**
 * Auth middleware — verifies the JWT token in the Authorization header.
 * All API routes except /api/auth/* require this.
 *
 * Expected header:  Authorization: Bearer <token>
 *
 * Every 401 from here carries `code: AUTH_REQUIRED`. That code is the ONLY
 * thing the browser treats as "your session died, go to /login" — see the
 * response interceptor in client/src/api/client.js.
 *
 * The distinction matters because 401 is overloaded: a route that resolves a
 * Discord token the admin pasted also answers 401 when THAT token is dead
 * (questService.startAccount, questMonthly.activate). Before this code existed,
 * pasting a dead token into "Add account manually" logged the admin out of the
 * panel — two different auth domains collapsed onto one status number.
 */
const AUTH_REQUIRED = "AUTH_REQUIRED";

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    let token = authHeader && authHeader.split(" ")[1]; // "Bearer <token>"

    // Fallback to query param for cases where headers aren't possible (downloads, SSE)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res
            .status(401)
            .json({ error: "Access denied: no token provided", code: AUTH_REQUIRED });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { username, iat, exp }
        next();
    } catch (err) {
        return res
            .status(401)
            .json({ error: "Access denied: invalid or expired token", code: AUTH_REQUIRED });
    }
};

module.exports = { authMiddleware, AUTH_REQUIRED };
