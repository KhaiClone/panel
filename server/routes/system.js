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
        const [cpuLoad, mem, fsData, temp] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize().catch(() => []),
            si.cpuTemperature().catch(() => ({ main: null })),
        ]);

        // Pick the root filesystem or the largest one as the "main" disk
        const mainFs =
            fsData.find((f) => f.mount === "/") ||
            fsData.sort((a, b) => b.size - a.size)[0] ||
            null;

        res.json({
            cpu: {
                usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
                temperature: temp.main ?? null,
            },
            memory: {
                totalBytes: mem.total,
                usedBytes: mem.active,
                freeBytes: mem.available,
                usedPercent: parseFloat(
                    ((mem.active / mem.total) * 100).toFixed(2),
                ),
            },
            disk: mainFs
                ? {
                      totalBytes: mainFs.size,
                      usedBytes: mainFs.used,
                      freeBytes: mainFs.size - mainFs.used,
                      usedPercent: parseFloat(
                          ((mainFs.used / mainFs.size) * 100).toFixed(2),
                      ),
                      mount: mainFs.mount,
                      fs: mainFs.type,
                  }
                : null,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
