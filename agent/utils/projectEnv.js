const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// ─────────────────────────────────────────────────────────────────────────────
//  The environment for project code the agent sets running: `pm2 start` (the
//  pm2 CLI copies its own environment into the app it registers —
//  Common.prepareAppConf), install commands and their npm scripts, `git pull`
//  (hooks), and the terminal.
//
//  The agent's own environment holds AGENT_API_KEY, and that key opens every
//  route of this agent: /term, /fs (every project's .env), /self/env (the
//  panel's .env on the node that hosts it). Until agent 1.14.0 every bot,
//  site, Lavalink and install script inherited it in process.env — one
//  `console.log(process.env)` or error reporter away from a stranger.
//
//  Drops every variable agent/.env defines, and AGENT_API_KEY wherever else it
//  came from. Everything else (PATH, HOME, LANG, NODE_ENV …) stays, so a
//  project sees the machine as it did before.
//
//  Not a wall: projects run as the agent's own Unix user, which can still read
//  agent/.env. This keeps the key out of what a project hands out by accident.
// ─────────────────────────────────────────────────────────────────────────────

const ENV_FILE = path.join(__dirname, "..", ".env");

// The pm2 CLI needs these to find its daemon, even when agent/.env sets them.
const KEEP = new Set(["PATH", "HOME", "PM2_HOME"]);

/** Names agent/.env defines (read every call — it is small and may be edited). */
const agentKeys = (envFile = ENV_FILE) => {
    let parsed = {};
    try {
        parsed = dotenv.parse(fs.readFileSync(envFile));
    } catch {
        /* no agent/.env — its variables came from pm2 or the shell */
    }
    return [...new Set([...Object.keys(parsed), "AGENT_API_KEY"])].filter((k) => !KEEP.has(k));
};

/** A copy of `base` without the agent's own variables. */
const projectEnv = (base = process.env, envFile = ENV_FILE) => {
    const env = { ...base };
    for (const key of agentKeys(envFile)) delete env[key];
    return env;
};

module.exports = { projectEnv, agentKeys };
