const express = require("express");
const router = express.Router();
const db = require("../db");

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/groups
//  List all groups.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
    try {
        const groups = await db.find("groups");
        res.json(groups);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/groups
//  Create a new group.
//  Body: { name: string, color?: string }  (color = hex or tailwind name)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
    try {
        const { name, color = "#6366f1" } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ error: "name is required" });
        }

        const existing = await db.findOne("groups", { name: name.trim() });
        if (existing) {
            return res
                .status(409)
                .json({ error: `Group "${name.trim()}" already exists` });
        }

        const group = await db.create("groups", {
            name: name.trim(),
            color,
            createdAt: Date.now(),
        });

        res.status(201).json(group);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/groups/:id
//  Rename or recolor a group.
//  Body: { name?, color? }
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res, next) => {
    try {
        const { name, color } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name.trim();
        if (color !== undefined) updates.color = color;

        const updated = await db.findOneAndUpdate(
            "groups",
            { _id: req.params.id },
            updates,
        );
        if (!updated) return res.status(404).json({ error: "Group not found" });

        res.json(updated);
    } catch (err) {
        next(err);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/groups/:id
//  Delete a group. Bots in this group become ungrouped (groupId cleared).
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
    try {
        const group = await db.findOne("groups", { _id: req.params.id });
        if (!group) return res.status(404).json({ error: "Group not found" });

        // Ungroup all bots that belonged to this group
        const botsInGroup = await db.find("bots", { groupId: req.params.id });
        for (const bot of botsInGroup) {
            await db.findOneAndUpdate(
                "bots",
                { _id: bot._id },
                { groupId: null },
            );
        }

        await db.findOneAndDelete("groups", { _id: req.params.id });

        res.json({
            message: `Group "${group.name}" deleted. ${botsInGroup.length} bot(s) ungrouped.`,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
