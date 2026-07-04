const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const auth = require("./middleware/auth");

const app = express();
app.disable("x-powered-by");
// Generous limit: fs/write sends whole file contents (panel caps reads at 10MB)
app.use(express.json({ limit: "15mb" }));

// Every route requires the shared agent key
app.use(auth);

app.use("/", require("./routes/system"));
app.use("/pm2", require("./routes/pm2"));
app.use("/git", require("./routes/git"));
app.use("/fs", require("./routes/fs"));
app.use("/logs", require("./routes/logs"));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error("[Agent]", err.message);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ error: err.message || "Internal agent error" });
});

const PORT = parseInt(process.env.AGENT_PORT) || 4200;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Agent] bot-panel agent listening on :${PORT}`);
    console.log(`[Agent] BOTS_ROOT_DIR = ${process.env.BOTS_ROOT_DIR}`);
    console.log(`[Agent] SITES_ROOT_DIR = ${process.env.SITES_ROOT_DIR || "(same as bots)"}`);
    if (!process.env.AGENT_API_KEY) {
        console.error("[Agent] WARNING: AGENT_API_KEY is not set — all requests will be rejected");
    }
});
