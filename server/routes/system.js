const express = require("express");
const si = require("systeminformation");
const router = express.Router();

let cachedStats = null;
let lastFetch = 0;
const CACHE_TTL = 2000; // 2 seconds

/**
 * GET /api/system/stats
 *
 * Returns current CPU load, RAM usage, and (if available) CPU temperature.
 * Polled by the dashboard every few seconds.
 */
router.get("/stats", async (req, res, next) => {
    try {
        const now = Date.now();
        if (cachedStats && now - lastFetch < CACHE_TTL) {
            return res.json(cachedStats);
        }

        const [cpuLoad, mem, fsData, temp, cpuInfo] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize().catch(() => []),
            si.cpuTemperature().catch(() => ({ main: null })),
            si.cpu().catch(() => ({ brand: null, manufacturer: null })),
        ]);

        // Pick the root filesystem or the largest one as the "main" disk
        const mainFs =
            fsData.find((f) => f.mount === "/") ||
            fsData.sort((a, b) => b.size - a.size)[0] ||
            null;

        const response = {
            cpu: {
                usagePercent: parseFloat(cpuLoad.currentLoad.toFixed(2)),
                temperature: temp.main ?? null,
                model: cpuInfo.brand // e.g. "Core i7-12700K"
                    ? `${cpuInfo.manufacturer} ${cpuInfo.brand}`.trim()
                    : null,
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
        };

        cachedStats = response;
        lastFetch = Date.now();
        res.json(response);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
