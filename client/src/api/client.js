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
// Redirect to login if the server returns 401 (expired/invalid token).
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem("token");
            if (window.location.pathname !== "/login") {
                window.location.href = "/login";
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
