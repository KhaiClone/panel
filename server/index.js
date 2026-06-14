require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const authRoutes = require("./routes/auth");
const botRoutes = require("./routes/bots");
const logRoutes = require("./routes/logs");
const systemRoutes = require("./routes/system");
const groupRoutes = require("./routes/groups");
const bulkRoutes = require("./routes/bulk");
const externalRoutes = require("./routes/external");
const panelRoutes = require("./routes/panel");
const githubRoutes = require("./routes/github");
const proxyRoutes = require("./routes/proxy");
const tagRoutes = require("./routes/tags");
const notificationRoutes = require("./routes/notifications");
const { authMiddleware } = require("./middleware/auth");
const { apiKeyMiddleware } = require("./middleware/apiKey");
const errorHandler = require("./middleware/errorHandler");
const expiryService = require("./services/expiryService");
const backupService = require("./services/backupService");
const memoryMonitorService = require("./services/memoryMonitorService");

// ─────────────────────────────────────────────────────────────────────────────
//  Validate critical env vars on startup
// ─────────────────────────────────────────────────────────────────────────────
const required = [
    "ADMIN_USERNAME",
    "ADMIN_PASSWORD_HASH",
    "JWT_SECRET",
    "BOTS_ROOT_DIR",
];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`[Server] Missing required env var: ${key}`);
        process.exit(1);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  App Setup
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// Security headers — disable CSP so React app can load from same origin
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — in dev, allow Vite dev server; in prod, same origin only
app.use(
    cors({
        origin:
            process.env.NODE_ENV === "production"
                ? false
                : process.env.CLIENT_URL || "http://localhost:5173",
        credentials: true,
    }),
);

app.use(express.json({ limit: "2mb" })); // env files could be a bit large

// ─────────────────────────────────────────────────────────────────────────────
//  API Routes
// ─────────────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/bots", authMiddleware, botRoutes);
app.use("/api/groups", authMiddleware, groupRoutes);
app.use("/api/bulk", authMiddleware, bulkRoutes);
app.use("/api/logs", logRoutes); // Auth handled per-route (SSE needs query-param token)
app.use("/api/system", authMiddleware, systemRoutes);
app.use("/api/panel", authMiddleware, panelRoutes);
app.use("/api/github", authMiddleware, githubRoutes);
app.use("/api/proxy", authMiddleware, proxyRoutes);
app.use("/api/external", apiKeyMiddleware, externalRoutes);
app.use("/api/tags", authMiddleware, tagRoutes);
app.use("/api/notifications", authMiddleware, notificationRoutes);

// ─────────────────────────────────────────────────────────────────────────────
//  Serve React Build in Production
// ─────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
    const distPath = path.join(__dirname, "../client/dist");
    app.use(express.static(distPath));
    // SPA fallback — all non-API routes serve index.html
    app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Global Error Handler — must be last
// ─────────────────────────────────────────────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
//  Start Scheduled Services
// ─────────────────────────────────────────────────────────────────────────────
expiryService.start();
backupService.start();
memoryMonitorService.start();

// ─────────────────────────────────────────────────────────────────────────────
//  Listen
// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, "::", () => {
    console.log(
        `[Server] Bot Panel running on port ${PORT} (${process.env.NODE_ENV || "development"})`,
    );
});
