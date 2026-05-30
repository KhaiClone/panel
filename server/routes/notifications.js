const express = require("express");
const router = express.Router();
const db = require("../db");

/**
 * GET /api/notifications
 * Returns the latest 50 notifications, sorted by newest first.
 */
router.get("/", async (req, res, next) => {
    try {
        const notifs = await db.find("notifications");
        res.json(notifs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50));
    } catch (err) {
        next(err);
    }
});

/**
 * POST /api/notifications/read
 * Marks all notifications as read.
 */
router.post("/read", async (req, res, next) => {
    try {
        const notifs = await db.find("notifications", { read: false });
        for (const n of notifs) {
            await db.findOneAndUpdate("notifications", { _id: n._id }, { read: true });
        }
        res.json({ message: "All notifications marked as read" });
    } catch (err) {
        next(err);
    }
});

/**
 * Helper to create a notification directly from backend services.
 */
router.createNotification = async (message, type) => {
    try {
        await db.create("notifications", {
            message,
            type,
            read: false,
            createdAt: Date.now()
        });
    } catch (err) {
        console.error("[Notifications] Failed to create notification:", err);
    }
};

module.exports = router;
