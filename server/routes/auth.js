const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();

/**
 * The panel has exactly ONE account: the admin, defined by ADMIN_USERNAME and
 * ADMIN_PASSWORD_HASH in .env. There is no users table, no roles and no
 * self-service registration — every authenticated request is the admin's.
 * To change the password, regenerate the hash and restart the panel:
 *   node -e "console.log(require('bcryptjs').hashSync('newpassword',10))"
 */

/**
 * POST /api/auth/login
 * Validates username + password against the env credentials.
 * Returns a signed JWT valid for 24 hours.
 * Body: { username: string, password: string }
 */
router.post("/login", async (req, res, next) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required" });
        }

        if (username !== process.env.ADMIN_USERNAME) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const validPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign(
            { username },
            process.env.JWT_SECRET,
            { expiresIn: "24h" },
        );

        res.json({ token, username });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/auth/verify
 * Check if the token is still valid.
 */
router.get("/verify", (req, res) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) return res.status(401).json({ valid: false });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        res.json({ valid: true, username: decoded.username });
    } catch {
        res.status(401).json({ valid: false });
    }
});

module.exports = router;
