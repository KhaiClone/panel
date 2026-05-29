const express = require("express");
const router = express.Router();
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/tags
//  List all tags.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
    try {
        const tags = await db.find("tags");
        res.json(tags);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/tags
//  Create a new tag.
//  Body: { name: string, color?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
    try {
        const { name, color = "#6366f1" } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "name is required" });
        }

        const existing = await db.findOne("tags", { name: name.trim() });
        if (existing) {
            return res.status(409).json({ error: `Tag "${name.trim()}" already exists` });
        }

        const tag = await db.create("tags", {
            name: name.trim(),
            color,
            createdAt: Date.now(),
        });

        res.status(201).json(tag);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/tags/:id
//  Rename or recolor a tag.
//  Body: { name?, color? }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
    try {
        const { name, color } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name.trim();
        if (color !== undefined) updates.color = color;

        const updated = await db.findOneAndUpdate(
            "tags",
            { _id: req.params.id },
            updates,
        );
        if (!updated) return res.status(404).json({ error: "Tag not found" });

        res.json(updated);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/tags/:id
//  Delete a tag and strip it from all bots that reference it.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
    try {
        const tag = await db.findOne("tags", { _id: req.params.id });
        if (!tag) return res.status(404).json({ error: "Tag not found" });

        // Strip this tag from all bots
        const allBots = await db.find("bots");
        let affectedCount = 0;
        for (const bot of allBots) {
            if (Array.isArray(bot.tags) && bot.tags.includes(req.params.id)) {
                await db.findOneAndUpdate(
                    "bots",
                    { _id: bot._id },
                    { tags: bot.tags.filter((t) => t !== req.params.id) },
                );
                affectedCount++;
            }
        }

        await db.findOneAndDelete("tags", { _id: req.params.id });

        res.json({
            message: `Tag "${tag.name}" deleted. Removed from ${affectedCount} bot(s).`,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
