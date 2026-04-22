const jwt = require("jsonwebtoken");

/**
 * Auth middleware — verifies the JWT token in the Authorization header.
 * All API routes except /api/auth/* require this.
 *
 * Expected header:  Authorization: Bearer <token>
 */
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1]; // "Bearer <token>"

    if (!token) {
        return res
            .status(401)
            .json({ error: "Access denied: no token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { username, role, iat, exp }
        next();
    } catch (err) {
        return res
            .status(401)
            .json({ error: "Access denied: invalid or expired token" });
    }
};

module.exports = { authMiddleware };
