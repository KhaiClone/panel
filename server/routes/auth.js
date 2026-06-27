const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const router = express.Router();
const db = require("../db");

/**
 * POST /api/auth/login
 * Validates username + password against the users table.
 * Returns a signed JWT valid for 24 hours.
 * Body: { username: string, password: string }
 */
router.post("/login", async (req, res, next) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required" });
        }

        const user = await db.findOne("users", { username });
        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (user.active === false) {
            return res.status(403).json({ error: "Account is disabled. Contact admin." });
        }

        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        await db.findOneAndUpdate("users", { _id: user._id }, { lastLoginAt: Date.now() });

        const token = jwt.sign(
            { userId: user._id, username: user.username, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "24h" },
        );

        res.json({ token, username: user.username, role: user.role });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/auth/verify
 * Check if the token is still valid. Returns user info + role.
 */
router.get("/verify", (req, res) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) return res.status(401).json({ valid: false });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        res.json({ valid: true, username: decoded.username, role: decoded.role, userId: decoded.userId });
    } catch {
        res.status(401).json({ valid: false });
    }
});

module.exports = router;
