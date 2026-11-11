// Website modes as the panel names them — the same three the server accepts
// (server/routes/bots.js WEBSITE_MODES). "api" (2026-11-11) is an app with no
// frontend: nginx proxies every path to it, so it has no dist folder.

const MODES = {
    static: { label: "Static", summary: "Static site — served by nginx" },
    fullstack: { label: "Full-stack", summary: "Full-stack — PM2 API + nginx frontend" },
    api: { label: "API only", summary: "API only — PM2 app, nginx proxies every path to it" },
};

const of = (mode) => MODES[mode] || MODES.static;

/** "Static" | "Full-stack" | "API only" (a site without a mode was created static). */
export const siteModeLabel = (mode) => of(mode).label;

/** One line on what serves the site. */
export const siteModeSummary = (mode) => of(mode).summary;

/** Modes where PM2 runs the project's app behind nginx (they switch into each other). */
export const runsApp = (mode) => mode === "fullstack" || mode === "api";
