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
 * DELETE /api/notifications/:id
 * Removes a specific notification.
 */
router.delete("/:id", async (req, res, next) => {
    try {
        await db.findOneAndDelete("notifications", { _id: req.params.id });
        res.json({ message: "Notification deleted" });
    } catch (err) {
        next(err);
    }
});

// The bell's types that read as trouble in the panel log (services/panelLog.js).
const LOG_KIND = { error: "error", warning: "warn", expired: "warn" };

/**
 * Helper to create a notification directly from backend services. It also
 * goes to the panel log channel, when one is set.
 */
router.createNotification = async (message, type) => {
    require("../services/panelLog").add(LOG_KIND[type] || "notice", message);
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
