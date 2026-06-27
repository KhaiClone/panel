const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const db = require("../db");
const { adminOnly } = require("../middleware/adminOnly");

// All routes here require admin (applied in index.js)

/**
 * GET /api/admin/users
 * List all users (without passwordHash).
 */
router.get("/", adminOnly, async (req, res, next) => {
    try {
        const users = await db.find("users");
        const safe = users.map(({ passwordHash, ...u }) => u);
        res.json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/users/me
 * Get current user info + their slot.
 * Used by regular users to know their quota.
 */
router.get("/me", async (req, res, next) => {
    try {
        const user = await db.findOne("users", { _id: req.user.id });
        if (!user) return res.status(404).json({ error: "User not found" });

        const { passwordHash, ...safe } = user;
        const slot = await db.findOne("slots", { userId: req.user.id }) || null;

        // Count user's bots/sites
        const bots = await db.find("bots", { ownerId: req.user.id });
        const botCount = bots.filter(b => b.projectType !== "website").length;
        const siteCount = bots.filter(b => b.projectType === "website").length;

        res.json({ ...safe, slot, usage: { bots: botCount, sites: siteCount } });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/users
 * Create a new user.
 * Body: { username, password, role? }
 */
router.post("/", adminOnly, async (req, res, next) => {
    try {
        const { username, password, role = "user" } = req.body;

        if (!username?.trim() || !password) {
            return res.status(400).json({ error: "username and password are required" });
        }
        if (!["admin", "user"].includes(role)) {
            return res.status(400).json({ error: "role must be 'admin' or 'user'" });
        }

        const existing = await db.findOne("users", { username: username.trim() });
        if (existing) {
            return res.status(409).json({ error: `Username "${username.trim()}" already exists` });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const user = await db.create("users", {
            username: username.trim(),
            passwordHash,
            role,
            active: true,
            createdAt: Date.now(),
            lastLoginAt: null,
        });

        const { passwordHash: _, ...safe } = user;
        res.status(201).json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/admin/users/:id
 * Update a user (username, password, role, active).
 */
router.put("/:id", adminOnly, async (req, res, next) => {
    try {
        const { username, password, role, active } = req.body;
        const updates = {};

        if (username !== undefined) updates.username = username.trim();
        if (role !== undefined) {
            if (!["admin", "user"].includes(role)) {
                return res.status(400).json({ error: "role must be 'admin' or 'user'" });
            }
            updates.role = role;
        }
        if (active !== undefined) updates.active = Boolean(active);
        if (password) {
            updates.passwordHash = await bcrypt.hash(password, 10);
        }

        const updated = await db.findOneAndUpdate("users", { _id: req.params.id }, updates);
        if (!updated) return res.status(404).json({ error: "User not found" });

        const { passwordHash, ...safe } = updated;
        res.json(safe);
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/admin/users/:id
 * Delete a user. Does NOT delete their bots (admin should remove them separately).
 */
router.delete("/:id", adminOnly, async (req, res, next) => {
    try {
        // Prevent deleting yourself
        if (req.params.id === req.user.id) {
            return res.status(400).json({ error: "You cannot delete your own account" });
        }

        const user = await db.findOneAndDelete("users", { _id: req.params.id });
        if (!user) return res.status(404).json({ error: "User not found" });

        // Also remove the slot
        await db.findOneAndDelete("slots", { userId: req.params.id });

        res.json({ message: `User "${user.username}" deleted` });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/users/:id/bots
 * List all bots belonging to a specific user.
 */
router.get("/:id/bots", adminOnly, async (req, res, next) => {
    try {
        const bots = await db.find("bots", { ownerId: req.params.id });
        res.json(bots);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
