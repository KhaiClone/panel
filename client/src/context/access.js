// Which pages staff can be given — the same keys as PAGES in
// server/services/staffService.js, which is what actually enforces them.
// Everything not listed here is the owner's alone, on the client too: a staff
// member who opens any other URL is sent to their first page.
export const STAFF_PAGES = [
    { key: "orders", path: "/orders" },
    { key: "stock", path: "/stock" },
    { key: "vouchers", path: "/vouchers" },
    { key: "ticketMenus", path: "/ticket-menus" },
    { key: "supporters", path: "/supporters" },
    { key: "resellers", path: "/resellers" },
    { key: "messages", path: "/messages" },
    { key: "webhooks", path: "/webhooks" },
    { key: "quests", path: "/quests" },
    { key: "badges", path: "/badges" },
    { key: "decors", path: "/decors" },
    { key: "pricing", path: "/pricing" },
];

/** The page key a path belongs to ("/quests/abc" → "quests"), or null. */
export const pageForPath = (pathname) =>
    STAFF_PAGES.find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`))?.key || null;

/** "edit" | "view" | null — what this user may do on `page`. The owner may do everything. */
export const accessTo = (user, page) => {
    if (!user) return null;
    if (user.kind === "owner") return "edit";
    return user.perms?.[page] || null;
};

/** Where this user lands after signing in, or when they open a page they cannot use. */
export const homeFor = (user) => {
    if (!user || user.kind === "owner") return "/systems";
    return STAFF_PAGES.find((p) => user.perms?.[p.key])?.path || "/no-access";
};

/** Why a staff session ended (server: staffService.END_REASONS). */
export const END_REASONS = {
    replaced: "Your account signed in somewhere else, so this session was closed.",
    logout: "You signed out.",
    kicked: "The owner signed you out.",
    removed: "Your panel access was removed.",
    role_lost: "You no longer have the Staff role in the server.",
    left_guild: "You are no longer in the server.",
    discord_revoked: "The panel's access to your Discord account was revoked.",
    expired: "Your session expired — sign in again.",
};
