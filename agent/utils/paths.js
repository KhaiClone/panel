const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
//  Root directories the agent is allowed to touch.
//
//  Two addressing conventions exist, and every fs/git/pm2 operation must go
//  through one of them:
//
//   1. {root, dir, sub}  → resolveSafe()  — the default for git-cloned projects
//      that live under BOTS_ROOT_DIR / SITES_ROOT_DIR.
//
//   2. {absPath}         → resolveAbs()   — for projects registered from an
//      existing folder (bot.source === "local") whose absolute path may sit
//      outside those two roots. Such a path is accepted ONLY when it resolves
//      inside one of the roots listed in EXTRA_ROOTS.
//
//  EXTRA_ROOTS is an allowlist, never a bypass: an unlisted path is refused.
//  Leaving it unset reproduces the agent's original behaviour exactly.
//
//  Example:
//    EXTRA_ROOTS=/home/khaidev/arnto,/home/khaidev/Lavalink
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute, normalized form of a configured directory. */
const _norm = (p) => path.resolve(path.normalize(p));

const rootDir = (root = "bots") => {
    const roots = {
        bots: process.env.BOTS_ROOT_DIR,
        sites: process.env.SITES_ROOT_DIR || process.env.BOTS_ROOT_DIR,
    };
    const dir = roots[root];
    if (!dir) throw new Error(`Unknown or unconfigured root "${root}"`);
    return _norm(dir);
};

/** Extra absolute roots from EXTRA_ROOTS (comma separated). Empty when unset. */
const extraRoots = () =>
    (process.env.EXTRA_ROOTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(_norm);

/** Every directory the agent may operate in, for error messages and checks. */
const allowedRoots = () => {
    const roots = [];
    for (const name of ["bots", "sites"]) {
        try {
            roots.push(rootDir(name));
        } catch {
            /* that root is unconfigured — skip it */
        }
    }
    return [...new Set([...roots, ...extraRoots()])];
};

/**
 * True when `target` is `base` itself or sits below it.
 *
 * A plain startsWith() would accept "/a/bc" for base "/a/b"; comparing on a
 * trailing separator keeps the check on real directory boundaries.
 */
const isInside = (target, base) => {
    if (target === base) return true;
    return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
};

/**
 * Resolve {root}/{dir}/{sub} and guarantee the result stays inside that root.
 * Same traversal guard as the panel's resolveSafePath.
 */
const resolveSafe = (root, dir, sub = "") => {
    const base = rootDir(root);
    const target = _norm(path.join(base, dir || "", sub || ""));
    if (!isInside(target, base)) throw new Error("Invalid path");
    return target;
};

/**
 * Resolve an absolute project path against the allowlist.
 *
 * Normalization also repairs sloppy stored paths — a doubled separator such as
 * "/home/khaidev//sites/x" collapses before the comparison, so a path that only
 * looked out-of-root is accepted correctly.
 */
const resolveAbs = (absPath, sub = "") => {
    if (!absPath || typeof absPath !== "string") throw new Error("absPath is required");
    if (!path.isAbsolute(_norm(absPath))) throw new Error("absPath must be an absolute path");

    const base = _norm(absPath);
    const roots = allowedRoots();
    const allowed = roots.some((r) => isInside(base, r));
    if (!allowed) {
        const err = new Error(
            `Path "${base}" is outside every allowed root. ` +
                `Allowed: ${roots.join(", ") || "(none configured)"}. ` +
                `Add its parent directory to EXTRA_ROOTS on this agent to permit it.`,
        );
        err.status = 400;
        throw err;
    }

    // A sub-path below an already-approved base still may not escape it.
    const target = _norm(path.join(base, sub || ""));
    if (!isInside(target, base)) throw new Error("Invalid path");
    return target;
};

/**
 * Single entry point for routes that accept either convention.
 *
 * Pass the request body straight through: when it carries `absPath` the
 * allowlist applies, otherwise {root, dir} behaves exactly as it always has.
 */
const resolveTarget = ({ root, dir, absPath } = {}, sub = "") =>
    absPath ? resolveAbs(absPath, sub) : resolveSafe(root, dir, sub);

module.exports = {
    rootDir,
    extraRoots,
    allowedRoots,
    isInside,
    resolveSafe,
    resolveAbs,
    resolveTarget,
};
