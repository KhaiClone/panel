const express = require("express");
const router = express.Router();
const db = require("../db");

// Groups are per-user. Admin sees all groups; users see only their own.

router.get("/", async (req, res, next) => {
    try {
        const query = req.user.role === "admin" ? {} : { ownerId: req.user.id };
        const groups = await db.find("groups", query);
        res.json(groups);
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

        const existing = await db.findOne("groups", { name: name.trim(), ownerId: req.user.id });
        if (existing) {
            return res.status(409).json({ error: `Group "${name.trim()}" already exists` });
        }

        const group = await db.create("groups", {
            name: name.trim(),
            color,
            ownerId: req.user.id,
            createdAt: Date.now(),
        });

        res.status(201).json(group);
    } catch (err) {
        next(err);
    }
});

router.put("/:id", async (req, res, next) => {
    try {
        const group = await db.findOne("groups", { _id: req.params.id });
        if (!group) return res.status(404).json({ error: "Group not found" });
        if (req.user.role !== "admin" && group.ownerId !== req.user.id) {
            return res.status(403).json({ error: "Access denied" });
        }

        const { name, color } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name.trim();
        if (color !== undefined) updates.color = color;

        const updated = await db.findOneAndUpdate("groups", { _id: req.params.id }, updates);
        res.json(updated);
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", async (req, res, next) => {
    try {
        const group = await db.findOne("groups", { _id: req.params.id });
        if (!group) return res.status(404).json({ error: "Group not found" });
        if (req.user.role !== "admin" && group.ownerId !== req.user.id) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Ungroup all bots in this group
        const botsInGroup = await db.find("bots", { groupId: req.params.id });
        for (const bot of botsInGroup) {
            await db.findOneAndUpdate("bots", { _id: bot._id }, { groupId: null });
        }

        await db.findOneAndDelete("groups", { _id: req.params.id });
        res.json({ message: `Group "${group.name}" deleted. ${botsInGroup.length} bot(s) ungrouped.` });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
