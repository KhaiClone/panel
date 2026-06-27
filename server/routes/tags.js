const express = require("express");
const router = express.Router();
const db = require("../db");

// Tags are per-user. Admin sees all; users see only their own.

router.get("/", async (req, res, next) => {
    try {
        const query = req.user.role === "admin" ? {} : { ownerId: req.user.id };
        const tags = await db.find("tags", query);
        res.json(tags);
    } catch (err) {
        next(err);
    }
});

router.post("/", async (req, res, next) => {
    try {
        const { name, color = "#6366f1" } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "name is required" });
        }

        const existing = await db.findOne("tags", { name: name.trim(), ownerId: req.user.id });
        if (existing) {
            return res.status(409).json({ error: `Tag "${name.trim()}" already exists` });
        }

        const tag = await db.create("tags", {
            name: name.trim(),
            color,
            ownerId: req.user.id,
            createdAt: Date.now(),
        });

        res.status(201).json(tag);
    } catch (err) {
        next(err);
    }
});

router.put("/:id", async (req, res, next) => {
    try {
        const tag = await db.findOne("tags", { _id: req.params.id });
        if (!tag) return res.status(404).json({ error: "Tag not found" });
        if (req.user.role !== "admin" && tag.ownerId !== req.user.id) {
            return res.status(403).json({ error: "Access denied" });
        }

        const { name, color } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name.trim();
        if (color !== undefined) updates.color = color;

        const updated = await db.findOneAndUpdate("tags", { _id: req.params.id }, updates);
        res.json(updated);
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", async (req, res, next) => {
    try {
        const tag = await db.findOne("tags", { _id: req.params.id });
        if (!tag) return res.status(404).json({ error: "Tag not found" });
        if (req.user.role !== "admin" && tag.ownerId !== req.user.id) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Strip this tag from all bots owned by this user
        const userBots = req.user.role === "admin"
            ? await db.find("bots")
            : await db.find("bots", { ownerId: req.user.id });

        let affectedCount = 0;
        for (const bot of userBots) {
            if (Array.isArray(bot.tags) && bot.tags.includes(req.params.id)) {
                await db.findOneAndUpdate("bots", { _id: bot._id }, {
                    tags: bot.tags.filter(t => t !== req.params.id),
                });
                affectedCount++;
            }
        }

        await db.findOneAndDelete("tags", { _id: req.params.id });
        res.json({ message: `Tag "${tag.name}" deleted. Removed from ${affectedCount} bot(s).` });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
