import axios from "axios";

// Base URL — empty string because Vite proxies /api in dev,
// and in production Express serves everything from the same origin.
const api = axios.create({
    baseURL: "/api",
    timeout: 30_000,
});

// ── Request interceptor ────────────────────────────────────────────────────
// Automatically attach the JWT token from localStorage to every request, plus
// the selected remote-view node (see context/NodeContext.jsx).
api.interceptors.request.use((config) => {
    const token = localStorage.getItem("token");
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    // Callers may pin a request to a specific node (e.g. "local") by setting
    // the header themselves — only fill it in when absent.
    const selectedNode = localStorage.getItem("bp_selected_node");
    if (selectedNode && selectedNode !== "local" && !config.headers["X-Panel-Node"]) {
        config.headers["X-Panel-Node"] = selectedNode;
    }
    return config;
});

// ── Response interceptor ───────────────────────────────────────────────────
// Redirect to login if the server returns 401 (expired/invalid token).
// Reset the remote-view selection if the selected node was deleted/disabled.
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            localStorage.removeItem("token");
            if (window.location.pathname !== "/login") {
                window.location.href = "/login";
            }
        }
        const code = error.response?.data?.code;
        if (code === "NODE_GONE" || code === "NODE_DISABLED") {
            localStorage.removeItem("bp_selected_node");
            window.location.reload();
        }
        return Promise.reject(error);
    },
);

export default api;
