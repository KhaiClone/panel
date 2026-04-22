const express = require("express");
const si = require("systeminformation");
const router = express.Router();

/**
 * GET /api/system/stats
 *
 * Returns current CPU load, RAM usage, and (if available) CPU temperature.
 * Polled by the dashboard every few seconds.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const [cpuLoad, mem, temp] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.cpuTemperature().catch(() => ({ main: null })),
        ]);

        res.json({
            cpu: {
                usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
                temperature: temp.main ?? null, // null if not supported
            },
            memory: {
                totalBytes: mem.total,
                // mem.active = total - free - buffers - cached,
                // which matches what btop / neofetch / free -h report as "used".
                usedBytes: mem.active,
                freeBytes: mem.available,
                usedPercent: parseFloat(
                    ((mem.active / mem.total) * 100).toFixed(2),
                ),
            },
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
