const path = require("path");

/**
 * Root directories the agent is allowed to touch.
 * Every fs/git/pm2 operation must resolve inside one of these.
 */
const rootDir = (root = "bots") => {
    const roots = {
        bots: process.env.BOTS_ROOT_DIR,
        sites: process.env.SITES_ROOT_DIR || process.env.BOTS_ROOT_DIR,
    };
    const dir = roots[root];
    if (!dir) throw new Error(`Unknown or unconfigured root "${root}"`);
    return path.normalize(dir);
};

/**
 * Resolve {root}/{dir}/{sub} and guarantee the result stays inside the root.
 * Same traversal guard as the panel's resolveSafePath.
 */
const resolveSafe = (root, dir, sub = "") => {
    const base = rootDir(root);
    const target = path.normalize(path.join(base, dir || "", sub || ""));
    if (!target.startsWith(base)) throw new Error("Invalid path");
    return target;
};

module.exports = { rootDir, resolveSafe };
