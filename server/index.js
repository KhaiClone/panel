require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const bcrypt = require("bcryptjs");

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
const userRoutes = require("./routes/users");
const slotRoutes = require("./routes/slots");
const nodeRoutes = require("./routes/nodes");
const shopOrderRoutes = require("./routes/shopOrders");
const decorRoutes = require("./routes/decors");
const { authMiddleware } = require("./middleware/auth");
const { adminOnly } = require("./middleware/adminOnly");
const { apiKeyMiddleware } = require("./middleware/apiKey");
const nodeContext = require("./middleware/nodeContext");
const errorHandler = require("./middleware/errorHandler");
const expiryService = require("./services/expiryService");
const backupService = require("./services/backupService");
const memoryMonitorService = require("./services/memoryMonitorService");
const nodeService = require("./services/nodeService");
const termService = require("./services/termService");
const db = require("./db");

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
//  Seed admin user from env vars (runs once if no users table exists)
// ─────────────────────────────────────────────────────────────────────────────
async function seedAdminUser() {
    try {
        const existing = await db.findOne("users", { username: process.env.ADMIN_USERNAME });
        if (!existing) {
            await db.create("users", {
                username: process.env.ADMIN_USERNAME,
                passwordHash: process.env.ADMIN_PASSWORD_HASH,
                role: "admin",
                active: true,
                createdAt: Date.now(),
                lastLoginAt: null,
            });
            console.log(`[Server] Admin user "${process.env.ADMIN_USERNAME}" seeded from env`);
        }

        // Migrate existing bots that have no ownerId → assign to admin
        const admin = await db.findOne("users", { role: "admin" });
        if (admin) {
            const allBots = await db.find("bots");
            let migrated = 0;
            for (const bot of allBots) {
                if (!bot.ownerId) {
                    await db.findOneAndUpdate("bots", { _id: bot._id }, { ownerId: admin._id });
                    migrated++;
                }
            }
            if (migrated > 0) {
                console.log(`[Server] Migrated ${migrated} existing bot(s) → ownerId: ${admin._id}`);
            }
        }

        // Migrate existing bots that have no nodeId → they run on this VPS
        {
            const allBots = await db.find("bots");
            let nodeMigrated = 0;
            for (const bot of allBots) {
                if (!bot.nodeId) {
                    await db.findOneAndUpdate("bots", { _id: bot._id }, { nodeId: nodeService.LOCAL_NODE_ID });
                    nodeMigrated++;
                }
            }
            if (nodeMigrated > 0) {
                console.log(`[Server] Migrated ${nodeMigrated} existing bot(s) → nodeId: "local"`);
            }
        }
    } catch (err) {
        console.error("[Server] Seed error:", err.message);
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
app.use("/api/bots", authMiddleware, nodeContext, botRoutes);
app.use("/api/groups", authMiddleware, groupRoutes);
app.use("/api/bulk", authMiddleware, bulkRoutes);
app.use("/api/logs", logRoutes); // Auth handled per-route (SSE needs query-param token)
app.use("/api/system", authMiddleware, adminOnly, nodeContext, systemRoutes);
app.use("/api/panel", authMiddleware, adminOnly, panelRoutes);
app.use("/api/github", authMiddleware, adminOnly, githubRoutes);
app.use("/api/proxy", authMiddleware, adminOnly, proxyRoutes);
app.use("/api/external", apiKeyMiddleware, externalRoutes);
app.use("/api/tags", authMiddleware, tagRoutes);
app.use("/api/notifications", authMiddleware, notificationRoutes);
app.use("/api/admin/users", authMiddleware, userRoutes);
app.use("/api/admin/slots", authMiddleware, slotRoutes);
app.use("/api/nodes", authMiddleware, adminOnly, nodeRoutes);
app.use("/api/shop", authMiddleware, adminOnly, shopOrderRoutes);
app.use("/api/decors", authMiddleware, adminOnly, decorRoutes);

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
nodeService.startHealthPolling();

// ─────────────────────────────────────────────────────────────────────────────
//  Listen + Seed
// ─────────────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
const server = app.listen(PORT, "0.0.0.0", async () => {
    console.log(
        `[Server] Bot Panel running on port ${PORT} (${process.env.NODE_ENV || "development"})`,
    );
    await seedAdminUser();
});

// Interactive terminal (WebSocket upgrade on /api/term)
termService.attachTermServer(server);
