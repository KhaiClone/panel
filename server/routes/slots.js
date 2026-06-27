const express = require("express");
const router = express.Router();
const db = require("../db");
const { adminOnly } = require("../middleware/adminOnly");

/**
 * GET /api/admin/slots
 * List all slots with enriched user info.
 */
router.get("/", adminOnly, async (req, res, next) => {
    try {
        const slots = await db.find("slots");
        const users = await db.find("users");
        const userMap = Object.fromEntries(users.map(u => [u._id, u.username]));

        const enriched = await Promise.all(slots.map(async (slot) => {
            const bots = await db.find("bots", { ownerId: slot.userId });
            return {
                ...slot,
                username: userMap[slot.userId] || "Unknown",
                usage: {
                    bots: bots.filter(b => b.projectType !== "website").length,
                    sites: bots.filter(b => b.projectType === "website").length,
                },
            };
        }));

        res.json(enriched);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /api/admin/slots/user/:userId
 * Get the slot for a specific user.
 */
router.get("/user/:userId", adminOnly, async (req, res, next) => {
    try {
        const slot = await db.findOne("slots", { userId: req.params.userId });
        res.json(slot || null);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/admin/slots
 * Create or replace a slot for a user.
 * Body: { userId, maxBots, maxSites, maxRamPerBot?, expiresAt?, label? }
 */
router.post("/", adminOnly, async (req, res, next) => {
    try {
        const {
            userId,
            maxBots = 5,
            maxSites = 2,
            maxRamPerBot = null,
            expiresAt = null,
            label = "",
        } = req.body;

        if (!userId) return res.status(400).json({ error: "userId is required" });

        const user = await db.findOne("users", { _id: userId });
        if (!user) return res.status(404).json({ error: "User not found" });

        // Replace existing slot if any
        const existing = await db.findOne("slots", { userId });
        if (existing) {
            const updated = await db.findOneAndUpdate("slots", { _id: existing._id }, {
                maxBots, maxSites, maxRamPerBot, expiresAt, label, updatedAt: Date.now(),
            });
            return res.json(updated);
        }

        const slot = await db.create("slots", {
            userId,
            maxBots,
            maxSites,
            maxRamPerBot,
            expiresAt,
            label,
            createdAt: Date.now(),
        });

        res.status(201).json(slot);
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /api/admin/slots/:id
 * Update an existing slot.
 */
router.put("/:id", adminOnly, async (req, res, next) => {
    try {
        const { maxBots, maxSites, maxRamPerBot, expiresAt, label } = req.body;
        const updates = { updatedAt: Date.now() };

        if (maxBots !== undefined) updates.maxBots = maxBots;
        if (maxSites !== undefined) updates.maxSites = maxSites;
        if (maxRamPerBot !== undefined) updates.maxRamPerBot = maxRamPerBot;
        if (expiresAt !== undefined) updates.expiresAt = expiresAt;
        if (label !== undefined) updates.label = label;

        const updated = await db.findOneAndUpdate("slots", { _id: req.params.id }, updates);
        if (!updated) return res.status(404).json({ error: "Slot not found" });

        res.json(updated);
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /api/admin/slots/:id
 */
router.delete("/:id", adminOnly, async (req, res, next) => {
    try {
        const slot = await db.findOneAndDelete("slots", { _id: req.params.id });
        if (!slot) return res.status(404).json({ error: "Slot not found" });
        res.json({ message: "Slot deleted" });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
