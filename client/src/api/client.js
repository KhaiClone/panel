import axios from "axios";

// Base URL — empty string because Vite proxies /api in dev,
// and in production Express serves everything from the same origin.
const api = axios.create({
    baseURL: "/api",
    timeout: 30_000,
});

// ── Request interceptor ────────────────────────────────────────────────────
// Attach the JWT token from localStorage to every request.
api.interceptors.request.use((config) => {
    const token = localStorage.getItem("token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    // No global node scope any more: list endpoints return every node's data
    // and the pages filter locally. A caller that genuinely wants one node's
    // view still sets X-Panel-Node itself — NodeDetailPage does exactly that.
    return config;
});

// ── Response interceptor ───────────────────────────────────────────────────
// Redirect to login when OUR session died — and only then.
//
// 401 alone is not enough to decide that. Several routes resolve a Discord
// token the admin typed in, and they answer 401 when THAT token is dead:
// POST /quests/start, /quests/preview, /quests/monthly. Logging out on a bare
// 401 meant pasting a dead token into "Add account manually" kicked the admin
// back to /login instead of showing "token is dead" — the panel session and the
// customer's Discord token share one status number.
//
// authMiddleware now stamps `code: "AUTH_REQUIRED"` on the 401s that really do
// mean "log in again". Everything else is the caller's to display.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        const res = error.response;
        if (res?.status === 401 && res.data?.code === "AUTH_REQUIRED") {
            // The answer to a request made with an older token (a new login
            // already replaced it — e.g. on the Discord callback page) must not
            // throw the new session away.
            const sent = String(error.config?.headers?.Authorization || "").replace(/^Bearer /, "");
            const current = localStorage.getItem("token");
            if (sent && current && sent !== current) return Promise.reject(error);
            localStorage.removeItem("token");
            if (!["/login", "/auth/discord/callback"].includes(window.location.pathname)) {
                // A staff session that was ended says why (signed in elsewhere,
                // Staff role taken away, …) — the login page shows it. Kept in
                // sessionStorage too: on a page load the router's own redirect
                // to /login can win over this one and drop the query.
                const reason = res.data.reason;
                if (reason) {
                    try { sessionStorage.setItem("bp_ended", reason); } catch { /* storage disabled */ }
                }
                window.location.href = reason ? `/login?ended=${encodeURIComponent(reason)}` : "/login";
            }
        }
        // NODE_GONE / NODE_DISABLED are left for the caller to handle: only a
        // page that deliberately scopes to one node can send that header, and
        // only it knows what to do when that node is gone.
        return Promise.reject(error);
    },
);

// One-time cleanup: the global node switcher is gone, so this key is dead.
// Left here for a while so browsers that still hold it drop it on next load.
try { localStorage.removeItem("bp_selected_node"); } catch { /* storage disabled */ }

export default api;
