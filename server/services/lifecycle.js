// ─────────────────────────────────────────────────────────────────────────────
//  Panel run state.
//
//    starting     booted, not yet sure it is the panel in charge (lease claim
//                 pending) — background jobs wait
//    active       normal operation
//    maintenance  handing over to a panel on another node: background jobs are
//                 paused, in-flight quest/badge work is stopped WITHOUT touching
//                 its DB status, and the HTTP gate refuses writes
//    fenced       a newer panel has taken over (see panelLease) — this process
//                 does nothing but say where the panel went
//
//  Background jobs never check the state themselves: every scheduled callback is
//  wrapped in guard(), which simply skips the tick unless the panel is active.
// ─────────────────────────────────────────────────────────────────────────────

let state = "starting";
let info = null;

const get = () => ({ state, info });
const isActive = () => state === "active";

/** Wrap a scheduled callback so it only runs while the panel is active. */
const guard = (fn) => (...args) => (state === "active" ? fn(...args) : undefined);

/** Leave "starting". Returns false when the panel was fenced during startup. */
const activate = () => {
    if (state === "fenced") return false;
    state = "active";
    info = null;
    return true;
};

/**
 * Stop the work that must not run in two panels at once, keeping it resumable:
 * quest loops stay "running" in the DB so restore() on the next panel picks
 * them up, the monthly batch stops without being marked done, and badge orders
 * are allowed to finish (a half-sent order cannot be resumed — see badgeService).
 */
const suspendWork = async () => {
    const questService = require("./questService");
    const questMonthly = require("./questMonthly");
    const badgeService = require("./badgeService");
    const [quests, monthly, badges] = await Promise.allSettled([
        questService.suspendAll({ timeoutMs: 30_000 }),
        questMonthly.abortRuns({ timeoutMs: 30_000 }),
        badgeService.waitIdle({ timeoutMs: 90_000 }),
    ]);
    return {
        questsSuspended: quests.value ?? 0,
        monthlyAborted: monthly.value ?? false,
        badgeOrdersStillRunning: badges.value ?? 0,
    };
};

/** active → maintenance. Resolves once in-flight work has stopped. */
const enterMaintenance = async (details = null) => {
    if (state !== "active") {
        const err = new Error(`The panel is ${state}, not active`);
        err.status = 409;
        throw err;
    }
    state = "maintenance";
    info = details;
    return suspendWork();
};

/** maintenance → active: the hand-over was abandoned, pick the work back up. */
const exitMaintenance = async () => {
    if (state !== "maintenance") return;
    state = "active";
    info = null;
    await require("./questService").restore().catch((e) => console.warn("[Panel] quest restore:", e.message));
    await require("./badgeService").restoreOrders().catch(() => {});
};

/**
 * A newer panel owns the nodes now. Stops everything this process was doing and
 * never undoes itself — only a restart re-evaluates (and is fenced again).
 */
const fence = (details) => {
    if (state === "fenced") return;
    const wasActive = state === "active";
    state = "fenced";
    info = details || null;
    console.error(
        `[Panel] FENCED — a newer panel controls the nodes${details?.byNodeId ? ` (panel node ${details.byNodeId})` : ""}. ` +
            "This process has stopped all background work.",
    );
    if (wasActive) suspendWork().catch(() => {});
    // …and leaves the Discord bus to the panel that replaced it.
    require("./discordBus").stop().catch(() => {});
};

module.exports = { get, isActive, guard, activate, enterMaintenance, exitMaintenance, fence };
